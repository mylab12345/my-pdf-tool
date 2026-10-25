import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { BrowserWindow } from 'electron';
import type {
  AttachmentInfo,
  CompressionOptions,
  ConvertToImagesOptions,
  DocumentSummary,
  FillValue,
  FormFieldInfo,
  HeaderFooterOptions,
  OcrOptions,
  PdfMetadata,
  RedactionOptions,
  RedactionRegion,
  SecurityOptions,
  SignatureOptions,
  SignatureVerification,
  TextExportFormat,
  WatermarkOptions,
} from '../shared/types';
import type { CreatedCertificate } from '../shared/types';
import type {
  CompressOutcome,
  ExportOutcome,
  FormCreateField,
  MergeOptions,
  OcrOutcome,
  OutlineEntryInput,
  RedactOutcome,
  SignOutcome,
  SplitOptions,
  ValidationReport,
} from '../shared/ipc';
import { appError, normalizeError } from '../core/errors';
import { encodeText, convertToImages, convertToText, zipFiles } from '../core/pdf/convert';
import { compressDocument } from '../core/pdf/compress';
import { createFormFields, fillForm, flattenForm, listFormFields } from '../core/pdf/forms';
import { loadPdf, savePdf } from '../core/pdf/loader';
import { addAttachment, listAttachments, removeAttachment, writeOutline } from '../core/pdf/metadata';
import { extractPages, mergeDocuments } from '../core/pdf/pages';
import { buildSearchablePdf, availableLanguages, ocrDocument } from '../core/pdf/ocr';
import { addHeaderFooter, addWatermark } from '../core/pdf/watermark';
import { redactDocument, previewRedactions } from '../core/pdf/redact';
import { encryptDocument } from '../core/pdf/security';
import type { PdfRenderer } from '../core/raster/renderer';
import type { FontManager } from '../core/pdf/fonts';
import { chunkPages, formatPageRanges, parsePageRanges, splitAtBoundaries, splitEvery } from '../shared/ranges';
import { ensureExtension, replaceExtension, sanitizeFileName } from '../shared/format';
import type { SessionStore } from './documents/session-store';
import type { FileSystem, showDirectoryDialog, showSavePdfDialog } from './files';
import type { OcrWorkerFactory } from './ocr-engine';
import type { TaskManager } from './tasks';
import type { AppPaths } from './paths';
import { signDocument, verifyPdfSignature, createSelfSignedCertificate } from './pdf/sign';
import { paintBoxesOnImage } from './pdf/canvas-paint';

export interface ToolServiceDependencies {
  store: SessionStore;
  renderer: PdfRenderer;
  fonts: FontManager;
  fs: FileSystem;
  paths: AppPaths;
  tasks: TaskManager;
  ocr: OcrWorkerFactory;
  getWindow(): BrowserWindow | null;
  /** Native dialogs, injected so the service stays testable. */
  dialogs: {
    savePdf: typeof showSavePdfDialog;
    directory: typeof showDirectoryDialog;
  };
}

/**
 * High-level document tools.
 *
 * Each tool reads the session's current bytes, runs the corresponding engine and
 * either replaces the document content (transformations) or writes files to disk
 * (exports). Long running work reports progress through the TaskManager.
 */
export class ToolService {
  constructor(private readonly deps: ToolServiceDependencies) {}

  private async bytes(id: string): Promise<Uint8Array> {
    return this.deps.store.documentFor(id);
  }

  private window(): BrowserWindow | null {
    return this.deps.getWindow();
  }

  /* ---------------------------------------------------------------------- */
  /* Merge and split                                                         */
  /* ---------------------------------------------------------------------- */

  async merge(options: MergeOptions): Promise<DocumentSummary> {
    if (options.documentIds.length < 2) throw appError('INVALID_INPUT', 'Select at least two open documents to merge.');
    const sources = [];
    for (const id of options.documentIds) {
      sources.push({
        name: this.deps.store.summaryOf(id).name,
        bytes: await this.bytes(id),
        ...(this.deps.store.getPassword(id) !== undefined ? { password: this.deps.store.getPassword(id)! } : {}),
      });
    }
    const merged = await mergeDocuments(sources);
    const opened = await this.deps.store.openBytes(merged, { name: 'Merged.pdf', path: null });
    if (options.outputPath) {
      await this.deps.store.save(opened.id, { path: options.outputPath });
      return this.deps.store.summaryOf(opened.id);
    }
    return opened;
  }

