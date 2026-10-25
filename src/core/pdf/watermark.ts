import { degrees, rgb, type PDFDocument, type PDFPage } from '@cantoo/pdf-lib';
import { hexToRgb } from '../../shared/format';
import type { HeaderFooterOptions, WatermarkOptions } from '../../shared/types';
import { appError } from '../errors';
import { embedImage } from './create';
import type { FontManager } from './fonts';
import { measureWidth } from './text-layout';

function targetPages(doc: PDFDocument, pages?: number[] | null): PDFPage[] {
  const all = doc.getPages();
  if (!pages || pages.length === 0) return all;
  const set = new Set(pages);
  return all.filter((_, index) => set.has(index));
}

/** Adds a text or image watermark to the selected pages. */
export async function addWatermark(doc: PDFDocument, options: WatermarkOptions, fonts: FontManager): Promise<number> {
  const pages = targetPages(doc, options.pages);
  if (!pages.length) throw appError('INVALID_INPUT', 'Select at least one page.');

  if (options.image) {
    const bytes = decodeImage(options.image);
    const embedded = await embedImage(doc, bytes, 'watermark');
    for (const page of pages) {
      const { width, height } = page.getSize();
      const targetWidth = width * Math.max(0.1, Math.min(1, options.scale)) * 0.6;
      const targetHeight = (embedded.height / embedded.width) * targetWidth;
      page.drawImage(embedded.image, {
        x: width * options.x - targetWidth / 2,
        y: height * options.y - targetHeight / 2,
        width: targetWidth,
        height: targetHeight,
        opacity: options.opacity,
        rotate: degrees(options.rotation),
      });
    }
    return pages.length;
  }

  const text = (options.text ?? '').trim();
  if (!text) throw appError('INVALID_INPUT', 'Enter watermark text or choose an image.');
  const font = await fonts.embedForText(doc, options.fontFamily || 'standard:Helvetica', text);
  const [r, g, b] = hexToRgb(options.color);
  const size = Math.max(6, options.fontSize);

  for (const page of pages) {
    const { width, height } = page.getSize();
    if (options.tile) {
      const textWidth = Math.max(1, measureWidth(text, font.font, size));
      const stepX = textWidth + size * 3;
      const stepY = size * 6;
      for (let y = -height; y < height * 2; y += stepY) {
        for (let x = -width; x < width * 2; x += stepX) {
          page.drawText(text, {
            x,
            y,
            size,
            font: font.font,
            color: rgb(r, g, b),
            opacity: options.opacity,
            rotate: degrees(options.rotation),
          });
        }
      }
    } else {
      const textWidth = measureWidth(text, font.font, size);
      page.drawText(text, {
        x: width * options.x - textWidth / 2,
        y: height * options.y - size / 2,
        size,
        font: font.font,
        color: rgb(r, g, b),
        opacity: options.opacity,
        rotate: degrees(options.rotation),
      });
    }
  }
  return pages.length;
}

/** Token substitution shared by header/footer and page numbering. */
export function formatTokens(
  template: string,
  values: { page: number; pages: number; firstPage?: number; date?: Date; title?: string },
): string {
  const date = values.date ?? new Date();
  return template
    .replace(/\{page\}/gi, String(values.page))
    .replace(/\{pages\}/gi, String(values.pages))
    .replace(/\{date\}/gi, date.toISOString().slice(0, 10))
    .replace(/\{time\}/gi, date.toISOString().slice(11, 19))
    .replace(/\{title\}/gi, values.title ?? '')
    .replace(/\{filename\}/gi, values.title ?? '');
}

/** Converts a number to lower-case roman numerals (page numbering styles). */
export function toRoman(value: number): string {
  if (value <= 0) return String(value);
  const table: [number, string][] = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ];
  let remaining = value;
  let out = '';
  for (const [amount, symbol] of table) {
    while (remaining >= amount) {
      remaining -= amount;
      out += symbol;
    }
  }
  return out;
}

