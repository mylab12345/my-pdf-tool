import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { RedactionBox } from '../../core/pdf/redact';

/**
 * Paints opaque rectangles onto a rendered page bitmap.
 *
 * Used by the redaction pipeline: the bitmap is rebuilt from scratch (never
 * patched in place on the original vector content), so text underneath the boxes
 * cannot be recovered from the produced file.
 */
export async function paintBoxesOnImage(image: Uint8Array, boxes: RedactionBox[], fill: string): Promise<Uint8Array> {
  const decoded = await loadImage(Buffer.from(image));
  const canvas = createCanvas(decoded.width, decoded.height);
  const context = canvas.getContext('2d');
  context.drawImage(decoded, 0, 0);
  context.fillStyle = fill;
  for (const box of boxes) {
    context.fillRect(box.x, box.y, box.width, box.height);
  }
  return new Uint8Array(canvas.toBuffer('image/png'));
}
