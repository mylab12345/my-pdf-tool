import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FontAsset, FontManager } from '../core/pdf/fonts';
import { FontManager as Manager } from '../core/pdf/fonts';
import type { AppPaths } from './paths';

const MAX_SYSTEM_FONTS = 400;

/** Directories that contain user/system TrueType fonts on each platform. */
export function systemFontDirectories(): string[] {
  if (process.platform === 'win32') {
    const windir = process.env.WINDIR ?? 'C:\\Windows';
    const localAppData = process.env.LOCALAPPDATA ?? '';
    return [
      path.join(windir, 'Fonts'),
      localAppData ? path.join(localAppData, 'Microsoft', 'Windows', 'Fonts') : '',
    ].filter(Boolean);
  }
  const home = process.env.HOME ?? '';
  return [
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    home ? path.join(home, '.fonts') : '',
    home ? path.join(home, '.local', 'share', 'fonts') : '',
  ].filter(Boolean);
}

/**
 * Discovers system fonts (TrueType/OpenType only).
 *
 * The list powers the font picker; the bytes are only read when a font is
 * actually embedded, so startup stays fast.
 */
export function discoverSystemFonts(limit = MAX_SYSTEM_FONTS): FontAsset[] {
  const fonts: FontAsset[] = [];
  const seen = new Set<string>();
  const walk = (directory: string, depth = 0): void => {
    if (depth > 3 || fonts.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (fonts.length >= limit) return;
      const full = path.join(directory, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!/\.(ttf|otf)$/i.test(entry)) continue;
      const key = full.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      fonts.push({
        id: `system:${full}`,
        family: prettifyFontName(entry),
        style: /bold/i.test(entry) ? 'Bold' : /italic|oblique/i.test(entry) ? 'Italic' : 'Regular',
        source: 'system',
        unicode: true,
        path: full,
      });
    }
  };
  for (const directory of systemFontDirectories()) {
    if (existsSync(directory)) walk(directory);
  }
  return fonts.sort((a, b) => a.family.localeCompare(b.family));
}

function prettifyFontName(fileName: string): string {
  return path
    .basename(fileName)
    .replace(/\.(ttf|otf)$/i, '')
    .replace(/[-_](Regular|Book|Roman)$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

/** Creates the application-wide font manager (bundled + system fonts). */
export function createFontManager(paths: AppPaths): FontManager {
  return new Manager(async (asset) => {
    const file = asset.path ?? (asset.bundledFile ? path.join(paths.fonts, asset.bundledFile) : null);
    if (!file || !existsSync(file)) return null;
    try {
      return new Uint8Array(readFileSync(file));
    } catch {
      return null;
    }
  }, discoverSystemFonts());
}

/** Lists the bundled OCR languages available offline. */
export function installedOcrLanguages(paths: AppPaths): string[] {
  try {
    return readdirSync(paths.ocrLanguages)
      .filter((file) => file.endsWith('.traineddata.gz') || file.endsWith('.traineddata'))
      .map((file) => file.replace(/\.traineddata(\.gz)?$/, ''));
  } catch {
    return [];
  }
}
