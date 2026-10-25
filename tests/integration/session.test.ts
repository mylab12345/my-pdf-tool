import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { PDFDocument } from '@cantoo/pdf-lib';
import { SessionStore, type SessionFileSystem } from '../../src/main/documents/session-store';
import { ToolService } from '../../src/main/tools';
import { TaskManager } from '../../src/main/tasks';
import { savePdf } from '../../src/core/pdf/loader';
import type { AppPaths } from '../../src/main/paths';
import type { OcrWorkerFactory } from '../../src/main/ocr-engine';
import { createFontManager, extractText, makePdf, pngFromCanvas, renderer, resourcesDir, repoRoot } from '../unit/helpers';

/**
 * Main-process integration tests.
 *
 * These exercise the real SessionStore / ToolService graph with a fake file
 * system, so the code that actually runs inside Electron is covered without
 * needing a display server. Only the OS-facing adapters (dialogs, printer,
 * clipboard) are stubbed.
 */

class MemoryFileSystem implements SessionFileSystem {
  readonly files = new Map<string, Uint8Array>();

  async readFile(filePath: string): Promise<Uint8Array> {
    const bytes = this.files.get(filePath);
    if (!bytes) throw new Error(`ENOENT: ${filePath}`);
    return bytes;
  }

  async writeFile(filePath: string, bytes: Uint8Array): Promise<void> {
    this.files.set(filePath, bytes);
  }
}

const paths: AppPaths = {
  userData: path.join(tmpdir(), 'arena-test'),
  settings: path.join(tmpdir(), 'arena-test', 'settings.json'),
  recentFiles: path.join(tmpdir(), 'arena-test', 'recent.json'),
  recovery: path.join(tmpdir(), 'arena-test', 'recovery'),
  logs: path.join(tmpdir(), 'arena-test', 'logs'),
  temp: mkdtempSync(path.join(tmpdir(), 'arena-temp-')),
  certificates: path.join(tmpdir(), 'arena-test', 'certs'),
  ocrLanguages: path.join(resourcesDir, 'ocr-langs'),
  fonts: path.join(resourcesDir, 'fonts'),
};

const ocr: OcrWorkerFactory = {
  create: async () => {
    throw new Error('OCR is not used in these tests');
  },
  installed: () => ['eng'],
  importLanguageFile: async () => 'eng',
  languageDirectory: paths.ocrLanguages,
};

function harness() {
  const fs = new MemoryFileSystem();
  const fonts = createFontManager();
  const store = new SessionStore({ renderer: renderer(), fonts, fs });
  const written: string[] = [];
  const tasks = new TaskManager(() => undefined);
  const tools = new ToolService({
    store,
    renderer: renderer(),
    fonts,
    fs: fs as never,
    paths,
    tasks,
    ocr,
    getWindow: () => null,
    dialogs: {
      savePdf: async () => {
        const target = path.join(paths.temp, `out-${written.length}.pdf`);
        written.push(target);
        return target;
      },
      directory: async () => paths.temp,
    },
  });
  return { fs, store, tools, written };
}

