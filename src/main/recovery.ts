import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appError } from '../core/errors';
import type { AppPaths } from './paths';
import type { SessionStore } from './documents/session-store';

/**
 * Crash recovery.
 *
 * While autosave is enabled the app periodically writes the *current* bytes of
 * every dirty document into the recovery folder together with a small JSON
 * index. If the process dies, the next start offers the snapshots back instead
 * of losing work.
 */
export interface RecoveryEntry {
  /** Absolute path of the snapshot file. */
  path: string;
  name: string;
  /** Original location, so saving after recovery overwrites the right file. */
  originalPath: string | null;
  modified: string;
  size: number;
}

interface RecoveryIndexEntry {
  file: string;
  name: string;
  originalPath: string | null;
  modified: string;
  size: number;
}

const INDEX_FILE = 'index.json';

export class RecoveryService {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly paths: AppPaths,
    private readonly store: SessionStore,
  ) {}

  /** Writes snapshots for all dirty documents that have a path or a name. */
  async snapshot(): Promise<RecoveryEntry[]> {
    if (this.busy) return this.list();
    this.busy = true;
    try {
      await mkdir(this.paths.recovery, { recursive: true });
      const index = await this.readIndex();
      const written: RecoveryEntry[] = [];

      for (const summary of this.store.dirtySessions()) {
        const fileName = `${sanitize(summary.name || summary.id)}.pdf`;
        const target = path.join(this.paths.recovery, fileName);
        try {
          const bytes = await this.store.documentFor(summary.id);
          await writeFile(target, bytes);
          const entry: RecoveryEntry = {
            path: target,
            name: summary.name,
            originalPath: summary.path,
            modified: new Date().toISOString(),
            size: bytes.byteLength,
          };
          written.push(entry);
          index.set(fileName, { file: fileName, name: summary.name, originalPath: summary.path, modified: entry.modified, size: entry.size });
        } catch (error) {
          console.warn('[recovery] could not snapshot', summary.name, (error as Error).message);
        }
      }

      // Forget snapshots whose document has been saved or closed.
      const active = new Set(written.map((entry) => path.basename(entry.path)));
      for (const [key, entry] of index) {
        if (!active.has(key)) {
          const file = path.join(this.paths.recovery, entry.file);
          try {
            if (existsSync(file)) unlinkSync(file);
          } catch {
            /* ignore */
          }
          index.delete(key);
        }
      }

      await this.writeIndex(index);
      return written;
    } finally {
      this.busy = false;
    }
  }

  /** Starts periodic snapshots (no-op when the interval is not positive). */
  start(intervalSeconds: number): void {
    this.stop();
    if (intervalSeconds <= 0) return;
    this.timer = setInterval(() => {
      void this.snapshot().catch((error) => console.warn('[recovery] autosave failed:', (error as Error).message));
    }, Math.max(15, intervalSeconds) * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Recovery candidates left over from a previous run. */
  async list(): Promise<RecoveryEntry[]> {
    const index = await this.readIndex();
    const entries: RecoveryEntry[] = [];
    for (const entry of index.values()) {
      const file = path.join(this.paths.recovery, entry.file);
      if (!existsSync(file)) continue;
      try {
        const stats = statSync(file);
        entries.push({
          path: file,
          name: entry.name,
          originalPath: entry.originalPath,
          modified: stats.mtime.toISOString(),
          size: stats.size,
        });
      } catch {
        /* ignore unreadable entry */
      }
    }
    return entries.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  async read(entryPath: string): Promise<Uint8Array> {
    const resolved = path.resolve(entryPath);
    if (!resolved.startsWith(path.resolve(this.paths.recovery))) {
      throw appError('PERMISSION_DENIED', 'The recovery file is outside the recovery folder.');
    }
    const buffer = await readFile(resolved);
    return new Uint8Array(buffer);
  }

  /** Removes a single snapshot after it has been restored or discarded. */
  remove(entryPath: string): void {
    const resolved = path.resolve(entryPath);
    if (!resolved.startsWith(path.resolve(this.paths.recovery))) return;
    try {
      if (existsSync(resolved)) unlinkSync(resolved);
    } catch {
      /* ignore */
    }
    const index = new Map<string, RecoveryIndexEntry>();
    try {
      const raw = JSON.parse(readFileSync(path.join(this.paths.recovery, INDEX_FILE), 'utf8'));
      for (const entry of raw) index.set(entry.file, entry);
    } catch {
      /* ignore */
    }
    index.delete(path.basename(resolved));
    try {
      writeFileSync(path.join(this.paths.recovery, INDEX_FILE), JSON.stringify([...index.values()], null, 2));
    } catch {
      /* ignore */
    }
  }

  clear(): void {
    try {
      for (const file of readdirSync(this.paths.recovery)) {
        if (!file.endsWith('.pdf') && file !== INDEX_FILE) continue;
        try {
          unlinkSync(path.join(this.paths.recovery, file));
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  private async readIndex(): Promise<Map<string, RecoveryIndexEntry>> {
    const map = new Map<string, RecoveryIndexEntry>();
    try {
      if (!existsSync(this.paths.recovery)) return map;
      const raw = JSON.parse(await readFile(path.join(this.paths.recovery, INDEX_FILE), 'utf8')) as RecoveryIndexEntry[];
      for (const entry of raw) if (entry?.file) map.set(entry.file, entry);
    } catch {
      /* corrupt index: start fresh, snapshots are re-created */
    }
    return map;
  }

  private async writeIndex(index: Map<string, RecoveryIndexEntry>): Promise<void> {
    await writeFile(path.join(this.paths.recovery, INDEX_FILE), JSON.stringify([...index.values()], null, 2));
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 120) || 'recovered';
}
