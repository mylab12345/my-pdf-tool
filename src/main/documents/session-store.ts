import type { PDFDocument } from '@cantoo/pdf-lib';
import { LIMITS } from '../../shared/constants';
import { baseName, ensureExtension } from '../../shared/format';
import type { DocumentOperation } from '../../shared/ipc';
import type {
  Annotation,
  DocumentSummary,
  PageOrientation,
  PageSizeName,
  PdfInfo,
  SecurityOptions,
  TextDocumentOptions,
} from '../../shared/types';
import { appError, normalizeError } from '../../core/errors';
import { listAnnotations } from '../../core/pdf/annotations';
import { createId } from '../../core/pdf/annotation-io';
import { createBlankDocument, createImageDocument, createTextDocument, type ImageInput } from '../../core/pdf/create';
import type { FontManager } from '../../core/pdf/fonts';
import { buildPdfInfo } from '../../core/pdf/info';
import { detectEncryption, loadPdf, savePdf } from '../../core/pdf/loader';
import { applyOperation, describeOperation, validateOperation, type OperationContext } from '../../core/pdf/operations';
import { encryptDocument } from '../../core/pdf/security';
import type { PdfRenderer } from '../../core/raster/renderer';

export interface SessionFileSystem {
  readFile(path: string): Promise<Uint8Array>;
  /** Writes atomically (temp file + rename) and preserves permissions. */
  writeFile(path: string, bytes: Uint8Array, options?: { backup?: boolean }): Promise<void>;
}

export interface SessionDependencies {
  renderer: PdfRenderer;
  fonts: FontManager;
  fs: SessionFileSystem;
  newId?: () => string;
  onChanged?: (summary: DocumentSummary) => void;
}

interface Session {
  id: string;
  name: string;
  path: string | null;
  password?: string;
  security?: SecurityOptions | null;
  baseBytes: Uint8Array;
  operations: DocumentOperation[];
  undone: DocumentOperation[];
  revision: number;
  dirty: boolean;
  readOnly: boolean;
  cache: { revision: number; bytes: Uint8Array; info: PdfInfo } | null;
}

export interface OpenSessionOptions {
  path?: string | null;
  name?: string;
  password?: string;
  readOnly?: boolean;
}

