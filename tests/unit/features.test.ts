import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { loadPdf, savePdf } from '../../src/core/pdf/loader';
import { createImageDocument } from '../../src/core/pdf/create';
import { compressDocument, describeCompression } from '../../src/core/pdf/compress';
import { convertToImages, convertToText, normalizeText, zipFiles } from '../../src/core/pdf/convert';
import { redactDocument } from '../../src/core/pdf/redact';
import { addHeaderFooter, addWatermark, formatPageNumber, formatTokens, toRoman } from '../../src/core/pdf/watermark';
import { validateDocument } from '../../src/core/pdf/validate';
import { fillForm, listFormFields, createFormFields, flattenForm } from '../../src/core/pdf/forms';
import { paintBoxesOnImage } from '../../src/main/pdf/canvas-paint';
import { FormFieldInfo } from '../../src/shared/types';
import { createFontManager, extractText, isJpeg, isPng, makePdf, pngFromCanvas, renderer } from './helpers';

const fonts = createFontManager();

async function noisyScanPdf(pages = 2): Promise<Uint8Array> {
  const images = Array.from({ length: pages }, (_, index) => ({
    name: `scan-${index}.png`,
    bytes: pngFromCanvas(1240, 1754, (context) => {
      context.fillStyle = '#f4f1e8';
      context.fillRect(0, 0, 1240, 1754);
      // Dense random dots make the PNG large, like a real scan.
      for (let i = 0; i < 20000; i += 1) {
        context.fillStyle = `rgb(${Math.random() * 255},${Math.random() * 255},${Math.random() * 255})`;
        context.fillRect(Math.random() * 1200, Math.random() * 1700, 3, 3);
      }
      context.fillStyle = '#222222';
      context.font = '48px sans-serif';
      context.fillText(`Scanned page ${index + 1}`, 80, 200);
    }),
  }));
  return createImageDocument(
    { images: [], pageSize: 'A4', orientation: 'portrait', margin: 0, onePerPage: true },
    images,
  );
}

describe('compression', () => {
  it('shrinks image-only documents and keeps the page count', async () => {
    const bytes = await noisyScanPdf(2);
    const result = await compressDocument(
      bytes,
      { profile: 'balanced' },
      { renderer: renderer() },
    );
    expect(result.compressedSize).toBeLessThan(result.originalSize);
    expect(result.lossy).toBe(true);
    expect(result.method).toContain('rasterised');
    expect((await loadPdf(result.bytes)).getPageCount()).toBe(2);
    expect(describeCompression(result)).toContain('smaller');
  });

  it('keeps text documents searchable with the lossless profile', async () => {
    const bytes = await makePdf({ pages: 2, text: 'Compression keeps this text' });
    const result = await compressDocument(bytes, { profile: 'lossless' }, { renderer: renderer() });
    expect(result.lossy).toBe(false);
    const text = (await extractText(result.bytes)).join('\n');
    expect(text).toContain('Compression keeps this text');
  });

  it('honours custom settings', async () => {
    const bytes = await noisyScanPdf(1);
    const result = await compressDocument(
      bytes,
      { profile: 'custom', dpi: 90, quality: 40, rasterizePages: true, grayscale: true, stripMetadata: true },
      { renderer: renderer() },
    );
    expect(result.compressedSize).toBeLessThan(result.originalSize);
    expect(result.method).toContain('90 dpi');
  });

  it('reports progress and supports cancellation', async () => {
    const bytes = await noisyScanPdf(2);
    const progress: number[] = [];
    const result = await compressDocument(bytes, { profile: 'balanced' }, { renderer: renderer() }, {
      onProgress: (completed) => progress.push(completed),
      shouldCancel: () => progress.length > 0,
    });
    expect(progress.length).toBeGreaterThan(0);
    expect(result.bytes.byteLength).toBeGreaterThan(0);
  });
});

