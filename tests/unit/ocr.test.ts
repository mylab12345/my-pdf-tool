import path from 'node:path';
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import { createWorker } from 'tesseract.js';
import { describe, expect, it } from 'vitest';
import { createImageDocument } from '../../src/core/pdf/create';
import { buildSearchablePdf, ocrDocument, type TesseractWorkerLike } from '../../src/core/pdf/ocr';
import { loadPdf, savePdf } from '../../src/core/pdf/loader';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { createFontManager, pngFromCanvas, renderer, resourcesDir } from './helpers';

const fonts = createFontManager();
const langPath = path.join(resourcesDir, 'ocr-langs');
const cachePath = path.join(os.tmpdir(), 'arena-pdf-ocr-cache');

async function createWorkerFor(languages: string[]): Promise<TesseractWorkerLike> {
  mkdirSync(cachePath, { recursive: true });
  const worker = await createWorker(languages.join('+'), 1, {
    langPath,
    cachePath,
    gzip: true,
    logger: () => undefined,
    errorHandler: () => undefined,
  });
  return worker as unknown as TesseractWorkerLike;
}

/** Builds a "scanned" PDF: a page containing only a bitmap with text. */
async function scannedPdf(text = 'Invoice 2026 total 1499 rupees'): Promise<Uint8Array> {
  const png = pngFromCanvas(1400, 500, (context) => {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 1400, 500);
    context.fillStyle = '#101010';
    context.font = '64px sans-serif';
    context.fillText(text, 60, 180);
    context.font = '40px sans-serif';
    context.fillText('Paid in full on 25 October', 60, 300);
  });
  return createImageDocument(
    { images: [], pageSize: 'A4', orientation: 'portrait', margin: 40, onePerPage: true },
    [{ name: 'scan.png', bytes: png }],
  );
}

describe('OCR', () => {
  it('recognises text from a scanned page fully offline', async () => {
    const bytes = await scannedPdf();
    // The source document has no text layer at all.
    const before = await renderer().text(bytes);
    expect(before[0]!.text.trim()).toBe('');

    const result = await ocrDocument(
      bytes,
      { languages: ['eng'], dpi: 300, pages: [0], searchablePdf: false },
      { renderer: renderer(), fonts, createWorker: createWorkerFor },
    );

    expect(result.languages).toEqual(['eng']);
    expect(result.pages).toHaveLength(1);
    const text = result.pages[0]!.text.toLowerCase();
    expect(text).toContain('invoice');
    expect(text).toContain('2026');
    expect(text).toContain('1499');
    expect(result.pages[0]!.confidence).toBeGreaterThan(60);
    expect(result.pages[0]!.words.length).toBeGreaterThan(5);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('produces a searchable PDF with an invisible text layer', async () => {
    const bytes = await scannedPdf();
    const result = await ocrDocument(
      bytes,
      { languages: ['eng'], dpi: 250, pages: [0], searchablePdf: true },
      { renderer: renderer(), fonts, createWorker: createWorkerFor },
    );
    expect(result.bytes).toBeDefined();

    const searchable = result.bytes!;
    const text = (await renderer().text(searchable))[0]!.text;
    expect(text.toLowerCase()).toContain('invoice');
    expect(text.toLowerCase()).toContain('rupees');

    // The original bitmap must still be visible (the layer is transparent).
    const rendered = await renderer().renderPage(searchable, 0, { dpi: 72 });
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const image = await loadImage(Buffer.from(rendered.data));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixel = context.getImageData(Math.round(image.width * 0.2), Math.round(image.height * 0.3), 1, 1).data;
    expect(pixel[0]! > 240 && pixel[1]! > 240).toBe(true);
  });

  it('reads rotated scans and keeps the text layer aligned', async () => {
    // A real rotated scan: the bitmap itself is rotated, the page carries /Rotate 90
    // so viewers display it upright.
    const png = pngFromCanvas(500, 1400, (context) => {
      // Text rotated 90° counter-clockwise inside the bitmap; the page /Rotate 90
      // turns it back to horizontal for the reader.
      context.save();
      context.translate(0, 1400);
      context.rotate(-Math.PI / 2);
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, 1400, 500);
      context.fillStyle = '#101010';
      context.font = '64px sans-serif';
      context.fillText('Rotated page 42', 60, 160);
      context.restore();
    });
    const bytes = await createImageDocument(
      { images: [], pageSize: 'A4', orientation: 'portrait', margin: 30, onePerPage: true },
      [{ name: 'rotated.png', bytes: png }],
    );
    const doc = await loadPdf(bytes);
    doc.getPage(0).setRotation({ type: 'degrees', angle: 90 } as never);
    const rotated = await savePdf(doc);

    // Coordinate mapping must round-trip on a rotated page.
    const probe = { x: 120, y: 300 };
    const imagePoints = await renderer().pdfToImagePoints(rotated, 0, 200, [probe]);
    const back = await renderer().imageToPdfPoints(rotated, 0, 200, [imagePoints[0]!]);
    expect(back[0]!.x).toBeCloseTo(probe.x, 1);
    expect(back[0]!.y).toBeCloseTo(probe.y, 1);

    const result = await ocrDocument(
      rotated,
      { languages: ['eng'], dpi: 200, pages: [0], searchablePdf: true },
      { renderer: renderer(), fonts, createWorker: createWorkerFor },
    );
    expect(result.pages[0]!.text).toMatch(/Rotated/i);
    const text = (await renderer().text(result.bytes!))[0]!.text;
    expect(text).toMatch(/Rotated/i);
  }, 180_000);

  it('skips empty pages without failing', async () => {
    const empty = await PDFDocument.create();
    empty.addPage([595, 842]);
    const font = await empty.embedFont(StandardFonts.Helvetica);
    empty.getPage(0).drawText('tiny', { x: 20, y: 20, size: 10, font });
    const bytes = await savePdf(empty);

    const result = await ocrDocument(
      bytes,
      { languages: ['eng'], dpi: 150, pages: [0], searchablePdf: false },
      { renderer: renderer(), fonts, createWorker: createWorkerFor },
    );
    expect(result.pages).toHaveLength(1);
    expect(typeof result.pages[0]!.text).toBe('string');
  });

  it('builds a text layer directly from word boxes', async () => {
    const bytes = await scannedPdf();
    const layer = await buildSearchablePdf(
      bytes,
      [
        {
          pageIndex: 0,
          text: 'synthetic',
          confidence: 90,
          width: 1191,
          height: 1684,
          words: [
            { text: 'synthetic', confidence: 90, bbox: { x0: 100, y0: 100, x1: 400, y1: 160 } },
          ],
        },
      ],
      150,
      { renderer: renderer(), fonts },
    );
    expect((await renderer().text(layer))[0]!.text).toContain('synthetic');
  });
});
