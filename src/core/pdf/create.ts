import { PDFDocument, type PDFPage, rgb } from '@cantoo/pdf-lib';
import { resolvePageSize } from '../../shared/constants';
import type { ImageDocumentOptions, PageOrientation, PageSizeName, TextDocumentOptions } from '../../shared/types';
import { appError } from '../errors';
import type { FontManager } from './fonts';
import { savePdf } from './loader';
import { measureWidth } from './text-layout';

export interface CreateBlankOptions {
  pageSize: PageSizeName;
  orientation: PageOrientation;
  count?: number;
  customSize?: { width: number; height: number };
}

/** Creates an empty document with the requested page setup. */
export async function createBlankDocument(options: CreateBlankOptions): Promise<Uint8Array> {
  const count = Math.max(1, Math.min(options.count ?? 1, 5000));
  const size = options.customSize ?? resolvePageSize(options.pageSize, options.orientation);
  const doc = await PDFDocument.create();
  for (let index = 0; index < count; index += 1) doc.addPage([size.width, size.height]);
  doc.setProducer('Arena PDF Studio');
  doc.setCreator('Arena PDF Studio');
  return savePdf(doc);
}

/* -------------------------------------------------------------------------- */
/* Markdown / plain text                                                       */
/* -------------------------------------------------------------------------- */

interface InlineRun {
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
}

type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; runs: InlineRun[] }
  | { kind: 'paragraph'; runs: InlineRun[] }
  | { kind: 'bullet'; runs: InlineRun[]; depth: number; ordered?: number }
  | { kind: 'quote'; runs: InlineRun[] }
  | { kind: 'code'; text: string }
  | { kind: 'rule' };

/** Minimal, dependency-free Markdown block parser (headings, lists, quotes, rules, code). */
export function parseMarkdownBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  let inCode = false;
  let codeLines: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ kind: 'paragraph', runs: parseInline(paragraph.join(' ')) });
      paragraph = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '  ');
    if (/^\s*```/.test(line)) {
      if (inCode) {
        blocks.push({ kind: 'code', text: codeLines.join('\n') });
        codeLines = [];
        inCode = false;
      } else {
        flushParagraph();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(rawLine);
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushParagraph();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = Math.min(6, heading[1]!.length) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ kind: 'heading', level, runs: parseInline(heading[2]!.trim()) });
      continue;
    }
    if (/^\s{0,3}([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flushParagraph();
      blocks.push({ kind: 'rule' });
      continue;
    }
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      blocks.push({ kind: 'bullet', depth: Math.floor(bullet[1]!.length / 2), runs: parseInline(bullet[2]!.trim()) });
      continue;
    }
    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ordered) {
      flushParagraph();
      blocks.push({
        kind: 'bullet',
        depth: Math.floor(ordered[1]!.length / 2),
        ordered: Number(ordered[2]),
        runs: parseInline(ordered[3]!.trim()),
      });
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      blocks.push({ kind: 'quote', runs: parseInline(quote[1]!.trim()) });
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  if (codeLines.length) blocks.push({ kind: 'code', text: codeLines.join('\n') });
  return blocks;
}

/** Parses `**bold**`, `*italic*` and `` `code` `` markers into runs. */
export function parseInline(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`)/g;
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) runs.push({ text: text.slice(lastIndex, index), bold: false, italic: false, code: false });
    const token = match[0];
    if (token.startsWith('**') || token.startsWith('__')) {
      runs.push({ text: token.slice(2, -2), bold: true, italic: false, code: false });
    } else if (token.startsWith('`')) {
      runs.push({ text: token.slice(1, -1), bold: false, italic: false, code: true });
    } else {
      runs.push({ text: token.slice(1, -1), bold: false, italic: true, code: false });
    }
    lastIndex = index + token.length;
  }
  if (lastIndex < text.length) runs.push({ text: text.slice(lastIndex), bold: false, italic: false, code: false });
  return runs.length ? runs : [{ text, bold: false, italic: false, code: false }];
}

interface TextContext {
  doc: PDFDocument;
  fonts: FontManager;
  page: { width: number; height: number };
  margin: number;
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  pages: PDFPage[];
  cursorY: number;
  color: [number, number, number];
  title?: string;
  footer?: string;
}

