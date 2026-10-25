import { app } from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/constants';
import type { AppSettings, RecentFile } from '../shared/types';
import type { AppPaths } from './paths';

/**
 * JSON-backed preferences.
 *
 * Writes are atomic (temp file + rename) and the store never throws on read: a
 * corrupted settings file falls back to defaults instead of blocking startup.
 */
export class Preferences {
  private settings: AppSettings;
  private recent: RecentFile[] = [];

  constructor(private readonly paths: AppPaths) {
    this.settings = this.loadSettings();
    this.recent = this.loadRecent();
  }

  private loadSettings(): AppSettings {
    try {
      if (existsSync(this.paths.settings)) {
        const parsed = JSON.parse(readFileSync(this.paths.settings, 'utf8')) as Partial<AppSettings>;
        return sanitizeSettings({ ...DEFAULT_SETTINGS, ...parsed });
      }
    } catch (error) {
      console.warn('[preferences] could not read settings, using defaults:', (error as Error).message);
    }
    return { ...DEFAULT_SETTINGS };
  }

  private loadRecent(): RecentFile[] {
    try {
      if (existsSync(this.paths.recentFiles)) {
        const parsed = JSON.parse(readFileSync(this.paths.recentFiles, 'utf8'));
        if (Array.isArray(parsed)) {
          return parsed.filter((entry): entry is RecentFile => typeof entry?.path === 'string').slice(0, 50);
        }
      }
    } catch {
      /* ignore */
    }
    return [];
  }

  all(): AppSettings {
    return { ...this.settings };
  }

  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.settings[key];
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.settings = sanitizeSettings({ ...this.settings, ...patch });
    this.persist(this.paths.settings, this.settings);
    return this.all();
  }

  recentFiles(): RecentFile[] {
    return this.recent.map((entry) => ({ ...entry }));
  }

  addRecent(file: RecentFile): RecentFile[] {
    this.recent = [file, ...this.recent.filter((entry) => entry.path !== file.path)].slice(0, Math.max(4, this.settings.maxRecentFiles));
    this.persist(this.paths.recentFiles, this.recent);
    return this.recentFiles();
  }

  removeRecent(filePath: string): RecentFile[] {
    this.recent = this.recent.filter((entry) => entry.path !== filePath);
    this.persist(this.paths.recentFiles, this.recent);
    return this.recentFiles();
  }

  clearRecent(): RecentFile[] {
    this.recent = [];
    this.persist(this.paths.recentFiles, this.recent);
    return [];
  }

  private persist(file: string, data: unknown): void {
    try {
      const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
      writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
      renameSync(temp, file);
    } catch (error) {
      console.warn('[preferences] could not persist', file, (error as Error).message);
    }
  }
}

function sanitizeSettings(input: AppSettings): AppSettings {
  const clamp = (value: number, min: number, max: number, fallback: number) =>
    Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  return {
    theme: ['system', 'light', 'dark'].includes(input.theme) ? input.theme : 'system',
    accent: /^#[0-9a-f]{6}$/i.test(input.accent) ? input.accent : DEFAULT_SETTINGS.accent,
    defaultPageSize: input.defaultPageSize ?? DEFAULT_SETTINGS.defaultPageSize,
    defaultOrientation: input.defaultOrientation === 'landscape' ? 'landscape' : 'portrait',
    autosaveEnabled: Boolean(input.autosaveEnabled),
    autosaveIntervalSeconds: clamp(input.autosaveIntervalSeconds, 15, 600, DEFAULT_SETTINGS.autosaveIntervalSeconds),
    maxRecentFiles: clamp(input.maxRecentFiles, 4, 40, DEFAULT_SETTINGS.maxRecentFiles),
    confirmOnClose: Boolean(input.confirmOnClose),
    defaultOcrLanguages: Array.isArray(input.defaultOcrLanguages) && input.defaultOcrLanguages.length ? input.defaultOcrLanguages : ['eng'],
    defaultCompressionProfile: ['lossless', 'balanced', 'aggressive', 'custom'].includes(input.defaultCompressionProfile)
      ? input.defaultCompressionProfile
      : 'balanced',
    renderDpi: clamp(input.renderDpi, 72, 300, DEFAULT_SETTINGS.renderDpi),
    showSidebar: Boolean(input.showSidebar),
    printScale: input.printScale === 'actual' ? 'actual' : 'fit',
    language: typeof input.language === 'string' && input.language ? input.language : 'en',
    checkAssociationsOnStart: Boolean(input.checkAssociationsOnStart),
  };
}

/** Environment report shown in the About/diagnostics dialog. */
export async function environmentReport(paths: AppPaths, extra: {
  fontsBundled: number;
  ocrLanguages: string[];
  capabilities: { printing: boolean; clipboardImages: boolean; fileAssociations: boolean };
}) {
  const os = await import('node:os');
  return {
    platform: `${process.platform} (${os.release()})`,
    arch: process.arch,
    osVersion: `${os.type()} ${os.release()}`,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? '',
    chromeVersion: process.versions.chrome ?? '',
    nodeVersion: process.versions.node,
    locale: app.getLocale(),
    totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
    cpuCount: os.cpus().length,
    fontsBundled: extra.fontsBundled,
    ocrLanguages: extra.ocrLanguages,
    paths: {
      documents: app.getPath('documents'),
      downloads: app.getPath('downloads'),
      userData: paths.userData,
      temp: paths.temp,
    },
    capabilities: {
      ...extra.capabilities,
      nativeDialogs: true,
      dragAndDrop: true,
    },
  };
}
