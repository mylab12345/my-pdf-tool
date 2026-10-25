import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, type PDFDocument } from '@cantoo/pdf-lib';
import type { OutlineItem, PdfMetadata } from '../../shared/types';
import { appError } from '../errors';

/** Resolves the document information dictionary (may be absent). */
export function infoDict(doc: PDFDocument): PDFDict | undefined {
  const entry = doc.context.trailerInfo.Info;
  if (entry instanceof PDFDict) return entry;
  const resolved = entry ? doc.context.lookup(entry) : undefined;
  return resolved instanceof PDFDict ? resolved : undefined;
}

function infoString(dict: PDFDict | undefined, key: string): string | undefined {
  if (!dict) return undefined;
  const value = dict.lookup(PDFName.of(key));
  if (value instanceof PDFString || value instanceof PDFHexString) {
    try {
      const text = value.decodeText();
      return text.length ? text : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Reads document information dictionary values into the app model. */
export function readMetadata(doc: PDFDocument): PdfMetadata {
  const dict = infoDict(doc);
  const metadata: PdfMetadata = {};
  const title = infoString(dict, 'Title');
  const author = infoString(dict, 'Author');
  const subject = infoString(dict, 'Subject');
  const keywords = infoString(dict, 'Keywords');
  const creator = infoString(dict, 'Creator');
  const producer = infoString(dict, 'Producer');
  if (title) metadata.title = title;
  if (author) metadata.author = author;
  if (subject) metadata.subject = subject;
  if (keywords) metadata.keywords = keywords.split(/[,;]/).map((entry) => entry.trim()).filter(Boolean);
  if (creator) metadata.creator = creator;
  if (producer) metadata.producer = producer;
  const created = doc.getCreationDate();
  const modified = doc.getModificationDate();
  if (created) metadata.creationDate = created.toISOString();
  if (modified) metadata.modificationDate = modified.toISOString();
  return metadata;
}

/**
 * Writes metadata directly into the information dictionary.
 *
 * pdf-lib's helpers join keywords with a space, which loses the separator, so
 * the dictionary is written explicitly to keep keywords individually readable.
 */
export function writeMetadata(doc: PDFDocument, metadata: PdfMetadata): void {
  const ctx = doc.context;
  let dict = infoDict(doc);
  if (!dict) {
    dict = ctx.obj({}) as PDFDict;
    const ref = ctx.register(dict);
    doc.context.trailerInfo.Info = ref;
  }
  const put = (key: string, value: string | undefined) => {
    if (value && value.trim()) {
      dict!.set(PDFName.of(key), PDFHexString.fromText(value));
    } else {
      dict!.delete(PDFName.of(key));
    }
  };
  put('Title', metadata.title);
  put('Author', metadata.author);
  put('Subject', metadata.subject);
  put('Keywords', metadata.keywords?.filter(Boolean).join(', '));
  put('Creator', metadata.creator ?? 'Arena PDF Studio');
  put('Producer', metadata.producer ?? 'Arena PDF Studio');
  doc.setModificationDate(new Date());
}

/** Removes the XMP metadata stream and the info dictionary (privacy scrub). */
export function scrubMetadata(doc: PDFDocument, options: { keepProducer?: boolean } = {}): void {
  if (options.keepProducer) {
    const producer = doc.getProducer();
    delete doc.context.trailerInfo.Info;
    doc.setProducer(producer ?? 'Arena PDF Studio');
  } else {
    delete doc.context.trailerInfo.Info;
  }
  doc.catalog.delete(PDFName.of('Metadata'));
  doc.catalog.delete(PDFName.of('PieceInfo'));
  doc.catalog.delete(PDFName.of('MarkInfo'));
}

/* -------------------------------------------------------------------------- */
/* Outline (bookmarks)                                                         */
/* -------------------------------------------------------------------------- */

/** Reads the document outline into a nested structure. */
export function readOutline(doc: PDFDocument): OutlineItem[] {
  const outlines = doc.catalog.lookup(PDFName.of('Outlines'));
  const dict = outlines instanceof PDFDict ? outlines : undefined;
  if (!dict) return [];
  const pageIndexByRef = new Map<string, number>();
  doc.getPages().forEach((page, index) => pageIndexByRef.set(refKey(page.ref), index));

  const first = dict.get(PDFName.of('First'));
  if (!first) return [];
  return readSiblings(first, pageIndexByRef, 0, doc);
}

function readSiblings(start: unknown, pageIndexByRef: Map<string, number>, depth: number, doc: PDFDocument): OutlineItem[] {
  const items: OutlineItem[] = [];
  let current = start;
  let guard = 0;
  while (current && guard < 5000) {
    guard += 1;
    const resolved = doc.context.lookup(current as never);
    const dict = resolved instanceof PDFDict ? resolved : undefined;
    if (!dict) break;
    const title = readText(dict.lookup(PDFName.of('Title'))) ?? 'Untitled';
    const pageIndex = resolveDestinationPage(dict, pageIndexByRef);
    const children = depth < 8 ? readSiblings(dict.get(PDFName.of('First')), pageIndexByRef, depth + 1, doc) : [];
    items.push({ title, pageIndex, children });
    current = dict.get(PDFName.of('Next'));
  }
  return items;
}

function resolveDestinationPage(dict: PDFDict, pageIndexByRef: Map<string, number>): number | null {
  const direct = dict.lookup(PDFName.of('Dest'));
  const fromDest = pageFromDestination(direct, pageIndexByRef);
  if (fromDest !== null) return fromDest;
  const action = dict.lookup(PDFName.of('A'));
  if (action instanceof PDFDict) {
    const actionDest = action.lookup(PDFName.of('D'));
    const fromAction = pageFromDestination(actionDest, pageIndexByRef);
    if (fromAction !== null) return fromAction;
  }
  return null;
}

function pageFromDestination(destination: unknown, pageIndexByRef: Map<string, number>): number | null {
  if (destination instanceof PDFRef) return pageIndexByRef.get(refKey(destination)) ?? null;
  if (destination instanceof PDFArray) {
    const first = destination.get(0);
    if (first instanceof PDFRef) return pageIndexByRef.get(refKey(first)) ?? null;
    if (first instanceof PDFNumber) return first.asNumber();
    return null;
  }
  if (destination instanceof PDFDict) {
    const pageRef = destination.get(PDFName.of('D'));
    if (pageRef instanceof PDFRef) return pageIndexByRef.get(refKey(pageRef)) ?? null;
  }
  if (typeof destination === 'string') return null;
  return null;
}

function readText(value: unknown): string | undefined {
  if (value instanceof PDFString || value instanceof PDFHexString) {
    try {
      return value.decodeText();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface OutlineEntry {
  title: string;
  pageIndex: number | null;
  children: { title: string; pageIndex: number | null }[];
}

/** Rebuilds the document outline (bookmarks). */
export function writeOutline(doc: PDFDocument, items: OutlineEntry[]): void {
  const ctx = doc.context;
  doc.catalog.delete(PDFName.of('Outlines'));
  if (!items.length) return;

  const pageRef = (pageIndex: number | null): PDFRef | null => {
    if (pageIndex === null || pageIndex < 0 || pageIndex >= doc.getPageCount()) return null;
    return doc.getPage(pageIndex).ref;
  };

  const outlineRoot = ctx.obj({ Type: 'Outlines' }) as PDFDict;
  const rootRef = ctx.register(outlineRoot);

  const flat: { dict: PDFDict; ref: PDFRef; parentRef: PDFRef; children: { dict: PDFDict; ref: PDFRef }[] }[] = [];

  for (const item of items) {
    if (!item.title.trim()) continue;
    const dict = ctx.obj({ Title: PDFHexString.fromText(item.title), Parent: rootRef }) as PDFDict;
    const dest = pageRef(item.pageIndex);
    if (dest) dict.set(PDFName.of('Dest'), ctx.obj([dest, 'XYZ', null, null, null]));
    const ref = ctx.register(dict);
    const children = item.children
      .filter((child) => child.title.trim())
      .map((child) => {
        const childDict = ctx.obj({ Title: PDFHexString.fromText(child.title), Parent: ref }) as PDFDict;
        const childDest = pageRef(child.pageIndex);
        if (childDest) childDict.set(PDFName.of('Dest'), ctx.obj([childDest, 'XYZ', null, null, null]));
        const childRef = ctx.register(childDict);
        return { dict: childDict, ref: childRef };
      });
    flat.push({ dict, ref, parentRef: rootRef, children });
  }

  if (!flat.length) {
    doc.catalog.delete(PDFName.of('Outlines'));
    return;
  }

  // Link siblings at the top level.
  flat.forEach((entry, index) => {
    const next = flat[index + 1];
    const previous = flat[index - 1];
    if (next) entry.dict.set(PDFName.of('Next'), next.ref);
    if (previous) entry.dict.set(PDFName.of('Prev'), previous.ref);
  });
  outlineRoot.set(PDFName.of('First'), flat[0]!.ref);
  outlineRoot.set(PDFName.of('Last'), flat[flat.length - 1]!.ref);
  outlineRoot.set(PDFName.of('Count'), PDFNumber.of(flat.reduce((total, entry) => total + 1 + entry.children.length, 0)));
  doc.catalog.set(PDFName.of('Outlines'), rootRef);

  // Link children under each parent.
  for (const entry of flat) {
    if (!entry.children.length) continue;
    entry.children.forEach((child, index) => {
      const next = entry.children[index + 1];
      const previous = entry.children[index - 1];
      if (next) child.dict.set(PDFName.of('Next'), next.ref);
      if (previous) child.dict.set(PDFName.of('Prev'), previous.ref);
    });
    entry.dict.set(PDFName.of('First'), entry.children[0]!.ref);
    entry.dict.set(PDFName.of('Last'), entry.children[entry.children.length - 1]!.ref);
    entry.dict.set(PDFName.of('Count'), PDFNumber.of(entry.children.length));
  }
}

/* -------------------------------------------------------------------------- */
/* Attachments                                                                 */
/* -------------------------------------------------------------------------- */

export interface AttachmentEntry {
  name: string;
  size: number;
  description?: string;
  bytes: Uint8Array;
}

export function listAttachments(doc: PDFDocument): AttachmentEntry[] {
  try {
    return doc.getAttachments().map((attachment) => ({
      name: attachment.name,
      size: attachment.data.byteLength,
      ...(attachment.description ? { description: attachment.description } : {}),
      bytes: attachment.data,
    }));
  } catch {
    return [];
  }
}

export async function addAttachment(doc: PDFDocument, name: string, data: Uint8Array, description?: string): Promise<void> {
  if (!name.trim()) throw appError('INVALID_INPUT', 'The attachment needs a file name.');
  const safeName = name.replace(/[\\/]/g, '-');
  if (doc.getAttachments().some((attachment) => attachment.name === safeName)) {
    doc.detach(safeName);
  }
  await doc.attach(data, safeName, {
    mimeType: 'application/octet-stream',
    ...(description ? { description } : {}),
    creationDate: new Date(),
    modificationDate: new Date(),
  });
}

export function removeAttachment(doc: PDFDocument, name: string): boolean {
  if (!doc.getAttachments().some((attachment) => attachment.name === name)) return false;
  doc.detach(name);
  return true;
}

export function refKey(ref: PDFRef): string {
  return `${ref.objectNumber}:${ref.generationNumber}`;
}
