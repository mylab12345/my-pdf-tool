import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFString,
  rgb,
  type PDFDocument,
  type PDFPage,
  type PDFFont,
  type PDFRef,
} from '@cantoo/pdf-lib';
import { hexToRgb, rgbToHex } from '../../shared/format';
import type { Annotation, AnnotationInput } from '../../shared/types';

/* -------------------------------------------------------------------------- */
/* Dictionary helpers                                                          */
/* -------------------------------------------------------------------------- */

export function dictOf(value: unknown): PDFDict | undefined {
  return value instanceof PDFDict ? value : undefined;
}

export function nameOf(dict: PDFDict, key: string): string | undefined {
  const value = dict.lookup(PDFName.of(key));
  if (value instanceof PDFName) return value.asString().replace(/^\//, '');
  return undefined;
}

export function numberOf(dict: PDFDict, key: string): number | undefined {
  const value = dict.lookup(PDFName.of(key));
  if (value instanceof PDFNumber) return value.asNumber();
  return undefined;
}

export function boolOf(dict: PDFDict, key: string): boolean | undefined {
  const value = dict.lookup(PDFName.of(key));
  if (value instanceof PDFBool) return value.asBoolean();
  return undefined;
}

export function textOf(dict: PDFDict, key: string): string | undefined {
  const value = dict.lookup(PDFName.of(key));
  if (value instanceof PDFString || value instanceof PDFHexString) {
    try {
      return value.decodeText();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function arrayOf(dict: PDFDict, key: string): PDFArray | undefined {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFArray ? value : undefined;
}

export function numbersOf(array: PDFArray | undefined): number[] {
  if (!array) return [];
  const out: number[] = [];
  for (let index = 0; index < array.size(); index += 1) {
    const value = array.lookup(index);
    if (value instanceof PDFNumber) out.push(value.asNumber());
  }
  return out;
}

export function colorOf(dict: PDFDict): string | undefined {
  const values = numbersOf(arrayOf(dict, 'C'));
  if (values.length < 3) return undefined;
  return rgbToHex(values[0]!, values[1]!, values[2]!);
}

export function opacityOf(dict: PDFDict): number {
  const value = numberOf(dict, 'CA') ?? numberOf(dict, 'ca');
  return typeof value === 'number' ? Math.max(0, Math.min(1, value)) : 1;
}

/** Formats a JavaScript date as a PDF date literal. */
export function formatPdfDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(
    date.getUTCMinutes(),
  )}${pad(date.getUTCSeconds())}Z`;
}

/** Parses a PDF date literal into an ISO string (best effort). */
export function parsePdfDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!match) return undefined;
  const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00'] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Extracts the annotation dictionaries of a page together with their refs. */
export function pageAnnotationEntries(page: PDFPage): { ref: PDFRef | null; dict: PDFDict }[] {
  const annots = page.node.Annots();
  if (!annots) return [];
  const entries: { ref: PDFRef | null; dict: PDFDict }[] = [];
  for (let index = 0; index < annots.size(); index += 1) {
    const raw = annots.get(index);
    const dict = annots.lookupMaybe(index, PDFDict);
    if (!dict) continue;
    entries.push({ ref: raw && 'objectNumber' in raw ? (raw as PDFRef) : null, dict });
  }
  return entries;
}

/** Normalises a PDF rect (`[x1 y1 x2 y2]`) into x/y/width/height. */
export function readRect(dict: PDFDict): { x: number; y: number; width: number; height: number } | null {
  const values = numbersOf(arrayOf(dict, 'Rect'));
  if (values.length < 4) return null;
  const [x1, y1, x2, y2] = values as [number, number, number, number];
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

export function annotationId(dict: PDFDict, ref: PDFRef | null): string {
  const named = textOf(dict, 'NM');
  if (named) return named;
  if (ref) return `ref:${ref.objectNumber}:${ref.generationNumber}`;
  return `obj:${Math.random().toString(36).slice(2, 10)}`;
}

const MARKUP_TYPES = new Set(['Highlight', 'Underline', 'StrikeOut', 'Squiggly']);

/** Converts a PDF annotation dictionary into the application model. */
export function readAnnotation(dict: PDFDict, ref: PDFRef | null, pageIndex: number): Annotation | null {
  const subtype = nameOf(dict, 'Subtype') ?? 'Unknown';
  const rect = readRect(dict);
  if (!rect) return null;
  const base = {
    id: annotationId(dict, ref),
    pageIndex,
    rect,
    color: colorOf(dict) ?? '#ffd400',
    opacity: opacityOf(dict),
    author: textOf(dict, 'T'),
    contents: textOf(dict, 'Contents'),
    createdAt: parsePdfDate(textOf(dict, 'M')),
    editable: true,
  };

  if (MARKUP_TYPES.has(subtype)) {
    const quads = readQuads(dict, rect);
    const type = subtype === 'Highlight' ? 'highlight' : subtype === 'Underline' ? 'underline' : subtype === 'StrikeOut' ? 'strikeout' : 'squiggly';
    return { ...base, type, quads };
  }

  switch (subtype) {
    case 'Text':
      return { ...base, type: 'note', icon: (nameOf(dict, 'Name') as 'Note' | 'Comment' | 'Help' | 'Insert') ?? 'Note', open: boolOf(dict, 'Open') ?? false };
    case 'FreeText': {
      const da = textOf(dict, 'DA') ?? '';
      const sizeMatch = da.match(/\/([A-Za-z0-9]+)\s+([\d.]+)\s+Tf/);
      const colorMatch = da.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/);
      const alignValue = numberOf(dict, 'Q') ?? 0;
      return {
        ...base,
        type: 'freetext',
        text: base.contents ?? '',
        fontSize: sizeMatch ? Number(sizeMatch[2]) : 12,
        fontFamily: sizeMatch ? fontIdFromDaFontName(sizeMatch[1]!) : 'standard:Helvetica',
        align: alignValue === 1 ? 'center' : alignValue === 2 ? 'right' : 'left',
        lineHeight: 1.3,
        bold: false,
        italic: false,
        color: colorMatch ? rgbToHex(Number(colorMatch[1]), Number(colorMatch[2]), Number(colorMatch[3])) : '#000000',
        background: colorOf(dict) ?? null,
        borderColor: colorOf(dict) ?? null,
        borderWidth: numberOf(dict, 'BS') ?? 0,
      };
    }
    case 'Ink': {
      const inkList = arrayOf(dict, 'InkList');
      const paths: { x: number; y: number }[][] = [];
      if (inkList) {
        for (let index = 0; index < inkList.size(); index += 1) {
          const points = numbersOf(inkList.lookupMaybe(index, PDFArray));
          const path: { x: number; y: number }[] = [];
          for (let p = 0; p + 1 < points.length; p += 2) path.push({ x: points[p]!, y: points[p + 1]! });
          if (path.length > 1) paths.push(path);
        }
      }
      return { ...base, type: 'ink', paths, strokeWidth: numberOf(dict, 'BS') ?? 1.5 };
    }
    case 'Square':
    case 'Circle':
    case 'Line': {
      const line = numbersOf(arrayOf(dict, 'L'));
      const start = line.length >= 4 ? { x: line[0]!, y: line[1]! } : undefined;
      const end = line.length >= 4 ? { x: line[2]!, y: line[3]! } : undefined;
      const type = subtype === 'Square' ? 'square' : subtype === 'Circle' ? 'circle' : 'line';
      return {
        ...base,
        type,
        strokeWidth: numberOf(dict, 'BS') ?? 1.5,
        fill: null,
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
      };
    }
    case 'Redact':
      return { ...base, type: 'redact', strokeWidth: 0, fill: '#000000' };
    case 'Link': {
      const action = dictOf(dict.lookup(PDFName.of('A')));
      const uri = action ? textOf(action, 'URI') : undefined;
      return { ...base, type: 'link', ...(uri ? { url: uri } : {}) };
    }
    case 'Stamp':
      return { ...base, type: 'unknown', contents: base.contents ?? nameOf(dict, 'Name') ?? 'Stamp' };
    default:
      return { ...base, type: 'unknown', contents: base.contents ?? subtype };
  }
}

function readQuads(dict: PDFDict, rect: { x: number; y: number; width: number; height: number }) {
  const values = numbersOf(arrayOf(dict, 'QuadPoints'));
  const quads: { x: number; y: number; width: number; height: number }[] = [];
  for (let index = 0; index + 7 < values.length; index += 8) {
    const xs = [values[index]!, values[index + 2]!, values[index + 4]!, values[index + 6]!];
    const ys = [values[index + 1]!, values[index + 3]!, values[index + 5]!, values[index + 7]!];
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    quads.push({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
  }
  return quads.length ? quads : [rect];
}

function fontIdFromDaFontName(name: string): string {
  const map: Record<string, string> = {
    Helv: 'standard:Helvetica',
    HeBo: 'standard:Helvetica-Bold',
    TiRo: 'standard:Times-Roman',
    Cour: 'standard:Courier',
  };
  return map[name] ?? 'standard:Helvetica';
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

export interface WriteContext {
  doc: PDFDocument;
  page: PDFPage;
  pageIndex: number;
}

/** Serialises an annotation model object into a PDF dictionary and attaches it. */
export function writeAnnotation(context: WriteContext, input: AnnotationInput, id?: string): PDFDict {
  const { doc, page } = context;
  const ctx = doc.context;
  const annotationId = id ?? createId();
  const subtype = subtypeFor(input);
  const dict = ctx.obj({}) as PDFDict;

  const set = (key: string, value: PDFObject) => dict.set(PDFName.of(key), value);

  set('Type', PDFName.of('Annot'));
  set('Subtype', PDFName.of(subtype));
  set('Rect', ctx.obj([round(input.rect.x), round(input.rect.y), round(input.rect.x + input.rect.width), round(input.rect.y + input.rect.height)]));
  set('P', page.ref);
  set('F', PDFNumber.of(4)); // print
  set('NM', PDFHexString.fromText(annotationId));
  set('M', PDFString.of(formatPdfDate(new Date())));
  set('T', PDFHexString.fromText(input.author || 'Arena PDF Studio'));
  set('CA', PDFNumber.of(clamp01(input.opacity)));
  if (input.contents) set('Contents', PDFHexString.fromText(input.contents));

  switch (input.type) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly': {
      set('C', ctx.obj(hexToRgb(input.color)));
      set('QuadPoints', ctx.obj(quadsToArray(input.quads.length ? input.quads : [input.rect]).map(round)));
      break;
    }
    case 'note': {
      set('C', ctx.obj(hexToRgb(input.color)));
      set('Name', PDFName.of(input.icon ?? 'Note'));
      set('Open', ctx.obj(Boolean(input.open)));
      break;
    }
    case 'freetext': {
      const [r, g, b] = hexToRgb(input.color);
      set('Contents', PDFHexString.fromText(input.text));
      set('DA', PDFString.of(`/${daFontName(input.fontFamily)} ${input.fontSize} Tf ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`));
      set('Q', PDFNumber.of(input.align === 'center' ? 1 : input.align === 'right' ? 2 : 0));
      set('BS', ctx.obj({ W: input.borderWidth, S: 'S' }));
      set('C', ctx.obj(hexToRgb(input.background ?? '#ffffff')));
      break;
    }
    case 'ink':
    case 'signature': {
      set('C', ctx.obj(hexToRgb(input.color)));
      set('InkList', ctx.obj(input.paths.map((path) => path.flatMap((point) => [round(point.x), round(point.y)]))));
      set('BS', ctx.obj({ W: input.strokeWidth, S: 'S' }));
      break;
    }
    case 'square':
    case 'circle': {
      set('C', ctx.obj(hexToRgb(input.color)));
      set('BS', ctx.obj({ W: input.strokeWidth, S: 'S' }));
      if (input.fill) set('IC', ctx.obj(hexToRgb(input.fill)));
      break;
    }
    case 'line':
    case 'arrow': {
      const start = input.start ?? { x: input.rect.x, y: input.rect.y };
      const end = input.end ?? { x: input.rect.x + input.rect.width, y: input.rect.y + input.rect.height };
      set('C', ctx.obj(hexToRgb(input.color)));
      set('L', ctx.obj([round(start.x), round(start.y), round(end.x), round(end.y)]));
      set('BS', ctx.obj({ W: input.strokeWidth, S: 'S' }));
      if (input.type === 'arrow') {
        const head = ctx.obj({ S: 'ClosedArrow' });
        set('LE', ctx.obj([head, 'None']));
      }
      break;
    }
    case 'redact': {
      set('C', ctx.obj([0, 0, 0]));
      set('IC', ctx.obj([0, 0, 0]));
      set('BS', ctx.obj({ W: 0, S: 'S' }));
      break;
    }
    case 'link': {
      set('Border', ctx.obj([0, 0, 1]));
      if (input.url) {
        set('A', ctx.obj({ S: 'URI', URI: PDFString.of(input.url) }));
      } else if (input.targetPageIndex !== undefined && input.targetPageIndex < doc.getPageCount()) {
        const target = doc.getPage(input.targetPageIndex).ref;
        set('Dest', ctx.obj([target, 'XYZ', null, null, null]));
      }
      break;
    }
    case 'stamp': {
      set('C', ctx.obj(hexToRgb(input.color)));
      set('Name', PDFName.of('Draft'));
      break;
    }
    default:
      break;
  }

  const ref = ctx.register(dict);
  page.node.addAnnot(ref);
  return dict;
}

function subtypeFor(input: AnnotationInput): string {
  switch (input.type) {
    case 'highlight':
      return 'Highlight';
    case 'underline':
      return 'Underline';
    case 'strikeout':
      return 'StrikeOut';
    case 'squiggly':
      return 'Squiggly';
    case 'note':
      return 'Text';
    case 'freetext':
      return 'FreeText';
    case 'ink':
    case 'signature':
      return 'Ink';
    case 'square':
      return 'Square';
    case 'circle':
      return 'Circle';
    case 'line':
    case 'arrow':
      return 'Line';
    case 'redact':
      return 'Redact';
    case 'link':
      return 'Link';
    case 'stamp':
      return 'Stamp';
    default:
      return 'Text';
  }
}

function daFontName(fontId: string): string {
  if (fontId.includes('Bold')) return 'HeBo';
  if (fontId.includes('Times')) return 'TiRo';
  if (fontId.includes('Courier')) return 'Cour';
  return 'Helv';
}

function quadsToArray(quads: { x: number; y: number; width: number; height: number }[]): number[] {
  const values: number[] = [];
  for (const quad of quads) {
    const left = quad.x;
    const right = quad.x + quad.width;
    const bottom = quad.y;
    const top = quad.y + quad.height;
    // PDF quad order: upper-left, upper-right, lower-left, lower-right.
    values.push(left, top, right, top, left, bottom, right, bottom);
  }
  return values;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
}

export function createId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `a${Date.now().toString(36)}${random}`;
}

/** Removes an annotation by id from every page; returns the number removed. */
export function removeAnnotationById(doc: PDFDocument, id: string): number {
  let removed = 0;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let index = annots.size() - 1; index >= 0; index -= 1) {
      const dict = annots.lookupMaybe(index, PDFDict);
      if (!dict) continue;
      const raw = annots.get(index);
      const ref = raw && 'objectNumber' in raw ? (raw as PDFRef) : null;
      if (annotationId(dict, ref) === id) {
        annots.remove(index);
        removed += 1;
      }
    }
  }
  return removed;
}

/** Appends a raster image to the page content (stamps, visible signatures). */
export async function addContentImage(
  doc: PDFDocument,
  pageIndex: number,
  rect: { x: number; y: number; width: number; height: number },
  bytes: Uint8Array,
  opacity = 1,
): Promise<void> {
  const page = doc.getPage(pageIndex);
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const image = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  page.drawImage(image, { x: rect.x, y: rect.y, width: rect.width, height: rect.height, opacity });
}

/** Draws text into the page content with an embedded font (flatten path). */
export function drawTextContent(
  page: PDFPage,
  text: string,
  options: { x: number; y: number; size: number; color: string; font: PDFFont },
  opacity = 1,
): void {
  const [r, g, b] = hexToRgb(options.color);
  page.drawText(text, {
    x: options.x,
    y: options.y,
    size: options.size,
    font: options.font,
    color: rgb(r, g, b),
    opacity,
  });
}
