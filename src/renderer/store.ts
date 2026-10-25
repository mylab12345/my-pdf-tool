import { create } from 'zustand';
import type { DocumentHandle, TaskProgress } from '../shared/ipc';
import type {
  Annotation,
  AppSettings,
  DocumentSummary,
  EnvironmentReport,
  ImageDocumentOptions,
  PdfInfo,
  TextDocumentOptions,
} from '../shared/types';
import { api, errorMessage, run } from './lib/bridge';
import { forgetPdf } from './lib/pdf';

export type ModalName =
  | 'settings'
  | 'ocr'
  | 'compress'
  | 'encrypt'
  | 'sign'
  | 'redact'
  | 'watermark'
  | 'headerFooter'
  | 'convert'
  | 'split'
  | 'merge'
  | 'forms'
  | 'metadata'
  | 'print'
  | 'attachments'
  | 'outline'
  | 'shortcuts'
  | 'about'
  | 'newDocument'
  | 'recovery';

export interface ToastMessage {
  id: string;
  kind: 'info' | 'success' | 'error';
  title: string;
  message?: string;
}

export interface DocEntry {
  summary: DocumentSummary;
  info: PdfInfo | null;
  annotations: Annotation[];
  /** Bumped whenever the bytes change so pdf.js re-reads the document. */
  revision: number;
}

interface AppState {
  ready: boolean;
  docs: Record<string, DocEntry>;
  order: string[];
  activeId: string | null;
  settings: AppSettings | null;
  environment: EnvironmentReport | null;
  fonts: { id: string; family: string; style: string; unicode: boolean; source: string }[];
  tasks: Record<string, TaskProgress>;
  toasts: ToastMessage[];
  modal: ModalName | null;
  busy: string | null;

  init(): Promise<void>;
  absorb(handle: DocumentHandle): Promise<void>;
  refresh(id: string): Promise<void>;
  openPath(path: string): Promise<void>;
  openDialog(): Promise<void>;
  createDocument(options: { pageSize: string; orientation: 'portrait' | 'landscape'; name?: string }): Promise<void>;
  createFromText(options: TextDocumentOptions): Promise<void>;
  createFromImages(options: ImageDocumentOptions): Promise<void>;
  save(id?: string, saveAs?: boolean): Promise<void>;
  close(id: string, force?: boolean): Promise<void>;
  setActive(id: string): void;
  undo(): Promise<void>;
  redo(): Promise<void>;
  apply(operations: Parameters<typeof api.documents.apply>[1], options?: { silent?: boolean }): Promise<void>;
  updateSettings(patch: Partial<AppSettings>): Promise<void>;
  setTask(progress: TaskProgress): void;
  clearTask(taskId: string): void;
  toast(kind: ToastMessage['kind'], title: string, message?: string): void;
  dismissToast(id: string): void;
  setModal(modal: ModalName | null): void;
  setBusy(label: string | null): void;
}

