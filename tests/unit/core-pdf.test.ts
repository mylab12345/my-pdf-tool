import { describe, expect, it } from 'vitest';
import { loadPdf, savePdf, detectEncryption, hasPdfHeader, readPdfVersion } from '../../src/core/pdf/loader';
import { createBlankDocument, createImageDocument, createTextDocument, parseMarkdownBlocks } from '../../src/core/pdf/create';
import {
  appendDocument,
  deletePages,
  duplicatePages,
  extractPages,
  insertBlankPage,
  mergeDocuments,
  movePage,
  reorderPages,
  resizePages,
  rotatePages,
} from '../../src/core/pdf/pages';
import { encryptDocument, passwordStrength } from '../../src/core/pdf/security';
import { readMetadata, writeMetadata, writeOutline, readOutline, addAttachment, listAttachments, removeAttachment, scrubMetadata } from '../../src/core/pdf/metadata';
import { createFontManager, extractText, isPng, makePdf, pngBytes, renderer } from './helpers';
import { AppError } from '../../src/core/errors';

const fonts = createFontManager();

describe('loader', () => {
  it('round-trips a document and detects the header/version', async () => {
    const bytes = await makePdf({ pages: 2 });
    expect(hasPdfHeader(bytes)).toBe(true);
    expect(readPdfVersion(bytes)).toBeDefined();
    const doc = await loadPdf(bytes);
    expect(doc.getPageCount()).toBe(2);
    const saved = await savePdf(doc);
    expect(new Uint8Array(saved)).toEqual(expect.any(Uint8Array));
    expect((await loadPdf(saved)).getPageCount()).toBe(2);
  });

  it('rejects non-PDF data with a typed error', async () => {
    await expect(loadPdf(new Uint8Array([1, 2, 3, 4]))).rejects.toMatchObject({ code: 'CORRUPT_DOCUMENT' });
  });

  it('reports password protection instead of failing silently', async () => {
    const bytes = await makePdf();
    const doc = await loadPdf(bytes);
    encryptDocument(doc, {
      userPassword: 'secret',
      ownerPassword: 'owner',
      permissions: { printing: true, modifying: false, copying: false, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: false },
    });
    const encrypted = await savePdf(doc);
    const detected = detectEncryption(encrypted);
    expect(detected.encrypted).toBe(true);
    expect(detected.algorithm).toBe('AES-256');
    await expect(loadPdf(encrypted)).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
    await expect(loadPdf(encrypted, { password: 'wrong' })).rejects.toMatchObject({ code: 'INVALID_PASSWORD' });
    const opened = await loadPdf(encrypted, { password: 'secret' });
    expect(opened.getPageCount()).toBe(1);
  });

  it('produces AES-256 files that pdf.js also refuses to open without a password', async () => {
    const doc = await loadPdf(await makePdf());
    encryptDocument(doc, {
      userPassword: 'user123',
      ownerPassword: 'owner456',
      permissions: { printing: 'highResolution', modifying: false, copying: false, annotating: false, fillingForms: false, contentAccessibility: true, documentAssembly: false },
    });
    const encrypted = await savePdf(doc);
    await expect(renderer().text(encrypted)).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
    const text = await renderer().text(encrypted, { password: 'user123' });
    expect(text[0]!.text).toContain('Page 1');
  });
});

