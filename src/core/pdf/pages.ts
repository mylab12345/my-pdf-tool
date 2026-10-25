import { PDFDocument, PDFName, PDFArray, PDFRef, degrees, type PDFPage } from '@cantoo/pdf-lib';
import { resolvePageSize } from '../../shared/constants';
import type { PageOrientation, PageSizeName } from '../../shared/types';
import { appError, assert } from '../errors';
import { loadPdf, savePdf } from './loader';

/** Clamps and de-duplicates a list of page indices. */
export function normalizePageIndices(pages: number[], pageCount: number): number[] {
  const unique = new Set<number>();
  for (const page of pages) {
    if (!Number.isFinite(page)) continue;
    const index = Math.trunc(page);
    if (index >= 0 && index < pageCount) unique.add(index);
  }
  return [...unique].sort((a, b) => a - b);
}

export function deletePages(doc: PDFDocument, pages: number[]): number {
  const targets = normalizePageIndices(pages, doc.getPageCount());
  assert(doc.getPageCount() - targets.length >= 1, 'A document must keep at least one page.');
  // Remove from the highest index so earlier indices stay valid.
  for (const index of [...targets].sort((a, b) => b - a)) doc.removePage(index);
  return targets.length;
}

export function rotatePages(doc: PDFDocument, pages: number[], delta: number): number {
  const targets = normalizePageIndices(pages, doc.getPageCount());
  for (const index of targets) {
    const page = doc.getPage(index);
    const current = page.getRotation().angle;
    const next = ((current + delta) % 360 + 360) % 360;
    page.setRotation(degrees(next));
  }
  return targets.length;
}

/**
 * Moves a page to a new position.
 *
 * Implemented as a page-tree reordering (rather than remove + insert) because
 * pdf-lib's `insertPage` re-creates leaf dictionaries, which leaves references
 * pointing at the wrong objects for some viewers.
 */
export async function movePage(doc: PDFDocument, from: number, to: number): Promise<void> {
  const count = doc.getPageCount();
  assert(from >= 0 && from < count, `Page ${from + 1} does not exist.`);
  const target = Math.max(0, Math.min(count - 1, to));
  if (from === target) return;
  const order = doc.getPageIndices();
  const [moved] = order.splice(from, 1);
  order.splice(target, 0, moved!);
  await reorderPages(doc, order);
}

/** Duplicates pages right after their source position. */
export async function duplicatePages(doc: PDFDocument, pages: number[]): Promise<number> {
  const targets = normalizePageIndices(pages, doc.getPageCount());
  let inserted = 0;
  // Copy from the end so insert positions computed from the original layout stay valid.
  for (const [offset, index] of [...targets].sort((a, b) => b - a).entries()) {
    const [copy] = await doc.copyPages(doc, [index]);
    if (!copy) continue;
    doc.insertPage(index + 1, copy);
    inserted += 1;
    void offset;
  }
  return inserted;
}

export function insertBlankPage(
  doc: PDFDocument,
  at: number,
  size: PageSizeName,
  orientation: PageOrientation,
  customSize?: { width: number; height: number },
): void {
  const dimensions = customSize ?? resolvePageSize(size, orientation);
  const page = doc.insertPage(Math.max(0, Math.min(doc.getPageCount(), at)), [dimensions.width, dimensions.height]);
  void page;
}

/** Copies pages from another PDF into this document. */
export async function insertPagesFrom(
  doc: PDFDocument,
  sourceBytes: Uint8Array,
  sourceName: string,
  pages: number[],
  at: number,
  password?: string,
): Promise<number> {
  const source = await loadPdf(sourceBytes, password !== undefined ? { password } : {});
  const indices = pages.length ? normalizePageIndices(pages, source.getPageCount()) : source.getPageIndices();
  if (!indices.length) throw appError('INVALID_INPUT', `No pages selected from "${sourceName}".`);
  const copied = await doc.copyPages(source, indices);
  let position = Math.max(0, Math.min(doc.getPageCount(), at));
  for (const page of copied) {
    doc.insertPage(position, page);
    position += 1;
  }
  return copied.length;
}

/**
 * Reorders pages. Works on the page tree in place so annotations, form fields
 * and links survive; falls back to a rebuild for nested page trees.
 */
