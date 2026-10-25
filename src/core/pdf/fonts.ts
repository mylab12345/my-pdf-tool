import { PDFDocument, type PDFFont, StandardFonts } from '@cantoo/pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { FontInfo } from '../../shared/types';
import { BUNDLED_FONTS, STANDARD_FONTS } from '../../shared/constants';
import { appError } from '../errors';

/** Maps the UI font id to a pdf-lib standard font. */
const STANDARD_FONT_MAP: Record<string, StandardFonts> = {
  'standard:Helvetica': StandardFonts.Helvetica,
  'standard:Helvetica-Bold': StandardFonts.HelveticaBold,
  'standard:Helvetica-Oblique': StandardFonts.HelveticaOblique,
  'standard:Helvetica-BoldOblique': StandardFonts.HelveticaBoldOblique,
  'standard:Times-Roman': StandardFonts.TimesRoman,
  'standard:Times-Bold': StandardFonts.TimesRomanBold,
  'standard:Times-Italic': StandardFonts.TimesRomanItalic,
  'standard:Times-BoldItalic': StandardFonts.TimesRomanBoldItalic,
  'standard:Courier': StandardFonts.Courier,
  'standard:Courier-Bold': StandardFonts.CourierBold,
  'standard:Courier-Oblique': StandardFonts.CourierOblique,
  'standard:Courier-BoldOblique': StandardFonts.CourierBoldOblique,
  'standard:Symbol': StandardFonts.Symbol,
  'standard:ZapfDingbats': StandardFonts.ZapfDingbats,
};

/** Variant lookup for the standard 14 fonts: family -> {bold, italic}. */
const STANDARD_VARIANTS: Record<string, Partial<Record<'bold' | 'italic' | 'bolditalic', string>>> = {
  'standard:Helvetica': {
    bold: 'standard:Helvetica-Bold',
    italic: 'standard:Helvetica-Oblique',
    bolditalic: 'standard:Helvetica-BoldOblique',
  },
  'standard:Helvetica-Bold': { italic: 'standard:Helvetica-BoldOblique' },
  'standard:Helvetica-Oblique': { bold: 'standard:Helvetica-BoldOblique' },
  'standard:Times-Roman': { bold: 'standard:Times-Bold', italic: 'standard:Times-Italic', bolditalic: 'standard:Times-BoldItalic' },
  'standard:Times-Bold': { italic: 'standard:Times-BoldItalic' },
  'standard:Times-Italic': { bold: 'standard:Times-BoldItalic' },
  'standard:Courier': { bold: 'standard:Courier-Bold', italic: 'standard:Courier-Oblique', bolditalic: 'standard:Courier-BoldOblique' },
  'standard:Courier-Bold': { italic: 'standard:Courier-BoldOblique' },
  'standard:Courier-Oblique': { bold: 'standard:Courier-BoldOblique' },
};

/** A font registered with the application. */
export interface FontAsset extends FontInfo {
  bundledFile?: string;
  weight?: number;
}

export interface FontStyleRequest {
  bold?: boolean;
  italic?: boolean;
}

/**
 * Some font binaries cannot be subset by fontkit (variable fonts, unusual table
 * layouts). Subsetting failure only surfaces at save time as an obscure error,
 * so each font is probed once and embedded whole when it cannot be subset.
 */
const subsetCache = new Map<string, boolean>();

function canSubset(bytes: Uint8Array): boolean {
  try {
    const font = fontkit.create(bytes);
    const subset = font.createSubset();
    subset.includeGlyph(font.glyphForCodePoint(65));
    (subset as unknown as { encode(): Uint8Array }).encode();
    return true;
  } catch {
    return false;
  }
}

const UNICODE_FALLBACKS = {
  devanagari: 'bundled:NotoSansDevanagari-Regular',
  regular: 'bundled:Inter-Regular',
  bold: 'bundled:Inter-Bold',
} as const;

/**
 * Provides font discovery and embedding with no filesystem access: the caller
 * injects a byte loader, so the same code serves the main process, tests and
 * (through IPC) the renderer.
 */
export class FontManager {
  private readonly assets: FontAsset[];
  private readonly cache = new WeakMap<PDFDocument, Map<string, PDFFont>>();
  private readonly registered = new WeakSet<PDFDocument>();

  constructor(
    private readonly loadFontBytes: (asset: FontAsset) => Promise<Uint8Array | null>,
    systemFonts: FontAsset[] = [],
  ) {
    this.assets = [
      ...STANDARD_FONTS.map<FontAsset>((font) => ({
        id: font.id,
        family: font.family,
        style: font.style,
        source: 'standard',
        unicode: false,
      })),
      ...BUNDLED_FONTS.map<FontAsset>((font) => ({
        id: font.id,
        family: font.family,
        style: font.style,
        source: 'bundled',
        unicode: true,
        bundledFile: font.file,
        weight: font.weight,
      })),
      ...systemFonts,
    ];
  }

