import type { PDFFont } from '@cantoo/pdf-lib';

export interface WrappedLine {
  text: string;
  width: number;
}

/**
 * Greedy word wrapping that also breaks over-long words and preserves explicit
 * newlines. Hyphenation is intentionally avoided: PDF text should stay
 * searchable and copy-pasteable exactly as authored.
 */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): WrappedLine[] {
  const lines: WrappedLine[] = [];
  const measure = (value: string) => {
    try {
      return font.widthOfTextAtSize(value, size);
    } catch {
      return value.length * size * 0.5;
    }
  };

  for (const paragraph of text.split(/\r?\n/)) {
    if (paragraph.trim() === '') {
      lines.push({ text: '', width: 0 });
      continue;
    }
    const words = paragraph.split(/(\s+)/).filter((word) => word.length > 0);
    let current = '';
    const flush = () => {
      const trimmed = current.replace(/\s+$/, '');
      lines.push({ text: trimmed, width: measure(trimmed) });
      current = '';
    };

    for (const word of words) {
      if (current === '' && /^\s+$/.test(word)) continue;
      const candidate = current + word;
      if (measure(candidate) <= maxWidth || current === '') {
        if (/^\s+$/.test(word)) {
          current = candidate;
          continue;
        }
        if (measure(candidate) <= maxWidth) {
          current = candidate;
          continue;
        }
        // A single word longer than the line: hard break it.
        let chunk = '';
        for (const char of word) {
          if (measure(chunk + char) > maxWidth && chunk !== '') {
            lines.push({ text: chunk, width: measure(chunk) });
            chunk = char;
          } else {
            chunk += char;
          }
        }
        current = chunk;
        continue;
      }
      flush();
      current = word.trimStart();
    }
    flush();
  }

  return lines;
}

export interface DrawTextOptions {
  x: number;
  y: number;
  maxWidth: number;
  fontSize: number;
  lineHeight: number;
  align: 'left' | 'center' | 'right';
  /** Top of the text block; lines are drawn downward. */
  startFromTop?: boolean;
}

export interface LaidOutLine extends WrappedLine {
  x: number;
  baselineY: number;
}

/**
 * Computes the box positions for each wrapped line. Coordinates are in PDF user
 * space with the origin at the bottom-left of the page.
 */
export function layoutText(text: string, font: PDFFont, options: DrawTextOptions): { lines: LaidOutLine[]; height: number } {
  const wrapped = wrapText(text, font, options.fontSize, options.maxWidth);
  const lineStep = options.fontSize * options.lineHeight;
  const lines = wrapped.map((line, index) => {
    let x = options.x;
    if (options.align === 'center') x = options.x + (options.maxWidth - line.width) / 2;
    if (options.align === 'right') x = options.x + (options.maxWidth - line.width);
    const baselineY = options.y - index * lineStep;
    return { ...line, x: Math.max(options.x, x), baselineY };
  });
  return { lines, height: wrapped.length * lineStep };
}

/** Splits text into lines that fit a given width (used for form fields and stamps). */
export function fitLines(text: string, font: PDFFont, size: number, maxWidth: number, maxLines: number): string[] {
  return wrapText(text, font, size, maxWidth)
    .map((line) => line.text)
    .slice(0, maxLines);
}

/** Counts the "visual" length of a string for layout debugging and tests. */
export function measureWidth(text: string, font: PDFFont, size: number): number {
  try {
    return font.widthOfTextAtSize(text, size);
  } catch {
    return text.length * size * 0.5;
  }
}