/** Creates a PDF from plain text or Markdown. */
export async function createTextDocument(options: TextDocumentOptions, fonts: FontManager): Promise<Uint8Array> {
  const pageSize = resolvePageSize(options.pageSize, options.orientation);
  const doc = await PDFDocument.create();
  doc.setTitle(options.title || 'Untitled document');
  doc.setCreator('Arena PDF Studio');
  doc.setProducer('Arena PDF Studio');
  doc.setCreationDate(new Date());

  const context: TextContext = {
    doc,
    fonts,
    page: pageSize,
    margin: Math.max(18, options.margin),
    fontSize: Math.max(6, options.fontSize),
    lineHeight: Math.max(1, options.lineHeight),
    fontFamily: options.fontFamily,
    pages: [],
    cursorY: 0,
    color: [0.1, 0.1, 0.12],
    title: options.title,
  };
  context.pages.push(doc.addPage([pageSize.width, pageSize.height]));
  context.cursorY = pageSize.height - context.margin;

  for (const block of parseMarkdownBlocks(options.text)) {
    await renderBlock(context, block);
  }

  if (options.footer) {
    const font = await fonts.embed(doc, context.fontFamily);
    context.pages.forEach((page, index) => {
      page.drawText(`${options.footer} — ${index + 1}/${context.pages.length}`, {
        x: context.margin,
        y: context.margin / 2,
        size: Math.max(7, context.fontSize * 0.75),
        font,
        color: rgb(0.45, 0.47, 0.55),
      });
    });
  }

  return savePdf(doc);
}

function ensureSpace(context: TextContext, needed: number): PDFPage {
  const current = context.pages[context.pages.length - 1]!;
  if (context.cursorY - needed < context.margin) {
    const page = context.doc.addPage([context.page.width, context.page.height]);
    context.pages.push(page);
    context.cursorY = context.page.height - context.margin;
    return page;
  }
  return current;
}

interface DrawRunsOptions {
  x: number;
  maxWidth: number;
  fontSize: number;
  lineHeight: number;
  color: [number, number, number];
  indent?: number;
}

/** Draws inline runs with word wrapping, switching fonts for bold/italic spans. */
async function drawRuns(context: TextContext, runs: InlineRun[], options: DrawRunsOptions): Promise<void> {
  const { fontSize, color } = options;
  const indent = options.indent ?? 0;
  const maxWidth = options.maxWidth - indent;

  interface Buffer {
    text: string;
    bold: boolean;
    italic: boolean;
    code: boolean;
    width: number;
  }
  let line: Buffer[] = [];
  let lineWidth = 0;

  const fontFor = async (bold: boolean, italic: boolean, code: boolean, text: string) => {
    const family = code ? 'standard:Courier' : context.fontFamily;
    const result = await context.fonts.embedForText(context.doc, family, text, { bold, italic });
    return result.font;
  };

  const flush = async (baseline: number) => {
    let x = options.x + indent;
    for (const chunk of line) {
      if (chunk.text.trim() !== '') {
        const font = await fontFor(chunk.bold, chunk.italic, chunk.code, chunk.text);
        context.pages[context.pages.length - 1]!.drawText(chunk.text, {
          x,
          y: baseline,
          size: fontSize,
          font,
          color: rgb(color[0], color[1], color[2]),
        });
      }
      x += chunk.width;
    }
    line = [];
    lineWidth = 0;
  };

  ensureSpace(context, fontSize * options.lineHeight);

  for (const run of runs) {
    const words = run.text.split(/(\s+)/).filter((word) => word.length > 0);
    for (const word of words) {
      const font = await fontFor(run.bold, run.italic, run.code, word);
      const wordWidth = measureWidth(word, font, fontSize);
      if (lineWidth + wordWidth > maxWidth && lineWidth > 0) {
        await flush(context.cursorY);
        context.cursorY -= fontSize * options.lineHeight;
        ensureSpace(context, fontSize * options.lineHeight);
        if (/^\s+$/.test(word)) continue;
      }
      const previous = line[line.length - 1];
      if (previous && previous.bold === run.bold && previous.italic === run.italic && previous.code === run.code) {
        previous.text += word;
        previous.width += wordWidth;
      } else {
        line.push({ text: word, bold: run.bold, italic: run.italic, code: run.code, width: wordWidth });
      }
      lineWidth += wordWidth;
    }
  }
  if (line.length) {
    await flush(context.cursorY);
    context.cursorY -= fontSize * options.lineHeight;
  }
}

