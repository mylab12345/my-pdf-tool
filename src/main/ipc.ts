import { BrowserWindow, ipcMain, clipboard, app, shell } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { IPC } from '../shared/ipc';
import type {
  CompressionOptions,
  DocumentSummary,
  FillValue,
  HeaderFooterOptions,
  OcrOptions,
  PdfMetadata,
  RedactionOptions,
  Result,
  SecurityOptions,
  SignatureOptions,
  WatermarkOptions,
} from '../shared/types';
import type { DocumentOperation, MergeOptions, PrintOptions, SplitOptions } from '../shared/ipc';
import { appError, normalizeError, toErrorPayload } from '../core/errors';
import { ensureExtension } from '../shared/format';
import type { SessionStore } from './documents/session-store';
import type { FileSystem, showDirectoryDialog, showSavePdfDialog } from './files';
import { openExternalLink, revealInFolder, showOpenPdfDialog } from './files';
import type { Preferences } from './preferences';
import { environmentReport } from './preferences';
import { installedOcrLanguages } from './fonts';
import type { AppPaths } from './paths';
import type { TaskManager } from './tasks';
import type { ToolService } from './tools';
import type { DocumentProtocol } from './protocol';
import { listPrinters, printDocument } from './print';
import type { FontManager } from '../core/pdf/fonts';
import type { PdfRenderer } from '../core/raster/renderer';

export interface IpcDependencies {
  store: SessionStore;
  tools: ToolService;
  paths: AppPaths;
  prefs: Preferences;
  fs: FileSystem;
  fonts: FontManager;
  renderer: PdfRenderer;
  tasks: TaskManager;
  protocol: DocumentProtocol;
  getWindow(): BrowserWindow | null;
  dialogs: { savePdf: typeof showSavePdfDialog; directory: typeof showDirectoryDialog };
  onQuitRequested(): void;
}

/** Wraps a handler so every response is a typed Result (never a thrown error). */
function handle<TArgs extends unknown[], TResult>(
  channel: string,
  handler: (...args: TArgs) => Promise<TResult> | TResult,
): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      const value = await handler(...(args as TArgs));
      return { ok: true, value } satisfies Result<TResult>;
    } catch (error) {
      const payload = toErrorPayload(error);
      if (payload.code !== 'CANCELLED') {
        console.warn(`[ipc] ${channel} failed:`, payload.code, payload.message, payload.details ?? '');
      }
      return { ok: false, error: payload } satisfies Result<TResult>;
    }
  });
}

const idSchema = z.string().min(1).max(200);
const pathSchema = z.string().min(1).max(4096);
const pageListSchema = z.array(z.number().int().min(0)).max(20000);

const textDocumentSchema = z.object({
  title: z.string().max(500),
  text: z.string().max(20_000_000),
  pageSize: z.string().max(20),
  orientation: z.enum(['portrait', 'landscape']),
  fontSize: z.number().min(4).max(96),
  fontFamily: z.string().max(500),
  margin: z.number().min(0).max(300),
  lineHeight: z.number().min(0.8).max(4),
  footer: z.string().max(500).optional(),
});

const securitySchema = z.object({
  userPassword: z.string().max(500).optional(),
  ownerPassword: z.string().max(500).optional(),
  algorithm: z.enum(['AES-256', 'AES-128', 'RC4-128', 'RC4-40']).optional(),
  permissions: z.object({
    printing: z.union([z.boolean(), z.enum(['lowResolution', 'highResolution'])]),
    modifying: z.boolean(),
    copying: z.boolean(),
    annotating: z.boolean(),
    fillingForms: z.boolean(),
    contentAccessibility: z.boolean(),
    documentAssembly: z.boolean(),
  }),
});

const compressionSchema = z.object({
  profile: z.enum(['lossless', 'balanced', 'aggressive', 'custom']),
  dpi: z.number().min(36).max(600).optional(),
  quality: z.number().min(1).max(100).optional(),
  rasterizePages: z.boolean().optional(),
  stripMetadata: z.boolean().optional(),
  imageDpi: z.number().min(36).max(600).optional(),
  grayscale: z.boolean().optional(),
});

