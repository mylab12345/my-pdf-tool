import { rgb, type PDFDocument } from '@cantoo/pdf-lib';
import type { DocumentOperation } from '../../shared/ipc';
import { dataUrlToBytes } from '../base64';
import { appError } from '../errors';
import { addAnnotation, addImageStamp, flattenAnnotations, removeAnnotation, updateAnnotation } from './annotations';
import type { FontManager } from './fonts';
import { embedImage } from './create';
import { hexToRgb } from '../../shared/format';
import {
  cropPages,
  deletePages,
  duplicatePages,
  insertBlankPage,
  insertPagesFrom,
  movePage,
  reorderPages,
  resizePages,
  rotatePages,
} from './pages';
import { writeMetadata, writeOutline } from './metadata';
import { measureWidth } from './text-layout';

export interface OperationContext {
  fonts: FontManager;
}

/**
 * Applies a single reversible operation to a document.
 *
 * Operations are the unit of undo/redo: the session keeps the base bytes plus an
 * operation list and replays it, so undo never depends on storing full copies of
 * large documents.
 */
export async function applyOperation(doc: PDFDocument, operation: DocumentOperation, context: OperationContext): Promise<void> {
  switch (operation.kind) {
    case 'deletePages':
      deletePages(doc, operation.pages);
      return;
    case 'rotatePages':
      rotatePages(doc, operation.pages, operation.degrees);
      return;
    case 'movePage':
      await movePage(doc, operation.from, operation.to);
      return;
    case 'duplicatePages':
      await duplicatePages(doc, operation.pages);
      return;
    case 'insertBlankPage':
      insertBlankPage(doc, operation.at, operation.size, operation.orientation, operation.customSize);
      return;
    case 'insertPagesFrom':
      await insertPagesFrom(doc, operation.sourceBytes, operation.sourceName, operation.pages, operation.at);
      return;
    case 'cropPages':
      cropPages(doc, operation.pages, operation.box);
      return;
    case 'resizePages':
      resizePages(doc, operation.pages, operation.size, operation.orientation, operation.scaleContent);
      return;
    case 'reorderPages':
      await reorderPages(doc, operation.order);
      return;
    case 'setMetadata':
      writeMetadata(doc, operation.metadata);
      return;
    case 'addAnnotation':
      addAnnotation(doc, operation.annotation);
      return;
    case 'updateAnnotation':
      if (!updateAnnotation(doc, operation.id, operation.annotation)) {
        throw appError('NOT_FOUND', 'The annotation no longer exists.');
      }
      return;
    case 'removeAnnotation':
      if (!removeAnnotation(doc, operation.id)) {
        throw appError('NOT_FOUND', 'The annotation no longer exists.');
      }
      return;
    case 'addImage': {
      const { bytes } = dataUrlToBytes(operation.dataUrl);
      if (bytes.length === 0) throw appError('INVALID_INPUT', 'The image could not be read.');
      await addImageStamp(doc, operation.pageIndex, operation.rect, bytes, operation.opacity ?? 1);
      return;
    }
    case 'replaceText': {
      // Cover the original text with an opaque box, then draw the replacement.
      const page = doc.getPage(operation.pageIndex);
      const [bgR, bgG, bgB] = hexToRgb(operation.background);
      page.drawRectangle({
        x: operation.rect.x,
        y: operation.rect.y,
        width: operation.rect.width,
        height: operation.rect.height,
        color: rgb(bgR, bgG, bgB),
        borderWidth: 0,
      });
      const font = await context.fonts.embedForText(doc, operation.fontFamily, operation.text);
      const [textR, textG, textB] = hexToRgb(operation.color);
      const size = Math.max(4, operation.fontSize);
      operation.text.split('\n').forEach((line, index) => {
        if (!line) return;
        const width = measureWidth(line, font.font, size);
        const scale = width > operation.rect.width && width > 0 ? operation.rect.width / width : 1;
        page.drawText(line, {
          x: operation.rect.x + 1,
          y: operation.rect.y + operation.rect.height - size - index * size * 1.2,
          size: size * scale,
          font: font.font,
          color: rgb(textR, textG, textB),
        });
      });
      return;
    }
    case 'flattenAnnotations':
      await flattenAnnotations(doc, context.fonts, { pages: operation.pages ?? null });
      return;
    case 'setOutline':
      writeOutline(doc, operation.items);
      return;
    default: {
      const exhaustive: never = operation;
      throw appError('UNSUPPORTED_FEATURE', `Unknown operation ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Verifies that an operation only touches pages that exist. */
export function validateOperation(operation: DocumentOperation, pageCount: number): string[] {
  const problems: string[] = [];
  const inRange = (index: number) => Number.isInteger(index) && index >= 0 && index < pageCount;
  const checkPages = (pages: number[], allowEmpty = false) => {
    if (!pages.length && !allowEmpty) problems.push('No pages selected.');
    for (const page of pages) if (!inRange(page)) problems.push(`Page ${page + 1} does not exist.`);
  };
  switch (operation.kind) {
    case 'deletePages':
      checkPages(operation.pages);
      if (operation.pages.length >= pageCount) problems.push('A document must keep at least one page.');
      break;
    case 'rotatePages':
    case 'duplicatePages':
    case 'cropPages':
    case 'resizePages':
      checkPages(operation.pages);
      break;
    case 'movePage':
      if (!inRange(operation.from) || !inRange(operation.to)) problems.push('Invalid page position.');
      break;
    case 'reorderPages':
      if (operation.order.length !== pageCount) problems.push('The new order must list every page.');
      break;
    case 'insertBlankPage':
    case 'insertPagesFrom':
      if (operation.at < 0 || operation.at > pageCount) problems.push('Invalid insert position.');
      break;
    case 'addAnnotation':
      if (!inRange(operation.annotation.pageIndex)) problems.push('Invalid page for this annotation.');
      break;
    case 'addImage':
    case 'replaceText':
      if (!inRange(operation.pageIndex)) problems.push('Invalid page for this object.');
      break;
    default:
      break;
  }
  return problems;
}

/** Embeds a data URL image into a document (helper for tests and tools). */
export async function embedDataUrlImage(doc: PDFDocument, dataUrl: string, name = 'image') {
  const { bytes } = dataUrlToBytes(dataUrl);
  return embedImage(doc, bytes, name);
}

/** Human readable label for the undo/redo UI. */
export function describeOperation(operation: DocumentOperation): string {
  switch (operation.kind) {
    case 'deletePages':
      return operation.pages.length === 1 ? 'Delete page' : `Delete ${operation.pages.length} pages`;
    case 'rotatePages':
      return 'Rotate pages';
    case 'movePage':
      return 'Move page';
    case 'duplicatePages':
      return 'Duplicate pages';
    case 'insertBlankPage':
      return 'Insert blank page';
    case 'insertPagesFrom':
      return `Insert pages from ${operation.sourceName}`;
    case 'cropPages':
      return 'Crop pages';
    case 'resizePages':
      return 'Resize pages';
    case 'reorderPages':
      return 'Reorder pages';
    case 'setMetadata':
      return 'Edit properties';
    case 'addAnnotation':
      return `Add ${operation.annotation.type}`;
    case 'updateAnnotation':
      return 'Edit annotation';
    case 'removeAnnotation':
      return 'Delete annotation';
    case 'addImage':
      return 'Insert image';
    case 'replaceText':
      return 'Edit text';
    case 'flattenAnnotations':
      return 'Flatten annotations';
    case 'setOutline':
      return 'Edit bookmarks';
    default:
      return 'Edit';
  }
}
