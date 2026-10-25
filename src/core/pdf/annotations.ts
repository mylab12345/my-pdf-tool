import { PDFDict, PDFName, rgb, type PDFDocument, type PDFPage } from '@cantoo/pdf-lib';
import { hexToRgb } from '../../shared/format';
import type { Annotation, AnnotationInput, FreeTextAnnotation, ShapeAnnotation } from '../../shared/types';
import type { FontManager } from './fonts';
import {
  addContentImage,
  annotationId,
  boolOf,
  colorOf,
  createId,
  drawTextContent,
  nameOf,
  numberOf,
  opacityOf,
  pageAnnotationEntries,
  readAnnotation,
  readRect,
  removeAnnotationById,
  textOf,
  writeAnnotation,
} from './annotation-io';
import { wrapText } from './text-layout';

/** Lists every annotation in the document, in page order. */
export function listAnnotations(doc: PDFDocument): Annotation[] {
  const annotations: Annotation[] = [];
  doc.getPages().forEach((page, pageIndex) => {
    for (const entry of pageAnnotationEntries(page)) {
      // Form field widgets and popups are not user annotations.
      const subtype = nameOf(entry.dict, 'Subtype');
      if (subtype === 'Widget' || subtype === 'Popup') continue;
      const annotation = readAnnotation(entry.dict, entry.ref, pageIndex);
      if (annotation) annotations.push(annotation);
    }
  });
  return annotations;
}

export function countAnnotations(doc: PDFDocument): number {
  return listAnnotations(doc).length;
}

/** Adds an annotation and returns the stored model (including its id). */
export function addAnnotation(doc: PDFDocument, input: AnnotationInput): Annotation {
  assertPage(doc, input.pageIndex);
  const page = doc.getPage(input.pageIndex);
  const id = input.id ?? createId();
  const dict = writeAnnotation({ doc, page, pageIndex: input.pageIndex }, input, id);
  const stored = readAnnotation(dict, null, input.pageIndex);
  return stored ?? { ...(input as Annotation), id, createdAt: new Date().toISOString() };
}

/** Replaces an annotation (remove + add, keeping the id). */
export function updateAnnotation(doc: PDFDocument, id: string, input: AnnotationInput): boolean {
  const removed = removeAnnotationById(doc, id);
  if (removed === 0) return false;
  writeAnnotation({ doc, page: doc.getPage(input.pageIndex), pageIndex: input.pageIndex }, input, id);
  return true;
}

export function removeAnnotation(doc: PDFDocument, id: string): boolean {
  return removeAnnotationById(doc, id) > 0;
}

export interface FlattenResult {
  flattened: number;
  skipped: number;
}

/**
 * Burns annotations into the page content and removes them from the annotation
 * layer. Supported: markup, notes, free text, ink, shapes, lines and redaction
 * boxes. Annotations produced by other applications that use custom appearance
 * streams (stamps, widgets) are counted as skipped and left untouched.
 */
export async function flattenAnnotations(
  doc: PDFDocument,
  fonts: FontManager,
  options: { pages?: number[] | null } = {},
): Promise<FlattenResult> {
  const targets = options.pages === null || options.pages === undefined ? null : new Set(options.pages);
  let flattened = 0;
  let skipped = 0;

  const pages = doc.getPages();
  for (const [pageIndex, page] of pages.entries()) {
    if (targets && !targets.has(pageIndex)) continue;
    const annots = page.node.Annots();
    if (!annots || annots.size() === 0) continue;

    const toRemove: number[] = [];
    for (let index = 0; index < annots.size(); index += 1) {
      const dict = annots.lookupMaybe(index, PDFDict);
      if (!dict) continue;
      const didFlatten = await flattenSingle(page, dict, fonts, doc);
      if (didFlatten) {
        toRemove.push(index);
        flattened += 1;
      } else {
        skipped += 1;
      }
    }
    // Remove from the end so indices stay valid.
    for (const index of toRemove.sort((a, b) => b - a)) annots.remove(index);
    if (annots.size() === 0) page.node.delete(PDFName.of('Annots'));
  }

  return { flattened, skipped };
}

