import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';
import { FontManager, type FontAsset } from '../../src/core/pdf/fonts';
import { savePdf } from '../../src/core/pdf/loader';
import { PdfRenderer } from '../../src/core/raster/renderer';
import { createNodeRendererDependencies } from '../../src/main/pdf/node-pdfjs';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
export const resourcesDir = path.join(repoRoot, 'resources');

/** Font manager wired to the bundled fonts (or standard fonts when absent). */
export function createFontManager(systemFonts: FontAsset[] = []): FontManager {
  return new FontManager(
    async (asset) => {
      if (!asset.bundledFile) return null;
      const file = path.join(resourcesDir, 'fonts', asset.bundledFile);
      if (!existsSync(file)) return null;
      return new Uint8Array(readFileSync(file));
    },
    systemFonts,
  );
}

let sharedRenderer: PdfRenderer | null = null;

/** Shared pdf.js renderer for the Node test environment. */
export function renderer(): PdfRenderer {
  sharedRenderer ??= new PdfRenderer(createNodeRendererDependencies());
  return sharedRenderer;
}

export interface FixtureOptions {
  pages?: number;
  text?: string;
  size?: [number, number];
}

/** Builds a simple PDF fixture with text on every page. */
export async function makePdf(options: FixtureOptions = {}): Promise<Uint8Array> {
  const pageCount = options.pages ?? 1;
  const size = options.size ?? [595.28, 841.89];
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pageCount; index += 1) {
    const page = doc.addPage(size);
    const label = options.text ?? `Page ${index + 1} of ${pageCount}`;
    page.drawText(label, { x: 50, y: size[1] - 80, size: 18, font, color: rgb(0, 0, 0) });
    page.drawText(`Body text for page ${index + 1}. The quick brown fox jumps over the lazy dog.`, {
      x: 50,
      y: size[1] - 120,
      size: 11,
      font,
      color: rgb(0.2, 0.2, 0.2),
    });
  }
  return savePdf(doc);
}

/** Text of every page, via pdf.js (independent of pdf-lib). */
export async function extractText(bytes: Uint8Array): Promise<string[]> {
  const pages = await renderer().text(bytes);
  return pages.map((page) => page.text);
}

export function pngFromCanvas(width: number, height: number, draw: (context: any) => void): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createCanvas } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  draw(context);
  return new Uint8Array(canvas.toBuffer('image/png'));
}

export function pngBytes(width: number, height: number, color = '#3366ff'): Uint8Array {
  return pngFromCanvas(width, height, (context) => {
    context.fillStyle = color;
    context.fillRect(4, 4, width - 8, height - 8);
  });
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
}
