import { protocol } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { DOC_PROTOCOL_SCHEME, PROTOCOL_SCHEME } from '../shared/constants';

/**
 * Custom protocol setup.
 *
 * `arenapdfdoc://` streams document bytes to the renderer with HTTP range
 * support, so pdf.js loads only the parts of a large file it needs instead of
 * copying the whole document over IPC.
 *
 * `arenapdf://` serves the built renderer bundle from an origin that can host
 * module workers and fetch() calls (file:// cannot).
 */
export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

/** Must run before `app.whenReady()`. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PROTOCOL_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, codeCache: true },
    },
    {
      scheme: DOC_PROTOCOL_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: false },
    },
  ]);
}

export interface DocumentSource {
  /** Current bytes for a session id. */
  bytesForSession(sessionId: string): Promise<Uint8Array>;
}

export class DocumentProtocol {
  private readonly blobs = new Map<string, { bytes: Uint8Array; createdAt: number }>();

  constructor(private readonly source: DocumentSource) {}

  /** Registers a one-shot in-memory document (used for printing). */
  registerBlob(bytes: Uint8Array, ttlMs = 5 * 60 * 1000): string {
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    this.blobs.set(token, { bytes, createdAt: Date.now() });
    // Opportunistic cleanup of stale blobs.
    for (const [key, entry] of this.blobs) {
      if (Date.now() - entry.createdAt > ttlMs) this.blobs.delete(key);
    }
    return `${DOC_PROTOCOL_SCHEME}://blob/${token}`;
  }

  sessionUrl(sessionId: string, revision: number): string {
    return `${DOC_PROTOCOL_SCHEME}://session/${encodeURIComponent(sessionId)}?rev=${revision}`;
  }

  /** Installs the request handlers (after app ready). */
  install(rendererRoot: string): void {
    protocol.handle(DOC_PROTOCOL_SCHEME, async (request) => {
      try {
        const url = new URL(request.url);
        const kind = url.hostname;
        const key = decodeURIComponent(url.pathname.replace(/^\//, ''));
        let bytes: Uint8Array | null = null;
        if (kind === 'session') bytes = await this.source.bytesForSession(key);
        else if (kind === 'blob') bytes = this.blobs.get(key)?.bytes ?? null;
        if (!bytes) return new Response('Document not found', { status: 404 });
        return respondWithRange(request, bytes);
      } catch (error) {
        return new Response(`Protocol error: ${(error as Error).message}`, { status: 500 });
      }
    });

    protocol.handle(PROTOCOL_SCHEME, async (request) => {
      const url = new URL(request.url);
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const resolved = path.normalize(path.join(rendererRoot, relative));
      // Prevent path traversal outside the bundle.
      if (!resolved.startsWith(path.normalize(rendererRoot))) {
        return new Response('Forbidden', { status: 403 });
      }
      if (!existsSync(resolved)) {
        // Single page app: unknown routes fall back to index.html.
        const fallback = path.join(rendererRoot, 'index.html');
        if (!existsSync(fallback)) return new Response('Not found', { status: 404 });
        return new Response(toStandalone(readFileSync(fallback)), { headers: { 'content-type': MIME_TYPES['.html']! } });
      }
      const extension = path.extname(resolved).toLowerCase();
      const mime = MIME_TYPES[extension] ?? 'application/octet-stream';
      // Reading through node:fs (not net.fetch) keeps the bundle loadable from
      // inside app.asar, where file:// URLs do not exist as real files.
      const headers = new Headers({ 'content-type': mime, 'cache-control': 'no-cache' });
      return new Response(toStandalone(readFileSync(resolved)), { headers });
    });
  }
}

function toStandalone(buffer: Buffer | string): ArrayBuffer {
  const source = typeof buffer === 'string' ? Buffer.from(buffer) : buffer;
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy.buffer as ArrayBuffer;
}

/** Responds with HTTP range support (pdf.js relies on it for large files). */
function respondWithRange(request: Request, bytes: Uint8Array): Response {
  const headers = new Headers({
    'content-type': 'application/pdf',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  const range = request.headers.get('range');
  if (!range) {
    headers.set('content-length', String(bytes.byteLength));
    return new Response(toStandalone(Buffer.from(bytes)), { status: 200, headers });
  }
  const match = range.match(/bytes=(\d*)-(\d*)/);
  if (!match) {
    headers.set('content-length', String(bytes.byteLength));
    return new Response(toStandalone(Buffer.from(bytes)), { status: 200, headers });
  }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), bytes.byteLength - 1) : bytes.byteLength - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= bytes.byteLength) {
    return new Response('Range not satisfiable', {
      status: 416,
      headers: { 'content-range': `bytes */${bytes.byteLength}` },
    });
  }
  const slice = bytes.subarray(start, end + 1);
  headers.set('content-range', `bytes ${start}-${end}/${bytes.byteLength}`);
  headers.set('content-length', String(slice.byteLength));
  return new Response(toStandalone(Buffer.from(slice)), { status: 206, headers });
}