/**
 * In-memory document store.
 *
 * Each session keeps the bytes it was opened with plus the list of operations
 * applied on top. Undo/redo replays the list, so large documents are never
 * duplicated in memory and every edit is deterministic and testable.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private counter = 0;

  constructor(private readonly deps: SessionDependencies) {}

  private nextId(): string {
    if (this.deps.newId) return this.deps.newId();
    this.counter += 1;
    return `doc-${Date.now().toString(36)}-${this.counter}`;
  }

  private context(): OperationContext {
    return { fonts: this.deps.fonts };
  }

  /* ---------------------------------------------------------------------- */
  /* Opening and creating                                                    */
  /* ---------------------------------------------------------------------- */

  async openPath(path: string, options: { password?: string; readOnly?: boolean } = {}): Promise<DocumentSummary> {
    let bytes: Uint8Array;
    try {
      bytes = await this.deps.fs.readFile(path);
    } catch (error) {
      throw normalizeError(error);
    }
    return this.openBytes(bytes, {
      path,
      name: baseName(path),
      ...(options.password !== undefined ? { password: options.password } : {}),
      ...(options.readOnly ? { readOnly: true } : {}),
    });
  }

  async openBytes(bytes: Uint8Array, options: OpenSessionOptions = {}): Promise<DocumentSummary> {
    if (!bytes || bytes.byteLength === 0) {
      throw appError('INVALID_INPUT', 'The file is empty.');
    }
    const doc = await loadPdf(bytes, options.password !== undefined ? { password: options.password } : {});
    const id = this.nextId();
    const encryption = detectEncryption(bytes);
    const session: Session = {
      id,
      name: options.name ?? (options.path ? baseName(options.path) : 'Untitled.pdf'),
      path: options.path ?? null,
      ...(options.password !== undefined ? { password: options.password } : {}),
      security: null,
      baseBytes: new Uint8Array(bytes),
      operations: [],
      undone: [],
      revision: 1,
      dirty: false,
      readOnly: options.readOnly ?? false,
      cache: null,
    };
    void encryption;
    this.sessions.set(id, session);
    // Build the info eagerly so the first UI paint has page geometry.
    await this.info(id, doc);
    return this.summary(session);
  }

  async createBlank(options: { pageSize: PageSizeName; orientation: PageOrientation; name?: string }): Promise<DocumentSummary> {
    const bytes = await createBlankDocument({ pageSize: options.pageSize, orientation: options.orientation });
    return this.openBytes(bytes, { name: options.name ?? 'Untitled.pdf', path: null });
  }

  async createFromText(options: TextDocumentOptions): Promise<DocumentSummary> {
    const bytes = await createTextDocument(options, this.deps.fonts);
    const name = `${(options.title || 'Document').replace(/[\\/:*?"<>|]/g, '-')}.pdf`;
    return this.openBytes(bytes, { name });
  }

  async createFromImages(options: { images: ImageInput[]; pageSize: string; orientation: PageOrientation; margin: number; onePerPage: boolean }, name = 'Images.pdf'): Promise<DocumentSummary> {
    const bytes = await createImageDocument(
      {
        images: [],
        pageSize: options.pageSize === 'FitImage' ? 'FitImage' : (options.pageSize as PageSizeName),
        orientation: options.orientation,
        margin: options.margin,
        onePerPage: options.onePerPage,
      },
      options.images,
    );
    return this.openBytes(bytes, { name });
  }

  /* ---------------------------------------------------------------------- */
  /* Reading                                                                 */
  /* ---------------------------------------------------------------------- */

  private get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw appError('NOT_FOUND', 'This document is no longer open.');
    return session;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  summaries(): DocumentSummary[] {
    return [...this.sessions.values()].map((session) => this.summary(session));
  }

  summary(session: Session): DocumentSummary {
    const cache = session.cache;
    return {
      id: session.id,
      path: session.path,
      name: session.name,
      pageCount: cache?.info.pageCount ?? 0,
      fileSize: cache?.bytes.byteLength ?? session.baseBytes.byteLength,
      dirty: session.dirty,
      encrypted: Boolean(session.security) || Boolean(session.password) || detectEncryption(session.baseBytes).encrypted,
      canUndo: session.operations.length > 0,
      canRedo: session.undone.length > 0,
      ...(session.operations.length ? { undoLabel: describeOperation(session.operations[session.operations.length - 1]!) } : {}),
      ...(session.undone.length ? { redoLabel: describeOperation(session.undone[session.undone.length - 1]!) } : {}),
    };
  }

  summaryOf(id: string): DocumentSummary {
    return this.summary(this.get(id));
  }

  /** Current bytes, replaying the operation list when needed. */
  async bytes(id: string): Promise<Uint8Array> {
    const session = this.get(id);
    if (session.cache && session.cache.revision === session.revision) return session.cache.bytes;
    const bytes = await this.render(session);
    const info = await this.inspect(session, bytes);
    session.cache = { revision: session.revision, bytes, info };
    return bytes;
  }

  private async render(session: Session): Promise<Uint8Array> {
    if (session.operations.length === 0) return session.baseBytes;
    const doc = await loadPdf(session.baseBytes, session.password !== undefined ? { password: session.password } : {});
    for (const operation of session.operations) {
      await applyOperation(doc, operation, this.context());
    }
    if (session.security) encryptDocument(doc, session.security);
    return savePdf(doc);
  }

  async info(id: string, existingDoc?: PDFDocument): Promise<PdfInfo> {
    const session = this.get(id);
    if (session.cache && session.cache.revision === session.revision && !existingDoc) {
      return session.cache.info;
    }
    if (existingDoc) {
      const snapshot = await this.safeInspectBytes(session.baseBytes, session.password);
      // The cached info is recomputed lazily on first `bytes()` call.
      const info = buildPdfInfo({ bytes: session.baseBytes, doc: existingDoc, ...(snapshot ? { snapshot } : {}), fileSize: session.baseBytes.byteLength });
      session.cache = { revision: session.revision, bytes: session.baseBytes, info };
      return info;
    }
    const bytes = await this.bytes(id);
    return session.cache!.info;
  }

  private async inspect(session: Session, bytes: Uint8Array): Promise<PdfInfo> {
    const doc = await loadPdf(bytes, session.password !== undefined ? { password: session.password } : {});
    const snapshot = await this.safeInspectBytes(bytes, session.password);
    return buildPdfInfo({ bytes, doc, ...(snapshot ? { snapshot } : {}), fileSize: bytes.byteLength });
  }

  private async safeInspectBytes(bytes: Uint8Array, password?: string) {
    try {
      return await this.deps.renderer.inspect(bytes, password !== undefined ? { password, textSampleSize: 6 } : { textSampleSize: 6 });
    } catch {
      // A malformed document should still be openable for repair.
      return undefined;
    }
  }

  async annotations(id: string): Promise<Annotation[]> {
    const session = this.get(id);
    const bytes = await this.bytes(id);
    const doc = await loadPdf(bytes, session.password !== undefined ? { password: session.password } : {});
    return listAnnotations(doc);
  }

  /* ---------------------------------------------------------------------- */
  /* Editing                                                                 */
  /* ---------------------------------------------------------------------- */

  async apply(id: string, operations: DocumentOperation[]): Promise<DocumentSummary> {
    const session = this.get(id);
    if (session.readOnly) throw appError('PERMISSION_DENIED', 'This document is open in read-only mode.');
    if (!operations.length) return this.summary(session);
    const info = await this.info(id);
    for (const operation of operations) {
      const problems = validateOperation(operation, info.pageCount);
      if (problems.length) throw appError('INVALID_INPUT', problems[0]!, { details: problems.join(' ') });
    }
    // Pin annotation ids before the operations are recorded: undo/redo replays
    // the list, so the ids must not change between passes.
    for (const operation of operations) {
      if (operation.kind === 'addAnnotation' && !operation.annotation.id) {
        operation.annotation.id = createId();
      }
    }
    session.operations.push(...operations);
    session.undone = [];
    if (session.operations.length > LIMITS.historyDepth) {
      // Collapse the oldest operations into the base bytes.
      await this.collapseHistory(session);
    }
    session.revision += 1;
    session.dirty = true;
    session.cache = null;
    // Recompute eagerly so the caller gets a correct summary and page count.
    await this.bytes(id);
    const summary = this.summary(session);
    this.deps.onChanged?.(summary);
    return summary;
  }

  private async collapseHistory(session: Session): Promise<void> {
    const keep = Math.floor(LIMITS.historyDepth / 2);
    const dropped = session.operations.slice(0, session.operations.length - keep);
    const doc = await loadPdf(session.baseBytes, session.password !== undefined ? { password: session.password } : {});
    for (const operation of dropped) await applyOperation(doc, operation, this.context());
    session.baseBytes = await savePdf(doc);
    session.operations = session.operations.slice(-keep);
  }

  async undo(id: string): Promise<DocumentSummary> {
    const session = this.get(id);
    const operation = session.operations.pop();
    if (!operation) return this.summary(session);
    session.undone.push(operation);
    session.revision += 1;
    session.dirty = true;
    session.cache = null;
    await this.bytes(id);
    const summary = this.summary(session);
    this.deps.onChanged?.(summary);
    return summary;
  }

  async redo(id: string): Promise<DocumentSummary> {
    const session = this.get(id);
    const operation = session.undone.pop();
    if (!operation) return this.summary(session);
    session.operations.push(operation);
    session.revision += 1;
    session.dirty = true;
    session.cache = null;
    await this.bytes(id);
    const summary = this.summary(session);
    this.deps.onChanged?.(summary);
    return summary;
  }

  /** Replaces the document bytes (used by terminal tools: OCR, sign, redact…). */
  async replaceBytes(id: string, bytes: Uint8Array, options: { security?: SecurityOptions | null; keepHistory?: boolean } = {}): Promise<DocumentSummary> {
    const session = this.get(id);
    session.baseBytes = new Uint8Array(bytes);
    if (!options.keepHistory) {
      session.operations = [];
      session.undone = [];
    }
    session.security = options.security ?? null;
    session.revision += 1;
    session.dirty = true;
    session.cache = null;
    await this.bytes(id);
    const summary = this.summary(session);
    this.deps.onChanged?.(summary);
    return summary;
  }

  /** Applies password protection to the session (all future saves re-encrypt). */
  async setSecurity(id: string, security: SecurityOptions | null): Promise<DocumentSummary> {
    const session = this.get(id);
    session.security = security;
    session.dirty = true;
    session.revision += 1;
    session.cache = null;
    await this.bytes(id);
    const summary = this.summary(session);
    this.deps.onChanged?.(summary);
    return summary;
  }

  /* ---------------------------------------------------------------------- */
  /* Saving                                                                  */
  /* ---------------------------------------------------------------------- */

  async save(id: string, options: { path?: string; keepBackup?: boolean } = {}): Promise<{ path: string }> {
    const session = this.get(id);
    if (!options.path && !session.path) {
      throw appError('INVALID_INPUT', 'Choose a location to save the document.');
    }
    const target = ensureExtension(options.path ?? session.path!, '.pdf');
    const bytes = await this.bytes(id);
    try {
      await this.deps.fs.writeFile(target, bytes, options.keepBackup ? { backup: true } : {});
    } catch (error) {
      throw normalizeError(error);
    }
    session.path = target;
    session.name = baseName(target);
    session.baseBytes = new Uint8Array(bytes);
    session.operations = [];
    session.undone = [];
    session.dirty = false;
    session.revision += 1;
    session.cache = null;
    await this.info(id);
    const summary = this.summary(session);
    this.deps.onChanged?.(summary);
    return { path: target };
  }

  close(id: string): void {
    this.sessions.delete(id);
    void this.deps.renderer.release(`session:${id}`);
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  /** Bytes for the custom protocol / pdf.js (current revision). */
  async documentFor(id: string): Promise<Uint8Array> {
    return this.bytes(id);
  }

  getPassword(id: string): string | undefined {
    return this.get(id).password;
  }

  rename(id: string, name: string): DocumentSummary {
    const session = this.get(id);
    session.name = name;
    return this.summary(session);
  }

  /** Monotonic revision of a session (bumped on every change). */
  revisionOf(id: string): number {
    return this.get(id).revision;
  }

  isDirty(id: string): boolean {
    return this.get(id).dirty;
  }

  dirtySessions(): DocumentSummary[] {
    return [...this.sessions.values()].filter((session) => session.dirty).map((session) => this.summary(session));
  }
}