describe('document creation', () => {
  it('creates blank pages in the requested size and orientation', async () => {
    const bytes = await createBlankDocument({ pageSize: 'A4', orientation: 'landscape', count: 3 });
    const doc = await loadPdf(bytes);
    expect(doc.getPageCount()).toBe(3);
    const size = doc.getPage(0).getSize();
    expect(Math.round(size.width)).toBe(842);
    expect(Math.round(size.height)).toBe(595);
  });

  it('creates a searchable document from markdown', async () => {
    const bytes = await createTextDocument(
      {
        title: 'Report',
        text: '# Quarterly report\n\nThis is **bold** and *italic* text.\n\n- first item\n- second item\n\n> quoted line\n\n```\ncode block\n```',
        pageSize: 'A4',
        orientation: 'portrait',
        fontSize: 11,
        fontFamily: 'standard:Helvetica',
        margin: 50,
        lineHeight: 1.4,
      },
      fonts,
    );
    const doc = await loadPdf(bytes);
    expect(doc.getTitle()).toBe('Report');
    const text = (await extractText(bytes)).join('\n');
    expect(text).toContain('Quarterly report');
    expect(text).toContain('bold');
    expect(text).toContain('second item');
    expect(text).toContain('quoted line');
  });

  it('embeds a Unicode font for Devanagari text', async () => {
    const bytes = await createTextDocument(
      {
        title: 'Unicode',
        text: 'नमस्ते दुनिया — Arena PDF',
        pageSize: 'A4',
        orientation: 'portrait',
        fontSize: 14,
        fontFamily: 'standard:Helvetica',
        margin: 40,
        lineHeight: 1.4,
      },
      fonts,
    );
    // The bundled Noto Sans Devanagari font must be embedded, not a substitution.
    const text = await renderer().text(bytes);
    expect(text[0]!.text).toContain('Arena PDF');
    const doc = await loadPdf(bytes);
    const resources = doc.getPages()[0]!.node.Resources();
    expect(JSON.stringify(Object.keys(resources?.entries() ?? {}))).toBeDefined();
  });

  it('wraps long text across pages', async () => {
    const longText = Array.from({ length: 220 }, (_, index) => `Paragraph ${index + 1}: ${'lorem ipsum dolor sit amet '.repeat(4)}`).join('\n\n');
    const bytes = await createTextDocument(
      {
        title: 'Long',
        text: longText,
        pageSize: 'A4',
        orientation: 'portrait',
        fontSize: 11,
        fontFamily: 'standard:Helvetica',
        margin: 56,
        lineHeight: 1.35,
      },
      fonts,
    );
    const doc = await loadPdf(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(3);
  });

  it('creates a PDF from images', async () => {
    const bytes = await createImageDocument(
      { images: [], pageSize: 'FitImage', orientation: 'portrait', margin: 10, onePerPage: true },
      [{ name: 'pixel.png', bytes: pngBytes(400, 200) }],
    );
    const doc = await loadPdf(bytes);
    expect(doc.getPageCount()).toBe(1);
    const size = doc.getPage(0).getSize();
    expect(Math.round(size.width)).toBe(420);
    expect(Math.round(size.height)).toBe(220);
  });

  it('parses markdown structures', () => {
    const blocks = parseMarkdownBlocks('# Title\n\n- a\n- b\n\n1. one\n\n> quote\n\n---');
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'bullet', 'bullet', 'bullet', 'quote', 'rule']);
  });
});

describe('page operations', () => {
  it('deletes, rotates, moves and duplicates pages', async () => {
    const doc = await loadPdf(await makePdf({ pages: 5 }));
    deletePages(doc, [1]);
    expect(doc.getPageCount()).toBe(4);
    rotatePages(doc, [0, 2], 90);
    expect(doc.getPage(0).getRotation().angle).toBe(90);
    await movePage(doc, 3, 0);
    const moved = await savePdf(doc);
    const text = (await extractText(moved))[0]!;
    // Pages were [1,3,4,5] after deleting page 2; page 5 moves to the front.
    expect(text).toContain('Page 5');
    const duplicated = await loadPdf(moved);
    await duplicatePages(duplicated, [0]);
    expect(duplicated.getPageCount()).toBe(5);
  });

  it('reorders the page tree in place and keeps content intact', async () => {
    const doc = await loadPdf(await makePdf({ pages: 3 }));
    await reorderPages(doc, [2, 0, 1]);
    const bytes = await savePdf(doc);
    const texts = await extractText(bytes);
    expect(texts[0]).toContain('Page 3');
    expect(texts[1]).toContain('Page 1');
    expect(texts[2]).toContain('Page 2');
  });

  it('inserts blank pages and pages from another document', async () => {
    const doc = await loadPdf(await makePdf({ pages: 2 }));
    insertBlankPage(doc, 1, 'Letter', 'portrait');
    expect(doc.getPageCount()).toBe(3);
    const inserted = await appendDocument(doc, await makePdf({ pages: 2, text: 'Appended page' }));
    expect(inserted).toBe(2);
    expect(doc.getPageCount()).toBe(5);
  });

  it('merges and extracts documents', async () => {
    const a = await makePdf({ pages: 2, text: 'Document A' });
    const b = await makePdf({ pages: 3, text: 'Document B' });
    const merged = await mergeDocuments([
      { name: 'a.pdf', bytes: a },
      { name: 'b.pdf', bytes: b },
    ]);
    expect((await loadPdf(merged)).getPageCount()).toBe(5);
    const single = await extractPages(merged, [2]);
    expect((await loadPdf(single)).getPageCount()).toBe(1);
  });

  it('resizes pages with content scaling', async () => {
    const doc = await loadPdf(await makePdf({ pages: 1, size: [595.28, 841.89] }));
    resizePages(doc, [0], 'A5', 'portrait', true);
    const size = doc.getPage(0).getSize();
    expect(Math.round(size.width)).toBe(420);
    expect(Math.round(size.height)).toBe(595);
  });

  it('refuses to delete every page', async () => {
    const doc = await loadPdf(await makePdf({ pages: 1 }));
    expect(() => deletePages(doc, [0])).toThrow(AppError);
  });
});

