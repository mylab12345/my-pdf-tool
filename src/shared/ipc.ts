import type {
  Annotation,
  AnnotationInput,
  AppSettings,
  CompressionOptions,
  CompressionResult,
  ConvertToImagesOptions,
  CreatedCertificate,
  DocumentSummary,
  EnvironmentReport,
  FillValue,
  FormFieldInfo,
  ImageDocumentOptions,
  TextDocumentOptions,
  FontInfo,
  HeaderFooterOptions,
  OcrOptions,
  OcrResult,
  PageOrientation,
  PageSizeName,
  PdfInfo,
  RedactionOptions,
  RedactionRegion,
  RedactionResult,
  RecentFile,
  RenderedPage,
  Result,
  SecurityOptions,
  SignatureOptions,
  SignatureVerification,
  TextExportFormat,
  WatermarkOptions,
  PdfMetadata,
} from './types';

/* -------------------------------------------------------------------------- */
/* Channels                                                                    */
/* -------------------------------------------------------------------------- */

export const IPC = {
  app: {
    environment: 'app:environment',
    settingsGet: 'app:settings:get',
    settingsUpdate: 'app:settings:update',
    recentFiles: 'app:recent-files',
    revealPath: 'app:reveal-path',
    openExternal: 'app:open-external',
    openPathDialog: 'app:open-path-dialog',
    quit: 'app:quit',
    report: 'app:report',
    recoveryList: 'app:recovery:list',
    recoveryRestore: 'app:recovery:restore',
    recoveryDiscard: 'app:recovery:discard',
    windowState: 'app:window:state',
    windowToggleMaximize: 'app:window:toggle-maximize',
  },
  documents: {
    open: 'doc:open',
    openDialog: 'doc:open-dialog',
    create: 'doc:create',
    fromText: 'doc:from-text',
    fromImages: 'doc:from-images',
    summary: 'doc:summary',
    list: 'doc:list',
    info: 'doc:info',
    close: 'doc:close',
    save: 'doc:save',
    saveDialog: 'doc:save-dialog',
    saveTo: 'doc:save-to',
    undo: 'doc:undo',
    redo: 'doc:redo',
    apply: 'doc:apply',
    annotations: 'doc:annotations',
    renderPage: 'doc:render-page',
    url: 'doc:url',
  },
  tools: {
    merge: 'tools:merge',
    split: 'tools:split',
    compress: 'tools:compress',
    encrypt: 'tools:encrypt',
    decrypt: 'tools:decrypt',
    exportImages: 'tools:export-images',
    exportText: 'tools:export-text',
    ocr: 'tools:ocr',
    ocrLanguages: 'tools:ocr-languages',
    importOcrLanguage: 'tools:ocr-language-import',
    sign: 'tools:sign',
    verifySignature: 'tools:verify-signature',
    createCertificate: 'tools:create-certificate',
    redact: 'tools:redact',
    previewRedactions: 'tools:redact-preview',
    watermark: 'tools:watermark',
    headerFooter: 'tools:header-footer',
    formsList: 'tools:forms-list',
    formsFill: 'tools:forms-fill',
    formsFlatten: 'tools:forms-flatten',
    formsCreate: 'tools:forms-create',
    validate: 'tools:validate',
    extractText: 'tools:extract-text',
    extractImages: 'tools:extract-images',
    attachmentsList: 'tools:attachments-list',
    attachmentsAdd: 'tools:attachments-add',
    attachmentsExtract: 'tools:attachments-extract',
    attachmentsRemove: 'tools:attachments-remove',
    setOutline: 'tools:set-outline',
    setMetadata: 'tools:set-metadata',
  },
  files: {
    read: 'files:read',
    write: 'files:write',
    pickSave: 'files:pick-save',
    pickDirectory: 'files:pick-directory',
    writeMany: 'files:write-many',
    tempFile: 'files:temp-file',
  },
  print: {
    print: 'print:print',
    pageToPdf: 'print:page-to-pdf',
    printers: 'print:printers',
  },
  fonts: { list: 'fonts:list' },
  clipboard: { writeText: 'clipboard:write-text', readText: 'clipboard:read-text' },
  tasks: { cancel: 'tasks:cancel' },
} as const;

/** Events pushed from main to renderer. */
export const IPC_EVENTS = {
  menuCommand: 'event:menu-command',
  openFileRequest: 'event:open-file',
  taskProgress: 'event:task-progress',
  documentChanged: 'event:document-changed',
  windowState: 'event:window-state',
  recoveryAvailable: 'event:recovery-available',
} as const;

