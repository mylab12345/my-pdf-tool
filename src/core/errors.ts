import type { AppErrorPayload } from '../shared/types';

export type AppErrorCode =
  | 'PASSWORD_REQUIRED'
  | 'INVALID_PASSWORD'
  | 'CORRUPT_DOCUMENT'
  | 'UNSUPPORTED_FEATURE'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'DISK_FULL'
  | 'FILE_IN_USE'
  | 'INVALID_INPUT'
  | 'CANCELLED'
  | 'TOO_LARGE'
  | 'FONT_MISSING'
  | 'OCR_FAILED'
  | 'SIGNATURE_FAILED'
  | 'PRINT_FAILED'
  | 'INTERNAL';

/** Error type carrying a stable machine code, a user message and a recovery hint. */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details?: string;
  readonly hint?: string;

  constructor(code: AppErrorCode, message: string, options: { details?: string; hint?: string } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = options.details;
    this.hint = options.hint;
  }
}

const HINTS: Partial<Record<AppErrorCode, string>> = {
  PASSWORD_REQUIRED: 'This document is protected. Enter the password to open it.',
  INVALID_PASSWORD: 'The password did not match. Check the spelling and the keyboard layout, then try again.',
  CORRUPT_DOCUMENT: 'The file does not look like a valid PDF. It may be damaged or partially downloaded.',
  PERMISSION_DENIED: 'Choose a folder you can write to, for example your Documents folder.',
  DISK_FULL: 'Free up disk space and try again.',
  FILE_IN_USE: 'Close the file in other applications, or save with a different name.',
  FONT_MISSING: 'Pick another font. The selected font file could not be read.',
  OCR_FAILED: 'Try a higher render resolution or a different OCR language.',
  PRINT_FAILED: 'Check that a printer is installed and selected, then retry.',
  INTERNAL: 'Retry the action. If the problem persists, save the document and restart the application.',
};

export function appError(code: AppErrorCode, message: string, options: { details?: string; hint?: string } = {}): AppError {
  return new AppError(code, message, { hint: options.hint ?? HINTS[code], details: options.details });
}

/** Normalises unknown thrown values (including Node fs errors) into an AppError. */
export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const anyError = error as { code?: string; message?: string; name?: string } | null;
  const message = anyError?.message ?? String(error);
  const code = anyError?.code;

  if (code === 'EACCES' || code === 'EPERM') return appError('PERMISSION_DENIED', 'Permission denied for this location.', { details: message });
  if (code === 'ENOSPC') return appError('DISK_FULL', 'There is not enough disk space to write the file.', { details: message });
  if (code === 'EBUSY' || code === 'ETXTBSY') return appError('FILE_IN_USE', 'The file is locked by another program.', { details: message });
  if (code === 'ENOENT') return appError('NOT_FOUND', 'The file or folder could not be found.', { details: message });
  if (code === 'EISDIR') return appError('INVALID_INPUT', 'That path is a folder, not a file.', { details: message });
  if (anyError?.name === 'EncryptedPDFError' || /encrypted/i.test(message)) {
    return appError('PASSWORD_REQUIRED', 'This document is password protected.');
  }
  if (anyError?.name === 'PasswordException') {
    return /incorrect|invalid/i.test(message)
      ? appError('INVALID_PASSWORD', 'The password is incorrect.')
      : appError('PASSWORD_REQUIRED', 'This document is password protected.');
  }
  if (/no password given|password required/i.test(message)) {
    return appError('PASSWORD_REQUIRED', 'This document is password protected.');
  }
  if (/password incorrect|incorrect password/i.test(message)) return appError('INVALID_PASSWORD', 'The password is incorrect.');
  if (/No PDF header|Failed to parse|Invalid object|Expected instance|Offset .* is out of range/i.test(message)) {
    return appError('CORRUPT_DOCUMENT', 'The PDF file appears to be damaged.', { details: message });
  }
  if (code === 'CANCELLED') return appError('CANCELLED', 'The task was cancelled.');
  return appError('INTERNAL', message || 'An unexpected error occurred.', { details: anyError?.name });
}

export function toErrorPayload(error: unknown): AppErrorPayload {
  const normalized = normalizeError(error);
  const payload: AppErrorPayload = { code: normalized.code, message: normalized.message };
  if (normalized.details) payload.details = normalized.details;
  if (normalized.hint) payload.hint = normalized.hint;
  return payload;
}

/** Thrown by long running tasks when the user cancels them. */
export class CancelledError extends AppError {
  constructor(message = 'The task was cancelled.') {
    super('CANCELLED', message);
    this.name = 'CancelledError';
  }
}

export function assert(condition: unknown, message: string, code: AppErrorCode = 'INVALID_INPUT'): asserts condition {
  if (!condition) throw appError(code, message);
}
