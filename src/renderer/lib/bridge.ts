import type { PdfApi } from '../../shared/ipc';
import type { AppErrorPayload, Result } from '../../shared/types';

/**
 * Renderer side of the preload bridge.
 *
 * The bridge is injected by `src/preload/index.ts` as `window.arena`. Keeping the
 * typing here (instead of importing the preload module, which pulls in Electron
 * types) means the renderer bundle never references Node or Electron APIs.
 */
export interface ArenaBridge extends PdfApi {
  dragDropPath(file: File): string;
  platform: string;
  versions: { electron: string; chrome: string; node: string };
}

declare global {
  interface Window {
    arena: ArenaBridge;
  }
}

export const api: ArenaBridge = window.arena;

/** Error thrown for `{ok: false}` results, carrying the machine-readable code. */
export class IpcError extends Error {
  readonly code: string;
  readonly details?: string;
  readonly hint?: string;

  constructor(payload: AppErrorPayload) {
    super(payload.message);
    this.name = 'IpcError';
    this.code = payload.code;
    this.details = payload.details;
    this.hint = payload.hint;
  }

  get isCancel(): boolean {
    return this.code === 'CANCELLED';
  }
}

/** Awaits a bridge call and unwraps the result, throwing `IpcError` on failure. */
export async function run<T>(call: Promise<Result<T>>): Promise<T> {
  const result = await call;
  if (!result.ok) throw new IpcError(result.error);
  return result.value;
}

/** Like `run`, but returns `null` instead of throwing (used for optional flows). */
export async function attempt<T>(call: Promise<Result<T>>): Promise<T | null> {
  const result = await call;
  return result.ok ? result.value : null;
}

export function errorMessage(error: unknown): string {
  if (error instanceof IpcError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
