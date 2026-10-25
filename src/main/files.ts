import { BrowserWindow, dialog, shell } from 'electron';
import { constants as fsConstants } from 'node:fs';
import { access, copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appError } from '../core/errors';
import type { SessionFileSystem } from './documents/session-store';

/**
 * File system access for the main process.
 *
 * Writes are atomic: the bytes go to a temporary file in the same directory
 * (so the rename stays on one volume) and are then renamed over the target. The
 * original file's permissions are preserved when it already exists.
 */
export class FileSystem implements SessionFileSystem {
  async readFile(filePath: string): Promise<Uint8Array> {
    const buffer = await readFile(filePath);
    return new Uint8Array(buffer);
  }

  async writeFile(filePath: string, bytes: Uint8Array, options: { backup?: boolean } = {}): Promise<void> {
    const directory = path.dirname(filePath);
    await mkdir(directory, { recursive: true });
    const exists = await this.exists(filePath);
    if (exists) {
      const writable = await this.isWritable(filePath);
      if (!writable) {
        throw appError('PERMISSION_DENIED', `The file is read-only: ${filePath}`, {
          hint: 'Save with a different name, or change the file permissions.',
        });
      }
      if (options.backup) {
        await copyFile(filePath, `${filePath}.bak`).catch(() => undefined);
      }
    }
    const temp = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    try {
      await writeFile(temp, bytes, { mode: exists ? await this.modeOf(filePath) : 0o644 });
      await rename(temp, filePath);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await access(filePath, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async isWritable(filePath: string): Promise<boolean> {
    try {
      await access(filePath, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async modeOf(filePath: string): Promise<number> {
    try {
      const stats = await stat(filePath);
      return stats.mode & 0o777;
    } catch {
      return 0o644;
    }
  }
}

export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

/** Native open dialog (multi-select, PDF filter, remembers the last folder). */
export async function showOpenPdfDialog(window: BrowserWindow | null, defaultPath?: string): Promise<string[]> {
  const result = await dialog.showOpenDialog(window ?? undefined!, {
    title: 'Open PDF',
    defaultPath,
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'PDF documents', extensions: ['pdf'] },
      { name: 'All files', extensions: ['*'] },
    ] as never,
  } as never);
  if (result.canceled) return [];
  return result.filePaths;
}

export async function showSavePdfDialog(window: BrowserWindow | null, options: SaveDialogOptions = {}): Promise<string | null> {
  const result = await dialog.showSaveDialog(window ?? undefined!, {
    title: options.title ?? 'Save PDF',
    defaultPath: options.defaultPath,
    filters: options.filters ?? [{ name: 'PDF document', extensions: ['pdf'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  } as never);
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
}

export async function showOpenImagesDialog(window: BrowserWindow | null): Promise<string[]> {
  const result = await dialog.showOpenDialog(window ?? undefined!, {
    title: 'Choose images',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
  } as never);
  return result.canceled ? [] : result.filePaths;
}

export async function showDirectoryDialog(window: BrowserWindow | null, title = 'Choose a folder'): Promise<string | null> {
  const result = await dialog.showOpenDialog(window ?? undefined!, {
    title,
    properties: ['openDirectory', 'createDirectory'],
  } as never);
  if (result.canceled) return null;
  return result.filePaths[0] ?? null;
}

/** Shows the file in the platform file manager (Explorer, Nautilus, Dolphin…). */
export function revealInFolder(filePath: string): void {
  shell.showItemInFolder(filePath);
}

/** Opens an http(s) link in the default browser (allow-listed schemes only). */
export async function openExternalLink(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw appError('INVALID_INPUT', 'That link is not valid.');
  }
  if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) {
    throw appError('INVALID_INPUT', 'Only http, https and mailto links can be opened.');
  }
  await shell.openExternal(parsed.toString());
}

/** Suggests a sensible file name next to an existing document. */
export function siblingPath(filePath: string | null, suffix: string, extension = '.pdf'): string {
  if (!filePath) return `${suffix.replace(/[\\/]/g, '-')}${extension}`;
  const directory = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  return path.join(directory, `${base}-${suffix}${extension}`);
}
