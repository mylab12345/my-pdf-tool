import type { ValidationIssue, ValidationReport } from '../../shared/ipc';
import type { PdfRenderer } from '../raster/renderer';
import { normalizeError } from '../errors';
import { hasPdfHeader, loadPdf, readPdfVersion, trimToPdf } from './loader';

export interface ValidationDeps {
  renderer: PdfRenderer;
}

/**
 * Structural validation.
 *
 * A document is checked with two independent parsers (pdf-lib and pdf.js). When
 * the bytes only fail because of leading junk before the `%PDF-` header (common
 * for files recovered from email gateways), a repaired copy is produced.
 */
export async function validateDocument(bytes: Uint8Array, deps: ValidationDeps): Promise<ValidationReport> {
  const started = Date.now();
  const issues: ValidationIssue[] = [];

  if (!hasPdfHeader(bytes)) {
    issues.push({ severity: 'error', message: 'The file does not start with a PDF header.' });
    return { valid: false, pageCount: 0, issues, durationMs: Date.now() - started };
  }

  let pageCount = 0;
  let renderedPages = 0;
  let pdfLibOk = false;
  let pdfjsOk = false;

  try {
    const doc = await loadPdf(bytes);
    pdfLibOk = true;
    pageCount = doc.getPageCount();
    if (pageCount === 0) issues.push({ severity: 'error', message: 'The document contains no pages.' });
    const pages = doc.getPages();
    pages.forEach((page, index) => {
      const size = page.getSize();
      if (size.width <= 0 || size.height <= 0) {
        issues.push({ severity: 'error', message: `Page ${index + 1} has an invalid size.`, pageIndex: index });
      }
      if (size.width * size.height > 200 * 1024 * 1024) {
        issues.push({ severity: 'warning', message: `Page ${index + 1} is unusually large.`, pageIndex: index });
      }
      if (!page.node.Contents()) {
        issues.push({ severity: 'info', message: `Page ${index + 1} has no content stream (blank page).`, pageIndex: index });
      }
    });
  } catch (error) {
    issues.push({ severity: 'error', message: `The PDF structure could not be parsed: ${normalizeError(error).message}` });
  }

  try {
    const snapshot = await deps.renderer.inspect(bytes, { textSampleSize: 3 });
    pdfjsOk = true;
    renderedPages = snapshot.numPages;
    if (pageCount && snapshot.numPages !== pageCount) {
      issues.push({
        severity: 'warning',
        message: `The two parsers disagree on the page count (${pageCount} vs ${snapshot.numPages}).`,
      });
    }
    if (snapshot.textCharacters === 0) {
      issues.push({ severity: 'info', message: 'No text layer found: this looks like a scanned document (OCR can help).' });
    }
  } catch (error) {
    // The application itself renders through pdf.js, so a failure here is fatal
    // for display purposes even if pdf-lib could still walk the structures.
    issues.push({ severity: 'error', message: `The rendering engine could not open the document: ${normalizeError(error).message}` });
  }

  const version = readPdfVersion(bytes);
  if (version && Number.parseFloat(version) > 2.0) {
    issues.push({ severity: 'warning', message: `Unusual PDF version ${version}.` });
  }

  const trimmed = trimToPdf(bytes);
  const needsRepair = trimmed.byteLength !== bytes.byteLength;
  const valid = pdfLibOk && pdfjsOk && !issues.some((issue) => issue.severity === 'error');

  const report: ValidationReport = {
    valid,
    pageCount: pageCount || renderedPages,
    issues,
    durationMs: Date.now() - started,
  };
  if (needsRepair) {
    report.repairedBytes = trimmed;
    report.issues.push({
      severity: 'info',
      message: `Removed ${bytes.byteLength - trimmed.byteLength} bytes of leading data (repair available).`,
    });
  }
  return report;
}
