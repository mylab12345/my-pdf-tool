import { vi } from 'vitest';
import type { Result } from '../../src/shared/types';

/**
 * Renderer test environment.
 *
 * jsdom has no Electron preload bridge, so `window.arena` is replaced with a
 * stub whose methods all resolve successfully. Individual tests override the
 * calls they care about. Browser APIs that jsdom does not implement
 * (ResizeObserver, IntersectionObserver, matchMedia) get minimal shims.
 */

export const ok = <T,>(value: T): Promise<Result<T>> => Promise.resolve({ ok: true, value });

const hasDom = typeof window !== 'undefined';

const METHODS: Record<string, string[]> = {
  app: [
    'environment',
    'settings',
    'updateSettings',
    'recentFiles',
    'revealPath',
    'openExternal',
    'quit',
    'onMenuCommand',
    'onOpenFile',
    'onTaskProgress',
    'onDocumentChanged',
    'onRecoveryAvailable',
    'cancelTask',
    'report',
  ],
  documents: ['open', 'openDialog', 'create', 'fromText', 'fromImages', 'summary', 'list', 'info', 'close', 'save', 'saveDialog', 'saveTo', 'undo', 'redo', 'apply', 'annotations', 'renderPage', 'url'],
  tools: [
    'merge',
    'split',
    'compress',
    'encrypt',
    'decrypt',
    'exportImages',
    'exportText',
    'ocr',
    'ocrLanguages',
    'importOcrLanguage',
    'sign',
    'verifySignature',
    'createCertificate',
    'redact',
    'previewRedactions',
    'watermark',
    'headerFooter',
    'formsList',
    'formsFill',
    'formsFlatten',
    'formsCreate',
    'validate',
    'extractText',
    'extractImages',
    'attachmentsList',
    'attachmentsAdd',
    'attachmentsExtract',
    'attachmentsRemove',
    'setOutline',
    'setMetadata',
  ],
  files: ['read', 'write', 'pickSave', 'pickDirectory', 'writeMany'],
  print: ['print', 'pageToPdf', 'printers'],
  fonts: ['list'],
  clipboard: ['writeText', 'readText'],
  recovery: ['list', 'restore', 'discard'],
  window: ['state', 'toggleMaximize', 'onStateChange'],
};

function emptyNamespace(name: string): Record<string, unknown> {
  const namespace: Record<string, unknown> = {};
  for (const method of METHODS[name] ?? []) {
    // Event subscriptions must return an unsubscribe function, everything else
    // resolves with an empty successful result.
    namespace[method] = method.startsWith('on') ? vi.fn(() => () => undefined) : vi.fn(() => ok(null));
  }
  return namespace;
}

export function createBridge() {
  const bridge: Record<string, Record<string, unknown>> = {};
  for (const name of Object.keys(METHODS)) bridge[name] = emptyNamespace(name);
  return {
    ...bridge,
    app: {
      ...bridge.app,
      settings: vi.fn(() =>
        ok({
          theme: 'light',
          accent: '#3b6ef6',
          defaultPageSize: 'A4',
          defaultOrientation: 'portrait',
          autosaveEnabled: true,
          autosaveIntervalSeconds: 60,
          maxRecentFiles: 12,
          confirmOnClose: true,
          defaultOcrLanguages: ['eng'],
          defaultCompressionProfile: 'balanced',
          renderDpi: 110,
          showSidebar: true,
          printScale: 'fit',
          language: 'en',
          checkAssociationsOnStart: false,
        }),
      ),
      environment: vi.fn(() =>
        ok({
          platform: 'linux (6.1)',
          arch: 'x64',
          osVersion: 'Linux 6.1',
          appVersion: '1.0.0',
          electronVersion: '45.0.0',
          chromeVersion: '140.0.0',
          nodeVersion: '22.22.3',
          locale: 'en-US',
          totalMemoryMb: 8192,
          cpuCount: 8,
          fontsBundled: 3,
          ocrLanguages: ['eng'],
          paths: { documents: '/docs', downloads: '/dl', userData: '/data', temp: '/tmp' },
          capabilities: { printing: true, clipboardImages: true, fileAssociations: true, nativeDialogs: true, dragAndDrop: true },
        }),
      ),
      recentFiles: vi.fn(() => ok([])),
      updateSettings: vi.fn((patch: unknown) => ok(patch)),
      report: vi.fn(() => ok('Arena PDF Studio 1.0.0')),
    },
    documents: {
      ...bridge.documents,
      list: vi.fn(() => ok([])),
      openDialog: vi.fn(() => ok([])),
      create: vi.fn(() => ok({ id: 'doc-1', summary: summary() })),
      summary: vi.fn(() => ok(summary())),
      info: vi.fn(() =>
        ok({
          fileSize: 1024,
          pageCount: 1,
          pages: [],
          metadata: {},
          encrypted: false,
          hasForms: false,
          formFields: [],
          hasSignatures: false,
          outline: [],
          attachments: [],
          textCharacters: 10,
        }),
      ),
      annotations: vi.fn(() => ok([])),
      url: vi.fn(() => ok('arenadoc://session/doc-1?rev=1')),
    },
    fonts: { ...bridge.fonts, list: vi.fn(() => ok([])) },
    tools: {
      ...bridge.tools,
      ocrLanguages: vi.fn(() => ok([{ code: 'eng', name: 'English', installed: true }])),
      attachmentsList: vi.fn(() => ok([])),
      extractText: vi.fn(() => ok({ pages: [], text: '' })),
      validate: vi.fn(() => ok({ valid: true, pageCount: 1, issues: [], durationMs: 3 })),
    },
    print: { ...bridge.print, printers: vi.fn(() => ok([{ name: 'PDF', isDefault: true }])) },
    recovery: { ...bridge.recovery, list: vi.fn(() => ok([])) },
    window: {
      ...bridge.window,
      state: vi.fn(() => ok({ maximized: false, fullScreen: false, platform: 'linux' })),
    },
    clipboard: { ...bridge.clipboard, writeText: vi.fn(() => ok(null)), readText: vi.fn(() => ok('')) },
    dragDropPath: vi.fn(() => ''),
    platform: 'linux',
    versions: { electron: '45.0.0', chrome: '140.0.0', node: '22.22.3' },
  };
}

function summary() {
  return {
    id: 'doc-1',
    path: null,
    name: 'Untitled.pdf',
    pageCount: 1,
    fileSize: 1024,
    dirty: false,
    encrypted: false,
    canUndo: false,
    canRedo: false,
  };
}

class StubObserver {
  observe(): void {
    /* no-op */
  }
  unobserve(): void {
    /* no-op */
  }
  disconnect(): void {
    /* no-op */
  }
  takeRecords(): [] {
    return [];
  }
}

if (!hasDom) {
  // Node-based suites import this file only because it is a global setup file.
} else {
  installDomShims();
}

function installDomShims(): void {
globalThis.ResizeObserver ??= StubObserver as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver ??= StubObserver as unknown as typeof IntersectionObserver;

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

Object.defineProperty(window, 'arena', {
  value: createBridge(),
  writable: true,
  configurable: true,
});
}
