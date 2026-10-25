import type { RenderedPage } from '../../shared/types';
import { appError, normalizeError } from '../errors';
import type {
  PageText,
  PdfjsDocument,
  PdfjsModule,
  PdfOutlineSnapshot,
  RenderOptions,
  RendererDependencies,
} from './types';

const MAX_CACHED_DOCUMENTS = 3;

interface OpenDocument {
  doc: PdfjsDocument;
  destroy(): Promise<void>;
}

/**
 * PDF rasteriser and text extractor built on pdf.js.
 *
 * All environment specific parts (module loading, canvas implementation, font
 * paths) are injected, so the same code rasterises pages in the Electron main
 * process, in plain Node during tests and (if ever needed) in the renderer.
 */
export class PdfRenderer {
  private readonly cache = new Map<string, Promise<OpenDocument>>();

  constructor(private readonly deps: RendererDependencies) {}

  private async module(): Promise<PdfjsModule> {
    return this.deps.loadPdfjs();
  }

  /**
   * Opens a document. `key` allows callers to reuse a parsed document across
   * several operations (page thumbnails, OCR, compression).
   */
  async open(bytes: Uint8Array, options: { password?: string; key?: string } = {}): Promise<OpenDocument> {
    const key = options.key;
    if (key) {
      const cached = this.cache.get(key);
      if (cached) return cached;
    }
    const task = this.loadDocument(bytes, options.password);
    if (key) {
      this.cache.set(key, task);
      this.evict();
      task.catch(() => this.cache.delete(key));
    }
    return task;
  }

