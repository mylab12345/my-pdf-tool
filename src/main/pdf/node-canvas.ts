import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { CanvasHandle, CanvasProvider } from '../../core/raster/types';
import type { ImageFormat } from '../../shared/types';

/**
 * Canvas implementation for the Electron main process (and Node tests).
 *
 * `@napi-rs/canvas` ships prebuilt N-API binaries for Windows (x64/arm64) and
 * Linux (glibc/musl), so the renderer does not need a system Cairo/Pango
 * installation and the same code path runs on both target platforms.
 */
export class NapiCanvasProvider implements CanvasProvider {
  create(width: number, height: number): CanvasHandle {
    const canvas = createCanvas(Math.max(1, width), Math.max(1, height));
    const context = canvas.getContext('2d');
    return { canvas, context };
  }

  reset(handle: CanvasHandle, width: number, height: number): void {
    const canvas = handle.canvas as Canvas;
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
  }

  destroy(handle: CanvasHandle): void {
    const canvas = handle.canvas as Canvas;
    canvas.width = 1;
    canvas.height = 1;
  }

  encode(handle: CanvasHandle, format: ImageFormat, quality: number, grayscale: boolean): Uint8Array {
    const canvas = handle.canvas as Canvas;
    if (grayscale) {
      const context = handle.context as SKRSContext2D;
      try {
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const data = image.data;
        for (let index = 0; index < data.length; index += 4) {
          const luminance = 0.299 * data[index]! + 0.587 * data[index + 1]! + 0.114 * data[index + 2]!;
          data[index] = luminance;
          data[index + 1] = luminance;
          data[index + 2] = luminance;
        }
        context.putImageData(image, 0, 0);
      } catch {
        /* fall back to colour output */
      }
    }
    if (format === 'jpeg') {
      return new Uint8Array(canvas.toBuffer('image/jpeg', Math.min(100, Math.max(1, quality)) / 100));
    }
    return new Uint8Array(canvas.toBuffer('image/png'));
  }
}

/** pdf.js CanvasFactory implementation used when it needs scratch canvases. */
export class NapiCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(Math.max(1, width), Math.max(1, height));
    return { canvas, context: canvas.getContext('2d') };
  }

  reset(target: { canvas: Canvas; context: SKRSContext2D }, width: number, height: number): void {
    target.canvas.width = Math.max(1, width);
    target.canvas.height = Math.max(1, height);
  }

  destroy(target: { canvas: Canvas; context: SKRSContext2D }): void {
    target.canvas.width = 1;
    target.canvas.height = 1;
  }
}
