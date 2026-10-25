import type { PDFDocument } from '@cantoo/pdf-lib';
import type { PdfInfo, PageInfo } from '../../shared/types';
import type { PdfOutlineSnapshot } from '../raster/types';
import { hasSignatureField, listFormFields } from './forms';
import { detectEncryption, readPdfVersion } from './loader';
import { listAttachments, readMetadata, readOutline } from './metadata';

export interface InspectOptions {
  bytes: Uint8Array;
  doc: PDFDocument;
  /** Page geometry/text statistics from pdf.js (optional, improves accuracy). */
  snapshot?: PdfOutlineSnapshot;
  fileSize?: number;
}

/** Builds the document summary shown in the UI. */
export function buildPdfInfo(options: InspectOptions): PdfInfo {
  const { doc, snapshot } = options;
  const formFields = listFormFields(doc);
  const encryption = detectEncryption(options.bytes);

  const pages: PageInfo[] = doc.getPages().map((page, index) => {
    const size = page.getSize();
    const fromSnapshot = snapshot?.pages[index];
    const label = snapshot?.labels?.[index];
    return {
      index,
      width: round(fromSnapshot?.width ?? size.width),
      height: round(fromSnapshot?.height ?? size.height),
      rotation: ((page.getRotation().angle % 360) + 360) % 360,
      ...(label ? { label } : {}),
      hasText: snapshot ? snapshot.pagesWithText > 0 : undefined,
    };
  });

  const info: PdfInfo = {
    fileSize: options.fileSize ?? options.bytes.byteLength,
    pageCount: doc.getPageCount(),
    pages,
    metadata: readMetadata(doc),
    encrypted: encryption.encrypted,
    hasForms: formFields.length > 0,
    formFields,
    hasSignatures: hasSignatureField(doc),
    outline: readOutline(doc),
    attachments: listAttachments(doc).map((attachment) => ({
      name: attachment.name,
      size: attachment.size,
      ...(attachment.description ? { description: attachment.description } : {}),
    })),
    textCharacters: snapshot?.textCharacters ?? 0,
  };
  if (encryption.encrypted && encryption.algorithm) info.encryptionAlgorithm = encryption.algorithm;
  const version = readPdfVersion(options.bytes);
  if (version) info.pdfVersion = version;
  return info;
}

/** Short human readable description used in tooltips and reports. */
export function describeDocument(info: PdfInfo): string {
  const parts = [`${info.pageCount} page${info.pageCount === 1 ? '' : 's'}`];
  if (info.encrypted) parts.push('encrypted');
  if (info.hasForms) parts.push(`${info.formFields.length} form field${info.formFields.length === 1 ? '' : 's'}`);
  if (info.hasSignatures) parts.push('signed');
  if (info.attachments.length) parts.push(`${info.attachments.length} attachment${info.attachments.length === 1 ? '' : 's'}`);
  if (info.textCharacters === 0 && info.pageCount > 0) parts.push('scanned');
  return parts.join(' · ');
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
