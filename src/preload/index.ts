import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC, IPC_EVENTS } from '../shared/ipc';
import type {
  DocumentChangedEvent,
  MenuCommand,
  OpenFileRequest,
  PdfApi,
  TaskProgress,
} from '../shared/ipc';
import type { AppSettings, DocumentSummary, RecentFile } from '../shared/types';

/**
 * The only bridge between the sandboxed renderer and the main process.
 *
 * Nothing is exposed implicitly: each method maps to exactly one IPC channel and
 * every channel returns a discriminated `Result`, so a failing operation can
 * never reject an unhandled promise in the UI. Node/Electron internals stay out
 * of the renderer's reach — no `fs`, no `path`, no `require`.
 */

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: PdfApi = {
  app: {
    environment: () => ipcRenderer.invoke(IPC.app.environment),
    settings: () => ipcRenderer.invoke(IPC.app.settingsGet),
    updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.app.settingsUpdate, patch),
    recentFiles: () => ipcRenderer.invoke(IPC.app.recentFiles) as Promise<{ ok: true; value: RecentFile[] } | { ok: false; error: never }>,
    revealPath: (target: string) => ipcRenderer.invoke(IPC.app.revealPath, target),
    openExternal: (url: string) => ipcRenderer.invoke(IPC.app.openExternal, url),
    quit: () => ipcRenderer.invoke(IPC.app.quit),
    onMenuCommand: (listener: (command: MenuCommand) => void) => subscribe<MenuCommand>(IPC_EVENTS.menuCommand, listener),
    onOpenFile: (listener: (request: OpenFileRequest) => void) => subscribe<OpenFileRequest>(IPC_EVENTS.openFileRequest, listener),
    onTaskProgress: (listener: (progress: TaskProgress) => void) => subscribe<TaskProgress>(IPC_EVENTS.taskProgress, listener),
    onDocumentChanged: (listener: (event: DocumentChangedEvent) => void) => subscribe<DocumentChangedEvent>(IPC_EVENTS.documentChanged, listener),
    onRecoveryAvailable: (listener: (files: { path: string; name: string; modified: string }[]) => void) =>
      subscribe<{ path: string; name: string; modified: string }[]>(IPC_EVENTS.recoveryAvailable, listener),
    cancelTask: (taskId: string) => ipcRenderer.invoke(IPC.tasks.cancel, taskId),
    report: () => ipcRenderer.invoke(IPC.app.report),
  },

  documents: {
    open: (target, options) => ipcRenderer.invoke(IPC.documents.open, target, options ?? {}),
    openDialog: () => ipcRenderer.invoke(IPC.documents.openDialog),
    create: (options) => ipcRenderer.invoke(IPC.documents.create, options),
    fromText: (options) => ipcRenderer.invoke(IPC.documents.fromText, options),
    fromImages: (options) => ipcRenderer.invoke(IPC.documents.fromImages, options),
    summary: (id) => ipcRenderer.invoke(IPC.documents.summary, id),
    list: () => ipcRenderer.invoke(IPC.documents.list),
    info: (id) => ipcRenderer.invoke(IPC.documents.info, id),
    close: (id) => ipcRenderer.invoke(IPC.documents.close, id),
    save: (id, options) => ipcRenderer.invoke(IPC.documents.save, id, options ?? {}),
    saveDialog: (id) => ipcRenderer.invoke(IPC.documents.saveDialog, id),
    saveTo: (id, target, options) => ipcRenderer.invoke(IPC.documents.saveTo, id, target, options ?? {}),
    undo: (id) => ipcRenderer.invoke(IPC.documents.undo, id),
    redo: (id) => ipcRenderer.invoke(IPC.documents.redo, id),
    apply: (id, operations) => ipcRenderer.invoke(IPC.documents.apply, id, operations),
    annotations: (id) => ipcRenderer.invoke(IPC.documents.annotations, id),
    renderPage: (id, pageIndex, dpi) => ipcRenderer.invoke(IPC.documents.renderPage, id, pageIndex, dpi),
    url: (id) => ipcRenderer.invoke(IPC.documents.url, id),
  },

  tools: {
    merge: (options) => ipcRenderer.invoke(IPC.tools.merge, options),
    split: (id, options) => ipcRenderer.invoke(IPC.tools.split, id, options),
    compress: (id, options, taskId) => ipcRenderer.invoke(IPC.tools.compress, id, options, taskId),
    encrypt: (id, options) => ipcRenderer.invoke(IPC.tools.encrypt, id, options),
    decrypt: (id, ownerPassword) => ipcRenderer.invoke(IPC.tools.decrypt, id, ownerPassword),
    exportImages: (id, options, taskId) => ipcRenderer.invoke(IPC.tools.exportImages, id, options, taskId),
    exportText: (id, format) => ipcRenderer.invoke(IPC.tools.exportText, id, format),
    ocr: (id, options, taskId) => ipcRenderer.invoke(IPC.tools.ocr, id, options, taskId),
    ocrLanguages: () => ipcRenderer.invoke(IPC.tools.ocrLanguages),
    importOcrLanguage: () => ipcRenderer.invoke(IPC.tools.importOcrLanguage),
    sign: (id, options) => ipcRenderer.invoke(IPC.tools.sign, id, options),
    verifySignature: (id) => ipcRenderer.invoke(IPC.tools.verifySignature, id),
    createCertificate: (options) => ipcRenderer.invoke(IPC.tools.createCertificate, options),
    redact: (id, options, taskId) => ipcRenderer.invoke(IPC.tools.redact, id, options, taskId),
    previewRedactions: (id, regions, fill) => ipcRenderer.invoke(IPC.tools.previewRedactions, id, regions, fill),
    watermark: (id, options) => ipcRenderer.invoke(IPC.tools.watermark, id, options),
    headerFooter: (id, options) => ipcRenderer.invoke(IPC.tools.headerFooter, id, options),
    formsList: (id) => ipcRenderer.invoke(IPC.tools.formsList, id),
    formsFill: (id, values, flatten) => ipcRenderer.invoke(IPC.tools.formsFill, id, values, flatten),
    formsFlatten: (id) => ipcRenderer.invoke(IPC.tools.formsFlatten, id),
    formsCreate: (id, fields) => ipcRenderer.invoke(IPC.tools.formsCreate, id, fields),
    validate: (id) => ipcRenderer.invoke(IPC.tools.validate, id),
    extractText: (id, options) => ipcRenderer.invoke(IPC.tools.extractText, id, options ?? {}),
    extractImages: (id, taskId) => ipcRenderer.invoke(IPC.tools.extractImages, id, taskId),
    attachmentsList: (id) => ipcRenderer.invoke(IPC.tools.attachmentsList, id),
    attachmentsAdd: (id, payload) => ipcRenderer.invoke(IPC.tools.attachmentsAdd, id, payload),
    attachmentsExtract: (id, name) => ipcRenderer.invoke(IPC.tools.attachmentsExtract, id, name),
    attachmentsRemove: (id, name) => ipcRenderer.invoke(IPC.tools.attachmentsRemove, id, name),
    setOutline: (id, items) => ipcRenderer.invoke(IPC.tools.setOutline, id, items),
    setMetadata: (id, metadata) => ipcRenderer.invoke(IPC.tools.setMetadata, id, metadata),
  },

  files: {
    read: (target) => ipcRenderer.invoke(IPC.files.read, target),
    write: (target, data) => ipcRenderer.invoke(IPC.files.write, target, data),
    writeMany: (files) => ipcRenderer.invoke(IPC.files.writeMany, files),
    pickSave: (options) => ipcRenderer.invoke(IPC.files.pickSave, options),
    pickDirectory: (title) => ipcRenderer.invoke(IPC.files.pickDirectory, title),
  },

  print: {
    print: (id, options) => ipcRenderer.invoke(IPC.print.print, id, options),
    pageToPdf: (id, pageIndex) => ipcRenderer.invoke(IPC.print.pageToPdf, id, pageIndex),
    printers: () => ipcRenderer.invoke(IPC.print.printers),
  },

  fonts: {
    list: () => ipcRenderer.invoke(IPC.fonts.list),
  },

  clipboard: {
    writeText: (text) => ipcRenderer.invoke(IPC.clipboard.writeText, text),
    readText: () => ipcRenderer.invoke(IPC.clipboard.readText),
  },

  recovery: {
    list: () => ipcRenderer.invoke(IPC.app.recoveryList),
    restore: (entryPath) => ipcRenderer.invoke(IPC.app.recoveryRestore, entryPath),
    discard: (entryPath) => ipcRenderer.invoke(IPC.app.recoveryDiscard, entryPath),
  },

  window: {
    state: () => ipcRenderer.invoke(IPC.app.windowState),
    toggleMaximize: () => ipcRenderer.invoke(IPC.app.windowToggleMaximize),
    onStateChange: (listener: (state: { maximized: boolean; fullScreen: boolean }) => void) =>
      subscribe<{ maximized: boolean; fullScreen: boolean }>(IPC_EVENTS.windowState, listener),
  },
};

/**
 * Drag-and-drop: turn an OS file drop into a real path the main process can open.
 * `webUtils.getPathForFile` is the only supported way to resolve a dropped File
 * to a filesystem path in current Electron versions (`File.path` was removed).
 */
function pathForFile(file: File): string {
  try {
    return webUtils.getPathForFile(file);
  } catch {
    return '';
  }
}

contextBridge.exposeInMainWorld('arena', {
  ...api,
  /** Extra helpers that only make sense in the renderer. */
  dragDropPath: (file: File): string => pathForFile(file),
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});

export type ArenaBridge = PdfApi & {
  dragDropPath(file: File): string;
  platform: string;
  versions: { electron: string; chrome: string; node: string };
};

export type DocumentSummaryPayload = DocumentSummary;
