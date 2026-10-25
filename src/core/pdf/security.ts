import type { PDFDocument } from '@cantoo/pdf-lib';
import type { SecurityOptions } from '../../shared/types';
import { appError, assert } from '../errors';
import { detectEncryption } from './loader';

/** Converts app permissions into the pdf-lib permission shape. */
export function toPermissionOptions(options: SecurityOptions) {
  return {
    printing: options.permissions.printing,
    modifying: options.permissions.modifying,
    copying: options.permissions.copying,
    annotating: options.permissions.annotating,
    fillingForms: options.permissions.fillingForms,
    contentAccessibility: options.permissions.contentAccessibility,
    documentAssembly: options.permissions.documentAssembly,
  } as const;
}

export interface EncryptResult {
  algorithm: SecurityOptions['algorithm'];
  permissions: SecurityOptions['permissions'];
}

/**
 * Applies password protection. AES-256 is the default and the only algorithm
 * recommended by ISO 32000-2; RC4 requires an explicit opt-in.
 */
export function encryptDocument(doc: PDFDocument, options: SecurityOptions): EncryptResult {
  const algorithm = options.algorithm ?? 'AES-256';
  const userPassword = options.userPassword ?? '';
  const ownerPassword = options.ownerPassword ?? userPassword;
  assert(userPassword.length > 0 || ownerPassword.length > 0, 'Set a password to protect the document.');

  if ((algorithm === 'RC4-40' || algorithm === 'RC4-128') && userPassword.length < 1) {
    throw appError('INVALID_INPUT', 'Weak encryption still requires a password.');
  }

  try {
    doc.encrypt({
      userPassword,
      ownerPassword,
      algorithm,
      permissions: toPermissionOptions(options),
      allowWeakCryptography: algorithm === 'RC4-40' || algorithm === 'RC4-128',
    });
  } catch (error) {
    throw appError('INVALID_INPUT', `Could not encrypt the document: ${(error as Error).message}`);
  }
  return { algorithm, permissions: options.permissions };
}

/** Inspects raw bytes for encryption (works without the password). */
export function inspectEncryption(bytes: Uint8Array) {
  return detectEncryption(bytes);
}

export type PasswordStrength = { score: 0 | 1 | 2 | 3 | 4; label: string; suggestions: string[] };

/** Lightweight password strength estimation for the encryption dialog. */
export function passwordStrength(password: string): PasswordStrength {
  const suggestions: string[] = [];
  let score = 0;
  if (password.length >= 8) score += 1;
  else suggestions.push('Use at least 8 characters.');
  if (password.length >= 12) score += 1;
  else if (password.length >= 8) suggestions.push('Twelve characters or more is noticeably stronger.');
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  else suggestions.push('Mix upper and lower case letters.');
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score += 1;
  else suggestions.push('Add digits and symbols.');
  if (/(.)\1{2,}/.test(password) || /^(password|123456|qwerty)/i.test(password)) {
    score = Math.max(0, score - 2);
    suggestions.push('Avoid repeated characters and common words.');
  }
  const labels = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];
  return { score: Math.min(4, Math.max(0, score)) as PasswordStrength['score'], label: labels[Math.min(4, Math.max(0, score))]!, suggestions };
}

/** Owner and user password validation shared by the UI and the main process. */
export function validateSecurityOptions(options: SecurityOptions): string[] {
  const problems: string[] = [];
  if (!options.userPassword && !options.ownerPassword) problems.push('Set at least one password.');
  if (options.userPassword && options.userPassword.length < 4) problems.push('Use at least 4 characters.');
  if (options.userPassword && options.ownerPassword && options.userPassword === options.ownerPassword) {
    problems.push('The owner password should differ from the user password.');
  }
  return problems;
}