const ocrSchema = z.object({
  languages: z.array(z.string().min(2).max(20)).min(1).max(6),
  dpi: z.number().min(72).max(600),
  pages: pageListSchema.nullable().optional(),
  searchablePdf: z.boolean(),
});

const redactionSchema = z.object({
  regions: z
    .array(
      z.object({
        pageIndex: z.number().int().min(0),
        rects: z.array(z.object({ x: z.number(), y: z.number(), width: z.number().min(0), height: z.number().min(0) })).max(500),
      }),
    )
    .max(2000),
  fill: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  scrubMetadata: z.boolean(),
  dpi: z.number().min(72).max(600),
  verifyStrings: z.array(z.string().max(500)).max(200).optional(),
});

const signatureSchema = z.object({
  image: z.string().max(30_000_000).optional(),
  p12: z.string().max(5_000_000).optional(),
  p12Password: z.string().max(500).optional(),
  reason: z.string().max(500).optional(),
  location: z.string().max(500).optional(),
  contactInfo: z.string().max(500).optional(),
  signerName: z.string().max(500).optional(),
  digital: z.boolean(),
  pageIndex: z.number().int().min(0),
  rect: z.object({ x: z.number(), y: z.number(), width: z.number().min(0), height: z.number().min(0) }),
});

const printSchema = z.object({
  printerName: z.string().max(500).optional(),
  silent: z.boolean(),
  pages: z.string().max(200).optional(),
  copies: z.number().int().min(1).max(99).optional(),
  landscape: z.boolean().optional(),
  scale: z.enum(['fit', 'actual']).optional(),
  duplex: z.enum(['simplex', 'short-edge', 'long-edge']).optional(),
  color: z.boolean().optional(),
  heading: z.string().max(300).optional(),
});

const operationSchema: z.ZodType<DocumentOperation> = z.any() as z.ZodType<DocumentOperation>;

