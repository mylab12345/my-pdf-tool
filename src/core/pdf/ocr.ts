import { degrees, rgb } from '@cantoo/pdf-lib';
import type { OcrOptions, OcrPageResult, OcrResult, OcrWord } from '../../shared/types';
import { appError } from '../errors';
import type { PdfRenderer } from '../raster/renderer';
import type { FontManager } from './fonts';
import { loadPdf, savePdf } from './loader';

export interface OcrWordBox {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

interface OcrLine {
  words?: OcrWordBox[];
}
interface OcrParagraph {
  lines?: OcrLine[];
}
interface OcrBlock {
  paragraphs?: OcrParagraph[];
}

export interface OcrRecognizeResult {
  data: {
    text: string;
    confidence: number;
    blocks?: OcrBlock[];
    /** Some tesseract.js versions expose words directly. */
    words?: OcrWordBox[];
  };
}

/** The subset of a tesseract.js worker the engine relies on. */
export interface TesseractWorkerLike {
  recognize(
    image: Uint8Array,
    options?: Record<string, unknown>,
    output?: { blocks?: boolean; text?: boolean; hocr?: boolean; tsv?: boolean },
  ): Promise<OcrRecognizeResult>;
  terminate(): Promise<unknown>;
  setParameters?(params: Record<string, unknown>): Promise<unknown>;
}

/** Flattens the nested block/paragraph/line structure into a word list. */
export function extractWords(data: OcrRecognizeResult['data']): OcrWordBox[] {
  if (Array.isArray(data.words) && data.words.length) return data.words;
  const words: OcrWordBox[] = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          if (word.text?.trim()) words.push(word);
        }
      }
    }
  }
  return words;
}

export interface OcrDependencies {
  renderer: PdfRenderer;
  fonts: FontManager;
  /** Creates a worker for the given tesseract language string (e.g. "eng+deu"). */
  createWorker: (languages: string[], onProgress?: (percent: number, status: string) => void) => Promise<TesseractWorkerLike>;
}

export interface OcrHooks {
  onProgress?: (completed: number, total: number, label: string) => void;
  shouldCancel?: () => boolean;
}

