/**
 * Domain types shared by the main process, the preload bridge and the renderer.
 *
 * Nothing in this file may import Electron, Node or DOM APIs: it is the common
 * vocabulary of the whole application.
 */

export interface Point {
  x: number;
  y: number;
}

/** Axis-aligned rectangle in PDF user space (origin bottom-left, points). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageSize {
  width: number;
  height: number;
}

export type PageOrientation = 'portrait' | 'landscape';

export type PageSizeName =
  | 'A0'
  | 'A1'
  | 'A2'
  | 'A3'
  | 'A4'
  | 'A5'
  | 'A6'
  | 'Letter'
  | 'Legal'
  | 'Tabloid'
  | 'Executive'
  | 'Custom';

export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  creator?: string;
  producer?: string;
  creationDate?: string;
  modificationDate?: string;
}

export interface PageInfo {
  /** Zero-based page index. */
  index: number;
  width: number;
  height: number;
  /** Clockwise rotation in degrees (0 | 90 | 180 | 270). */
  rotation: number;
  /** Human readable page label when the document defines one. */
  label?: string;
  /** True when the page has an extractable text layer. */
  hasText?: boolean;
}

export interface PdfInfo {
  fileSize: number;
  pageCount: number;
  pages: PageInfo[];
  metadata: PdfMetadata;
  /** AES/RC4 encrypted (password protected). */
  encrypted: boolean;
  /** Only exposed when the document was opened (decrypted) successfully. */
  encryptionAlgorithm?: 'AES-256' | 'AES-128' | 'RC4-128' | 'RC4-40' | 'unknown';
  hasForms: boolean;
  formFields: FormFieldInfo[];
  hasSignatures: boolean;
  outline: OutlineItem[];
  attachments: AttachmentInfo[];
  /** Text characters found by the text layer (0 means a scanned document). */
  textCharacters: number;
  pdfVersion?: string;
}

export interface AttachmentInfo {
  name: string;
  size: number;
  mimeType?: string;
  description?: string;
}

export interface OutlineItem {
  title: string;
  pageIndex: number | null;
  children: OutlineItem[];
}

export type FormFieldType =
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'dropdown'
  | 'optionlist'
  | 'button'
  | 'signature'
  | 'unknown';

export interface FormFieldInfo {
  name: string;
  type: FormFieldType;
  value: string | boolean | string[] | null;
  options?: string[];
  required: boolean;
  readOnly: boolean;
  pageIndex: number | null;
  rect: Rect | null;
  multiline?: boolean;
  maxLength?: number;
}

/* -------------------------------------------------------------------------- */
/* Annotations                                                                 */
/* -------------------------------------------------------------------------- */

export type AnnotationType =
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'squiggly'
  | 'note'
  | 'freetext'
  | 'ink'
  | 'square'
  | 'circle'
  | 'line'
  | 'arrow'
  | 'stamp'
  | 'link'
  | 'redact'
  | 'signature'
  | 'unknown';

export interface AnnotationBase {
  id: string;
  type: AnnotationType;
  pageIndex: number;
  rect: Rect;
  /** Hex colour `#rrggbb`. */
  color: string;
  opacity: number;
  author?: string;
  contents?: string;
  createdAt?: string;
  /** False when the annotation was created by another application and can only be viewed. */
  editable?: boolean;
}

export interface MarkupAnnotation extends AnnotationBase {
  type: 'highlight' | 'underline' | 'strikeout' | 'squiggly';
  /** One rectangle per selected text line fragment. */
  quads: Rect[];
}

export interface NoteAnnotation extends AnnotationBase {
  type: 'note';
  icon: 'Note' | 'Comment' | 'Help' | 'Insert';
  /** True when the note is expanded in the document. */
  open?: boolean;
}

export interface FreeTextAnnotation extends AnnotationBase {
  type: 'freetext';
  text: string;
  fontSize: number;
  fontFamily: string;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  bold: boolean;
  italic: boolean;
  color: string;
  /** Background fill; `null` keeps the text transparent. */
  background: string | null;
  borderColor: string | null;
  borderWidth: number;
}

export interface InkAnnotation extends AnnotationBase {
  type: 'ink' | 'signature';
  /** Freehand strokes in PDF user space. */
  paths: Point[][];
  strokeWidth: number;
  /** Optional bitmap (PNG/JPEG base64) used for signature stamps. */
  image?: string;
}

export interface ShapeAnnotation extends AnnotationBase {
  type: 'square' | 'circle' | 'line' | 'arrow' | 'redact';
  strokeWidth: number;
  fill: string | null;
  start?: Point;
  end?: Point;
}