/** Formats a page number using `{page}`, `{pages}` tokens or roman numerals. */
export function formatPageNumber(format: string, page: number, pages: number, style: 'arabic' | 'roman' | 'letters' = 'arabic'): string {
  if (style === 'roman') return toRoman(page);
  if (style === 'letters') return String.fromCharCode(96 + Math.min(26, Math.max(1, page))).toUpperCase();
  return formatTokens(format || '{page}', { page, pages });
}

/** Adds headers/footers (and page numbers) to the selected pages. */
export async function addHeaderFooter(doc: PDFDocument, options: HeaderFooterOptions, fonts: FontManager): Promise<number> {
  const pages = targetPages(doc, options.pages);
  if (!pages.length) return 0;
  const size = Math.max(5, options.fontSize);
  const [r, g, b] = hexToRgb(options.color);
  const style = /roman/i.test(options.pageNumberFormat)
    ? 'roman'
    : /letter|alpha/i.test(options.pageNumberFormat)
      ? 'letters'
      : 'arabic';
  const title = doc.getTitle();
  const margin = Math.max(6, options.margin);

  interface Slot {
    page: PDFPage;
    text: string;
    align: 'left' | 'center' | 'right';
    y: number;
    width: number;
  }
  const slots: Slot[] = [];

  pages.forEach((page, index) => {
    if (!options.includeOnFirstPage && index === 0) return;
    const pageNumber = options.firstPageNumber + index;
    const values = {
      page: pageNumber,
      pages: pages.length + options.firstPageNumber - 1,
      ...(title ? { title } : {}),
    };
    const { width, height } = page.getSize();
    const top = height - margin - size;
    const bottom = margin;
    const totalPages = values.pages;

    const push = (template: string | undefined, align: 'left' | 'center' | 'right', y: number) => {
      if (!template || !template.trim()) return;
      const text = formatTokens(template, values);
      if (!text.trim()) return;
      slots.push({ page, text, align, y, width });
    };
    push(options.headerLeft, 'left', top);
    push(options.headerCenter, 'center', top);
    push(options.headerRight, 'right', top);
    push(options.footerLeft, 'left', bottom);
    push(options.footerCenter, 'center', bottom);
    push(options.footerRight, 'right', bottom);

    const wantsPageNumber = /\{page\}|\{pages\}/i.test(options.pageNumberFormat) || style !== 'arabic';
    if (wantsPageNumber) {
      const format = /\{page\}|\{pages\}/i.test(options.pageNumberFormat) ? options.pageNumberFormat : '{page}';
      const text = formatPageNumber(format, values.page, totalPages, style);
      slots.push({ page, text, align: 'right', y: bottom, width });
    }
  });

  for (const slot of slots) {
    const font = await fonts.embedForText(doc, 'standard:Helvetica', slot.text);
    const textWidth = measureWidth(slot.text, font.font, size);
    let x = margin;
    if (slot.align === 'center') x = (slot.width - textWidth) / 2;
    if (slot.align === 'right') x = slot.width - margin - textWidth;
    slot.page.drawText(slot.text, {
      x: Math.max(2, x),
      y: slot.y,
      size,
      font: font.font,
      color: rgb(r, g, b),
    });
  }

  return new Set(slots.map((slot) => slot.page)).size;
}

function decodeImage(dataUrl: string): Uint8Array {
  const match = dataUrl.match(/^data:[^,]*,([\s\S]*)$/);
  if (!match) throw appError('INVALID_INPUT', 'The watermark image could not be read.');
  const isBase64 = dataUrl.includes(';base64,');
  if (isBase64) {
    const binary = atobSafe(match[1] ?? '');
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  const decoded = decodeURIComponent(match[1] ?? '');
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

function atobSafe(value: string): string {
  if (typeof atob === 'function') return atob(value);
  // Minimal base64 decoder for Node environments.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const char of value.replace(/[^A-Za-z0-9+/]/g, '')) {
    buffer = (buffer << 6) | alphabet.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return output;
}
