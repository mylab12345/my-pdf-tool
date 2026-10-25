import path from 'node:path';
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createWorker } from 'tesseract.js';
import type { TesseractWorkerLike } from '../core/pdf/ocr';
import { appError } from '../core/errors';
import type { AppPaths } from './paths';

/**
 * Offline OCR worker factory.
 *
 * tesseract.js is pointed at the bundled traineddata (`langPath`) and a writable
 * cache directory, so recognition never performs a network request. The worker
 * runs in a Node worker thread inside the main process.
 */
export interface OcrWorkerFactory {
  create(
    languages: string[],
    onProgress?: (percent: number, status: string) => void,
  ): Promise<TesseractWorkerLike>;
  installed(): string[];
  importLanguageFile(filePath: string): Promise<string>;
  languageDirectory: string;
}

export function createOcrWorkerFactory(paths: AppPaths): OcrWorkerFactory {
  const cachePath = path.join(paths.temp, 'tesseract-cache');
  void mkdir(cachePath, { recursive: true });

  const installed = () => {
    try {
      const { readdirSync } = require('node:fs') as typeof import('node:fs');
      return readdirSync(paths.ocrLanguages)
        .filter((file: string) => file.endsWith('.traineddata.gz') || file.endsWith('.traineddata'))
        .map((file: string) => file.replace(/\.traineddata(\.gz)?$/, ''));
    } catch {
      return [];
    }
  };

  return {
    languageDirectory: paths.ocrLanguages,

    installed,

    async create(languages, onProgress) {
      const available = new Set(installed());
      const usable = languages.filter((language) => available.has(language));
      if (!usable.length) {
        throw appError('OCR_FAILED', `No OCR language data is installed for: ${languages.join(', ') || 'eng'}.`, {
          hint: 'Import the matching .traineddata file from Settings → OCR, or use English.',
        });
      }
      try {
        const worker = await createWorker(usable.join('+'), 1, {
          langPath: paths.ocrLanguages,
          cachePath,
          gzip: true,
          logger: (message: { progress?: number; status?: string }) => {
            onProgress?.(Math.round((message.progress ?? 0) * 100), message.status ?? '');
          },
          errorHandler: (error: unknown) => {
            console.warn('[ocr] worker error:', (error as Error)?.message ?? error);
          },
        });
        return worker as unknown as TesseractWorkerLike;
      } catch (error) {
        throw appError('OCR_FAILED', 'The OCR engine could not start.', {
          details: (error as Error).message,
          hint: 'Restart the application and try again.',
        });
      }
    },

    async importLanguageFile(filePath) {
      if (!existsSync(filePath)) throw appError('NOT_FOUND', 'The language file could not be found.');
      const name = path.basename(filePath);
      if (!/\.traineddata(\.gz)?$/.test(name)) {
        throw appError('INVALID_INPUT', 'Select a tesseract .traineddata or .traineddata.gz file.');
      }
      const target = path.join(paths.ocrLanguages, name);
      await mkdir(paths.ocrLanguages, { recursive: true });
      await copyFile(filePath, target);
      return name.replace(/\.traineddata(\.gz)?$/, '');
    },
  };
}