describe('SessionStore', () => {
  let session: ReturnType<typeof harness>;

  beforeEach(() => {
    session = harness();
  });

  it('opens bytes, reports page geometry and tracks dirty state', async () => {
    const bytes = await makePdf({ pages: 3 });
    const summary = await session.store.openBytes(bytes, { name: 'three.pdf' });
    expect(summary.pageCount).toBe(3);
    expect(summary.dirty).toBe(false);
    expect(summary.canUndo).toBe(false);

    const info = await session.store.info(summary.id);
    expect(info.pages).toHaveLength(3);
    expect(info.pages[0]!.width).toBeCloseTo(595.28, 1);
    expect(info.pages[0]!.height).toBeCloseTo(841.89, 1);
    expect(info.textCharacters).toBeGreaterThan(0);
    expect(info.encrypted).toBe(false);
  });

  it('applies page operations and undoes them by replaying history', async () => {
    const bytes = await makePdf({ pages: 4 });
    const { id } = await session.store.openBytes(bytes, { name: 'four.pdf' });

    await session.store.apply(id, [{ kind: 'deletePages', pages: [1] }]);
    let summary = session.store.summaryOf(id);
    expect(summary.pageCount).toBe(3);
    expect(summary.dirty).toBe(true);
    expect(summary.canUndo).toBe(true);
    expect(summary.undoLabel).toBeTruthy();

    await session.store.apply(id, [{ kind: 'rotatePages', pages: [0], degrees: 90 }]);
    expect((await session.store.info(id)).pages[0]!.rotation).toBe(90);

    summary = await session.store.undo(id);
    expect((await session.store.info(id)).pages[0]!.rotation).toBe(0);
    summary = await session.store.undo(id);
    expect(summary.pageCount).toBe(4);

    summary = await session.store.redo(id);
    expect(summary.pageCount).toBe(3);
  });

  it('saves through the injected file system and clears history', async () => {
    const bytes = await makePdf({ pages: 2 });
    const { id } = await session.store.openBytes(bytes, { name: 'save-me.pdf' });
    await session.store.apply(id, [{ kind: 'rotatePages', pages: [0], degrees: 180 }]);

    const target = path.join(paths.temp, 'saved.pdf');
    const result = await session.store.save(id, { path: target });
    expect(result.path).toBe(target);
    expect(session.fs.files.has(target)).toBe(true);
    expect(session.store.summaryOf(id).dirty).toBe(false);
    expect(session.store.summaryOf(id).canUndo).toBe(false);

    const reloaded = await PDFDocument.load(session.fs.files.get(target)!);
    expect(reloaded.getPageCount()).toBe(2);
  });

  it('persists annotations and exposes them to the renderer', async () => {
    const bytes = await makePdf({ pages: 2 });
    const { id } = await session.store.openBytes(bytes, { name: 'notes.pdf' });

    await session.store.apply(id, [
      {
        kind: 'addAnnotation',
        annotation: {
          type: 'highlight',
          pageIndex: 0,
          rect: { x: 40, y: 700, width: 200, height: 18 },
          quads: [{ x: 40, y: 700, width: 200, height: 18 }],
          color: '#f5c542',
          opacity: 0.35,
          editable: true,
        },
      },
      {
        kind: 'addAnnotation',
        annotation: {
          type: 'note',
          pageIndex: 1,
          rect: { x: 500, y: 300, width: 16, height: 16 },
          color: '#f5c542',
          opacity: 1,
          icon: 'Note',
          contents: 'Check this paragraph',
          editable: true,
        },
      },
    ]);

    const annotations = await session.store.annotations(id);
    expect(annotations).toHaveLength(2);
    expect(annotations.map((annotation) => annotation.pageIndex).sort()).toEqual([0, 1]);
    const note = annotations.find((annotation) => annotation.type === 'note');
    expect(note && 'contents' in note ? note.contents : '').toContain('Check this');

    const first = annotations[0]!;
    await session.store.apply(id, [{ kind: 'removeAnnotation', id: first.id }]);
    expect(await session.store.annotations(id)).toHaveLength(1);
  });

  it('clamps history depth and still undoes the recent steps', async () => {
    const bytes = await makePdf({ pages: 6 });
    const { id } = await session.store.openBytes(bytes, { name: 'deep.pdf' });
    for (let index = 0; index < 8; index += 1) {
      await session.store.apply(id, [{ kind: 'rotatePages', pages: [0], degrees: 90 }]);
    }
    // Eight 90° turns are equivalent to no rotation; history is folded so the
    // oldest edits live in the base bytes and only the recent ones replay.
    const info = await session.store.info(id);
    expect(info.pages[0]!.rotation % 360).toBe(0);
    await session.store.undo(id);
    expect((await session.store.info(id)).pages[0]!.rotation % 360).toBe(270);
  });
});