  async split(id: string, options: SplitOptions): Promise<{ files: string[] }> {
    const bytes = await this.bytes(id);
    const summary = this.deps.store.summaryOf(id);
    const info = await this.deps.store.info(id);
    const pageCount = info.pageCount;

    let groups: number[][];
    if (options.mode === 'every') {
      groups = splitEvery(Array.from({ length: pageCount }, (_, index) => index), Math.max(1, options.every ?? 1));
    } else if (options.mode === 'boundaries') {
      groups = splitAtBoundaries(pageCount, options.boundaries ?? []);
    } else {
      const parsed = parsePageRanges(options.ranges, pageCount);
      if (parsed.invalid.length) throw appError('INVALID_INPUT', `These page ranges are not valid: ${parsed.invalid.join(', ')}`);
      if (!parsed.pages.length) throw appError('INVALID_INPUT', 'The page selection is empty.');
      groups = chunkPages(parsed.pages, Math.max(1, Math.min(parsed.pages.length, Number(options.every ?? parsed.pages.length))));
    }
    if (!groups.length) throw appError('INVALID_INPUT', 'Nothing to split.');

    let directory = options.outputDirectory ?? null;
    if (!directory) {
      directory = await this.deps.dialogs.directory(this.window(), 'Choose a folder for the split files');
      if (!directory) throw appError('CANCELLED', 'Split cancelled.');
    }
    await mkdir(directory, { recursive: true });

    const base = sanitizeFileName(summary.name.replace(/\.pdf$/i, ''));
    const files: string[] = [];
    for (const [index, pages] of groups.entries()) {
      const extracted = await extractPages(bytes, pages);
      const label = pages.length === 1 ? `page-${(pages[0] ?? 0) + 1}` : `${formatPageRanges(pages).replace(/[,]/g, '_')}`;
      const target = path.join(directory, `${base}-${String(index + 1).padStart(2, '0')}-${label}.pdf`);
      await writeFile(target, extracted);
      files.push(target);
    }
    return { files };
  }

  /* ---------------------------------------------------------------------- */
  /* Compression, encryption, redaction, signing                             */
  /* ---------------------------------------------------------------------- */

  async compress(id: string, options: CompressionOptions, taskId?: string): Promise<CompressOutcome> {
    const bytes = await this.bytes(id);
    const task = this.deps.tasks.begin(taskId, 'Compressing document', 2);
    try {
      const result = await compressDocument(bytes, options, { renderer: this.deps.renderer }, {
        onProgress: (completed, total, label) => task.update(completed, total, label),
        shouldCancel: task.shouldCancel,
      });
      const summary = await this.deps.store.replaceBytes(id, result.bytes);
      return { result, summary };
    } finally {
      task.finish();
    }
  }

  async encrypt(id: string, options: SecurityOptions): Promise<DocumentSummary> {
    const bytes = await this.bytes(id);
    const doc = await loadPdf(bytes);
    encryptDocument(doc, options);
    const encrypted = await savePdf(doc);
    return this.deps.store.replaceBytes(id, encrypted, { security: options });
  }

  async decrypt(id: string, ownerPassword: string): Promise<DocumentSummary> {
    const bytes = await this.bytes(id);
    const sessionPassword = this.deps.store.getPassword(id);
    const doc = await loadPdf(bytes, sessionPassword !== undefined ? { password: sessionPassword } : {});
    void ownerPassword;
    const plain = await savePdf(doc);
    return this.deps.store.replaceBytes(id, plain, { security: null });
  }

  async sign(id: string, options: SignatureOptions): Promise<SignOutcome> {
    const bytes = await this.bytes(id);
    const signed = await signDocument(bytes, options);
    const summary = await this.deps.store.replaceBytes(id, signed);
    return { summary, verification: verifyPdfSignature(signed) };
  }

  async verifySignature(id: string): Promise<SignatureVerification> {
    return verifyPdfSignature(await this.bytes(id));
  }

  createCertificate(options: { name: string; organization?: string; email?: string; password: string; years: number }): CreatedCertificate {
    return createSelfSignedCertificate(options);
  }

  async redact(id: string, options: RedactionOptions, taskId?: string): Promise<RedactOutcome> {
    const bytes = await this.bytes(id);
    const task = this.deps.tasks.begin(taskId, 'Redacting document', 2);
    try {
      const result = await redactDocument(bytes, options, { renderer: this.deps.renderer, paintBoxes: paintBoxesOnImage }, {
        onProgress: (completed, total, label) => task.update(completed, total, label),
        shouldCancel: task.shouldCancel,
      });
      const summary = await this.deps.store.replaceBytes(id, result.bytes);
      return {
        summary,
        verified: result.verified,
        remaining: result.remaining,
        removedTextCount: result.removedTextCount,
        pagesRedacted: result.pagesRedacted,
      };
    } finally {
      task.finish();
    }
  }

  async previewRedactions(id: string, regions: RedactionRegion[], fill: string) {
    const bytes = await this.bytes(id);
    const preview = await previewRedactions(bytes, regions, fill, 150);
    const first = regions[0]?.pageIndex ?? 0;
    return this.deps.renderer.renderPage(preview, first, { dpi: 110 });
  }

