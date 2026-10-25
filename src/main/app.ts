import { BrowserWindow, app, dialog, ipcMain, nativeTheme, screen, session, shell } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { IPC, IPC_EVENTS, type MenuCommand, type TaskProgress } from '../shared/ipc';
import type { DocumentSummary } from '../shared/types';
import { PROTOCOL_SCHEME } from '../shared/constants';
import { PdfRenderer } from '../core/raster/renderer';
import { createNodeRendererDependencies } from './pdf/node-pdfjs';
import { SessionStore } from './documents/session-store';
import { ToolService } from './tools';
import { FileSystem, showDirectoryDialog, showOpenPdfDialog, showSavePdfDialog } from './files';
import { createFontManager, installedOcrLanguages } from './fonts';
import { createOcrWorkerFactory } from './ocr-engine';
import { DocumentProtocol, registerSchemes } from './protocol';
import { TaskManager } from './tasks';
import { Preferences } from './preferences';
import { resolveAppPaths, type AppPaths } from './paths';
import { RecoveryService } from './recovery';
import { installApplicationMenu } from './menu';
import { registerIpcHandlers } from './ipc';

/**
 * Application entry point.
 *
 * Startup order matters: the custom schemes must be registered before `ready`,
 * the document protocol needs the session store, and the window is only created
 * once every IPC handler exists so the renderer can call anything immediately.
 */

const DEV_SERVER_URL = process.env.ARENA_DEV_SERVER_URL ?? process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:5199';

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
}

let mainWindow: BrowserWindow | null = null;
let paths: AppPaths;
let preferences: Preferences;
let store: SessionStore;
let tools: ToolService;
let tasks: TaskManager;
let recovery: RecoveryService;
let protocol: DocumentProtocol;
let fontManager: ReturnType<typeof createFontManager>;
let ocr: ReturnType<typeof createOcrWorkerFactory>;
let quitting = false;
const revisions = new Map<string, number>();

const isDev = !app.isPackaged;
function log(...args: unknown[]): void {
  if (isDev) console.log('[main]', ...args);
}

/* -------------------------------------------------------------------------- */
/* Window state                                                                */
/* -------------------------------------------------------------------------- */

function statePath(): string {
  return path.join(paths.userData, 'window-state.json');
}

function loadWindowState(): WindowState {
  const defaults: WindowState = { width: 1360, height: 900, maximized: false };
  try {
    if (!existsSync(statePath())) return defaults;
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<WindowState>;
    const display = screen.getPrimaryDisplay().workAreaSize;
    return {
      width: clamp(parsed.width, 900, display.width),
      height: clamp(parsed.height, 600, display.height),
      ...(typeof parsed.x === 'number' ? { x: parsed.x } : {}),
      ...(typeof parsed.y === 'number' ? { y: parsed.y } : {}),
      maximized: Boolean(parsed.maximized),
    };
  } catch {
    return defaults;
  }
}

function saveWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getNormalBounds();
  const state: WindowState = {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    maximized: mainWindow.isMaximized(),
  };
  try {
    writeFileSync(statePath(), JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

function clamp(value: number | undefined, min: number, max: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return Math.max(min, Math.min(max, min));
  return Math.max(min, Math.min(max, Math.round(value)));
}

/* -------------------------------------------------------------------------- */
/* Windows                                                                     */
/* -------------------------------------------------------------------------- */

function rendererRoot(): string {
  return path.join(app.getAppPath(), 'dist', 'renderer');
}

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createMainWindow(): BrowserWindow {
  const state = loadWindowState();
  const window = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14141a' : '#f6f7f9',
    title: 'Arena PDF Studio',
    icon: iconPath(),
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
      // Chromium's built-in PDF viewer is used for printing.
      plugins: true,
    },
  });

  window.once('ready-to-show', () => {
    if (state.maximized) window.maximize();
    window.show();
  });

  window.on('closed', () => {
    mainWindow = null;
  });

  window.on('close', (event) => {
    if (quitting) return;
    if (!hasUnsavedChanges()) return;
    event.preventDefault();
    void confirmClose(() => {
      quitting = true;
      window.close();
    });
  });

  // Never navigate away from the app; open external links in the browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${PROTOCOL_SCHEME}://`) && !url.startsWith(DEV_SERVER_URL)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });

  const target = isDev && process.env.ARENA_NO_DEV_SERVER !== '1' ? DEV_SERVER_URL : `${PROTOCOL_SCHEME}://app/index.html`;
  void window.loadURL(target).catch((error) => {
    log('failed to load renderer:', (error as Error).message);
  });

  return window;
}