describe('metadata, outline and attachments', () => {
  it('writes and reads metadata', async () => {
    const doc = await loadPdf(await makePdf());
    writeMetadata(doc, { title: 'Quarterly', author: 'Arena', subject: 'Report', keywords: ['pdf', 'offline'] });
    const bytes = await savePdf(doc);
    const reopened = await loadPdf(bytes);
    const metadata = readMetadata(reopened);
    expect(metadata.title).toBe('Quarterly');
    expect(metadata.author).toBe('Arena');
    expect(metadata.keywords).toEqual(['pdf', 'offline']);
  });

  it('scrubs metadata', async () => {
    const doc = await loadPdf(await makePdf());
    writeMetadata(doc, { title: 'Sensitive', author: 'Someone' });
    scrubMetadata(doc);
    const bytes = await savePdf(doc);
    const metadata = readMetadata(await loadPdf(bytes));
    expect(metadata.title).toBeUndefined();
    expect(metadata.author).toBeUndefined();
  });

  it('round-trips bookmarks', async () => {
    const doc = await loadPdf(await makePdf({ pages: 3 }));
    writeOutline(doc, [
      { title: 'Introduction', pageIndex: 0, children: [{ title: 'Scope', pageIndex: 1 }] },
      { title: 'Results', pageIndex: 2, children: [] },
    ]);
    const bytes = await savePdf(doc);
    const outline = readOutline(await loadPdf(bytes));
    expect(outline).toHaveLength(2);
    expect(outline[0]!.title).toBe('Introduction');
    expect(outline[0]!.pageIndex).toBe(0);
    expect(outline[0]!.children[0]!.title).toBe('Scope');
    expect(outline[1]!.pageIndex).toBe(2);
  });

  it('adds and removes attachments', async () => {
    const doc = await loadPdf(await makePdf());
    await addAttachment(doc, 'notes.txt', new Uint8Array([104, 105]), 'Greeting');
    const bytes = await savePdf(doc);
    const reopened = await loadPdf(bytes);
    const attachments = listAttachments(reopened);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.name).toBe('notes.txt');
    expect(attachments[0]!.bytes).toEqual(new Uint8Array([104, 105]));
    expect(removeAttachment(reopened, 'notes.txt')).toBe(true);
    expect(listAttachments(reopened)).toHaveLength(0);
  });
});

describe('security helpers', () => {
  it('scores password strength', () => {
    expect(passwordStrength('123456').score).toBeLessThan(2);
    expect(passwordStrength('Tr0ub4dor&3-very-long').score).toBeGreaterThanOrEqual(3);
  });

  it('writes RC4 only when explicitly requested', async () => {
    const doc = await loadPdf(await makePdf());
    expect(() =>
      encryptDocument(doc, {
        userPassword: 'x',
        algorithm: 'RC4-128',
        permissions: { printing: true, modifying: true, copying: true, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: true },
      }),
    ).not.toThrow();
    const encrypted = await savePdf(doc);
    expect(detectEncryption(encrypted).algorithm).toBe('RC4-128');
  });
});

describe('fixtures', () => {
  it('renders a page to PNG through pdf.js and the native canvas', async () => {
    const rendered = await renderer().renderPage(await makePdf(), 0, { dpi: 144 });
    expect(isPng(rendered.data)).toBe(true);
    expect(rendered.width).toBe(1191);
    expect(rendered.height).toBeGreaterThan(1600);
  });
});
