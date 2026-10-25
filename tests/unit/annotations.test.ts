import { describe, expect, it } from 'vitest';
import { loadPdf, savePdf } from '../../src/core/pdf/loader';
import { addAnnotation, annotationCounts, flattenAnnotations, listAnnotations, removeAnnotation, updateAnnotation } from '../../src/core/pdf/annotations';
import type { AnnotationInput } from '../../src/shared/types';
import { createFontManager, extractText, makePdf, renderer } from './helpers';

const fonts = createFontManager();

const highlight: AnnotationInput = {
  type: 'highlight',
  pageIndex: 0,
  rect: { x: 50, y: 700, width: 200, height: 20 },
  quads: [{ x: 50, y: 700, width: 200, height: 20 }],
  color: '#ffd400',
  opacity: 0.6,
  contents: 'Important sentence',
  author: 'Reviewer',
};

describe('annotations', () => {
  it('stores markup, note, free text, ink and shapes as real PDF annotations', async () => {
    const doc = await loadPdf(await makePdf({ pages: 2 }));
    addAnnotation(doc, highlight);
    addAnnotation(doc, {
      type: 'note',
      pageIndex: 0,
      rect: { x: 400, y: 700, width: 24, height: 24 },
      color: '#ffd400',
      opacity: 1,
      icon: 'Note',
      contents: 'Please verify this figure',
    });
    addAnnotation(doc, {
      type: 'freetext',
      pageIndex: 1,
      rect: { x: 60, y: 600, width: 220, height: 60 },
      color: '#111111',
      opacity: 1,
      text: 'Inserted comment',
      fontSize: 12,
      fontFamily: 'standard:Helvetica',
      align: 'left',
      lineHeight: 1.3,
      bold: false,
      italic: false,
      background: '#ffffff',
      borderColor: '#cccccc',
      borderWidth: 1,
    });
    addAnnotation(doc, {
      type: 'ink',
      pageIndex: 1,
      rect: { x: 60, y: 500, width: 120, height: 60 },
      color: '#e11d48',
      opacity: 1,
      paths: [
        [
          { x: 60, y: 500 },
          { x: 100, y: 540 },
          { x: 140, y: 500 },
        ],
      ],
      strokeWidth: 2,
    });
    addAnnotation(doc, {
      type: 'square',
      pageIndex: 1,
      rect: { x: 200, y: 400, width: 100, height: 80 },
      color: '#2563eb',
      opacity: 1,
      strokeWidth: 1.5,
      fill: null,
    });

    const bytes = await savePdf(doc);
    const reopened = await loadPdf(bytes);
    const annotations = listAnnotations(reopened);
    expect(annotations).toHaveLength(5);
    expect(annotations.map((annotation) => annotation.type).sort()).toEqual(['freetext', 'highlight', 'ink', 'note', 'square']);
    expect(annotationCounts(reopened)).toEqual([2, 3]);

    const listed = annotations.find((annotation) => annotation.type === 'highlight')!;
    expect(listed.contents).toBe('Important sentence');
    expect(listed.author).toBe('Reviewer');
    expect(listed.rect.width).toBeCloseTo(200, 1);
    expect(listed.color.toLowerCase()).toBe('#ffd400');
    expect((listed as { quads: unknown[] }).quads).toHaveLength(1);

    // Object streams hide the dictionaries, so also write a plain-xref copy and
    // check the annotation subtypes directly in the file syntax.
    const plain = await savePdf(await loadPdf(bytes), { useObjectStreams: false });
    const raw = Buffer.from(plain).toString('latin1');
    expect(raw).toContain('/Highlight');
    expect(raw).toContain('/FreeText');
    expect(raw).toContain('/Ink');
    expect(raw).toContain('/Square');
  });

  it('removes and updates annotations by id', async () => {
    const doc = await loadPdf(await makePdf());
    const created = addAnnotation(doc, highlight);
    expect(listAnnotations(doc)).toHaveLength(1);

    const updated = updateAnnotation(doc, created.id, { ...highlight, color: '#34aadc', opacity: 0.4 });
    expect(updated).toBe(true);
    const afterUpdate = listAnnotations(doc);
    expect(afterUpdate).toHaveLength(1);
    expect(afterUpdate[0]!.color.toLowerCase()).toBe('#34aadc');

    expect(removeAnnotation(doc, created.id)).toBe(true);
    expect(listAnnotations(doc)).toHaveLength(0);
    expect(removeAnnotation(doc, 'missing')).toBe(false);
  });

  it('flattens annotations into page content', async () => {
    const doc = await loadPdf(await makePdf());
    addAnnotation(doc, highlight);
    addAnnotation(doc, {
      type: 'freetext',
      pageIndex: 0,
      rect: { x: 60, y: 620, width: 240, height: 40 },
      color: '#000000',
      opacity: 1,
      text: 'Flattened note text',
      fontSize: 14,
      fontFamily: 'standard:Helvetica',
      align: 'left',
      lineHeight: 1.3,
      bold: false,
      italic: false,
      background: null,
      borderColor: null,
      borderWidth: 0,
    });

    const result = await flattenAnnotations(doc, fonts);
    expect(result.flattened).toBe(2);
    expect(result.skipped).toBe(0);
    const bytes = await savePdf(doc);

    const reopened = await loadPdf(bytes);
    expect(listAnnotations(reopened)).toHaveLength(0);
    const text = (await extractText(bytes)).join('\n');
    expect(text).toContain('Flattened note text');

    // The highlight must now be visible in the rendered pixels.
    const rendered = await renderer().renderPage(bytes, 0, { dpi: 72 });
    const colour = await samplePixel(rendered.data, 120, 841.89 - 710, rendered.width, rendered.height);
    expect(colour.r).toBeGreaterThan(200);
    expect(colour.b).toBeLessThan(160);
  });

  it('keeps untranslatable annotations instead of dropping them', async () => {
    const doc = await loadPdf(await makePdf());
    addAnnotation(doc, {
      type: 'link',
      pageIndex: 0,
      rect: { x: 50, y: 600, width: 100, height: 20 },
      color: '#0000ff',
      opacity: 1,
      url: 'https://example.invalid/doc',
    });
    const result = await flattenAnnotations(doc, fonts);
    expect(result.flattened).toBe(0);
    expect(result.skipped).toBe(1);
    expect(listAnnotations(doc)).toHaveLength(1);
  });
});

async function samplePixel(png: Uint8Array, x: number, y: number, width: number, height: number) {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(Buffer.from(png));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const px = Math.max(0, Math.min(image.width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(image.height - 1, Math.round(y)));
  const data = context.getImageData(px, py, 1, 1).data;
  void width;
  void height;
  return { r: data[0]!, g: data[1]!, b: data[2]! };
}