  /* ---------------------------------------------------------------------- */
  /* OCR and exports                                                         */
  /* ---------------------------------------------------------------------- */

  async ocr(id: string, options: OcrOptions, taskId?: string): Promise<OcrOutcome> {
    const bytes = await this.bytes(id);
    const info = await this.deps.store.info(id);
    const task = this.deps.tasks.begin(taskId, 'Running OCR', options.pages?.length ?? info.pageCount);
    try {
      const result = await ocrDocument(bytes, options, {
        renderer: this.deps.renderer,
        fonts: this.deps.fonts,
        createWorker: (languages, onProgress) => this.deps.ocr.create(languages, onProgress),
      }, {
        onProgress: (completed, total, label) => task.update(completed, total, label),
        shouldCancel: task.shouldCancel,
      });
      let summary: DocumentSummary | null = null;
      if (options.searchablePdf && result.bytes) {
        summary = await this.deps.store.replaceBytes(id, result.bytes);
      }
      return {
        text: result.text,
        confidence: result.pages.length
          ? Math.round(result.pages.reduce((total, page) => total + page.confidence, 0) / result.pages.length)
          : 0,
        pages: result.pages.map((page) => ({
          pageIndex: page.pageIndex,
          text: page.text,
          confidence: page.confidence,
          words: page.words.length,
        })),
        durationMs: result.durationMs,
        languages: result.languages,
        searchable: Boolean(result.bytes),
        summary,
      };
    } finally {
      task.finish();
    }
  }

  async ocrLanguages(): Promise<{ code: string; name: string; installed: boolean }[]> {
    return availableLanguages(this.deps.ocr.installed());
  }

  async exportImages(
    id: string,
    options: ConvertToImagesOptions & { zip: boolean; directory?: string },
    taskId?: string,
  ): Promise<ExportOutcome> {
    const bytes = await this.bytes(id);
    const summary = this.deps.store.summaryOf(id);
    const base = sanitizeFileName(summary.name.replace(/\.pdf$/i, ''));
    const task = this.deps.tasks.begin(taskId, 'Exporting images', options.pages?.length ?? summary.pageCount);
    try {
      const images = await convertToImages(bytes, options, this.deps.renderer, {
        onProgress: (completed, total, label) => task.update(completed, total, label),
        shouldCancel: task.shouldCancel,
      });
      let directory = options.directory ?? null;
      if (!directory) {
        directory = await this.deps.dialogs.directory(this.window(), options.zip ? 'Choose where to save the ZIP' : 'Choose a folder for the images');
        if (!directory) throw appError('CANCELLED', 'Export cancelled.');
      }
      await mkdir(directory, { recursive: true });
      if (options.zip) {
        const archive = zipFiles(images.map((image) => ({ name: image.name, data: image.data })));
        const zipPath = path.join(directory, `${base}-images.zip`);
        await writeFile(zipPath, archive);
        return { directory, files: [zipPath], zipPath };
      }
      const files: string[] = [];
      for (const image of images) {
        const target = path.join(directory, `${base}-${image.name}`);
        await writeFile(target, image.data);
        files.push(target);
      }
      return { directory, files };
    } finally {
      task.finish();
    }
  }

  async extractImages(id: string, taskId?: string): Promise<{ directory: string; files: string[] }> {
    return this.exportImages(id, { zip: false, format: 'png', dpi: 150, quality: 90, pages: null }, taskId);
  }

  async exportText(id: string, format: TextExportFormat): Promise<{ path: string }> {
    const bytes = await this.bytes(id);
    const summary = this.deps.store.summaryOf(id);
    const base = sanitizeFileName(summary.name.replace(/\.pdf$/i, ''));
    const result = await convertToText(bytes, format, this.deps.renderer, { title: base });
    const extension = format === 'markdown' ? '.md' : format === 'html' ? '.html' : '.txt';
    const target = await this.deps.dialogs.savePdf(this.window(), {
      title: 'Export text',
      defaultPath: `${base}${extension}`,
      filters: [{ name: format.toUpperCase(), extensions: [extension.replace('.', '')] }],
    });
    if (!target) throw appError('CANCELLED', 'Export cancelled.');
    await writeFile(ensureExtension(target, extension), encodeText(result.content));
    return { path: ensureExtension(target, extension) };
  }

  /* ---------------------------------------------------------------------- */
  /* Page furniture, forms, metadata                                         */
  /* ---------------------------------------------------------------------- */

  async watermark(id: string, options: WatermarkOptions): Promise<DocumentSummary> {
    const doc = await loadPdf(await this.bytes(id), this.passwordFor(id));
    await addWatermark(doc, options, this.deps.fonts);
    return this.deps.store.replaceBytes(id, await savePdf(doc));
  }