export type MenuCommand =
  | 'file:new'
  | 'file:open'
  | 'file:save'
  | 'file:saveAs'
  | 'file:print'
  | 'file:close'
  | 'edit:undo'
  | 'edit:redo'
  | 'edit:find'
  | 'edit:delete-annotations'
  | 'view:zoom-in'
  | 'view:zoom-out'
  | 'view:fit-width'
  | 'view:fit-page'
  | 'view:rotate-left'
  | 'view:rotate-right'
  | 'view:sidebar'
  | 'tools:ocr'
  | 'tools:compress'
  | 'tools:encrypt'
  | 'tools:convert'
  | 'tools:sign'
  | 'tools:redact'
  | 'tools:watermark'
  | 'tools:forms'
  | 'tools:merge'
  | 'tools:split'
  | 'tools:settings'
  | 'help:shortcuts'
  | 'help:about';

export interface TaskProgress {
  taskId: string;
  label: string;
  phase?: string;
  completed: number;
  total: number;
  /** 0-100 shortcut for rendering. */
  percent: number;
  cancellable: boolean;
}

export interface DocumentChangedEvent {
  id: string;
  revision: number;
  summary: DocumentSummary;
}

export interface OpenFileRequest {
  paths: string[];
  /** Present when the app was launched by a double-click on a .pdf file. */
  source: 'argv' | 'second-instance' | 'mac-open-file' | 'dialog' | 'association';
}

/* -------------------------------------------------------------------------- */
/* Operation payloads                                                          */
/* -------------------------------------------------------------------------- */

export type DocumentOperation =
  | { kind: 'deletePages'; pages: number[] }
  | { kind: 'rotatePages'; pages: number[]; degrees: 90 | 180 | 270 | -90 | -180 | -270 }
  | { kind: 'movePage'; from: number; to: number }
  | { kind: 'duplicatePages'; pages: number[] }
  | { kind: 'insertBlankPage'; at: number; size: PageSizeName; orientation: PageOrientation; customSize?: { width: number; height: number } }
  | { kind: 'insertPagesFrom'; sourceBytes: Uint8Array; sourceName: string; pages: number[]; at: number }
  | { kind: 'cropPages'; pages: number[]; box: { x: number; y: number; width: number; height: number } }
  | { kind: 'resizePages'; pages: number[]; size: PageSizeName; orientation: PageOrientation; scaleContent: boolean }
  | { kind: 'reorderPages'; order: number[] }
  | { kind: 'setMetadata'; metadata: PdfMetadata }
  | { kind: 'addAnnotation'; annotation: AnnotationInput }
  | { kind: 'updateAnnotation'; id: string; annotation: AnnotationInput }
  | { kind: 'removeAnnotation'; id: string }
  | { kind: 'addImage'; pageIndex: number; rect: { x: number; y: number; width: number; height: number }; dataUrl: string; opacity?: number }
  | { kind: 'replaceText'; pageIndex: number; rect: { x: number; y: number; width: number; height: number }; text: string; fontSize: number; fontFamily: string; color: string; background: string }
  | { kind: 'flattenAnnotations'; pages?: number[] | null }
  | { kind: 'setOutline'; items: { title: string; pageIndex: number | null; children: { title: string; pageIndex: number | null }[] }[] };

export interface DocumentHandle {
  id: string;
  summary: DocumentSummary;
}

export interface SaveOptionsPayload {
  path?: string;
  /** Re-encrypt with a new password on save (null removes protection). */
  security?: SecurityOptions | null;
  /** Use incremental update for speed (annotation-only changes). */
  incremental?: boolean;
  keepBackup?: boolean;
}

export interface OpenOptionsPayload {
  password?: string;
  /** Open read-only without prompting again. */
  readOnly?: boolean;
}

export interface SplitOptions {
  mode: 'every' | 'ranges' | 'boundaries';
  every?: number;
  ranges?: string;
  boundaries?: number[];
  outputDirectory?: string;
}

export interface MergeOptions {
  /** Document ids in merge order; the first one becomes the target. */
  documentIds: string[];
  outputPath?: string;
  keepOriginalOpen?: boolean;
}

export interface PrintOptions {
  printerName?: string;
  silent: boolean;
  pages?: string;
  copies?: number;
  landscape?: boolean;
  scale?: 'fit' | 'actual';
  duplex?: 'simplex' | 'short-edge' | 'long-edge';
  color?: boolean;
  heading?: string;
}

export interface PrintResult {
  printed: boolean;
  printerName?: string;
  message?: string;
}