const LANGUAGE_NAMES: Record<string, string> = {
  eng: 'English',
  deu: 'German',
  fra: 'French',
  spa: 'Spanish',
  ita: 'Italian',
  por: 'Portuguese',
  nld: 'Dutch',
  rus: 'Russian',
  ara: 'Arabic',
  hin: 'Hindi',
  mar: 'Marathi',
  tam: 'Tamil',
  tel: 'Telugu',
  ben: 'Bengali',
  guj: 'Gujarati',
  kan: 'Kannada',
  mal: 'Malayalam',
  pan: 'Punjabi',
  urd: 'Urdu',
  chi_sim: 'Chinese (simplified)',
  chi_tra: 'Chinese (traditional)',
  jpn: 'Japanese',
  kor: 'Korean',
  tur: 'Turkish',
  pol: 'Polish',
  ukr: 'Ukrainian',
  vie: 'Vietnamese',
  swe: 'Swedish',
  dan: 'Danish',
  nor: 'Norwegian',
  fin: 'Finnish',
  ces: 'Czech',
  ell: 'Greek',
  heb: 'Hebrew',
  tha: 'Thai',
  ind: 'Indonesian',
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

/**
 * Runs OCR over the selected pages and, optionally, writes an invisible text
 * layer so the resulting PDF is searchable.
 *
 * Everything is local: the tesseract worker, the WASM core and the traineddata
 * files ship with the application.
 */
export async function ocrDocument(
  bytes: Uint8Array,
  options: OcrOptions,
  deps: OcrDependencies,
  hooks: OcrHooks = {},
): Promise<OcrResult> {
  const started = Date.now();
  const languages = options.languages.length ? options.languages : ['eng'];
  const snapshot = await deps.renderer.inspect(bytes);
  const pageIndices = (options.pages ?? snapshot.pages.map((_, index) => index)).filter(
    (index) => index >= 0 && index < snapshot.numPages,
  );
  if (!pageIndices.length) throw appError('INVALID_INPUT', 'Select at least one page for OCR.');

  const dpi = Math.max(72, Math.min(600, options.dpi || 300));
  hooks.onProgress?.(0, pageIndices.length, 'Starting OCR engine');
  const worker = await deps.createWorker(languages, (percent, status) => {
    hooks.onProgress?.(0, pageIndices.length, `Loading ${languages.join('+')} (${status} ${Math.round(percent)}%)`);
  });

  const results: OcrPageResult[] = [];
  try {
    for (const [position, pageIndex] of pageIndices.entries()) {
      if (hooks.shouldCancel?.()) break;
      hooks.onProgress?.(position, pageIndices.length, `Recognising page ${pageIndex + 1}`);
      const image = await deps.renderer.renderPage(bytes, pageIndex, { dpi, format: 'png' });
      const { data } = await worker.recognize(image.data, {}, { blocks: true, text: true });
      const words: OcrWord[] = extractWords(data)
        .filter((word) => word.text.trim().length > 0)
        .map((word) => ({
          text: word.text,
          confidence: word.confidence,
          bbox: word.bbox,
        }));
      results.push({
        pageIndex,
        text: data.text.trim(),
        confidence: data.confidence,
        words,
        width: image.width,
        height: image.height,
      });
      hooks.onProgress?.(position + 1, pageIndices.length, `Page ${pageIndex + 1} recognised`);
    }
  } finally {
    await worker.terminate().catch(() => undefined);
  }

  const text = results
    .map((page) => `--- Page ${page.pageIndex + 1} ---\n${page.text}`)
    .join('\n\n');

  let searchable: Uint8Array | undefined;
  if (options.searchablePdf && results.length) {
    hooks.onProgress?.(pageIndices.length, pageIndices.length, 'Writing searchable text layer');
    searchable = await buildSearchablePdf(bytes, results, dpi, deps);
  }

  return {
    pages: results,
    text,
    ...(searchable ? { bytes: searchable } : {}),
    languages,
    durationMs: Date.now() - started,
  };
}

/**
 * Adds an invisible (fully transparent) text layer aligned with the recognised
 * words, so search, selection and copy work on scanned documents.
 *
 * Coordinates are mapped from rendered-image pixels back to PDF user space with
 * pdf.js's viewport transform, which keeps the layer aligned on rotated pages.
 */
export async function buildSearchablePdf(
  bytes: Uint8Array,
  pages: OcrPageResult[],
  dpi: number,
  deps: Pick<OcrDependencies, 'renderer' | 'fonts'>,
): Promise<Uint8Array> {
  const snapshot = await deps.renderer.inspect(bytes);
  const scale = 72 / dpi;

  interface Item {
    text: string;
    x: number;
    y: number;
    size: number;
  }
  const layer = new Map<number, Item[]>();

  for (const page of pages) {
    const candidates = page.words.filter((word) => word.text.trim().length > 0);
    if (!candidates.length) continue;
    const corners = await deps.renderer.imageToPdfPoints(
      bytes,
      page.pageIndex,
      dpi,
      candidates.map((word) => ({ x: word.bbox.x0, y: word.bbox.y1 })),
    );
    const items: Item[] = [];
    for (const [index, word] of candidates.entries()) {
      const corner = corners[index];
      if (!corner) continue;
      const boxHeight = (word.bbox.y1 - word.bbox.y0) * scale;
      const boxWidth = (word.bbox.x1 - word.bbox.x0) * scale;
      if (boxWidth <= 0 || boxHeight <= 0) continue;
      items.push({ text: word.text, x: corner.x, y: corner.y, size: Math.max(1, boxHeight * 0.86) });
    }
    layer.set(page.pageIndex, items);
  }

  const doc = await loadPdf(bytes);
  for (const [pageIndex, items] of layer) {
    if (pageIndex >= doc.getPageCount()) continue;
    const page = doc.getPage(pageIndex);
    const rotation = snapshot.pages[pageIndex]?.rotation ?? 0;
    for (const item of items) {
      const embedded = await deps.fonts.embedForText(doc, 'standard:Helvetica', item.text);
      page.drawText(item.text, {
        x: item.x,
        y: item.y,
        size: item.size,
        font: embedded.font,
        color: rgb(0, 0, 0),
        opacity: 0,
        rotate: degrees(rotation),
      });
    }
  }
  return savePdf(doc);
}

/** Lists languages that are usable offline (installed traineddata files). */
export function availableLanguages(installed: string[]): { code: string; name: string; installed: boolean }[] {
  const codes = new Set([...installed, 'eng']);
  return [...codes]
    .sort()
    .map((code) => ({ code, name: languageName(code), installed: installed.includes(code) }));
}