export interface StampAnnotation extends AnnotationBase {
  type: 'stamp';
  /** Base64 PNG/JPEG. */
  image: string;
  label?: string;
}

export interface LinkAnnotation extends AnnotationBase {
  type: 'link';
  url?: string;
  targetPageIndex?: number;
}

export type Annotation =
  | MarkupAnnotation
  | NoteAnnotation
  | FreeTextAnnotation
  | InkAnnotation
  | ShapeAnnotation
  | StampAnnotation
  | LinkAnnotation
  | (AnnotationBase & { type: 'unknown' });

/**
 * Annotations accepted for creation.
 *
 * `id` is normally assigned by the engine, but callers may supply one so that a
 * recorded edit replays to the exact same annotation (used by undo/redo, which
 * re-applies the operation list).
 */
type Assignable<T> = Omit<T, 'id' | 'createdAt'> & { id?: string };

export type AnnotationInput =
  | Assignable<MarkupAnnotation>
  | Assignable<NoteAnnotation>
  | Assignable<FreeTextAnnotation>
  | Assignable<InkAnnotation>
  | Assignable<ShapeAnnotation>
  | Assignable<StampAnnotation>
  | Assignable<LinkAnnotation>;

/* -------------------------------------------------------------------------- */
/* Feature option payloads                                                     */
/* -------------------------------------------------------------------------- */

export interface SecurityOptions {
  userPassword?: string;
  ownerPassword?: string;
  algorithm?: 'AES-256' | 'AES-128' | 'RC4-128' | 'RC4-40';
  permissions: {
    printing: boolean | 'lowResolution' | 'highResolution';
    modifying: boolean;
    copying: boolean;
    annotating: boolean;
    fillingForms: boolean;
    contentAccessibility: boolean;
    documentAssembly: boolean;
  };
}

export type CompressionProfile = 'lossless' | 'balanced' | 'aggressive' | 'custom';

export interface CompressionOptions {
  profile: CompressionProfile;
  /** Target image resolution for rasterised pages (DPI). */
  dpi?: number;
  /** JPEG quality 1-100 for rasterised pages. */
  quality?: number;
  /** Convert pages to images (destroys the text layer). */
  rasterizePages?: boolean;
  /** Remove metadata, thumbnails and unused objects. */
  stripMetadata?: boolean;
  /** Downsample embedded raster images above this DPI. */
  imageDpi?: number;
  grayscale?: boolean;
}

export interface CompressionResult {
  bytes: Uint8Array;
  originalSize: number;
  compressedSize: number;
  method: string;
  lossy: boolean;
}

export interface WatermarkOptions {
  text?: string;
  image?: string;
  fontSize: number;
  color: string;
  opacity: number;
  rotation: number;
  /** Relative position 0-1 in page space (0.5 = centre). */
  x: number;
  y: number;
  tile: boolean;
  scale: number;
  fontFamily: string;
  pages?: number[] | null;
}

export interface HeaderFooterOptions {
  headerLeft?: string;
  headerCenter?: string;
  headerRight?: string;
  footerLeft?: string;
  footerCenter?: string;
  footerRight?: string;
  fontSize: number;
  color: string;
  margin: number;
  fontFamily: string;
  firstPageNumber: number;
  pageNumberFormat: string;
  includeOnFirstPage: boolean;
  pages?: number[] | null;
}

export interface OcrOptions {
  /** BCP-47-ish tesseract language codes, e.g. ['eng'] or ['eng','deu']. */
  languages: string[];
  /** Render DPI used for recognition (300 is a good default). */
  dpi: number;
  pages?: number[] | null;
  /** Embed an invisible text layer so the PDF becomes searchable. */
  searchablePdf: boolean;
}

export interface OcrPageResult {
  pageIndex: number;
  text: string;
  confidence: number;
  words: OcrWord[];
  width: number;
  height: number;
}

export interface OcrWord {
  text: string;
  /** Bounding box in image pixels at the rendered scale. */
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number;
}

export interface OcrResult {
  pages: OcrPageResult[];
  text: string;
  /** Present when a searchable PDF was produced. */
  bytes?: Uint8Array;
  languages: string[];
  durationMs: number;
}

export type ImageFormat = 'png' | 'jpeg';

export interface ConvertToImagesOptions {
  format: ImageFormat;
  dpi: number;
  quality: number;
  pages?: number[] | null;
  grayscale?: boolean;
}

