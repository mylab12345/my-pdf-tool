import { strToU8, zipSync } from 'fflate';
import type { ConvertToImagesOptions, ConvertedImage, TextExportFormat } from '../../shared/types';
import type { PdfRenderer } from '../raster/renderer';

/** Renders pages to PNG/JPEG images for export. */
export async function convertToImages(
  bytes: Uint8Array,
  options: ConvertToImagesOptions,
  renderer: PdfRenderer,
  hooks: { onProgress?: (completed: number, total: number, label: string) => void; shouldCancel?: () => boolean } = {},
): Promise<ConvertedImage[]> {
  const info = await renderer.inspect(bytes);
  const pages = (options.pages ?? info.pages.map((_, index) => index)).filter((index) => index >= 0 && index < info.numPages);
  const rendered = await renderer.renderPages(bytes, pages, {
    dpi: options.dpi,
    format: options.format,
    quality: options.quality,
    grayscale: options.grayscale ?? false,
    onProgress: (completed, total, pageIndex) => hooks.onProgress?.(completed, total, `Rendering page ${pageIndex + 1}`),
    ...(hooks.shouldCancel ? { shouldCancel: hooks.shouldCancel } : {}),
  });
  const pad = Math.max(2, String(info.numPages).length);
  return rendered.map((page) => ({
    pageIndex: page.pageIndex,
    name: `page-${String(page.pageIndex + 1).padStart(pad, '0')}.${options.format === 'jpeg' ? 'jpg' : 'png'}`,
    data: page.data,
    width: page.width,
    height: page.height,
  }));
}

/** Packs exported files into a ZIP archive (no native dependency). */
export function zipFiles(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  const used = new Map<string, number>();
  for (const file of files) {
    const count = used.get(file.name) ?? 0;
    used.set(file.name, count + 1);
    const name = count === 0 ? file.name : file.name.replace(/(\.[^.]+)?$/, `-${count}$1`);
    entries[name] = file.data;
  }
  return zipSync(entries, { level: 6 });
}

export interface TextExportResult {
  name: string;
  content: string;
  mimeType: string;
}

/** Extracts text as plain text, Markdown or HTML. */
export async function convertToText(
  bytes: Uint8Array,
  format: TextExportFormat,
  renderer: PdfRenderer,
  options: { title?: string } = {},
): Promise<TextExportResult> {
  const pages = await renderer.text(bytes);
  const title = options.title ?? 'document';

  if (format === 'txt') {
    return {
      name: `${title}.txt`,
      mimeType: 'text/plain;charset=utf-8',
      content: pages.map((page) => normalizeText(page.text)).join('\n\n--- page break ---\n\n'),
    };
  }

  if (format === 'markdown') {
    const body = pages
      .map((page, index) => `## Page ${index + 1}\n\n${normalizeText(page.text).replace(/\n{3,}/g, '\n\n')}`)
      .join('\n\n');
    return { name: `${title}.md`, mimeType: 'text/markdown;charset=utf-8', content: `# ${title}\n\n${body}\n` };
  }

  const html = pages
    .map((page, index) => {
      const paragraphs = normalizeText(page.text)
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br />')}</p>`)
        .join('\n');
      return `<section class="page" data-page="${index + 1}">\n<h2>Page ${index + 1}</h2>\n${paragraphs}\n</section>`;
    })
    .join('\n');
  return {
    name: `${title}.html`,
    mimeType: 'text/html;charset=utf-8',
    content: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #111827; }
  section.page { border-bottom: 1px solid #e5e7eb; padding-bottom: 1.5rem; margin-bottom: 1.5rem; }
  h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280; }
</style>
</head>
<body>
${html}
</body>
</html>
`,
  };
}

/** Collapses the line breaks pdf.js inserts between text runs. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Builds a CSV of per-page text statistics (used by the export dialog). */
export function textStatistics(pages: { pageIndex: number; text: string }[]): string {
  const rows = [['page', 'characters', 'words', 'lines']];
  for (const page of pages) {
    const words = page.text.split(/\s+/).filter(Boolean).length;
    const lines = page.text.split('\n').length;
    rows.push([String(page.pageIndex + 1), String(page.text.length), String(words), String(lines)]);
  }
  return rows.map((row) => row.join(',')).join('\n');
}

/** Encodes text content for writing to disk. */
export function encodeText(content: string): Uint8Array {
  return strToU8(content);
}