describe('conversion', () => {
  it('renders pages to PNG and JPEG', async () => {
    const bytes = await makePdf({ pages: 2 });
    const pngs = await convertToImages(bytes, { format: 'png', dpi: 72, quality: 90, pages: [0] }, renderer());
    expect(pngs).toHaveLength(1);
    expect(isPng(pngs[0]!.data)).toBe(true);
    expect(pngs[0]!.name).toBe('page-01.png');
    // Rounded up from 595.28 pt.
    expect(pngs[0]!.width).toBe(596);

    const jpegs = await convertToImages(bytes, { format: 'jpeg', dpi: 150, quality: 70, pages: null }, renderer());
    expect(jpegs).toHaveLength(2);
    expect(isJpeg(jpegs[0]!.data)).toBe(true);
    expect(jpegs[0]!.width).toBe(1241);
  });

  it('exports text, markdown and HTML', async () => {
    const bytes = await makePdf({ pages: 2, text: 'Export me <please>' });
    const txt = await convertToText(bytes, 'txt', renderer(), { title: 'report' });
    expect(txt.name).toBe('report.txt');
    expect(txt.content).toContain('Export me');

    const md = await convertToText(bytes, 'markdown', renderer(), { title: 'report' });
    expect(md.content).toContain('## Page 1');

    const html = await convertToText(bytes, 'html', renderer(), { title: 'report' });
    expect(html.content).toContain('<!doctype html>');
    expect(html.content).toContain('&lt;please&gt;');
    expect(html.content).not.toContain('<please>');
  });

  it('zips exported files with fflate', () => {
    const zip = zipFiles([
      { name: 'a.png', data: new Uint8Array([1, 2, 3]) },
      { name: 'a.png', data: new Uint8Array([4, 5, 6]) },
    ]);
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
  });

  it('normalises extracted text', () => {
    expect(normalizeText('a  \n\n\n b  \n')).toBe('a\n\n b');
  });
});

describe('watermark and page furniture', () => {
  it('draws a text watermark that becomes part of the content', async () => {
    const doc = await loadPdf(await makePdf({ pages: 2 }));
    const count = await addWatermark(
      doc,
      {
        text: 'CONFIDENTIAL',
        fontSize: 40,
        color: '#ff0000',
        opacity: 0.25,
        rotation: 45,
        x: 0.5,
        y: 0.5,
        tile: false,
        scale: 1,
        fontFamily: 'standard:Helvetica',
        pages: null,
      },
      fonts,
    );
    expect(count).toBe(2);
    const bytes = await savePdf(doc);
    const text = (await extractText(bytes)).join('\n');
    expect(text).toContain('CONFIDENTIAL');
  });

  it('tiles watermarks', async () => {
    const doc = await loadPdf(await makePdf({ pages: 1 }));
    await addWatermark(
      doc,
      { text: 'DRAFT', fontSize: 20, color: '#888888', opacity: 0.2, rotation: 30, x: 0.5, y: 0.5, tile: true, scale: 1, fontFamily: 'standard:Helvetica' },
      fonts,
    );
    const text = (await extractText(await savePdf(doc)))[0]!;
    expect(text.match(/DRAFT/g)?.length ?? 0).toBeGreaterThan(3);
  });

  it('adds headers, footers and page numbers with tokens', async () => {
    const doc = await loadPdf(await makePdf({ pages: 3 }));
    doc.setTitle('Annual report');
    const touched = await addHeaderFooter(
      doc,
      {
        headerLeft: '{title}',
        headerRight: '{date}',
        footerCenter: 'Page {page} of {pages}',
        fontSize: 9,
        color: '#333333',
        margin: 28,
        fontFamily: 'standard:Helvetica',
        firstPageNumber: 1,
        pageNumberFormat: '{page} / {pages}',
        includeOnFirstPage: true,
        pages: null,
      },
      fonts,
    );
    expect(touched).toBe(3);
    const pages = await extractText(await savePdf(doc));
    expect(pages[0]).toContain('Annual report');
    expect(pages[0]).toContain('1 / 3');
    expect(pages[2]).toContain('3 / 3');
  });

  it('formats tokens, roman numerals and letters', () => {
    expect(formatTokens('{page}/{pages} {title}', { page: 2, pages: 9, title: 'Doc' })).toBe('2/9 Doc');
    expect(toRoman(4)).toBe('iv');
    expect(toRoman(1990)).toBe('mcmxc');
    expect(formatPageNumber('{page}', 7, 10, 'roman')).toBe('vii');
    expect(formatPageNumber('{page}', 3, 10, 'letters')).toBe('C');
  });
});