function iconPath(): string | undefined {
  const candidate = path.join(app.getAppPath(), 'build', 'icon.png');
  return existsSync(candidate) ? candidate : undefined;
}

/* -------------------------------------------------------------------------- */
/* Unsaved changes                                                             */
/* -------------------------------------------------------------------------- */

function hasUnsavedChanges(): boolean {
  return store.dirtySessions().length > 0;
}

async function confirmClose(onConfirm: () => void): Promise<void> {
  const dirty = store.dirtySessions();
  if (!preferences.get('confirmOnClose') || dirty.length === 0) {
    onConfirm();
    return;
  }
  const window = mainWindow;
  const options = {
    type: 'warning' as const,
    buttons: ['Save and close', 'Discard changes', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Unsaved changes',
    message: dirty.length === 1 ? `Save changes to “${dirty[0]!.name}” before closing?` : `Save changes to ${dirty.length} documents before closing?`,
    detail: 'Unsaved edits will be lost if you close without saving.',
  };
  const response = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  if (response.response === 2) return;
  if (response.response === 0) {
    for (const summary of dirty) {
      try {
        if (summary.path) {
          await store.save(summary.id);
        } else {
          const target = await showSavePdfDialog(window, { title: 'Save PDF as', defaultPath: summary.name });
          if (!target) return; // user cancelled the save dialog → keep the window open
          await store.save(summary.id, { path: target });
        }
      } catch (error) {
        await dialog.showMessageBox({
          type: 'error',
          message: `Could not save “${summary.name}”`,
          detail: (error as Error).message,
          buttons: ['OK'],
        });
        return;
      }
    }
  }
  onConfirm();
}

/* -------------------------------------------------------------------------- */
/* File opening                                                                */
/* -------------------------------------------------------------------------- */

function pdfPathsFromArgv(argv: string[]): string[] {
  return argv
    .slice(1)
    .filter((argument) => !argument.startsWith('-'))
    .filter((argument) => argument.toLowerCase().endsWith('.pdf'))
    .filter((argument) => existsSync(argument));
}

async function announceOpenRequest(pathsToOpen: string[], source: 'argv' | 'second-instance' | 'mac-open-file' | 'association'): Promise<void> {
  if (!pathsToOpen.length) return;
  const waitForWindow = async (): Promise<BrowserWindow> => {
    const window = await waitForMainWindow();
    if (window.webContents.isLoading()) {
      await new Promise<void>((resolve) => window.webContents.once('did-finish-load', () => resolve()));
    }
    return window;
  };
  const window = await waitForWindow();
  window.webContents.send(IPC_EVENTS.openFileRequest, { paths: pathsToOpen, source });
}

async function waitForMainWindow(): Promise<BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        clearInterval(interval);
        resolve(mainWindow);
      }
    }, 50);
  });
}