let toastCounter = 0;

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  docs: {},
  order: [],
  activeId: null,
  settings: null,
  environment: null,
  fonts: [],
  tasks: {},
  toasts: [],
  modal: null,
  busy: null,

  async init() {
    try {
      const [settings, environment, fonts, list] = await Promise.all([
        run(api.app.settings()),
        run(api.app.environment()),
        run(api.fonts.list()),
        run(api.documents.list()),
      ]);
      // Merge instead of replace: a document may already have been opened while
      // the initial state was loading.
      set((state) => {
        const docs = { ...state.docs };
        const order = [...state.order];
        for (const summary of list) {
          if (!docs[summary.id]) {
            docs[summary.id] = { summary, info: null, annotations: [], revision: 0 };
            order.push(summary.id);
          }
        }
        const activeId = state.activeId && docs[state.activeId] ? state.activeId : order[0] ?? null;
        return { settings, environment, fonts, docs, order, activeId, ready: true };
      });
      for (const summary of list) await get().refresh(summary.id);
    } catch (error) {
      set({ ready: true });
      get().toast('error', 'Could not start the application', errorMessage(error));
    }
  },

  async absorb(handle) {
    set((state) => ({
      docs: {
        ...state.docs,
        [handle.id]: { summary: handle.summary, info: state.docs[handle.id]?.info ?? null, annotations: [], revision: (state.docs[handle.id]?.revision ?? 0) + 1 },
      },
      order: state.order.includes(handle.id) ? state.order : [...state.order, handle.id],
      activeId: handle.id,
    }));
    await get().refresh(handle.id);
  },

  async refresh(id) {
    try {
      const [summary, info, annotations] = await Promise.all([
        run(api.documents.summary(id)),
        run(api.documents.info(id)),
        run(api.documents.annotations(id)),
      ]);
      set((state) => ({
        docs: {
          ...state.docs,
          [id]: { summary, info, annotations, revision: (state.docs[id]?.revision ?? 0) + 1 },
        },
      }));
    } catch (error) {
      const message = errorMessage(error);
      if (!/not open|unknown|does not exist/i.test(message)) get().toast('error', 'Could not refresh document', message);
    }
  },

  async openPath(path) {
    try {
      const handle = await run(api.documents.open(path));
      await get().absorb(handle);
    } catch (error) {
      get().toast('error', 'Could not open the file', errorMessage(error));
    }
  },

  async openDialog() {
    try {
      const handles = await run(api.documents.openDialog());
      for (const handle of handles) await get().absorb(handle);
    } catch (error) {
      get().toast('error', 'Could not open the file', errorMessage(error));
    }
  },

  async createDocument(options) {
    try {
      const handle = await run(api.documents.create(options as never));
      await get().absorb(handle);
      get().toast('success', 'Blank document created');
      set({ modal: null });
    } catch (error) {
      get().toast('error', 'Could not create the document', errorMessage(error));
    }
  },

  async createFromText(options) {
    try {
      const handle = await run(api.documents.fromText(options));
      await get().absorb(handle);
      get().toast('success', 'PDF created from text');
      set({ modal: null });
    } catch (error) {
      get().toast('error', 'Could not create the PDF', errorMessage(error));
    }
  },

  async createFromImages(options) {
    try {
      const handle = await run(api.documents.fromImages(options));
      await get().absorb(handle);
      get().toast('success', 'PDF created from images');
      set({ modal: null });
    } catch (error) {
      get().toast('error', 'Could not create the PDF', errorMessage(error));
    }
  },

  async save(id, saveAs = false) {
    const target = id ?? get().activeId;
    if (!target) return;
    try {
      const result = saveAs ? await run(api.documents.saveDialog(target)) : await run(api.documents.save(target, {}));
      if (!result) return;
      await get().refresh(target);
      get().toast('success', 'Document saved', result.path);
    } catch (error) {
      get().toast('error', 'The document could not be saved', errorMessage(error));
    }
  },

  async close(id, force = false) {
    const entry = get().docs[id];
    if (!entry) return;
    if (entry.summary.dirty && !force) {
      const confirmed = window.confirm(`“${entry.summary.name}” has unsaved changes. Close without saving?`);
      if (!confirmed) return;
    }
    try {
      await run(api.documents.close(id));
    } catch {
      /* closing a document is best effort */
    }
    set((state) => {
      const docs = { ...state.docs };
      delete docs[id];
      const order = state.order.filter((item) => item !== id);
      return { docs, order, activeId: state.activeId === id ? order[0] ?? null : state.activeId };
    });
  },

  setActive(id) {
    set({ activeId: id });
  },

  async undo() {
    const id = get().activeId;
    if (!id) return;
    try {
      await run(api.documents.undo(id));
      await get().refresh(id);
    } catch (error) {
      get().toast('error', 'Nothing to undo', errorMessage(error));
    }
  },

  async redo() {
    const id = get().activeId;
    if (!id) return;
    try {
      await run(api.documents.redo(id));
      await get().refresh(id);
    } catch (error) {
      get().toast('error', 'Nothing to redo', errorMessage(error));
    }
  },

  async apply(operations, options = {}) {
    const id = get().activeId;
    if (!id) return;
    try {
      await run(api.documents.apply(id, operations));
      await get().refresh(id);
      if (!options.silent) {
        // The change notification also refreshes other views (thumbnails).
        window.dispatchEvent(new CustomEvent('arena:document-changed', { detail: { id } }));
      }
    } catch (error) {
      get().toast('error', 'The change could not be applied', errorMessage(error));
    }
  },

  async updateSettings(patch) {
    try {
      const settings = await run(api.app.updateSettings(patch));
      set({ settings });
    } catch (error) {
      get().toast('error', 'Settings could not be saved', errorMessage(error));
    }
  },

  setTask(progress) {
    set((state) => ({ tasks: { ...state.tasks, [progress.taskId]: progress } }));
  },

  clearTask(taskId) {
    set((state) => {
      const tasks = { ...state.tasks };
      delete tasks[taskId];
      return { tasks };
    });
  },

  toast(kind, title, message) {
    toastCounter += 1;
    const id = `toast-${toastCounter}`;
    set((state) => ({ toasts: [...state.toasts.slice(-4), { id, kind, title, ...(message ? { message } : {}) }] }));
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4000);
  },

  dismissToast(id) {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  },

  setModal(modal) {
    set({ modal });
  },

  setBusy(label) {
    set({ busy: label });
  },
}));

