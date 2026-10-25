import { PDFDocument } from '@cantoo/pdf-lib';
import { appError, normalizeError } from '../errors';

export interface LoadPdfOptions {
  password?: string;
  /** Avoid pdf-lib rewriting dates on load (needed for byte-stable operations). */
  updateMetadata?: boolean;
  /** Allow opening documents with broken cross reference tables. */
  throwOnInvalidObject?: boolean;
}

export interface SavePdfOptions {
  useObjectStreams?: boolean;
  addDefaultPage?: boolean;
}

/**
 * Loads a PDF document from bytes, mapping library errors onto the application's
 * error vocabulary so the UI can prompt for a password or offer repair.
 */
export async function loadPdf(bytes: Uint8Array, options: LoadPdfOptions = {}): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, {
      updateMetadata: options.updateMetadata ?? false,
      throwOnInvalidObject: options.throwOnInvalidObject ?? false,
      ...(options.password !== undefined ? { password: options.password } : {}),
    });
  } catch (error) {
    throw normalizeError(error);
  }
}

/** Serialises a document. Object streams keep output compact (PDF 1.5+). */
export async function savePdf(doc: PDFDocument, options: SavePdfOptions = {}): Promise<Uint8Array> {
  try {
    const bytes = await doc.save({
      useObjectStreams: options.useObjectStreams ?? true,
      addDefaultPage: options.addDefaultPage ?? false,
      updateFieldAppearances: true,
    });
    return new Uint8Array(bytes);
  } catch (error) {
    throw normalizeError(error);
  }
}

/** Saves using an incremental update (fast path for annotation/form edits). */
export async function savePdfIncremental(doc: PDFDocument): Promise<Uint8Array> {
  const bytes = await doc.commit();
  return new Uint8Array(bytes);
}

/** Peek at the trailer without a full parse: is the document encrypted? */
export function detectEncryption(bytes: Uint8Array): { encrypted: boolean; algorithm?: 'AES-256' | 'AES-128' | 'RC4-128' | 'RC4-40' | 'unknown' } {
  const tail = Math.min(bytes.length, 16384);
  const text = latin1(bytes, tail, bytes.length - tail);
  if (!/\/Encrypt\b/.test(text)) return { encrypted: false };
  const vMatch = text.match(/\/V\s+(\d)/);
  const rMatch = text.match(/\/R\s+(\d)/);
  const version = vMatch ? Number(vMatch[1]) : 0;
  const revision = rMatch ? Number(rMatch[1]) : 0;
  let algorithm: 'AES-256' | 'AES-128' | 'RC4-128' | 'RC4-40' | 'unknown' = 'unknown';
  if (version === 5 || revision >= 5) algorithm = 'AES-256';
  else if (version === 4) algorithm = /\/AESV2\b/.test(text) ? 'AES-128' : 'RC4-128';
  else if (version === 2) algorithm = 'RC4-128';
  else if (version === 1) algorithm = 'RC4-40';
  return { encrypted: true, algorithm };
}

/** Does the buffer start with a PDF header? Tolerates leading junk (common). */
export function hasPdfHeader(bytes: Uint8Array): boolean {
  const head = latin1(bytes, Math.min(bytes.length, 1024));
  return head.includes('%PDF-');
}

export function readPdfVersion(bytes: Uint8Array): string | undefined {
  const head = latin1(bytes, Math.min(bytes.length, 1024));
  const match = head.match(/%PDF-(\d+\.\d+)/);
  return match?.[1];
}

/**
 * Decodes a slice of bytes as latin1 (binary-safe), which is enough to inspect
 * PDF dictionary syntax without a full parse.
 */
export function latin1(bytes: Uint8Array, length: number, offset = 0): string {
  let out = '';
  const end = Math.min(bytes.length, offset + length);
  const chunk = 8192;
  for (let i = offset; i < end; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, end)));
  }
  return out;
}

/** Ensures a buffer has no leading/trailing garbage before handing to parsers. */
export function trimToPdf(bytes: Uint8Array): Uint8Array {
  const headerIndex = latin1(bytes, Math.min(bytes.length, 2048)).indexOf('%PDF-');
  if (headerIndex > 0) return bytes.subarray(headerIndex);
  return bytes;
}

export async function assertValidPdf(bytes: Uint8Array, password?: string): Promise<void> {
  if (!hasPdfHeader(bytes)) {
    throw appError('CORRUPT_DOCUMENT', 'The file is not a PDF document.', { details: 'missing %PDF- header' });
  }
  await loadPdf(trimToPdf(bytes), password !== undefined ? { password } : {});
}
