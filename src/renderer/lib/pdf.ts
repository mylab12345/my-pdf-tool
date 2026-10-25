import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

/**
 * pdf.js setup for the renderer.
 *
 * Everything pdf.js needs (worker, CMaps, standard fonts, wasm decoders) is
 * served from the app bundle, so the viewer works with no network access. The
 * document bytes themselves arrive through the `arenadoc://` protocol, which
 * supports HTTP range requests — large files are streamed, not copied.
 */

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const assets = (name: string): string => new URL(`./pdfjs/${name}/`, document.baseURI).href;

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export function pdfjsOptions(): Record<string, unknown> {
  return {
    cMapUrl: assets('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assets('standard_fonts'),
    wasmUrl: assets('wasm'),
    iccUrl: assets('iccs'),
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: false,
    verbosity: 0,
  };
}

export interface LoadedPdf {
  url: string;
  document: PDFDocumentProxy;
}

const cache = new Map<string, Promise<PDFDocumentProxy>>();

/** Loads (and caches) a document by its protocol URL. */
export async function loadPdf(url: string, password?: string): Promise<PDFDocumentProxy> {
  const cached = cache.get(url);
  if (cached) return cached;
  const task = pdfjs.getDocument({
    url,
    ...(password ? { password } : {}),
    ...pdfjsOptions(),
  } as Parameters<typeof pdfjs.getDocument>[0]);
  const promise = task.promise as Promise<PDFDocumentProxy>;
  cache.set(url, promise);
  promise.catch(() => cache.delete(url));
  // Keep at most four documents parsed at once.
  if (cache.size > 4) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest) {
      const entry = cache.get(oldest);
      cache.delete(oldest);
      entry?.then((doc) => destroyDocument(doc)).catch(() => undefined);
    }
  }
  return promise;
}

export function forgetPdf(url: string): void {
  const entry = cache.get(url);
  cache.delete(url);
  entry?.then((doc) => destroyDocument(doc)).catch(() => undefined);
}

/** pdf.js exposes `destroy()` at runtime but the published types omit it. */
function destroyDocument(doc: PDFDocumentProxy): void {
  void (doc as unknown as { destroy?: () => Promise<void> }).destroy?.();
}

export interface RenderTarget {
  canvas: HTMLCanvasElement;
  page: PDFPageProxy;
  scale: number;
  /** Additional clockwise rotation in degrees (0/90/180/270). */
  rotation?: number;
}

/** Renders one page into a canvas at device pixel ratio. */
export async function renderPage({ canvas, page, scale, rotation = 0 }: RenderTarget): Promise<void> {
  const viewport = page.getViewport({ scale, rotation: ((page.rotate + rotation) % 360 + 360) % 360 });
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Canvas 2D context unavailable');

  canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
  canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;

  const task = page.render({
    canvas,
    canvasContext: context,
    viewport,
    transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
    background: '#ffffff',
  } as Parameters<PDFPageProxy['render']>[0]);
  await task.promise;
}

export interface TextSpan {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  transform: number[];
  fontFamily: string;
}

/**
 * Builds absolutely positioned spans for one page.
 *
 * This is a deliberately small text layer: it uses pdf.js' own transform matrix
 * so selection lines up with the rendered glyphs regardless of page rotation.
 */
export async function buildTextSpans(page: PDFPageProxy, scale: number, rotation = 0): Promise<{ spans: TextSpan[]; width: number; height: number }> {
  const viewport = page.getViewport({ scale, rotation: ((page.rotate + rotation) % 360 + 360) % 360 });
  const content = await page.getTextContent();
  const spans: TextSpan[] = [];
  for (const raw of content.items) {
    if (!('str' in raw) || !raw.str) continue;
    const transform = pdfjs.Util.transform(viewport.transform, raw.transform);
    const fontSize = Math.hypot(transform[2] ?? 0, transform[3] ?? 0);
    if (fontSize <= 0) continue;
    const width = (raw.width ?? 0) * viewport.scale;
    spans.push({
      text: raw.str,
      left: transform[4] ?? 0,
      top: (transform[5] ?? 0) - fontSize,
      width,
      height: fontSize * 1.15,
      fontSize,
      transform,
      fontFamily: raw.fontName ?? 'sans-serif',
    });
  }
  return { spans, width: viewport.width, height: viewport.height };
}

export type { PDFDocumentProxy, PDFPageProxy };
