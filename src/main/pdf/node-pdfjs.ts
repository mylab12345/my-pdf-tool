import path from 'node:path';
import { existsSync } from 'node:fs';
import type { PdfjsModule, RendererDependencies } from '../../core/raster/types';
import { NapiCanvasFactory, NapiCanvasProvider } from './node-canvas';

/**
 * pdf.js loader for the Node/Electron main process.
 *
 * pdf.js 6 ships ESM only, so it is imported dynamically (the main bundle stays
 * CommonJS for Electron compatibility). Asset directories are resolved from the
 * pdfjs-dist package so they work both unpacked and inside an asar archive.
 */
let modulePromise: Promise<PdfjsModule> | null = null;

export function loadPdfjsNode(): Promise<PdfjsModule> {
  modulePromise ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((module) => module as unknown as PdfjsModule);
  return modulePromise;
}

function resolvePdfjsAsset(name: string): string | undefined {
  try {
    const packageJson = require.resolve('pdfjs-dist/package.json');
    const candidate = path.join(path.dirname(packageJson), name);
    if (existsSync(candidate)) return candidate.endsWith(path.sep) ? candidate : `${candidate}${path.sep}`;
  } catch {
    /* package layout changed or asar resolution failed */
  }
  return undefined;
}

/** Full renderer configuration for the main process. */
export function createNodeRendererDependencies(options: { verbosity?: number } = {}): RendererDependencies {
  const canvasProvider = new NapiCanvasProvider();
  return {
    loadPdfjs: loadPdfjsNode,
    canvas: canvasProvider,
    ...(resolvePdfjsAsset('standard_fonts') ? { standardFontDataUrl: resolvePdfjsAsset('standard_fonts')! } : {}),
    ...(resolvePdfjsAsset('cmaps') ? { cMapUrl: resolvePdfjsAsset('cmaps')! } : {}),
    verbosity: options.verbosity ?? 0,
    documentOptions: {
      // pdf.js expects a factory *class* for scratch canvases (patterns, masks).
      CanvasFactory: NapiCanvasFactory,
    },
  };
}