async function renderBlock(context: TextContext, block: Block): Promise<void> {
  const contentWidth = context.page.width - context.margin * 2;
  switch (block.kind) {
    case 'heading': {
      const multipliers = [1.9, 1.6, 1.35, 1.2, 1.1, 1.05];
      const fontSize = context.fontSize * multipliers[block.level - 1]!;
      context.cursorY -= fontSize * 0.4;
      await drawRuns(context, block.runs.map((run) => ({ ...run, bold: true })), {
        x: context.margin,
        maxWidth: contentWidth,
        fontSize,
        lineHeight: 1.25,
        color: [0.05, 0.05, 0.08],
      });
      context.cursorY -= fontSize * 0.2;
      break;
    }
    case 'paragraph': {
      await drawRuns(context, block.runs, {
        x: context.margin,
        maxWidth: contentWidth,
        fontSize: context.fontSize,
        lineHeight: context.lineHeight,
        color: context.color,
      });
      context.cursorY -= context.fontSize * 0.45;
      break;
    }
    case 'bullet': {
      const indent = 18 + block.depth * 18;
      const marker = block.ordered !== undefined ? `${block.ordered}.` : '•';
      const markerFont = await context.fonts.embed(context.doc, context.fontFamily);
      ensureSpace(context, context.fontSize * context.lineHeight);
      context.pages[context.pages.length - 1]!.drawText(marker, {
        x: context.margin + indent - 14,
        y: context.cursorY,
        size: context.fontSize,
        font: markerFont,
        color: rgb(context.color[0], context.color[1], context.color[2]),
      });
      await drawRuns(context, block.runs, {
        x: context.margin,
        maxWidth: contentWidth,
        fontSize: context.fontSize,
        lineHeight: context.lineHeight,
        color: context.color,
        indent,
      });
      context.cursorY -= context.fontSize * 0.15;
      break;
    }
    case 'quote': {
      const startY = context.cursorY;
      await drawRuns(context, block.runs, {
        x: context.margin,
        maxWidth: contentWidth,
        fontSize: context.fontSize,
        lineHeight: context.lineHeight,
        color: [0.35, 0.38, 0.45],
        indent: 16,
      });
      const height = Math.max(context.fontSize * 1.4, startY - context.cursorY);
      context.pages[context.pages.length - 1]!.drawRectangle({
        x: context.margin + 4,
        y: startY - height + context.fontSize * 0.2,
        width: 2,
        height,
        color: rgb(0.6, 0.63, 0.7),
      });
      break;
    }
    case 'code': {
      const font = await context.fonts.embed(context.doc, 'standard:Courier');
      for (const line of block.text.split('\n')) {
        ensureSpace(context, context.fontSize * 1.35);
        context.pages[context.pages.length - 1]!.drawText(line || ' ', {
          x: context.margin + 12,
          y: context.cursorY,
          size: context.fontSize * 0.92,
          font,
          color: rgb(0.15, 0.17, 0.22),
        });
        context.cursorY -= context.fontSize * 1.35;
      }
      context.cursorY -= context.fontSize * 0.5;
      break;
    }
    case 'rule': {
      ensureSpace(context, 16);
      context.pages[context.pages.length - 1]!.drawLine({
        start: { x: context.margin, y: context.cursorY + 6 },
        end: { x: context.page.width - context.margin, y: context.cursorY + 6 },
        thickness: 0.75,
        color: rgb(0.8, 0.82, 0.86),
      });
      context.cursorY -= context.fontSize;
      break;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Images                                                                      */
/* -------------------------------------------------------------------------- */

export interface ImageInput {
  name: string;
  bytes: Uint8Array;
}

/** Creates a PDF from images, either one image per page or several per page. */
export async function createImageDocument(
  options: ImageDocumentOptions,
  images: ImageInput[],
): Promise<Uint8Array> {
  if (!images.length) throw appError('INVALID_INPUT', 'Select at least one image.');
  const doc = await PDFDocument.create();
  doc.setCreator('Arena PDF Studio');
  doc.setProducer('Arena PDF Studio');
  const margin = Math.max(0, options.margin);

  for (const image of images) {
    const embedded = await embedImage(doc, image.bytes, image.name);
    if (options.pageSize === 'FitImage') {
      const page = doc.addPage([embedded.width + margin * 2, embedded.height + margin * 2]);
      page.drawImage(embedded.image, { x: margin, y: margin, width: embedded.width, height: embedded.height });
      continue;
    }
    const size = resolvePageSize(options.pageSize, options.orientation);
    const reusePage = !options.onePerPage && doc.getPageCount() > 0;
    const page = reusePage ? doc.getPages()[doc.getPageCount() - 1]! : doc.addPage([size.width, size.height]);
    const scale = Math.min(
      (size.width - margin * 2) / embedded.width,
      (size.height - margin * 2) / embedded.height,
    );
    const width = embedded.width * scale;
    const height = embedded.height * scale;
    page.drawImage(embedded.image, { x: (size.width - width) / 2, y: (size.height - height) / 2, width, height });
  }
  return savePdf(doc);
}

/** Embeds a PNG or JPEG stored as bytes, validating the magic number. */
export async function embedImage(doc: PDFDocument, bytes: Uint8Array, name = 'image') {
  if (bytes.length < 12) throw appError('INVALID_INPUT', `The image "${name}" is empty or unreadable.`);
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (isPng) {
    const image = await doc.embedPng(bytes);
    return { image, width: image.width, height: image.height };
  }
  if (isJpeg) {
    const image = await doc.embedJpg(bytes);
    return { image, width: image.width, height: image.height };
  }
  throw appError('INVALID_INPUT', `"${name}" is not a PNG or JPEG image.`, {
    hint: 'Supported image formats are PNG and JPEG.',
  });
}