/** Drops cached viewer state for a document that has been closed. */
export function releaseDocument(id: string): void {
  forgetPdf(`arenadoc://session/${encodeURIComponent(id)}`);
}

export const activeEntry = (state: AppState): DocEntry | null => (state.activeId ? state.docs[state.activeId] ?? null : null);

/* -------------------------------------------------------------------------- */
/* View state                                                                  */
/* -------------------------------------------------------------------------- */

export type ToolMode = 'select' | 'highlight' | 'underline' | 'strikeout' | 'ink' | 'square' | 'note' | 'freetext' | 'redact';
export type SidebarTab = 'thumbnails' | 'outline' | 'annotations' | 'search' | 'attachments';
export type FitMode = 'none' | 'width' | 'page';

interface ViewState {
  zoom: number;
  fit: FitMode;
  currentPage: number;
  pageCount: number;
  sidebarOpen: boolean;
  tab: SidebarTab;
  tool: ToolMode;
  color: string;
  strokeWidth: number;
  fontSize: number;
  opacity: number;
  search: string;
  selectedAnnotation: string | null;
  showAnnotations: boolean;

  setZoom(zoom: number, fit?: FitMode): void;
  zoomBy(factor: number): void;
  setFit(fit: FitMode): void;
  setCurrentPage(page: number): void;
  setPageCount(count: number): void;
  toggleSidebar(): void;
  setTab(tab: SidebarTab): void;
  setTool(tool: ToolMode): void;
  setStyle(patch: Partial<Pick<ViewState, 'color' | 'strokeWidth' | 'fontSize' | 'opacity'>>): void;
  setSearch(text: string): void;
  selectAnnotation(id: string | null): void;
  toggleAnnotations(): void;
}

export const useView = create<ViewState>((set, get) => ({
  zoom: 1.15,
  fit: 'width',
  currentPage: 0,
  pageCount: 0,
  sidebarOpen: true,
  tab: 'thumbnails',
  tool: 'select',
  color: '#f5c542',
  strokeWidth: 2,
  fontSize: 12,
  opacity: 1,
  search: '',
  selectedAnnotation: null,
  showAnnotations: true,

  setZoom(zoom, fit = 'none') {
    set({ zoom: Math.min(6, Math.max(0.15, zoom)), fit });
  },
  zoomBy(factor) {
    const { zoom } = get();
    set({ zoom: Math.min(6, Math.max(0.15, zoom * factor)), fit: 'none' });
  },
  setFit(fit) {
    set({ fit });
  },
  setCurrentPage(page) {
    set({ currentPage: Math.max(0, page) });
  },
  setPageCount(count) {
    set({ pageCount: Math.max(0, count) });
  },
  toggleSidebar() {
    set((state) => ({ sidebarOpen: !state.sidebarOpen }));
  },
  setTab(tab) {
    set({ tab, sidebarOpen: true });
  },
  setTool(tool) {
    set({ tool, selectedAnnotation: null });
  },
  setStyle(patch) {
    set(patch);
  },
  setSearch(search) {
    set({ search });
  },
  selectAnnotation(id) {
    set({ selectedAnnotation: id });
  },
  toggleAnnotations() {
    set((state) => ({ showAnnotations: !state.showAnnotations }));
  },
}));