export function registerIpcHandlers(deps: IpcDependencies): void {
  const { store, tools, prefs, fs, fonts, renderer, tasks, protocol } = deps;

  /* ---------------------------------------------------------------------- */
  /* Application                                                             */
  /* ---------------------------------------------------------------------- */

  handle(IPC.app.environment, async () =>
    environmentReport(deps.paths, {
      fontsBundled: fonts.list().filter((font) => font.source === 'bundled').length,
      ocrLanguages: installedOcrLanguages(deps.paths),
      capabilities: { printing: true, clipboardImages: true, fileAssociations: process.platform !== 'darwin' },
    }),
  );

  handle(IPC.app.settingsGet, () => prefs.all());

  handle(IPC.app.settingsUpdate, (patch: unknown) => {
    const parsed = z.record(z.string(), z.unknown()).parse(patch) as Record<string, unknown>;
    return prefs.update(parsed as never);
  });

  handle(IPC.app.recentFiles, () => prefs.recentFiles());

  handle(IPC.app.revealPath, (filePath: unknown) => {
    revealInFolder(pathSchema.parse(filePath));
    return null;
  });

  handle(IPC.app.openExternal, async (url: unknown) => {
    await openExternalLink(z.string().url().max(2048).parse(url));
    return null;
  });

  handle(IPC.app.openPathDialog, async () => showOpenPdfDialog(deps.getWindow()));

  handle(IPC.app.quit, () => {
    deps.onQuitRequested();
    return null;
  });

  handle(IPC.app.report, async () => {
    const environment = await environmentReport(deps.paths, {
      fontsBundled: fonts.list().length,
      ocrLanguages: installedOcrLanguages(deps.paths),
      capabilities: { printing: true, clipboardImages: true, fileAssociations: true },
    });
    return [
      `Arena PDF Studio ${environment.appVersion}`,
      `Platform: ${environment.platform} (${environment.arch})`,
      `Electron ${environment.electronVersion} · Chromium ${environment.chromeVersion} · Node ${environment.nodeVersion}`,
      `Fonts: ${environment.fontsBundled} (bundled) / ${fonts.list().length} total`,
      `OCR languages: ${environment.ocrLanguages.join(', ') || 'none'}`,
      `Documents: ${store.summaries().length} open`,
      `User data: ${environment.paths.userData}`,
    ].join('\n');
  });

  /* ---------------------------------------------------------------------- */
  /* Documents                                                               */
  /* ---------------------------------------------------------------------- */

  handle(IPC.documents.open, async (filePath: unknown, options: unknown) => {
    const target = pathSchema.parse(filePath);
    const password = z.object({ password: z.string().max(500).optional() }).optional().parse(options);
    const summary = await store.openPath(target, password?.password !== undefined ? { password: password.password } : {});
    prefs.addRecent({ path: target, name: summary.name, openedAt: new Date().toISOString(), size: summary.fileSize });
    return { id: summary.id, summary };
  });

  handle(IPC.documents.openDialog, async () => {
    const paths = await showOpenPdfDialog(deps.getWindow());
    const handles = [];
    for (const filePath of paths) {
      const summary = await store.openPath(filePath);
      prefs.addRecent({ path: filePath, name: summary.name, openedAt: new Date().toISOString(), size: summary.fileSize });
      handles.push({ id: summary.id, summary });
    }
    return handles;
  });

  handle(IPC.documents.create, async (options: unknown) => {
    const parsed = z
      .object({ pageSize: z.string(), orientation: z.enum(['portrait', 'landscape']), name: z.string().optional() })
      .parse(options);
    const summary = await store.createBlank(parsed as never);
    return { id: summary.id, summary };
  });

  handle(IPC.documents.fromText, async (options: unknown) => {
    const parsed = textDocumentSchema.parse(options);
    const summary = await store.createFromText(parsed as never);
    return { id: summary.id, summary };
  });

  handle(IPC.documents.fromImages, async (options: unknown) => {
    const parsed = z
      .object({
        images: z.array(z.object({ name: z.string().max(400), dataUrl: z.string().max(60_000_000) })).min(1).max(2000),
        pageSize: z.string(),
        orientation: z.enum(['portrait', 'landscape']),
        margin: z.number().min(0).max(200),
        onePerPage: z.boolean(),
      })
      .parse(options);
    const images = parsed.images.map((image) => ({
      name: image.name,
      bytes: Buffer.from(image.dataUrl.replace(/^data:[^,]*,/, ''), 'base64'),
    }));
    const summary = await store.createFromImages({ ...parsed, images }, 'Images.pdf');
    return { id: summary.id, summary };
  });

  handle(IPC.documents.summary, (id: unknown) => store.summaryOf(idSchema.parse(id)));
  handle(IPC.documents.list, () => store.summaries());
  handle(IPC.documents.info, (id: unknown) => store.info(idSchema.parse(id)));

  handle(IPC.documents.close, (id: unknown) => {
    store.close(idSchema.parse(id));
    return null;
  });

  handle(IPC.documents.save, async (id: unknown, options: unknown) => {
    const docId = idSchema.parse(id);
    const parsed = z
      .object({ path: z.string().optional(), keepBackup: z.boolean().optional(), incremental: z.boolean().optional() })
      .optional()
      .parse(options);
    const result = await store.save(docId, {
      ...(parsed?.path ? { path: parsed.path } : {}),
      ...(parsed?.keepBackup ? { keepBackup: true } : {}),
    });
    const summary = store.summaryOf(docId);
    if (summary.path) {
      prefs.addRecent({ path: summary.path, name: summary.name, openedAt: new Date().toISOString(), size: summary.fileSize });
    }
    return result;
  });

  handle(IPC.documents.saveDialog, async (id: unknown) => {
    const docId = idSchema.parse(id);
    const summary = store.summaryOf(docId);
    const target = await deps.dialogs.savePdf(deps.getWindow(), {
      title: 'Save PDF as',
      ...(summary.path ? { defaultPath: summary.path } : { defaultPath: summary.name }),
    });
    if (!target) return null;
    const result = await store.save(docId, { path: ensureExtension(target, '.pdf') });
    prefs.addRecent({ path: result.path, name: store.summaryOf(docId).name, openedAt: new Date().toISOString(), size: store.summaryOf(docId).fileSize });
    return result;
  });

  handle(IPC.documents.saveTo, (id: unknown, target: unknown, options: unknown) => {
    const docId = idSchema.parse(id);
    const filePath = ensureExtension(pathSchema.parse(target), '.pdf');
    const parsed = z.object({ keepBackup: z.boolean().optional() }).optional().parse(options);
    return store.save(docId, { path: filePath, ...(parsed?.keepBackup ? { keepBackup: true } : {}) });
  });

  handle(IPC.documents.undo, (id: unknown) => store.undo(idSchema.parse(id)));
  handle(IPC.documents.redo, (id: unknown) => store.redo(idSchema.parse(id)));

  handle(IPC.documents.apply, async (id: unknown, operations: unknown) => {
    const docId = idSchema.parse(id);
    const list = z.array(operationSchema).min(1).max(2000).parse(operations);
    return store.apply(docId, list);
  });

  handle(IPC.documents.annotations, (id: unknown) => store.annotations(idSchema.parse(id)));

  handle(IPC.documents.renderPage, async (id: unknown, pageIndex: unknown, dpi: unknown) => {
    const docId = idSchema.parse(id);
    const page = z.number().int().min(0).parse(pageIndex);
    const resolution = z.number().min(36).max(600).optional().parse(dpi) ?? 110;
    const bytes = await store.documentFor(docId);
    return renderer.renderPage(bytes, page, { dpi: resolution, format: 'png' });
  });

  handle(IPC.documents.url, (id: unknown, revision: unknown) => {
    const docId = idSchema.parse(id);
    // The revision comes from the store, so the URL changes whenever the
    // document changes and pdf.js never serves a stale cached parse.
    const rev = z.number().int().min(0).optional().parse(revision) ?? store.revisionOf(docId);
    return protocol.sessionUrl(docId, rev);
  });

  /* ---------------------------------------------------------------------- */
  /* Tools                                                                   */
  /* ---------------------------------------------------------------------- */

  handle(IPC.tools.merge, (options: unknown) => {
    const parsed = z
      .object({
        documentIds: z.array(idSchema).min(2).max(200),
        outputPath: z.string().optional(),
        keepOriginalOpen: z.boolean().optional(),
      })
      .parse(options);
    return tools.merge(parsed as MergeOptions);
  });

  handle(IPC.tools.split, (id: unknown, options: unknown) => {
    const parsed = z
      .object({
        mode: z.enum(['every', 'ranges', 'boundaries']),
        every: z.number().int().min(1).max(10_000).optional(),
        ranges: z.string().max(20_000).optional(),
        boundaries: z.array(z.number().int().min(1)).max(10_000).optional(),
        outputDirectory: z.string().optional(),
      })
      .parse(options);
    return tools.split(idSchema.parse(id), parsed as SplitOptions);
  });

  handle(IPC.tools.compress, (id: unknown, options: unknown, taskId: unknown) =>
    tools.compress(idSchema.parse(id), compressionSchema.parse(options) as CompressionOptions, z.string().optional().parse(taskId)),
  );

  handle(IPC.tools.encrypt, (id: unknown, options: unknown) =>
    tools.encrypt(idSchema.parse(id), securitySchema.parse(options) as SecurityOptions),
  );

  handle(IPC.tools.decrypt, (id: unknown, ownerPassword: unknown) =>
    tools.decrypt(idSchema.parse(id), z.string().max(500).parse(ownerPassword)),
  );

  handle(IPC.tools.exportImages, (id: unknown, options: unknown, taskId: unknown) => {
    const parsed = z
      .object({
        format: z.enum(['png', 'jpeg']),
        dpi: z.number().min(36).max(600),
        quality: z.number().min(1).max(100),
        pages: pageListSchema.nullable().optional(),
        grayscale: z.boolean().optional(),
        zip: z.boolean(),
        directory: z.string().optional(),
      })
      .parse(options);
    return tools.exportImages(idSchema.parse(id), parsed, z.string().optional().parse(taskId));
  });

  handle(IPC.tools.exportText, (id: unknown, format: unknown) =>
    tools.exportText(idSchema.parse(id), z.enum(['txt', 'markdown', 'html']).parse(format)),
  );

  handle(IPC.tools.ocr, (id: unknown, options: unknown, taskId: unknown) =>
    tools.ocr(idSchema.parse(id), ocrSchema.parse(options) as OcrOptions, z.string().optional().parse(taskId)),
  );

  handle(IPC.tools.ocrLanguages, () => tools.ocrLanguages());

  handle(IPC.tools.importOcrLanguage, async () => {
    const files = await deps.dialogs.savePdf(deps.getWindow(), {
      title: 'Import tesseract language file',
      filters: [{ name: 'Traineddata', extensions: ['traineddata', 'gz'] }],
    });
    if (!files) return null;
    const code = await (deps as unknown as { ocr: { importLanguageFile(path: string): Promise<string> } }).ocr.importLanguageFile(files);
    return { code };
  });

  handle(IPC.tools.sign, (id: unknown, options: unknown) =>
    tools.sign(idSchema.parse(id), signatureSchema.parse(options) as SignatureOptions),
  );

  handle(IPC.tools.verifySignature, (id: unknown) => tools.verifySignature(idSchema.parse(id)));

  handle(IPC.tools.createCertificate, (options: unknown) => {
    const parsed = z
      .object({
        name: z.string().min(1).max(200),
        organization: z.string().max(200).optional(),
        email: z.string().max(200).optional(),
        password: z.string().min(6).max(200),
        years: z.number().int().min(1).max(20),
      })
      .parse(options);
    return tools.createCertificate(parsed);
  });

  handle(IPC.tools.redact, (id: unknown, options: unknown, taskId: unknown) =>
    tools.redact(idSchema.parse(id), redactionSchema.parse(options) as RedactionOptions, z.string().optional().parse(taskId)),
  );

  handle(IPC.tools.previewRedactions, (id: unknown, regions: unknown, fill: unknown) =>
    tools.previewRedactions(
      idSchema.parse(id),
      redactionSchema.shape.regions.parse(regions) as never,
      z.string().regex(/^#[0-9a-fA-F]{6}$/).parse(fill),
    ),
  );

  handle(IPC.tools.watermark, (id: unknown, options: unknown) => {
    const parsed = z
      .object({
        text: z.string().max(2000).optional(),
        image: z.string().max(30_000_000).optional(),
        fontSize: z.number().min(4).max(400),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        opacity: z.number().min(0.01).max(1),
        rotation: z.number().min(-180).max(180),
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        tile: z.boolean(),
        scale: z.number().min(0.05).max(1),
        fontFamily: z.string().max(500),
        pages: pageListSchema.nullable().optional(),
      })
      .parse(options);
    return tools.watermark(idSchema.parse(id), parsed as WatermarkOptions);
  });

  handle(IPC.tools.headerFooter, (id: unknown, options: unknown) => {
    const parsed = z
      .object({
        headerLeft: z.string().max(500).optional(),
        headerCenter: z.string().max(500).optional(),
        headerRight: z.string().max(500).optional(),
        footerLeft: z.string().max(500).optional(),
        footerCenter: z.string().max(500).optional(),
        footerRight: z.string().max(500).optional(),
        fontSize: z.number().min(4).max(48),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        margin: z.number().min(4).max(200),
        fontFamily: z.string().max(500),
        firstPageNumber: z.number().int().min(1).max(100_000),
        pageNumberFormat: z.string().max(100),
        includeOnFirstPage: z.boolean(),
        pages: pageListSchema.nullable().optional(),
      })
      .parse(options);
    return tools.headerFooter(idSchema.parse(id), parsed as HeaderFooterOptions);
  });

  handle(IPC.tools.formsList, (id: unknown) => tools.formsList(idSchema.parse(id)));

  handle(IPC.tools.formsFill, (id: unknown, values: unknown, flatten: unknown) => {
    const parsed = z.record(
      z.string().max(400),
      z.object({ type: z.enum(['text', 'checkbox', 'radio', 'dropdown', 'optionlist']), value: z.union([z.string().max(10_000), z.boolean()]) }),
    ).parse(values) as Record<string, FillValue>;
    return tools.formsFill(idSchema.parse(id), parsed, z.boolean().parse(flatten));
  });

  handle(IPC.tools.formsFlatten, (id: unknown) => tools.formsFlatten(idSchema.parse(id)));

  handle(IPC.tools.formsCreate, (id: unknown, fields: unknown) => {
    const parsed = z
      .array(
        z.object({
          kind: z.enum(['text', 'checkbox', 'radio', 'dropdown']),
          name: z.string().min(1).max(200),
          pageIndex: z.number().int().min(0),
          rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
          options: z.array(z.string().max(500)).max(200).optional(),
          required: z.boolean().optional(),
          multiline: z.boolean().optional(),
          fontSize: z.number().min(4).max(72).optional(),
        }),
      )
      .min(1)
      .max(200)
      .parse(fields);
    return tools.formsCreate(idSchema.parse(id), parsed as never);
  });

  handle(IPC.tools.validate, (id: unknown) => tools.validate(idSchema.parse(id)));

  handle(IPC.tools.extractText, (id: unknown, options: unknown) => {
    const parsed = z.object({ pages: pageListSchema.nullable().optional() }).optional().parse(options);
    return tools.extractText(idSchema.parse(id), parsed ?? {});
  });

  handle(IPC.tools.extractImages, (id: unknown, taskId: unknown) =>
    tools.extractImages(idSchema.parse(id), z.string().optional().parse(taskId)),
  );

  handle(IPC.tools.attachmentsList, (id: unknown) => tools.attachments(idSchema.parse(id)));

  handle(IPC.tools.attachmentsAdd, async (id: unknown, payload: unknown) => {
    const parsed = z
      .object({ name: z.string().min(1).max(255), data: z.instanceof(Uint8Array), description: z.string().max(500).optional() })
      .parse(payload);
    return tools.addAttachment(idSchema.parse(id), parsed);
  });

  handle(IPC.tools.attachmentsExtract, async (id: unknown, name: unknown) => {
    const docId = idSchema.parse(id);
    const attachmentName = z.string().min(1).max(255).parse(name);
    const { loadPdf } = await import('../core/pdf/loader');
    const { listAttachments } = await import('../core/pdf/metadata');
    const doc = await loadPdf(await store.documentFor(docId));
    const attachment = listAttachments(doc).find((entry) => entry.name === attachmentName);
    if (!attachment) throw appError('NOT_FOUND', `The attachment "${attachmentName}" does not exist.`);
    const target = await deps.dialogs.savePdf(deps.getWindow(), { title: 'Save attachment', defaultPath: attachment.name });
    if (!target) throw appError('CANCELLED', 'Cancelled.');
    await writeFile(target, attachment.bytes);
    return { name: attachment.name, data: attachment.bytes };
  });

  handle(IPC.tools.attachmentsRemove, (id: unknown, name: unknown) =>
    tools.removeAttachment(idSchema.parse(id), z.string().min(1).max(255).parse(name)),
  );

  handle(IPC.tools.setOutline, (id: unknown, items: unknown) => {
    const parsed = z
      .array(
        z.object({
          title: z.string().min(1).max(500),
          pageIndex: z.number().int().min(0).nullable(),
          children: z
            .array(z.object({ title: z.string().min(1).max(500), pageIndex: z.number().int().min(0).nullable() }))
            .max(200),
        }),
      )
      .max(500)
      .parse(items);
    return tools.setOutline(idSchema.parse(id), parsed);
  });

  handle(IPC.tools.setMetadata, (id: unknown, metadata: unknown) => {
    const parsed = z
      .object({
        title: z.string().max(500).optional(),
        author: z.string().max(500).optional(),
        subject: z.string().max(1000).optional(),
        keywords: z.array(z.string().max(200)).max(100).optional(),
        creator: z.string().max(500).optional(),
        producer: z.string().max(500).optional(),
      })
      .parse(metadata);
    return tools.setMetadata(idSchema.parse(id), parsed as PdfMetadata);
  });

  /* ---------------------------------------------------------------------- */
  /* Files                                                                   */
  /* ---------------------------------------------------------------------- */

  handle(IPC.files.read, async (filePath: unknown) => fs.readFile(pathSchema.parse(filePath)));

  handle(IPC.files.write, async (filePath: unknown, data: unknown) => {
    const target = pathSchema.parse(filePath);
    const bytes = z.instanceof(Uint8Array).parse(data);
    await fs.writeFile(target, bytes);
    return { path: target };
  });

  handle(IPC.files.pickSave, async (options: unknown) => {
    const parsed = z
      .object({
        title: z.string().max(200).optional(),
        defaultPath: z.string().max(4096).optional(),
        filters: z.array(z.object({ name: z.string().max(100), extensions: z.array(z.string().max(20)).max(20) })).max(20).optional(),
      })
      .optional()
      .parse(options);
    return deps.dialogs.savePdf(deps.getWindow(), parsed ?? {});
  });

  handle(IPC.files.pickDirectory, async (title: unknown) => deps.dialogs.directory(deps.getWindow(), z.string().max(200).optional().parse(title) ?? 'Choose a folder'));

  handle(IPC.files.writeMany, async (files: unknown) => {
    const parsed = z
      .array(z.object({ path: pathSchema, data: z.instanceof(Uint8Array) }))
      .min(1)
      .max(5000)
      .parse(files);
    const directories = new Set(parsed.map((file) => path.dirname(file.path)));
    if (directories.size !== 1) throw appError('INVALID_INPUT', 'All files must be written into the same folder.');
    const directory = await deps.dialogs.directory(deps.getWindow(), 'Choose a folder');
    if (!directory) return { files: [], canceled: true };
    await mkdir(directory, { recursive: true });
    const written: string[] = [];
    for (const file of parsed) {
      const target = path.join(directory, path.basename(file.path));
      await fs.writeFile(target, file.data);
      written.push(target);
    }
    return { files: written, canceled: false };
  });

  handle(IPC.files.tempFile, async (name: unknown) => {
    const safe = path.basename(z.string().min(1).max(255).parse(name));
    const target = path.join(deps.paths.temp, `${Date.now()}-${safe}`);
    await mkdir(deps.paths.temp, { recursive: true });
    return target;
  });

  /* ---------------------------------------------------------------------- */
  /* Printing                                                                */
  /* ---------------------------------------------------------------------- */

  handle(IPC.print.print, async (id: unknown, options: unknown) => {
    const docId = idSchema.parse(id);
    const parsed = printSchema.parse(options) as PrintOptions;
    return printDocument(docId, parsed, {
      loadDocument: (sessionId) => store.documentFor(sessionId),
      registerPrintable: (bytes) => protocol.registerBlob(bytes),
    });
  });

  handle(IPC.print.pageToPdf, async (id: unknown, pageIndex: unknown) => {
    const docId = idSchema.parse(id);
    const page = z.number().int().min(0).parse(pageIndex);
    const { extractPages } = await import('../core/pdf/pages');
    const bytes = await extractPages(await store.documentFor(docId), [page]);
    return { data: bytes, name: `page-${page + 1}.pdf` };
  });

  handle(IPC.print.printers, () => listPrinters(deps.getWindow()));

  /* ---------------------------------------------------------------------- */
  /* Fonts, clipboard, tasks                                                 */
  /* ---------------------------------------------------------------------- */

  handle(IPC.fonts.list, () => fonts.list());

  handle(IPC.clipboard.writeText, (text: unknown) => {
    clipboard.writeText(z.string().max(5_000_000).parse(text));
    return null;
  });

  handle(IPC.clipboard.readText, () => clipboard.readText());

  handle(IPC.tasks.cancel, (taskId: unknown) => {
    tasks.cancel(z.string().min(1).max(200).parse(taskId));
    return null;
  });
}

/** Removes all handlers (used when the app is asked to reload its window). */
export function unregisterIpcHandlers(): void {
  for (const group of Object.values(IPC)) {
    for (const channel of Object.values(group)) ipcMain.removeHandler(channel);
  }
}

export { app, shell };