export interface ConvertedImage {
  pageIndex: number;
  name: string;
  data: Uint8Array;
  width: number;
  height: number;
}

export type TextExportFormat = 'txt' | 'markdown' | 'html';

export interface SignatureOptions {
  /** Visible signature image (base64 PNG). */
  image?: string;
  /** Existing PKCS#12 keystore (base64). */
  p12?: string;
  p12Password?: string;
  reason?: string;
  location?: string;
  contactInfo?: string;
  signerName?: string;
  /** Add a cryptographic signature (PAdES B-B / adbe.pkcs7.detached). */
  digital: boolean;
  pageIndex: number;
  rect: Rect;
}

export interface CreatedCertificate {
  p12: string;
  fingerprint: string;
  subject: string;
  validFrom: string;
  validTo: string;
  pem: string;
}

export interface SignatureVerification {
  signed: boolean;
  valid: boolean;
  signerName?: string;
  issuer?: string;
  signingTime?: string;
  reason?: string;
  location?: string;
  algorithm?: string;
  integrityOk: boolean;
  certificateValidFrom?: string;
  certificateValidTo?: string;
  selfSigned?: boolean;
  messages: string[];
}

export interface RedactionRegion {
  pageIndex: number;
  rects: Rect[];
}

export interface RedactionOptions {
  regions: RedactionRegion[];
  /** Fill colour of the redaction boxes. */
  fill: string;
  /** Also remove document metadata and embedded attachments. */
  scrubMetadata: boolean;
  /** Resolution used when rasterising the pages. */
  dpi: number;
  /** Strings that must no longer appear in the produced document (verified). */
  verifyStrings?: string[];
}

export interface RedactionResult {
  bytes: Uint8Array;
  pagesRedacted: number;
  removedTextCount: number;
  /** True when every `verifyStrings` entry is absent from the output. */
  verified: boolean;
  remaining: string[];
}

export interface FillValue {
  type: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'optionlist';
  value: string | boolean;
}

export interface TextDocumentOptions {
  title: string;
  text: string;
  pageSize: PageSizeName;
  orientation: PageOrientation;
  fontSize: number;
  fontFamily: string;
  margin: number;
  lineHeight: number;
  footer?: string;
}

export interface ImageDocumentOptions {
  images: { name: string; dataUrl: string }[];
  pageSize: PageSizeName | 'FitImage';
  orientation: PageOrientation;
  margin: number;
  onePerPage: boolean;
}

export interface DocumentSummary {
  id: string;
  path: string | null;
  name: string;
  pageCount: number;
  fileSize: number;
  dirty: boolean;
  encrypted: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
}

export interface RenderedPage {
  pageIndex: number;
  width: number;
  height: number;
  data: Uint8Array;
  format: ImageFormat;
}

export interface FontInfo {
  /** Stable identifier: `standard:Helvetica` or `system:/path/font.ttf`. */
  id: string;
  /** PostScript/family name shown in the UI. */
  family: string;
  style: string;
  /** True when the font can embed arbitrary Unicode. */
  unicode: boolean;
  source: 'standard' | 'bundled' | 'system';
  path?: string;
}

export interface RecentFile {
  path: string;
  name: string;
  openedAt: string;
  size: number;
}

export interface AppSettings {
  theme: 'system' | 'light' | 'dark';
  accent: string;
  defaultPageSize: PageSizeName;
  defaultOrientation: PageOrientation;
  autosaveEnabled: boolean;
  autosaveIntervalSeconds: number;
  maxRecentFiles: number;
  confirmOnClose: boolean;
  defaultOcrLanguages: string[];
  defaultCompressionProfile: CompressionProfile;
  renderDpi: number;
  showSidebar: boolean;
  printScale: 'fit' | 'actual';
  language: string;
  checkAssociationsOnStart: boolean;
}

export interface EnvironmentReport {
  platform: string;
  arch: string;
  osVersion: string;
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  locale: string;
  totalMemoryMb: number;
  cpuCount: number;
  fontsBundled: number;
  ocrLanguages: string[];
  paths: {
    documents: string;
    downloads: string;
    userData: string;
    temp: string;
  };
  capabilities: {
    printing: boolean;
    clipboardImages: boolean;
    fileAssociations: boolean;
    nativeDialogs: boolean;
    dragAndDrop: boolean;
  };
}

export interface AppErrorPayload {
  code: string;
  message: string;
  details?: string;
  /** Suggested recovery action shown to the user. */
  hint?: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppErrorPayload };
