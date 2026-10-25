import { BrowserWindow } from 'electron';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { PrintOptions, PrintResult } from '../shared/ipc';
import { appError } from '../core/errors';

/**
 * Printing.
 *
 * A hidden BrowserWindow loads the document through the app's own document
 * protocol (so Chromium's internal PDF viewer handles pagination) and the result
 * is either sent to a printer or, when `outputPath` is set, written as a PDF via
 * `printToPDF`. This keeps printing pixel-identical to the on-screen rendering
 * on both Windows and Linux without any native printing dependency.
 */
export interface PrintDependencies {
  /** Returns the bytes of the document to print. */
  loadDocument(id: string): Promise<Uint8Array>;
  /** Builds a one-shot URL the hidden window can load. */
  registerPrintable(bytes: Uint8Array): string;
  onAfterPrint?(): void;
}

export async function printDocument(
  documentId: string,
  options: PrintOptions & { outputPath?: string },
  deps: PrintDependencies,
): Promise<PrintResult> {
  const bytes = await deps.loadDocument(documentId);
  if (!bytes.byteLength) throw appError('PRINT_FAILED', 'The document is empty.');

  const window = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1400,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      plugins: true,
    },
  });

  try {
    const url = deps.registerPrintable(bytes);
    await window.loadURL(url);
    // Give the PDF plugin a moment to lay out the document.
    await delay(options.silent === false ? 600 : 350);

    if (options.outputPath) {
      const pdf = await window.webContents.printToPDF({
        printBackground: true,
        landscape: options.landscape ?? false,
        scale: options.scale === 'actual' ? 1 : 1,
        preferCSSPageSize: false,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      await writeFile(options.outputPath, pdf);
      return { printed: true, message: `Saved print output to ${path.basename(options.outputPath)}` };
    }

    const printerName = options.printerName ?? (await defaultPrinter());
    const success = await new Promise<boolean>((resolve) => {
      window.webContents.print(
        {
          silent: options.silent,
          printBackground: true,
          ...(printerName ? { deviceName: printerName } : {}),
          copies: Math.max(1, Math.min(99, options.copies ?? 1)),
          landscape: options.landscape ?? false,
          ...(options.color !== undefined ? { color: options.color } : {}),
          margins: { marginType: 'default' },
          ...(options.duplex && options.duplex !== 'simplex'
            ? { duplexMode: options.duplex === 'short-edge' ? 'shortEdge' : 'longEdge' }
            : {}),
        },
        (ok, reason) => {
          if (!ok) console.warn('[print] failed:', reason);
          resolve(ok);
        },
      );
    });

    if (!success) {
      throw appError('PRINT_FAILED', 'The document could not be printed.', {
        hint: 'Check that a printer is available and not paused, then try again.',
      });
    }
    return { printed: true, ...(printerName ? { printerName } : {}) };
  } finally {
    deps.onAfterPrint?.();
    if (!window.isDestroyed()) window.destroy();
  }
}

/** Lists installed printers via the main window's webContents. */
export async function listPrinters(hostWindow: BrowserWindow | null): Promise<{ name: string; isDefault: boolean }[]> {
  if (!hostWindow || hostWindow.isDestroyed()) return [];
  try {
    const printers = await hostWindow.webContents.getPrintersAsync();
    const defaultName = printers.find((printer) => (printer as { isDefault?: boolean }).isDefault)?.name ?? printers[0]?.name;
    return printers.map((printer) => ({ name: printer.name, isDefault: printer.name === defaultName }));
  } catch {
    return [];
  }
}

async function defaultPrinter(): Promise<string | undefined> {
  try {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return undefined;
    const printers = await window.webContents.getPrintersAsync();
    return printers.find((printer) => (printer as { isDefault?: boolean }).isDefault)?.name ?? printers[0]?.name;
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
