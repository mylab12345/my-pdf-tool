import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import type { CompressionOptions, CompressionResult, RenderedPage } from '../../shared/types';
import type { PdfRenderer } from '../raster/renderer';
import { createImageDocument } from './create';
import { loadPdf, savePdf } from './loader';
import { scrubMetadata } from './metadata';

export interface CompressionHooks {
  onProgress?: (completed: number, total: number, label: string) => void;
  shouldCancel?: () => boolean;
}

export interface CompressionDeps {
  renderer: PdfRenderer;
}

interface ProfileSettings {
  rasterize: 'none' | 'scanned' | 'all';
  dpi: number;
  quality: number;
  grayscale: boolean;
  stripMetadata: boolean;
}

function settingsFor(options: CompressionOptions): ProfileSettings {
  switch (options.profile) {
    case 'lossless':
      return { rasterize: 'none', dpi: 150, quality: 90, grayscale: false, stripMetadata: options.stripMetadata ?? true };
    case 'balanced':
      return { rasterize: 'scanned', dpi: 150, quality: 72, grayscale: false, stripMetadata: options.stripMetadata ?? true };
    case 'aggressive':
      return { rasterize: 'all', dpi: 110, quality: 50, grayscale: true, stripMetadata: true };
    case 'custom':
    default:
      return {
        rasterize: options.rasterizePages ? 'all' : 'none',
        dpi: options.dpi ?? 150,
        quality: options.quality ?? 75,
        grayscale: options.grayscale ?? false,
        stripMetadata: options.stripMetadata ?? false,
      };
  }
}

/**
 * Compresses a document.
 *
 * Two independent strategies are combined:
 *
 * 1. Structural: rewrite with cross-reference/object streams, drop the XMP and
 *    info dictionaries and orphaned thumbnails. This never alters visible
 *    content, so text stays selectable.
 * 2. Rasterisation: pages that carry no text layer (i.e. scans) are re-encoded
 *    as JPEG at the target resolution. The "aggressive" profile rasterises every
 *    page, which is lossy for born-digital documents and therefore opt-in.
 */
export async function compressDocument(
  bytes: Uint8Array,
  options: CompressionOptions,
  deps: CompressionDeps,
  hooks: CompressionHooks = {},
): Promise<CompressionResult> {
  const settings = settingsFor(options);
  const originalSize = bytes.length;
  const doc = await loadPdf(bytes);
  const pageCount = doc.getPageCount();

  // Decide which pages to rasterise (needs the text layer information).
  let pagesToRasterize: number[] = [];
  if (settings.rasterize === 'all') {
    pagesToRasterize = doc.getPageIndices();
  } else if (settings.rasterize === 'scanned') {
    const textPages = await deps.renderer.text(bytes);
    const withoutText = new Set(textPages.filter((page) => page.text.trim().length === 0).map((page) => page.pageIndex));
    pagesToRasterize = doc.getPageIndices().filter((index) => withoutText.has(index));
  }

  let working: Uint8Array = bytes;
  let method = 'structural';

  if (pagesToRasterize.length > 0 && pagesToRasterize.length === pageCount) {
    // Every page becomes an image: build a fresh document from rendered pages.
    const rendered: RenderedPage[] = await deps.renderer.renderPages(bytes, pagesToRasterize, {
      dpi: settings.dpi,
      format: 'jpeg',
      quality: settings.quality,
      grayscale: settings.grayscale,
      onProgress: (completed, total) => hooks.onProgress?.(completed, total, 'Rasterising pages'),
      ...(hooks.shouldCancel ? { shouldCancel: hooks.shouldCancel } : {}),
    });
    const rebuilt = await createImageDocument(
      { images: [], pageSize: 'FitImage', orientation: 'portrait', margin: 0, onePerPage: true },
      rendered.map((page, index) => ({ name: `page-${index + 1}.jpg`, bytes: page.data })),
    );
    const rebuiltDoc = await loadPdf(rebuilt);
    copyPageLabels(doc, rebuiltDoc);
    if (settings.stripMetadata) scrubMetadata(rebuiltDoc);
    working = await savePdf(rebuiltDoc, { useObjectStreams: true });
    method = `rasterised (${settings.dpi} dpi, JPEG ${settings.quality})`;
  } else if (pagesToRasterize.length > 0) {
    // Mixed document: replace only the scanned pages, keeping text pages intact.
    const rendered = await deps.renderer.renderPages(bytes, pagesToRasterize, {
      dpi: settings.dpi,
      format: 'jpeg',
      quality: settings.quality,
      grayscale: settings.grayscale,
      onProgress: (completed, total) => hooks.onProgress?.(completed, total, 'Rasterising scanned pages'),
      ...(hooks.shouldCancel ? { shouldCancel: hooks.shouldCancel } : {}),
    });
    const rebuilt = await replacePagesWithImages(doc, pagesToRasterize, rendered);
    if (settings.stripMetadata) scrubMetadata(rebuilt);
    working = await savePdf(rebuilt, { useObjectStreams: true });
    method = `mixed (${pagesToRasterize.length} scanned page(s) re-encoded)`;
  } else {
    if (settings.stripMetadata) scrubMetadata(doc);
    doc.catalog.delete(PDFName.of('PieceInfo'));
    doc.catalog.delete(PDFName.of('Metadata'));
    working = await savePdf(doc, { useObjectStreams: true });
    method = 'structural (lossless)';
  }

  hooks.onProgress?.(1, 1, 'Finalising');

  const compressedSize = working.byteLength;
  return {
    bytes: working,
    originalSize,
    compressedSize,
    method,
    lossy: pagesToRasterize.length > 0,
  };
}

/**
 * Replaces individual pages with rendered images while keeping the rest of the
 * document (and its object structure) intact.
 */
async function replacePagesWithImages(
  doc: PDFDocument,
  pages: number[],
  rendered: RenderedPage[],
): Promise<PDFDocument> {
  const ordered = [...pages].sort((a, b) => a - b);
  for (const [position, pageIndex] of ordered.entries()) {
    const image = rendered[position];
    if (!image) continue;
    const page = doc.getPage(pageIndex);
    const size = page.getSize();
    const embedded = image.format === 'jpeg' ? await doc.embedJpg(image.data) : await doc.embedPng(image.data);

    // Blank the page content but keep the page object and its boxes.
    const contents = doc.context.obj([]);
    page.node.set(PDFName.of('Contents'), doc.context.register(contents));
    page.node.delete(PDFName.of('Resources'));
    page.drawImage(embedded, { x: 0, y: 0, width: size.width, height: size.height });
    // Rotation was baked into the rendered bitmap.
    page.setRotation({ type: 'degrees', angle: 0 } as never);
  }
  return doc;
}

function copyPageLabels(source: PDFDocument, target: PDFDocument): void {
  const labels = source.catalog.lookup(PDFName.of('PageLabels'));
  if (labels) target.catalog.set(PDFName.of('PageLabels'), target.context.obj(labels as never) as never);
}

/** Human readable summary for the compression dialog. */
export function describeCompression(result: CompressionResult): string {
  const saved = result.originalSize - result.compressedSize;
  const percent = result.originalSize > 0 ? (saved / result.originalSize) * 100 : 0;
  const sign = saved >= 0 ? 'smaller' : 'larger';
  return `${result.method}: ${percent.toFixed(1)}% ${sign} (${Math.abs(saved)} bytes ${saved >= 0 ? 'saved' : 'added'})`;
}