describe('redaction', () => {
  it('irreversibly removes redacted text and verifies the result', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595.28, 841.89]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('SECRET CODE 1234', { x: 60, y: 760, size: 22, font });
    page.drawText('Public information stays visible.', { x: 60, y: 720, size: 12, font });
    const bytes = await savePdf(doc);
    expect(Buffer.from(bytes).toString('latin1')).not.toBe('');

    const result = await redactDocument(
      bytes,
      {
        regions: [{ pageIndex: 0, rects: [{ x: 50, y: 730, width: 400, height: 60 }] }],
        fill: '#000000',
        scrubMetadata: true,
        dpi: 200,
        verifyStrings: ['SECRET CODE', '1234'],
      },
      { renderer: renderer(), paintBoxes: paintBoxesOnImage },
    );

    expect(result.verified).toBe(true);
    expect(result.remaining).toEqual([]);
    expect(result.pagesRedacted).toBe(1);
    expect(result.removedTextCount).toBeGreaterThan(0);

    const text = (await extractText(result.bytes)).join('\n');
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('1234');
    // Everything on the page is rasterised, so the visible copy is gone too.
    const raw = Buffer.from(result.bytes).toString('latin1');
    expect(raw).not.toContain('SECRET');
  });

  it('rejects empty redaction sets', async () => {
    const bytes = await makePdf();
    await expect(
      redactDocument(bytes, { regions: [], fill: '#000000', scrubMetadata: true, dpi: 150 }, {
        renderer: renderer(),
        paintBoxes: paintBoxesOnImage,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('forms', () => {
  it('creates, lists, fills and flattens fields', async () => {
    const doc = await loadPdf(await makePdf());
    const created = createFormFields(doc, [
      { kind: 'text', name: 'full_name', pageIndex: 0, rect: { x: 60, y: 600, width: 240, height: 24 } },
      { kind: 'checkbox', name: 'agree', pageIndex: 0, rect: { x: 60, y: 560, width: 18, height: 18 } },
      { kind: 'dropdown', name: 'country', pageIndex: 0, rect: { x: 60, y: 520, width: 180, height: 24 }, options: ['India', 'Germany', 'United States'] },
    ]);
    expect(created).toBe(3);

    let bytes = await savePdf(doc);
    let reopened = await loadPdf(bytes);
    let fields: FormFieldInfo[] = listFormFields(reopened);
    expect(fields).toHaveLength(3);
    expect(fields.map((field) => field.type).sort()).toEqual(['checkbox', 'dropdown', 'text']);

    const result = fillForm(reopened, {
      full_name: { type: 'text', value: 'Ada Lovelace' },
      agree: { type: 'checkbox', value: true },
      country: { type: 'dropdown', value: 'Germany' },
    });
    expect(result.filled).toBe(3);
    expect(result.errors).toEqual([]);

    bytes = await savePdf(reopened);
    reopened = await loadPdf(bytes);
    fields = listFormFields(reopened);
    expect(fields.find((field) => field.name === 'full_name')!.value).toBe('Ada Lovelace');
    expect(fields.find((field) => field.name === 'agree')!.value).toBe(true);
    expect(fields.find((field) => field.name === 'country')!.value).toBe('Germany');

    const flattened = flattenForm(reopened);
    expect(flattened).toBe(3);
    const afterFlatten = await loadPdf(await savePdf(reopened));
    expect(listFormFields(afterFlatten)).toHaveLength(0);
  });

  it('reports unknown fields instead of throwing', async () => {
    const doc = await loadPdf(await makePdf());
    createFormFields(doc, [{ kind: 'text', name: 'known', pageIndex: 0, rect: { x: 40, y: 500, width: 120, height: 20 } }]);
    const result = fillForm(doc, { unknown: { type: 'text', value: 'x' } });
    expect(result.filled).toBe(0);
    expect(result.skipped).toEqual(['unknown']);
  });
});

describe('validation', () => {
  it('accepts healthy documents', async () => {
    const report = await validateDocument(await makePdf({ pages: 2 }), { renderer: renderer() });
    expect(report.valid).toBe(true);
    expect(report.pageCount).toBe(2);
    expect(report.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
  });

  it('repairs files with leading junk', async () => {
    const bytes = await makePdf();
    const junk = new Uint8Array(bytes.length + 8);
    junk.set([0x47, 0x41, 0x52, 0x42, 0x41, 0x47, 0x45, 0x0a], 0);
    junk.set(bytes, 8);
    const report = await validateDocument(junk, { renderer: renderer() });
    expect(report.repairedBytes).toBeDefined();
    expect(report.repairedBytes!.length).toBe(bytes.length);
    expect(report.issues.some((issue) => issue.message.includes('leading data'))).toBe(true);
  });

  it('detects truncated files', async () => {
    const bytes = (await makePdf({ pages: 3 })).subarray(0, 400);
    const report = await validateDocument(bytes, { renderer: renderer() });
    expect(report.valid).toBe(false);
    expect(report.issues.some((issue) => issue.severity === 'error')).toBe(true);
  });
});