async function flattenSingle(page: PDFPage, dict: PDFDict, fonts: FontManager, doc: PDFDocument): Promise<boolean> {
  const subtype = nameOf(dict, 'Subtype');
  const rect = readRect(dict);
  if (!subtype || !rect) return false;
  const color = colorOf(dict) ?? '#000000';
  const opacity = opacityOf(dict);
  const [r, g, b] = hexToRgb(color);
  const borderWidth = numberOf(dict, 'BS') ?? 1;

  switch (subtype) {
    case 'Highlight': {
      const quads = readQuadRects(dict, rect);
      for (const quad of quads) {
        page.drawRectangle({
          x: quad.x,
          y: quad.y,
          width: quad.width,
          height: quad.height,
          color: rgb(1, 0.85, 0.1),
          opacity: Math.min(0.62, opacity),
        });
      }
      return true;
    }
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly': {
      const quads = readQuadRects(dict, rect);
      for (const quad of quads) {
        const y = subtype === 'Underline' ? quad.y + 1 : quad.y + quad.height / 2;
        if (subtype === 'Squiggly') {
          const step = Math.max(2, quad.height / 6);
          for (let x = quad.x; x < quad.x + quad.width; x += step * 2) {
            page.drawLine({ start: { x, y }, end: { x: Math.min(x + step, quad.x + quad.width), y: y + step / 2 }, thickness: 1, color: rgb(r, g, b), opacity });
          }
        } else {
          page.drawLine({
            start: { x: quad.x, y },
            end: { x: quad.x + quad.width, y },
            thickness: 1,
            color: rgb(r, g, b),
            opacity,
          });
        }
      }
      return true;
    }
    case 'Text': {
      // Sticky note: represent the note with a small printed marker.
      page.drawRectangle({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, color: rgb(1, 0.92, 0.45), borderColor: rgb(0.8, 0.7, 0.2), borderWidth: 0.8 });
      const font = await fonts.embed(doc, 'standard:Helvetica-Bold');
      page.drawText('i', { x: rect.x + rect.width * 0.35, y: rect.y + rect.height * 0.2, size: rect.height * 0.6, font, color: rgb(0.35, 0.3, 0.05) });
      const contents = textOf(dict, 'Contents');
      if (contents && rect.width > 40) {
        const body = await fonts.embed(doc, 'standard:Helvetica');
        const lines = wrapText(contents, body, 8, Math.min(220, rect.width * 2)).slice(0, 12);
        lines.forEach((line, index) => {
          if (!line.text) return;
          drawTextContent(page, line.text, { x: rect.x + rect.width + 4, y: rect.y + rect.height - 10 - index * 10, size: 8, color: '#333333', font: body });
        });
      }
      return true;
    }
    case 'FreeText': {
      const da = textOf(dict, 'DA') ?? '';
      const sizeMatch = da.match(/\s([\d.]+)\s+Tf/);
      const size = sizeMatch ? Number(sizeMatch[1]) : 12;
      const contents = textOf(dict, 'Contents') ?? '';
      const align = numberOf(dict, 'Q');
      const font = await fonts.embedForText(doc, 'standard:Helvetica', contents);
      const lines = wrapText(contents, font.font, size, Math.max(10, rect.width - 6));
      lines.forEach((line, index) => {
        if (!line.text) return;
        let x = rect.x + 3;
        if (align === 1) x = rect.x + (rect.width - line.width) / 2;
        if (align === 2) x = rect.x + rect.width - line.width - 3;
        page.drawText(line.text, {
          x,
          y: rect.y + rect.height - size - 3 - index * size * 1.25,
          size,
          font: font.font,
          color: rgb(r, g, b),
          opacity,
        });
      });
      return true;
    }
    case 'Ink': {
      const inkList = dict.lookup(PDFName.of('InkList'));
      const paths = readInkPaths(inkList);
      for (const path of paths) {
        for (let index = 1; index < path.length; index += 1) {
          page.drawLine({
            start: path[index - 1]!,
            end: path[index]!,
            thickness: Math.max(0.5, borderWidth),
            color: rgb(r, g, b),
            opacity,
          });
        }
      }
      return true;
    }
    case 'Square':
      page.drawRectangle({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, borderColor: rgb(r, g, b), borderWidth, opacity });
      return true;
    case 'Circle':
      page.drawEllipse({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, xScale: rect.width / 2, yScale: rect.height / 2, borderColor: rgb(r, g, b), borderWidth, opacity });
      return true;
    case 'Line': {
      const values = asArrayValues(dict.lookup(PDFName.of('L')));
      if (values.length < 4) return false;
      page.drawLine({ start: { x: values[0]!, y: values[1]! }, end: { x: values[2]!, y: values[3]! }, thickness: Math.max(0.5, borderWidth), color: rgb(r, g, b), opacity });
      const isArrow = Boolean(dict.lookup(PDFName.of('LE')));
      if (isArrow) {
        const angle = Math.atan2(values[3]! - values[1]!, values[2]! - values[0]!);
        const head = 9;
        for (const offset of [Math.PI * 0.85, -Math.PI * 0.85]) {
          page.drawLine({
            start: { x: values[2]!, y: values[3]! },
            end: { x: values[2]! + head * Math.cos(angle + offset), y: values[3]! + head * Math.sin(angle + offset) },
            thickness: Math.max(0.5, borderWidth),
            color: rgb(r, g, b),
            opacity,
          });
        }
      }
      return true;
    }
    case 'Redact':
      page.drawRectangle({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, color: rgb(0, 0, 0) });
      return true;
    case 'Link':
      // Links stay interactive: nothing to burn in.
      return false;
    default:
      return false;
  }
}

