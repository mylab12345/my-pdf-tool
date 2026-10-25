/** Small formatting helpers shared by main and renderer (locale independent). */

export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : fractionDigits)} ${units[unit]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds % 60)} s`;
}

export function formatPercent(value: number, digits = 0): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/** Extracts the final path segment on both Windows and POSIX paths. */
export function baseName(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}

/** Directory part of a path, crossing Windows/POSIX separators. */
export function dirName(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, '');
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return index > 0 ? normalized.slice(0, index) : '';
}

export function replaceExtension(filePath: string, extension: string): string {
  const base = filePath.replace(/\.(pdf|PDF)$/, '');
  return `${base}${extension.startsWith('.') ? extension : `.${extension}`}`;
}

export function ensureExtension(filePath: string, extension: string): string {
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  return filePath.toLowerCase().endsWith(ext.toLowerCase()) ? filePath : `${filePath}${ext}`;
}

export function sanitizeFileName(name: string): string {
  return name
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'document';
}

/** Converts `#rrggbb` to an [r,g,b] tuple of 0-1 floats (PDF colour space). */
export function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '').trim();
  const full = normalized.length === 3 ? normalized.split('').map((c) => c + c).join('') : normalized;
  const value = Number.parseInt(full.slice(0, 6) || '000000', 16);
  if (Number.isNaN(value)) return [0, 0, 0];
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const to = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function roundTo(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