export interface FormCreateField {
  kind: 'text' | 'checkbox' | 'radio' | 'dropdown';
  name: string;
  pageIndex: number;
  rect: { x: number; y: number; width: number; height: number };
  options?: string[];
  required?: boolean;
  multiline?: boolean;
  fontSize?: number;
}

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  pageIndex?: number;
}

export interface ValidationReport {
  valid: boolean;
  pageCount: number;
  issues: ValidationIssue[];
  repairedBytes?: Uint8Array;
  durationMs: number;
}

/* -------------------------------------------------------------------------- */
/* The API exposed to the renderer through the preload bridge                  */
/* -------------------------------------------------------------------------- */

export interface DocumentApi {
  open(path: string, options?: OpenOptionsPayload): Promise<Result<DocumentHandle>>;
  openDialog(): Promise<Result<DocumentHandle[]>>;
  create(options: { pageSize: PageSizeName; orientation: PageOrientation; name?: string }): Promise<Result<DocumentHandle>>;
  fromText(options: TextDocumentOptions): Promise<Result<DocumentHandle>>;
  fromImages(options: ImageDocumentOptions): Promise<Result<DocumentHandle>>;
  summary(id: string): Promise<Result<DocumentSummary>>;
  list(): Promise<Result<DocumentSummary[]>>;
  info(id: string): Promise<Result<PdfInfo>>;
  close(id: string): Promise<Result<void>>;
  save(id: string, options?: SaveOptionsPayload): Promise<Result<{ path: string }>>;
  saveDialog(id: string): Promise<Result<{ path: string } | null>>;
  saveTo(id: string, path: string, options?: SaveOptionsPayload): Promise<Result<{ path: string }>>;
  undo(id: string): Promise<Result<DocumentSummary>>;
  redo(id: string): Promise<Result<DocumentSummary>>;
  apply(id: string, operations: DocumentOperation[]): Promise<Result<DocumentSummary>>;
  annotations(id: string): Promise<Result<Annotation[]>>;
  renderPage(id: string, pageIndex: number, dpi?: number): Promise<Result<RenderedPage>>;
  /** URL served by the main process for pdf.js (supports byte ranges). */
  url(id: string): Promise<Result<string>>;
}

export interface ExportOptions extends ConvertToImagesOptions {
  /** Pack the images into a ZIP archive instead of writing them individually. */
  zip: boolean;
  /** Target directory (defaults to a folder picker). */
  directory?: string;
}

export interface ExportOutcome {
  directory: string;
  files: string[];
  zipPath?: string;
}

export interface OcrOutcome {
  text: string;
  confidence: number;
  pages: { pageIndex: number; text: string; confidence: number; words: number }[];
  durationMs: number;
  languages: string[];
  searchable: boolean;
  summary: DocumentSummary | null;
}

export interface CompressOutcome {
  result: CompressionResult;
  summary: DocumentSummary;
}

export interface RedactOutcome {
  summary: DocumentSummary;
  verified: boolean;
  remaining: string[];
  removedTextCount: number;
  pagesRedacted: number;
}

export interface SignOutcome {
  summary: DocumentSummary;
  verification: SignatureVerification;
}