type Box = { x: number; y: number; width: number; height: number };

function readQuadRects(dict: PDFDict, fallback: Box | Box[]): Box[] {
  const raw = dict.lookup(PDFName.of('QuadPoints'));
  const boxes = Array.isArray(fallback) ? fallback : [fallback];
  if (!isPdfArray(raw)) return boxes;
  const values = asArrayValues(raw);
  const quads: Box[] = [];
  for (let index = 0; index + 7 < values.length; index += 8) {
    const xs = [values[index]!, values[index + 2]!, values[index + 4]!, values[index + 6]!];
    const ys = [values[index + 1]!, values[index + 3]!, values[index + 5]!, values[index + 7]!];
    quads.push({
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    });
  }
  return quads.length ? quads : boxes;
}

function isPdfArray(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'asArray' in value && typeof (value as { asArray: unknown }).asArray === 'function';
}

function asArrayValues(value: unknown): number[] {
  if (!isPdfArray(value)) return [];
  return (value as { asArray: () => { asNumber: () => number }[] }).asArray().map((item) => item.asNumber());
}

function readInkPaths(raw: unknown): { x: number; y: number }[][] {
  if (!isPdfArray(raw)) return [];
  const outer = (raw as { asArray: () => unknown[] }).asArray();
  const paths: { x: number; y: number }[][] = [];
  for (const entry of outer) {
    if (!isPdfArray(entry)) continue;
    const values = asArrayValues(entry);
    const path: { x: number; y: number }[] = [];
    for (let index = 0; index + 1 < values.length; index += 2) path.push({ x: values[index]!, y: values[index + 1]! });
    if (path.length > 1) paths.push(path);
  }
  return paths;
}

/** Adds an image stamp (or visible signature) into the page content. */
export async function addImageStamp(
  doc: PDFDocument,
  pageIndex: number,
  rect: { x: number; y: number; width: number; height: number },
  image: Uint8Array,
  opacity = 1,
): Promise<void> {
  assertPage(doc, pageIndex);
  await addContentImage(doc, pageIndex, rect, image, opacity);
}

/** Counts annotations per page (used by the sidebar and by flatten prompts). */
export function annotationCounts(doc: PDFDocument): number[] {
  const counts = doc.getPages().map(() => 0);
  for (const annotation of listAnnotations(doc)) {
    counts[annotation.pageIndex] = (counts[annotation.pageIndex] ?? 0) + 1;
  }
  return counts;
}

function assertPage(doc: PDFDocument, pageIndex: number): void {
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= doc.getPageCount()) {
    throw new Error(`Page ${pageIndex + 1} does not exist (document has ${doc.getPageCount()} pages).`);
  }
}

/** Type guard used by the UI to know whether an annotation carries rich text. */
export function isFreeText(annotation: Annotation): annotation is FreeTextAnnotation {
  return annotation.type === 'freetext';
}

export function isShape(annotation: Annotation): annotation is ShapeAnnotation {
  return annotation.type === 'square' || annotation.type === 'circle' || annotation.type === 'line' || annotation.type === 'arrow';
}

export { annotationId, boolOf };