export async function reorderPages(doc: PDFDocument, order: number[]): Promise<void> {
  const count = doc.getPageCount();
  const permutation = order.filter((index) => Number.isInteger(index) && index >= 0 && index < count);
  assert(permutation.length === count, `The page order must list all ${count} pages exactly once.`);
  const unique = new Set(permutation);
  assert(unique.size === count, 'The page order contains duplicates.');

  const pagesNode = doc.catalog.Pages();
  const kids = pagesNode.lookup(PDFName.of('Kids'), PDFArray);
  const currentPages = doc.getPages();

  const flat =
    kids.size() === count &&
    currentPages.every((page, index) => {
      const kid = kids.get(index);
      return kid instanceof PDFRef && kid.objectNumber === page.ref.objectNumber;
    });

  if (flat) {
    const refs = kids.asArray().slice();
    const reordered = permutation.map((index) => refs[index]!);
    for (let index = 0; index < reordered.length; index += 1) {
      kids.set(index, reordered[index]!);
    }
    return;
  }

  // Nested page tree: rebuild the document in the requested order.
  const copies = await doc.copyPages(doc, permutation);
  for (let index = 0; index < count; index += 1) doc.removePage(0);
  for (const page of copies) doc.addPage(page);
}

/** Sets the crop box (visible area) of the given pages. */
export function cropPages(
  doc: PDFDocument,
  pages: number[],
  box: { x: number; y: number; width: number; height: number },
): number {
  const targets = normalizePageIndices(pages, doc.getPageCount());
  assert(box.width > 1 && box.height > 1, 'The crop area is too small.');
  for (const index of targets) {
    const page = doc.getPage(index);
    page.setCropBox(box.x, box.y, box.width, box.height);
  }
  return targets.length;
}

/** Resizes pages, optionally scaling the content to fit the new media box. */
export function resizePages(
  doc: PDFDocument,
  pages: number[],
  size: PageSizeName,
  orientation: PageOrientation,
  scaleContent: boolean,
): number {
  const targets = normalizePageIndices(pages, doc.getPageCount());
  const target = resolvePageSize(size, orientation);
  for (const index of targets) {
    const page = doc.getPage(index);
    const current = page.getSize();
    if (scaleContent) {
      const scale = Math.min(target.width / current.width, target.height / current.height);
      page.scaleContent(scale, scale);
      const offsetX = (target.width - current.width * scale) / 2;
      const offsetY = (target.height - current.height * scale) / 2;
      page.translateContent(offsetX / scale, offsetY / scale);
    }
    page.setSize(target.width, target.height);
  }
  return targets.length;
}

/** Extracts a subset of pages into a new document. */
export async function extractPages(bytes: Uint8Array, pages: number[], password?: string): Promise<Uint8Array> {
  const source = await loadPdf(bytes, password !== undefined ? { password } : {});
  const indices = normalizePageIndices(pages, source.getPageCount());
  if (!indices.length) throw appError('INVALID_INPUT', 'Select at least one page to extract.');
  const target = await PDFDocument.create();
  const copied = await target.copyPages(source, indices);
  for (const page of copied) target.addPage(page);
  copyMetadata(source, target);
  return savePdf(target);
}

/** Merges documents in the given order into a new document. */
export async function mergeDocuments(
  sources: { name: string; bytes: Uint8Array; password?: string }[],
): Promise<Uint8Array> {
  if (sources.length < 2) throw appError('INVALID_INPUT', 'Select at least two documents to merge.');
  const target = await PDFDocument.create();
  let first: PDFDocument | null = null;
  for (const source of sources) {
    const doc = await loadPdf(source.bytes, source.password !== undefined ? { password: source.password } : {});
    first ??= doc;
    const copied = await target.copyPages(doc, doc.getPageIndices());
    for (const page of copied) target.addPage(page);
  }
  if (first) copyMetadata(first, target);
  target.setProducer('Arena PDF Studio');
  target.setModificationDate(new Date());
  return savePdf(target);
}

/** Appends every page of `sourceBytes` to `target` (used by merge into a session). */
export async function appendDocument(
  target: PDFDocument,
  sourceBytes: Uint8Array,
  password?: string,
): Promise<number> {
  const source = await loadPdf(sourceBytes, password !== undefined ? { password } : {});
  const copied = await target.copyPages(source, source.getPageIndices());
  for (const page of copied) target.addPage(page);
  return copied.length;
}

function copyMetadata(from: PDFDocument, to: PDFDocument): void {
  const title = from.getTitle();
  const author = from.getAuthor();
  const subject = from.getSubject();
  const keywords = from.getKeywords();
  const creator = from.getCreator();
  if (title) to.setTitle(title);
  if (author) to.setAuthor(author);
  if (subject) to.setSubject(subject);
  if (keywords) to.setKeywords(keywords.split(/[,;]\s*/));
  if (creator) to.setCreator(creator);
  to.setProducer('Arena PDF Studio');
  to.setCreationDate(new Date());
  to.setModificationDate(new Date());
}

/** Returns pages that are rotated (used to warn before OCR/compression). */
export function rotatedPages(doc: PDFDocument): number[] {
  const result: number[] = [];
  doc.getPages().forEach((page: PDFPage, index: number) => {
    if (page.getRotation().angle % 360 !== 0) result.push(index);
  });
  return result;
}