  async headerFooter(id: string, options: HeaderFooterOptions): Promise<DocumentSummary> {
    const doc = await loadPdf(await this.bytes(id), this.passwordFor(id));
    await addHeaderFooter(doc, options, this.deps.fonts);
    return this.deps.store.replaceBytes(id, await savePdf(doc));
  }

  async formsList(id: string): Promise<FormFieldInfo[]> {
    const doc = await loadPdf(await this.bytes(id), this.passwordFor(id));
    return listFormFields(doc);
  }

  async formsFill(id: string, values: Record<string, FillValue>, flatten: boolean): Promise<DocumentSummary> {
    const doc = await loadPdf(await this.bytes(id), this.passwordFor(id));
    const result = fillForm(doc, values);
    if (result.errors.length) {
      throw appError('INVALID_INPUT', `Some fields could not be filled: ${result.errors.join('; ')}`);
    }
    if (flatten) flattenForm(doc);
    return this.deps.store.replaceBytes(id, await savePdf(doc));
  }

  async formsFlatten(id: string): Promise<DocumentSummary> {
    const doc = await loadPdf(await this.bytes(id), this.passwordFor(id));
    flattenForm(doc);
    return this.deps.store.replaceBytes(id, await savePdf(doc));
  }

  async formsCreate(id: string, fields: FormCreateField[]): Promise<DocumentSummary> {
    const doc = await loadPdf(await this.bytes(id), this.passwordFor(id));
    createFormFields(doc, fields);
    return this.deps.store.replaceBytes(id, await savePdf(doc));
  }

  async setOutline(id: string, items: OutlineEntryInput[]): Promise<DocumentSummary> {
    const doc = await loadPdf(await this.bytes(id), this.passwordFor(id));
    writeOutline(doc, items);
    return this.deps.store.replaceBytes(id, await savePdf(doc));
  }

  async setMetadata(id: string, metadata: PdfMetadata): Promise<DocumentSummary> {
    const { writeMetadata } = await import('../core/pdf/metadata');
    const doc = await loadPdf(await this.bytes(id), this.passwordFor(id));
    writeMetadata(doc, metadata);
    return this.deps.store.replaceBytes(id, await savePdf(doc));
  }

  async attachments(id: string): Promise<AttachmentInfo[]> {
    const doc = await loadPdf(await this.bytes(id), this.passwordFor(id));
    return listAttachments(doc).map((attachment) => ({
      name: attachment.name,
      size: attachment.size,
      ...(attachment.description ? { description: attachment.description } : {}),
    }));
  }

  async addAttachment(id: string, payload: { name: string; data: Uint8Array; description?: string }): Promise<DocumentSummary> {
    const doc = await loadPdf(await this.bytes(id), this.passwordFor(id));
    await addAttachment(doc, payload.name, payload.data, payload.description);
    return this.deps.store.replaceBytes(id, await savePdf(doc));
  }

  async removeAttachment(id: string, name: string): Promise<DocumentSummary> {
    const doc = await loadPdf(await this.bytes(id), this.passwordFor(id));
    if (!removeAttachment(doc, name)) throw appError('NOT_FOUND', `The attachment "${name}" does not exist.`);
    return this.deps.store.replaceBytes(id, await savePdf(doc));
  }

  async extractText(id: string, options: { pages?: number[] | null } = {}): Promise<{ pages: { pageIndex: number; text: string }[]; text: string }> {
    const bytes = await this.bytes(id);
    const pages = await this.deps.renderer.text(bytes, options.pages ? { pages: options.pages } : {});
    return {
      pages: pages.map((page) => ({ pageIndex: page.pageIndex, text: page.text })),
      text: pages.map((page) => page.text).join('\n\n'),
    };
  }

  async validate(id: string): Promise<ValidationReport> {
    const { validateDocument } = await import('../core/pdf/validate');
    const report = await validateDocument(await this.bytes(id), { renderer: this.deps.renderer });
    return report;
  }

  /** Applies a repaired copy when structural validation found leading junk. */
  async repair(id: string, bytes: Uint8Array): Promise<DocumentSummary> {
    return this.deps.store.replaceBytes(id, bytes);
  }

  async searchableText(id: string, pages: { pageIndex: number; text: string; words: { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[]; confidence: number; width: number; height: number }[], dpi: number) {
    const bytes = await this.bytes(id);
    const result = await buildSearchablePdf(bytes, pages, dpi, { renderer: this.deps.renderer, fonts: this.deps.fonts });
    return this.deps.store.replaceBytes(id, result);
  }

  private passwordFor(id: string) {
    const password = this.deps.store.getPassword(id);
    return password !== undefined ? { password } : {};
  }
}
