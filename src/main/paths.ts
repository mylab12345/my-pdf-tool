import { app } from 'electron';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

/**
 * The application's on-disk layout.
 *
 * User data lives in the platform standard location provided by Electron:
 *   Windows: %APPDATA%\Arena PDF Studio
 *   Linux:   ~/.config/Arena PDF Studio
 * Bundled read-only assets live next to the executable (resources/…), both in
 * development and inside the packaged app.
 */
export interface AppPaths {
  userData: string;
  settings: string;
  recentFiles: string;
  recovery: string;
  logs: string;
  temp: string;
  certificates: string;
  ocrLanguages: string;
  fonts: string;
}

export function resolveAppPaths(): AppPaths {
  const userData = app.getPath('userData');
  const resources = resolveResourcesRoot();
  const paths: AppPaths = {
    userData,
    settings: path.join(userData, 'settings.json'),
    recentFiles: path.join(userData, 'recent-files.json'),
    recovery: path.join(userData, 'recovery'),
    logs: path.join(userData, 'logs'),
    temp: path.join(app.getPath('temp'), 'arena-pdf-studio'),
    certificates: path.join(userData, 'certificates'),
    ocrLanguages: path.join(resources, 'ocr-langs'),
    fonts: path.join(resources, 'fonts'),
  };
  for (const dir of [paths.userData, paths.recovery, paths.logs, paths.temp, paths.certificates]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  return paths;
}

/**
 * Finds the bundled resources directory in both layouts:
 *  - development: <repo>/resources
 *  - packaged:    <app>/resources/app.asar/resources (asar) or resources/ next to the app
 */
export function resolveResourcesRoot(): string {
  const candidates: string[] = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar', 'resources'));
    candidates.push(path.join(process.resourcesPath, 'resources'));
    candidates.push(path.join(process.resourcesPath, 'app', 'resources'));
  }
  candidates.push(path.join(app.getAppPath(), 'resources'));
  candidates.push(path.join(process.cwd(), 'resources'));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0] ?? path.join(process.cwd(), 'resources');
}