/** Restores recovery snapshots left behind by a crash. */
async function offerRecovery(): Promise<void> {
  const entries = await recovery.list();
  if (!entries.length) return;
  const window = await waitForMainWindow();
  const response = await dialog.showMessageBox(window, {
    type: 'question',
    buttons: ['Recover now', 'Discard'],
    defaultId: 0,
    cancelId: 1,
    title: 'Recover unsaved work',
    message: `${entries.length} unsaved document${entries.length === 1 ? '' : 's'} from the last session can be recovered.`,
    detail: entries.map((entry) => `• ${entry.name} (${new Date(entry.modified).toLocaleString()})`).join('\n'),
  });
  if (response.response === 0) {
    window.webContents.send(IPC_EVENTS.recoveryAvailable, entries.map((entry) => ({ path: entry.path, name: entry.name, modified: entry.modified })));
  } else {
    recovery.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                      */
/* -------------------------------------------------------------------------- */

function bootstrapServices(): void {
  paths = resolveAppPaths();
  preferences = new Preferences(paths);
  nativeTheme.themeSource = preferences.get('theme');

  const fs = new FileSystem();
  fontManager = createFontManager(paths);
  const renderer = new PdfRenderer(createNodeRendererDependencies());
  ocr = createOcrWorkerFactory(paths);

  tasks = new TaskManager((progress: TaskProgress) => send(IPC_EVENTS.taskProgress, progress));

  protocol = new DocumentProtocol({
    bytesForSession: (sessionId) => store.documentFor(sessionId),
  });

  const changedRevisions = (summary: DocumentSummary): void => {
    const revision = (revisions.get(summary.id) ?? 0) + 1;
    revisions.set(summary.id, revision);
    send(IPC_EVENTS.documentChanged, { id: summary.id, revision, summary });
  };

  store = new SessionStore({ renderer, fonts: fontManager, fs, onChanged: changedRevisions });

  tools = new ToolService({
    store,
    renderer,
    fonts: fontManager,
    fs,
    paths,
    tasks,
    ocr,
    getWindow: () => mainWindow,
    dialogs: { savePdf: showSavePdfDialog, directory: showDirectoryDialog },
  });

  recovery = new RecoveryService(paths, store);

  registerIpcHandlers({
    store,
    tools,
    paths,
    prefs: preferences,
    fs,
    fonts: fontManager,
    renderer,
    tasks,
    protocol,
    getWindow: () => mainWindow,
    dialogs: { savePdf: showSavePdfDialog, directory: showDirectoryDialog },
    onQuitRequested: () => {
      void confirmClose(() => {
        quitting = true;
        app.quit();
      });
    },
  });

  registerExtraHandlers();

  refreshMenu();
}

function refreshMenu(): void {
  installApplicationMenu({
    recentFiles: preferences.recentFiles(),
    isDev,
    getWindow: () => mainWindow,
    send: (command: MenuCommand) => send(IPC_EVENTS.menuCommand, command),
    openRecent: (recentPath) => {
      void announceOpenRequest([recentPath], 'association');
    },
    clearRecent: () => {
      preferences.clearRecent();
      refreshMenu();
    },
  });
}

/**
 * Handlers that need the whole app graph (recovery, printing extras) and are not
 * part of the stateless IPC layer.
 */
function registerExtraHandlers(): void {
  ipcMain.handle('app:recovery:list', async () => {
    try {
      return { ok: true, value: await recovery.list() };
    } catch (error) {
      return { ok: false, error: { code: 'INTERNAL', message: (error as Error).message } };
    }
  });
  ipcMain.handle('app:recovery:restore', async (_event, entryPath: string) => {
    try {
      const bytes = await recovery.read(entryPath);
      const summary = await store.openBytes(bytes, { name: path.basename(entryPath).replace(/\.pdf$/i, '.pdf') });
      recovery.remove(entryPath);
      return { ok: true, value: { id: summary.id, summary } };
    } catch (error) {
      return { ok: false, error: { code: 'RECOVERY_FAILED', message: (error as Error).message } };
    }
  });
  ipcMain.handle('app:recovery:discard', async (_event, entryPath: string) => {
    recovery.remove(entryPath);
    return { ok: true, value: null };
  });
  ipcMain.handle('app:window:state', () => ({
    ok: true,
    value: {
      maximized: mainWindow?.isMaximized() ?? false,
      fullScreen: mainWindow?.isFullScreen() ?? false,
      platform: process.platform,
    },
  }));
  ipcMain.handle('app:window:toggle-maximize', () => {
    if (!mainWindow) return { ok: true, value: null };
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { ok: true, value: null };
  });
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

export function start(): void {
  registerSchemes();

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    void announceOpenRequest(pdfPathsFromArgv(argv), 'second-instance');
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    void announceOpenRequest([filePath], 'mac-open-file');
  });

  app.whenReady().then(async () => {
    bootstrapServices();
    protocol.install(rendererRoot());

    // Harden the renderer session: no remote content, no permission prompts.
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === 'clipboard-sanitized-write');
    });

    mainWindow = createMainWindow();
    mainWindow.on('resize', saveWindowState);
    mainWindow.on('move', saveWindowState);
    const pushWindowState = (): void => {
      send(IPC_EVENTS.windowState, {
        maximized: mainWindow?.isMaximized() ?? false,
        fullScreen: mainWindow?.isFullScreen() ?? false,
      });
    };
    mainWindow.on('maximize', pushWindowState);
    mainWindow.on('unmaximize', pushWindowState);
    mainWindow.on('enter-full-screen', pushWindowState);
    mainWindow.on('leave-full-screen', pushWindowState);

    const autosave = preferences.get('autosaveEnabled');
    if (autosave) recovery.start(preferences.get('autosaveIntervalSeconds'));

    mainWindow.webContents.once('did-finish-load', () => {
      void offerRecovery();
      const argv = pdfPathsFromArgv(process.argv);
      if (argv.length) void announceOpenRequest(argv, 'argv');
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    recovery?.stop();
    if (preferences?.get('autosaveEnabled')) {
      // Best effort, synchronous-ish flush of unsaved work.
      void recovery?.snapshot().catch(() => undefined);
    }
  });

  app.on('will-quit', () => {
    saveWindowState();
    store?.closeAll();
  });

  process.on('uncaughtException', (error) => {
    console.error('[main] uncaught exception:', error);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[main] unhandled rejection:', reason);
  });

  log('ready');
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