describe('ToolService', () => {
  let session: ReturnType<typeof harness>;

  beforeEach(() => {
    session = harness();
  });

  it('merges two open documents into a new one', async () => {
    const first = await session.store.openBytes(await makePdf({ pages: 2 }), { name: 'a.pdf' });
    const second = await session.store.openBytes(await makePdf({ pages: 3 }), { name: 'b.pdf' });
    const merged = await session.tools.merge({ documentIds: [first.id, second.id], keepOriginalOpen: true });
    expect(merged.pageCount).toBe(5);
    expect(merged.name).toMatch(/merged/i);
  });

  it('compresses a document and reports the size change', async () => {
    const doc = await PDFDocument.create();
    // A noisy photo-like page: poor PNG compression, much smaller as JPEG.
    const image = await doc.embedPng(
      pngFromCanvas(900, 1200, (context) => {
        const region = context.createImageData(900, 1200);
        let seed = 123456789;
        const random = (): number => {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          return (seed >>> 16) & 0xff;
        };
        for (let index = 0; index < region.data.length; index += 4) {
          region.data[index] = random();
          region.data[index + 1] = random();
          region.data[index + 2] = random();
          region.data[index + 3] = 255;
        }
        context.putImageData(region, 0, 0);
      }),
    );
    const page = doc.addPage([595, 842]);
    page.drawImage(image, { x: 0, y: 0, width: 595, height: 842 });
    const opened = await session.store.openBytes(await savePdf(doc), { name: 'photo.pdf' });
    const outcome = await session.tools.compress(opened.id, { profile: 'aggressive', rasterizePages: true, dpi: 96, quality: 50 });
    expect(outcome.result.compressedSize).toBeLessThan(outcome.result.originalSize);
    expect(outcome.summary.pageCount).toBe(1);
  });

  it('writes extracted text to disk', async () => {
    const opened = await session.store.openBytes(await makePdf({ pages: 2, text: 'Quarterly results' }), { name: 'text.pdf' });
    const result = await session.tools.exportText(opened.id, 'markdown');
    expect(existsSync(result.path) || session.fs.files.has(result.path)).toBe(true);
  });

  it('adds a watermark and preserves searchable text', async () => {
    const bytes = await makePdf({ pages: 2, text: 'Original content' });
    const opened = await session.store.openBytes(bytes, { name: 'wm.pdf' });
    await session.tools.watermark(opened.id, {
      text: 'DRAFT',
      fontSize: 48,
      color: '#ff0000',
      opacity: 0.2,
      rotation: 45,
      x: 0.5,
      y: 0.5,
      tile: false,
      scale: 1,
      fontFamily: 'Inter',
    });
    const text = (await extractText(await session.store.documentFor(opened.id))).join('\n');
    expect(text).toContain('Original content');
    expect(text).toContain('DRAFT');
  });

  it('sets metadata and the outline', async () => {
    const opened = await session.store.openBytes(await makePdf({ pages: 3 }), { name: 'meta.pdf' });
    await session.tools.setMetadata(opened.id, { title: 'Report', author: 'QA', keywords: ['report', 'qa'] });
    await session.tools.setOutline(opened.id, [{ title: 'Introduction', pageIndex: 0, children: [{ title: 'Scope', pageIndex: 1 }] }]);
    const info = await session.store.info(opened.id);
    expect(info.metadata.title).toBe('Report');
    expect(info.outline[0]?.title).toBe('Introduction');
    expect(info.outline[0]?.children[0]?.title).toBe('Scope');
  });

  it('stores and removes attachments', async () => {
    const opened = await session.store.openBytes(await makePdf({ pages: 1 }), { name: 'att.pdf' });
    const payload = new Uint8Array(readFileSync(path.join(repoRoot, 'package.json')));
    await session.tools.addAttachment(opened.id, { name: 'data.json', data: payload, description: 'source data' });
    const list = await session.tools.attachments(opened.id);
    expect(list.map((entry) => entry.name)).toContain('data.json');
    await session.tools.removeAttachment(opened.id, 'data.json');
    expect((await session.tools.attachments(opened.id)).map((entry) => entry.name)).not.toContain('data.json');
  });

  it('validates a healthy document and fills form fields', async () => {
    const opened = await session.store.openBytes(await makePdf({ pages: 1 }), { name: 'form.pdf' });
    const report = await session.tools.validate(opened.id);
    expect(report.valid).toBe(true);
    expect(report.pageCount).toBe(1);

    await session.tools.formsCreate(opened.id, [
      { kind: 'text', name: 'fullName', pageIndex: 0, rect: { x: 60, y: 600, width: 220, height: 22 } },
    ]);
    const fields = await session.tools.formsList(opened.id);
    expect(fields.map((field) => field.name)).toContain('fullName');
    await session.tools.formsFill(opened.id, { fullName: { type: 'text', value: 'Ada Lovelace' } }, true);
    const text = (await extractText(await session.store.documentFor(opened.id))).join('\n');
    expect(text).toContain('Ada Lovelace');
  });
});
