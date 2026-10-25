import type { ImageFormat } from '../../shared/types';

/**
 * Minimal structural types for the parts of pdf.js the engine uses.
 *
 * Declaring them locally keeps `src/core` free of a hard dependency on the
 * pdf.js typings (which differ between the browser and Node builds) while still
 * type checking every call site.
 */

export interface PdfjsViewport {
  width: number;
  height: number;
  rotation: number;
  scale: number;
  convertToPdfPoint?: (x: number, y: number) => [number, number];
  convertToViewportPoint?: (x: number, y: number) => [number, number];
}

export interface PdfjsTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName?: string;
  hasEOL?: boolean;
}

export interface PdfjsTextContent {
  items: PdfjsTextItem[];
}

export interface PdfjsRenderTask {
  promise: Promise<void>;
  cancel?: () => void;
}

export interface PdfjsPage {
  getViewport(params: { scale: number; rotation?: number; dontFlip?: boolean }): PdfjsViewport;
  render(params: Record<string, unknown>): PdfjsRenderTask;
  getTextContent(params?: Record<string, unknown>): Promise<PdfjsTextContent>;
  cleanup(): void | Promise<void>;
}

export interface PdfjsDocument {
  numPages: number;
  getPage(index: number): Promise<PdfjsPage>;
  getPageLabels(): Promise<string[] | null>;
  destroy(): Promise<void>;
}

export interface PdfjsModule {
  getDocument(params: Record<string, unknown>): { promise: Promise<PdfjsDocument>; destroy(): Promise<void> };
  GlobalWorkerOptions?: { workerSrc?: string };
  version?: string;
}

/** A canvas implementation (browser canvas or a native/headless one). */
export interface CanvasHandle {
  canvas: unknown;
  context: unknown;
}

export interface CanvasProvider {
  create(width: number, height: number): CanvasHandle;
  reset(handle: CanvasHandle, width: number, height: number): void;
  destroy(handle: CanvasHandle): void;
  /** Encodes the canvas into PNG or JPEG bytes at the requested quality (0-100). */
  encode(handle: CanvasHandle, format: ImageFormat, quality: number, grayscale: boolean): Uint8Array;
}

export interface RendererDependencies {
  /** Lazily resolves the pdf.js module for the current environment. */
  loadPdfjs(): Promise<PdfjsModule>;
  canvas: CanvasProvider;
  /** Directory (file path or URL) containing pdf.js standard fonts. */
  standardFontDataUrl?: string;
  /** Directory (file path or URL) containing pdf.js CMaps. */
  cMapUrl?: string;
  /** pdf.js verbosity (0 = errors only). */
  verbosity?: number;
  /** Extra pdf.js document options (e.g. a canvasFactory for Node). */
  documentOptions?: Record<string, unknown>;
}

export interface RenderOptions {
  /** Rasterisation resolution in dots per inch (72 = 1:1 with PDF points). */
  dpi: number;
  format?: ImageFormat;
  quality?: number;
  grayscale?: boolean;
  /** Stop between pages when this returns true. */
  shouldCancel?: () => boolean;
  onProgress?: (completed: number, total: number, pageIndex: number) => void;
  password?: string;
  /** Cap on the rendered pixel dimensions to bound memory usage. */
  maxDimension?: number;
}

export interface PageText {
  pageIndex: number;
  text: string;
  items: PdfjsTextItem[];
}

export interface PdfOutlineSnapshot {
  numPages: number;
  pages: { width: number; height: number; rotation: number }[];
  labels: (string | null)[];
  textCharacters: number;
  pagesWithText: number;
}