export interface ToolsApi {
  merge(options: MergeOptions): Promise<Result<DocumentSummary>>;
  split(id: string, options: SplitOptions): Promise<Result<{ files: string[] }>>;
  compress(id: string, options: CompressionOptions, taskId?: string): Promise<Result<CompressOutcome>>;
  encrypt(id: string, options: SecurityOptions): Promise<Result<DocumentSummary>>;
  decrypt(id: string, ownerPassword: string): Promise<Result<DocumentSummary>>;
  exportImages(id: string, options: ExportOptions, taskId?: string): Promise<Result<ExportOutcome>>;
  exportText(id: string, format: TextExportFormat): Promise<Result<{ path: string }>>;
  ocr(id: string, options: OcrOptions, taskId?: string): Promise<Result<OcrOutcome>>;
  ocrLanguages(): Promise<Result<{ code: string; name: string; installed: boolean }[]>>;
  importOcrLanguage(): Promise<Result<{ code: string } | null>>;
  sign(id: string, options: SignatureOptions): Promise<Result<SignOutcome>>;
  verifySignature(id: string): Promise<Result<SignatureVerification>>;
  createCertificate(options: { name: string; organization?: string; email?: string; password: string; years: number }): Promise<Result<CreatedCertificate>>;
  redact(id: string, options: RedactionOptions, taskId?: string): Promise<Result<RedactOutcome>>;
  watermark(id: string, options: WatermarkOptions): Promise<Result<DocumentSummary>>;
  headerFooter(id: string, options: HeaderFooterOptions): Promise<Result<DocumentSummary>>;
  formsList(id: string): Promise<Result<FormFieldInfo[]>>;
  formsFill(id: string, values: Record<string, FillValue>, flatten: boolean): Promise<Result<DocumentSummary>>;
  formsFlatten(id: string): Promise<Result<DocumentSummary>>;
  formsCreate(id: string, fields: FormCreateField[]): Promise<Result<DocumentSummary>>;
  validate(id: string): Promise<Result<ValidationReport>>;
  extractText(id: string, options?: { pages?: number[] | null }): Promise<Result<{ pages: { pageIndex: number; text: string }[]; text: string }>>;
  extractImages(id: string, taskId?: string): Promise<Result<{ directory: string; files: string[] }>>;
  attachmentsList(id: string): Promise<Result<{ name: string; size: number; description?: string }[]>>;
  attachmentsAdd(id: string, payload: { name: string; data: Uint8Array; description?: string }): Promise<Result<DocumentSummary>>;
  attachmentsExtract(id: string, name: string): Promise<Result<{ name: string; data: Uint8Array }>>;
  attachmentsRemove(id: string, name: string): Promise<Result<DocumentSummary>>;
  setOutline(id: string, items: OutlineEntryInput[]): Promise<Result<DocumentSummary>>;
  setMetadata(id: string, metadata: PdfMetadata): Promise<Result<DocumentSummary>>;
  previewRedactions(id: string, regions: RedactionRegion[], fill: string): Promise<Result<RenderedPage>>;
}

export interface OutlineEntryInput {
  title: string;
  pageIndex: number | null;
  children: { title: string; pageIndex: number | null }[];
}

export interface FilesApi {
  read(path: string): Promise<Result<Uint8Array>>;
  write(path: string, data: Uint8Array): Promise<Result<{ path: string }>>;
  writeMany(files: { path: string; data: Uint8Array }[]): Promise<Result<{ files: string[]; canceled: boolean }>>;
  pickSave(options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<Result<string | null>>;
  pickDirectory(title?: string): Promise<Result<string | null>>;
}

export interface AppApi {
  environment(): Promise<Result<EnvironmentReport>>;
  settings(): Promise<Result<AppSettings>>;
  updateSettings(patch: Partial<AppSettings>): Promise<Result<AppSettings>>;
  recentFiles(): Promise<Result<RecentFile[]>>;
  revealPath(path: string): Promise<Result<void>>;
  openExternal(url: string): Promise<Result<void>>;
  quit(): Promise<Result<void>>;
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
  onOpenFile(listener: (request: OpenFileRequest) => void): () => void;
  onTaskProgress(listener: (progress: TaskProgress) => void): () => void;
  onDocumentChanged(listener: (event: DocumentChangedEvent) => void): () => void;
  onRecoveryAvailable(listener: (files: { path: string; name: string; modified: string }[]) => void): () => void;
  cancelTask(taskId: string): Promise<Result<void>>;
  report(): Promise<Result<string>>;
}

export interface PrintApi {
  print(id: string, options: PrintOptions): Promise<Result<PrintResult>>;
  pageToPdf(id: string, pageIndex: number): Promise<Result<{ data: Uint8Array; name: string }>>;
  printers(): Promise<Result<{ name: string; isDefault: boolean }[]>>;
}

export interface ClipboardApi {
  writeText(text: string): Promise<Result<void>>;
  readText(): Promise<Result<string>>;
}

export interface FontsApi {
  list(): Promise<Result<FontInfo[]>>;
}

export interface RecoveryApi {
  /** Snapshots left behind by a crash, newest first. */
  list(): Promise<Result<{ path: string; name: string; modified: string }[]>>;
  restore(path: string): Promise<Result<DocumentHandle>>;
  discard(path: string): Promise<Result<void>>;
}

export interface WindowApi {
  state(): Promise<Result<{ maximized: boolean; fullScreen: boolean; platform: string }>>;
  toggleMaximize(): Promise<Result<void>>;
  /** Fires when the window is maximised, restored or goes full screen. */
  onStateChange(listener: (state: { maximized: boolean; fullScreen: boolean }) => void): () => void;
}

export interface PdfApi {
  app: AppApi;
  recovery: RecoveryApi;
  window: WindowApi;
  documents: DocumentApi;
  tools: ToolsApi;
  files: FilesApi;
  print: PrintApi;
  fonts: FontsApi;
  clipboard: ClipboardApi;
}