  private evict(): void {
    while (this.cache.size > MAX_CACHED_DOCUMENTS) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const entry = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      entry?.then((opened) => opened.destroy()).catch(() => undefined);
    }
  }

  private async loadDocument(bytes: Uint8Array, password?: string): Promise<OpenDocument> {
    const pdfjs = await this.module();
    try {
      const task = pdfjs.getDocument({
        // pdf.js may transfer the buffer to a worker: always hand over a copy.
        data: new Uint8Array(bytes),
        isEvalSupported: false,
        useSystemFonts: true,
        disableFontFace: true,
        ...(password ? { password } : {}),
        ...(this.deps.standardFontDataUrl ? { standardFontDataUrl: this.deps.standardFontDataUrl } : {}),
        ...(this.deps.cMapUrl ? { cMapUrl: this.deps.cMapUrl, cMapPacked: true } : {}),
        verbosity: this.deps.verbosity ?? 0,
        ...this.deps.documentOptions,
      });
      const doc = await task.promise;
      return {
        doc,
        destroy: async () => {
          try {
            await task.destroy();
          } catch {
            /* already destroyed */
          }
        },
      };
    } catch (error) {
      throw normalizeError(error);
    }
  }

  /** Releases a cached document (call when a session is closed). */
  async release(key: string): Promise<void> {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.cache.delete(key);
    try {
      const opened = await entry;
      await opened.destroy();
    } catch {
      /* already destroyed */
    }
  }

  async destroy(): Promise<void> {
    const entries = [...this.cache.values()];
    this.cache.clear();
    await Promise.all(
      entries.map(async (entry) => {
        try {
          const opened = await entry;
          await opened.destroy();
        } catch {
          /* ignore */
        }
      }),
    );
  }

  /** Reads page geometry, labels and a text-layer sample without rendering. */
  async inspect(bytes: Uint8Array, options: { password?: string; textSampleSize?: number } = {}): Promise<PdfOutlineSnapshot> {
    const opened = await this.open(bytes, options.password ? { password: options.password } : {});
    const doc = opened.doc;
    try {
      const pages: { width: number; height: number; rotation: number }[] = [];
      for (let index = 0; index < doc.numPages; index += 1) {
        const page = await doc.getPage(index + 1);
        const viewport = page.getViewport({ scale: 1 });
        pages.push({
          width: round(viewport.width),
          height: round(viewport.height),
          rotation: viewport.rotation ?? 0,
        });
        page.cleanup();
      }
      let labels: (string | null)[] = [];
      try {
        labels = (await doc.getPageLabels()) ?? [];
      } catch {
        labels = [];
      }

      const sampleSize = Math.min(options.textSampleSize ?? 10, doc.numPages);
      let textCharacters = 0;
      let pagesWithText = 0;
      for (let index = 0; index < sampleSize; index += 1) {
        const page = await doc.getPage(index + 1);
        const content = await page.getTextContent();
        const length = content.items.reduce((total, item) => total + (item.str?.length ?? 0), 0);
        textCharacters += length;
        if (length > 0) pagesWithText += 1;
        page.cleanup();
      }

      return { numPages: doc.numPages, pages, labels, textCharacters, pagesWithText };
    } finally {
      if (!options.password) await opened.destroy().catch(() => undefined);
    }
  }

  /** Extracts the text layer of the requested pages. */
  async text(bytes: Uint8Array, options: { pages?: number[] | null; password?: string } = {}): Promise<PageText[]> {
    const opened = await this.open(bytes, options.password ? { password: options.password } : {});
    const doc = opened.doc;
    const indices = (options.pages ?? Array.from({ length: doc.numPages }, (_, index) => index)).filter(
      (index) => index >= 0 && index < doc.numPages,
    );
    const results: PageText[] = [];
    try {
      for (const index of indices) {
        const page = await doc.getPage(index + 1);
        const content = await page.getTextContent();
        results.push({ pageIndex: index, text: itemsToText(content.items), items: content.items });
        page.cleanup();
      }
      return results;
    } finally {
      if (!options.password) await opened.destroy().catch(() => undefined);
    }
  }

  /** Renders one page to PNG/JPEG bytes. */
  async renderPage(bytes: Uint8Array, pageIndex: number, options: RenderOptions): Promise<RenderedPage> {
    const opened = await this.open(bytes, options.password ? { password: options.password } : {});
    return this.renderWithDocument(opened.doc, pageIndex, options);
  }

  /** Renders several pages, reporting progress and honouring cancellation. */
  async renderPages(bytes: Uint8Array, pageIndices: number[], options: RenderOptions): Promise<RenderedPage[]> {
    const opened = await this.open(bytes, options.password ? { password: options.password } : {});
    const doc = opened.doc;
    const results: RenderedPage[] = [];
    for (const [position, pageIndex] of pageIndices.entries()) {
      if (options.shouldCancel?.()) break;
      results.push(await this.renderWithDocument(doc, pageIndex, options));
      options.onProgress?.(position + 1, pageIndices.length, pageIndex);
    }
    return results;
  }

  /**
   * Converts points from rendered-image pixel space (origin top-left) back to
   * PDF user space, honouring page rotation. Used to place OCR text layers.
   */
  async imageToPdfPoints(
    bytes: Uint8Array,
    pageIndex: number,
    dpi: number,
    points: { x: number; y: number }[],
    password?: string,
  ): Promise<{ x: number; y: number }[]> {
    const opened = await this.open(bytes, password ? { password } : {});
    const page = await opened.doc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: dpi / 72 });
    try {
      if (typeof viewport.convertToPdfPoint === 'function') {
        return points.map((point) => {
          const [x, y] = viewport.convertToPdfPoint!(point.x, point.y);
          return { x, y };
        });
      }
      // Fallback for viewports without the helper: invert the scale/rotation.
      const rotation = ((viewport.rotation % 360) + 360) % 360;
      const pageWidth = viewport.width / viewport.scale;
      const pageHeight = viewport.height / viewport.scale;
      return points.map((point) => {
        const px = point.x / viewport.scale;
        const py = point.y / viewport.scale;
        if (rotation === 90) return { x: py, y: pageWidth - px };
        if (rotation === 180) return { x: pageWidth - px, y: pageHeight - py };
        if (rotation === 270) return { x: pageHeight - py, y: px };
        return { x: px, y: pageHeight - py };
      });
    } finally {
      page.cleanup();
    }
  }

  /** Converts PDF user-space points into rendered-image pixel coordinates. */
  async pdfToImagePoints(
    bytes: Uint8Array,
    pageIndex: number,
    dpi: number,
    points: { x: number; y: number }[],
    password?: string,
  ): Promise<{ x: number; y: number }[]> {
    const opened = await this.open(bytes, password ? { password } : {});
    const page = await opened.doc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: dpi / 72 });
    try {
      if (typeof viewport.convertToViewportPoint === 'function') {
        return points.map((point) => {
          const [x, y] = viewport.convertToViewportPoint!(point.x, point.y);
          return { x, y };
        });
      }
      const rotation = ((viewport.rotation % 360) + 360) % 360;
      const pageWidth = viewport.width / viewport.scale;
      const pageHeight = viewport.height / viewport.scale;
      return points.map((point) => {
        const x = point.x * viewport.scale;
        const y = (pageHeight - point.y) * viewport.scale;
        if (rotation === 90) return { x: y, y: x };
        if (rotation === 180) return { x: viewport.width - x, y: viewport.height - y };
        if (rotation === 270) return { x: viewport.height - y, y: viewport.width - x };
        return { x, y };
      });
    } finally {
      page.cleanup();
    }
  }

  private async renderWithDocument(doc: PdfjsDocument, pageIndex: number, options: RenderOptions): Promise<RenderedPage> {
    if (pageIndex < 0 || pageIndex >= doc.numPages) {
      throw appError('INVALID_INPUT', `Page ${pageIndex + 1} does not exist.`);
    }
    const page = await doc.getPage(pageIndex + 1);
    const baseViewport = page.getViewport({ scale: 1 });
    let scale = Math.max(0.1, options.dpi / 72);
    const maxDimension = options.maxDimension ?? 5000;
    if (baseViewport.width * scale > maxDimension || baseViewport.height * scale > maxDimension) {
      scale = Math.min(maxDimension / baseViewport.width, maxDimension / baseViewport.height);
    }
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));

    const handle = this.deps.canvas.create(width, height);
    try {
      const task = page.render({
        canvasContext: handle.context,
        viewport,
        intent: 'print',
        background: 'white',
        canvas: handle.canvas,
      });
      await task.promise;
      const data = this.deps.canvas.encode(handle, options.format ?? 'png', options.quality ?? 85, options.grayscale ?? false);
      return { pageIndex, width, height, data, format: options.format ?? 'png' };
    } finally {
      this.deps.canvas.destroy(handle);
      page.cleanup();
    }
  }
}

function itemsToText(items: { str: string; hasEOL?: boolean }[]): string {
  let text = '';
  for (const item of items) {
    if (!item.str) continue;
    text += item.str;
    if (item.hasEOL) text += '\n';
  }
  return text;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
