import { PDFName, rgb } from '@cantoo/pdf-lib';
import { hexToRgb } from '../../shared/format';
import type { RedactionOptions, RedactionResult } from '../../shared/types';
import { appError } from '../errors';
import type { PdfRenderer } from '../raster/renderer';
import { createImageDocument } from './create';
import { loadPdf, savePdf } from './loader';
import { scrubMetadata } from './metadata';

export interface RedactionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RedactionDeps {
  renderer: PdfRenderer;
  /**
   * Paints opaque boxes onto a rendered page bitmap. Injected by the host so the
   * engine stays free of a hard canvas dependency.
   */
  paintBoxes(image: Uint8Array, boxes: RedactionBox[], fill: string): Promise<Uint8Array>;
}

export interface RedactionHooks {
  onProgress?: (completed: number, total: number, label: string) => void;
  shouldCancel?: () => boolean;
}

/**
 * Applies irreversible redactions.
 *
 * The redacted pages are re-rendered to bitmaps with the redaction boxes painted
 * into the pixels, then assembled into a new document. Text under the boxes is
 * therefore physically gone (not merely covered), metadata and attachments are
 * dropped and the result is verified by extracting text again.
 */
export async function redactDocument(
  bytes: Uint8Array,
  options: RedactionOptions,
  deps: RedactionDeps,
  hooks: RedactionHooks = {},
): Promise<RedactionResult> {
  const regions = options.regions.filter((region) => region.rects.length > 0);
  if (!regions.length) throw appError('INVALID_INPUT', 'Mark at least one area to redact.');

  const source = await loadPdf(bytes);
  const pageCount = source.getPageCount();
  for (const region of regions) {
    if (region.pageIndex < 0 || region.pageIndex >= pageCount) {
      throw appError('INVALID_INPUT', `Page ${region.pageIndex + 1} does not exist.`);
    }
  }

  const dpi = Math.max(96, Math.min(600, options.dpi || 200));
  const scale = 72 / dpi;
  const [r, g, b] = hexToRgb(options.fill);
  const fill = rgb(r, g, b);

  // Render every page (redaction must not leave the original content anywhere in
  // the file, so the whole document is rebuilt from rendered pages).
  hooks.onProgress?.(0, pageCount, 'Preparing pages');
  const rendered = await deps.renderer.renderPages(
    bytes,
    Array.from({ length: pageCount }, (_, index) => index),
    {
      dpi,
      format: 'png',
      onProgress: (completed, total) => hooks.onProgress?.(completed, total, 'Rendering pages'),
      ...(hooks.shouldCancel ? { shouldCancel: hooks.shouldCancel } : {}),
    },
  );

  // Paint the redaction boxes onto the rendered bitmaps.
  const painted: { name: string; bytes: Uint8Array }[] = [];
  for (const page of rendered) {
    const region = regions.find((entry) => entry.pageIndex === page.pageIndex);
    if (!region) {
      painted.push({ name: `page-${page.pageIndex}.png`, bytes: page.data });
      continue;
    }
    const pageHeightPoints = page.height * scale;
    // Convert PDF (bottom-up) coordinates into bitmap (top-down) pixels.
    const boxes = region.rects.map((rect) => ({
      x: rect.x / scale,
      y: (pageHeightPoints - rect.y - rect.height) / scale,
      width: rect.width / scale,
      height: rect.height / scale,
    }));
    painted.push({ name: `page-${page.pageIndex}.png`, bytes: await deps.paintBoxes(page.data, boxes, options.fill) });
  }

  const rebuilt = await createImageDocument(
    { images: [], pageSize: 'FitImage', orientation: 'portrait', margin: 0, onePerPage: true },
    painted.map((file) => ({ name: file.name, bytes: file.bytes })),
  );
  const doc = await loadPdf(rebuilt);
  // Re-apply the original page boxes so sizes stay identical.
  const pages = doc.getPages();
  for (const [index, page] of pages.entries()) {
    const original = source.getPage(index).getSize();
    page.setSize(original.width, original.height);
  }
  if (options.scrubMetadata) {
    scrubMetadata(doc);
    // Remove embedded files: they can hold the very content being redacted.
    doc.catalog.delete(PDFName.of('Names'));
    doc.catalog.delete(PDFName.of('AF'));
    doc.catalog.delete(PDFName.of('Outlines'));
  }
  doc.setProducer('Arena PDF Studio');
  doc.setCreator('Arena PDF Studio');
  const out = await savePdf(doc);

  // Verify: the redacted strings (and any other text on redacted pages) must be gone.
  const remaining: string[] = [];
  const textAfter = await deps.renderer.text(out);
  const combined = textAfter.map((page) => page.text).join('\n');
  for (const needle of options.verifyStrings ?? []) {
    if (needle.trim() && combined.includes(needle)) remaining.push(needle);
  }
  // Any leftover text is a weaker signal, but an empty text layer is expected.
  const textBefore = await deps.renderer.text(bytes);
  const removedTextCount = textBefore.reduce((total, page) => total + page.text.replace(/\s/g, '').length, 0) - combined.replace(/\s/g, '').length;

  hooks.onProgress?.(pageCount, pageCount, 'Redaction complete');

  return {
    bytes: out,
    pagesRedacted: regions.length,
    removedTextCount: Math.max(0, removedTextCount),
    verified: remaining.length === 0,
    remaining,
  };
}

/** Validates redaction regions before the UI submits them. */
export function validateRegions(regions: RedactionOptions['regions']): string[] {
  const problems: string[] = [];
  if (!regions.length) problems.push('Mark at least one redaction area.');
  for (const region of regions) {
    for (const rect of region.rects) {
      if (rect.width < 1 || rect.height < 1) problems.push(`A redaction box on page ${region.pageIndex + 1} is too small.`);
    }
  }
  return problems;
}

/** Creates a redacted preview by painting boxes only (no destructive change). */
export async function previewRedactions(
  bytes: Uint8Array,
  regions: RedactionOptions['regions'],
  fill: string,
  dpi: number,
): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  const [r, g, b] = hexToRgb(fill);
  for (const region of regions) {
    if (region.pageIndex >= doc.getPageCount()) continue;
    const page = doc.getPage(region.pageIndex);
    for (const rect of region.rects) {
      page.drawRectangle({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, color: rgb(r, g, b) });
    }
  }
  void dpi;
  return savePdf(doc);
}
