/**
 * Environment-agnostic base64 helpers.
 *
 * `Buffer`/`atob` availability differs between the main process, the renderer
 * and the test runner, so the engine carries its own implementation.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Int16Array(256).fill(-1);
for (let i = 0; i < ALPHABET.length; i += 1) LOOKUP[ALPHABET.charCodeAt(i)] = i;
LOOKUP['-'.charCodeAt(0)] = 62; // URL-safe
LOOKUP['_'.charCodeAt(0)] = 63;

const CHUNK = 0x8000;

export function encodeBase64(bytes: Uint8Array): string {
  let output = '';
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const slice = bytes.subarray(start, start + CHUNK);
    let chunk = '';
    for (let i = 0; i < slice.length; i += 3) {
      const b0 = slice[i]!;
      const b1 = i + 1 < slice.length ? slice[i + 1]! : 0;
      const b2 = i + 2 < slice.length ? slice[i + 2]! : 0;
      const triplet = (b0 << 16) | (b1 << 8) | b2;
      chunk += ALPHABET[(triplet >> 18) & 63];
      chunk += ALPHABET[(triplet >> 12) & 63];
      chunk += i + 1 < slice.length ? ALPHABET[(triplet >> 6) & 63] : '=';
      chunk += i + 2 < slice.length ? ALPHABET[triplet & 63] : '=';
    }
    output += chunk;
  }
  return output;
}

export function decodeBase64(input: string): Uint8Array {
  const clean = input.replace(/[\s\r\n]+/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const length = Math.floor((clean.length * 3) / 4) - padding;
  const bytes = new Uint8Array(Math.max(0, length));
  let byteIndex = 0;
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < clean.length; i += 1) {
    const code = clean.charCodeAt(i);
    if (code === 61) break; // '='
    const value = LOOKUP[code] ?? -1;
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[byteIndex++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes.subarray(0, byteIndex);
}

/** Parses a `data:` URL (or raw base64) into bytes plus MIME type. */
export function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mimeType?: string } {
  const match = dataUrl.match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/);
  if (!match) return { bytes: decodeBase64(dataUrl) };
  const [, mimeType, isBase64, payload] = match;
  if (isBase64) return { bytes: decodeBase64(payload ?? ''), mimeType: mimeType || undefined };
  const decoded = decodeURIComponent(payload ?? '');
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i) & 0xff;
  return { bytes, mimeType: mimeType || undefined };
}

export function bytesToDataUrl(bytes: Uint8Array, mimeType = 'application/octet-stream'): string {
  return `data:${mimeType};base64,${encodeBase64(bytes)}`;
}

/** Detects the image MIME type from magic bytes (PNG/JPEG only, by design). */
export function detectImageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  return null;
}

/** Converts bytes into a latin1 string (used for raw PDF syntax scanning). */
export function toLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return out;
}

export function fromLatin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}