  list(): FontAsset[] {
    const seen = new Set<string>();
    return this.assets.filter((asset) => {
      if (seen.has(asset.id)) return false;
      seen.add(asset.id);
      return true;
    });
  }

  find(fontId: string): FontAsset | undefined {
    const exact = this.assets.find((asset) => asset.id === fontId);
    if (exact) return exact;
    // The UI speaks in family names ("Inter"), while ids are namespaced
    // ("bundled:Inter-Regular"). Accept both, preferring the regular weight.
    const family = fontId.toLowerCase();
    const matches = this.assets.filter((asset) => asset.family.toLowerCase() === family);
    return matches.find((asset) => /regular/i.test(asset.style)) ?? matches[0];
  }

  /** Canonical id for an id-or-family string, or undefined when unknown. */
  resolveId(fontId: string): string | undefined {
    return this.find(fontId)?.id;
  }

  /** Resolves the concrete font id for a style request (bold/italic). */
  resolveVariant(fontId: string, style: FontStyleRequest = {}): string {
    const { bold, italic } = style;
    const canonical = this.resolveId(fontId) ?? fontId;
    fontId = canonical;
    if (!bold && !italic) return fontId;

    const standard = STANDARD_VARIANTS[fontId];
    if (standard) {
      if (bold && italic) return standard.bolditalic ?? fontId;
      if (bold) return standard.bold ?? fontId;
      return standard.italic ?? fontId;
    }

    // Bundled families: swap the weight token in the id.
    if (/^bundled:Inter-(Regular|Bold)$/.test(fontId) && bold) return UNICODE_FALLBACKS.bold;
    return fontId;
  }

  async embed(doc: PDFDocument, fontId: string): Promise<PDFFont> {
    let docCache = this.cache.get(doc);
    if (!docCache) {
      docCache = new Map();
      this.cache.set(doc, docCache);
    }
    const cached = docCache.get(fontId);
    if (cached) return cached;

    const standard = STANDARD_FONT_MAP[fontId];
    if (standard) {
      const font = await doc.embedFont(standard);
      docCache.set(fontId, font);
      return font;
    }

    const asset = this.find(fontId);
    if (!asset) throw appError('FONT_MISSING', `Font "${fontId}" is not available.`);
    const bytes = await this.loadFontBytes(asset);
    if (!bytes || bytes.length === 0) {
      throw appError('FONT_MISSING', `Could not read the font file for "${asset.family}".`, {
        hint: 'Pick a different font (Helvetica or Inter are always available).',
      });
    }
    if (!this.registered.has(doc)) {
      doc.registerFontkit(fontkit);
      this.registered.add(doc);
    }
    const key = asset.path ?? asset.bundledFile ?? asset.id;
    let subset = subsetCache.get(key);
    if (subset === undefined) {
      subset = canSubset(bytes);
      subsetCache.set(key, subset);
    }
    const font = await doc.embedFont(bytes, { subset });
    docCache.set(fontId, font);
    return font;
  }

  canEncode(font: PDFFont, text: string): boolean {
    try {
      font.encodeText(text);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Some documents (and the text creation tool) need a font that can express the
   * text. Standard fonts are Latin-1 only, so we transparently upgrade to a
   * bundled Unicode font and report which one was used.
   */
  async embedForText(
    doc: PDFDocument,
    fontId: string,
    text: string,
    style: FontStyleRequest = {},
  ): Promise<{ font: PDFFont; fontId: string; substituted: boolean }> {
    const variantId = this.resolveVariant(fontId, style);
    const requested = await this.embed(doc, variantId);
    if (this.canEncode(requested, text)) return { font: requested, fontId: variantId, substituted: false };

    const fallbackId = pickUnicodeFont(text, Boolean(style.bold));
    if (fallbackId !== variantId) {
      const fallback = await this.embed(doc, fallbackId);
      if (this.canEncode(fallback, text)) return { font: fallback, fontId: fallbackId, substituted: true };
    }
    return { font: requested, fontId: variantId, substituted: false };
  }
}

/** Chooses the bundled font best suited to the script found in `text`. */
export function pickUnicodeFont(text: string, bold = false): string {
  if (/[\u0900-\u097F]/.test(text)) return UNICODE_FALLBACKS.devanagari;
  return bold ? UNICODE_FALLBACKS.bold : UNICODE_FALLBACKS.regular;
}

export function requiresUnicodeFont(text: string): boolean {
  return /[^\u0000-\u00FF]/.test(text);
}

/** Best-effort mapping from a CSS font-family to an available font id. */
export function resolveFontId(fontFamily: string, fonts: FontInfo[]): string {
  const normalized = fontFamily.toLowerCase().replace(/['"]/g, '').trim();
  const exact = fonts.find((font) => font.id === fontFamily);
  if (exact) return exact.id;
  const match = fonts.find((font) => font.family.toLowerCase() === normalized);
  if (match) return match.id;
  const bundled = fonts.find((font) => font.source === 'bundled' && normalized.includes(font.family.toLowerCase()));
  if (bundled) return bundled.id;
  return 'standard:Helvetica';
}
