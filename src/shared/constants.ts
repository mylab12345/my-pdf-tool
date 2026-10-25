import type { PageSizeName, PageOrientation, AppSettings, PageSize } from './types';

/** Page sizes in PDF points (1/72 inch). */
export const PAGE_SIZES: Record<Exclude<PageSizeName, 'Custom'>, PageSize> = {
  A0: { width: 2383.94, height: 3370.39 },
  A1: { width: 1683.78, height: 2383.94 },
  A2: { width: 1190.55, height: 1683.78 },
  A3: { width: 841.89, height: 1190.55 },
  A4: { width: 595.28, height: 841.89 },
  A5: { width: 419.53, height: 595.28 },
  A6: { width: 297.64, height: 419.53 },
  Letter: { width: 612, height: 792 },
  Legal: { width: 612, height: 1008 },
  Tabloid: { width: 792, height: 1224 },
  Executive: { width: 521.86, height: 756 },
};

export const PAGE_SIZE_ORDER: PageSizeName[] = [
  'A4',
  'A3',
  'A5',
  'Letter',
  'Legal',
  'Tabloid',
  'Executive',
  'A0',
  'A1',
  'A2',
  'A6',
];

export function resolvePageSize(name: PageSizeName, orientation: PageOrientation): PageSize {
  const base = name === 'Custom' ? PAGE_SIZES.A4 : PAGE_SIZES[name];
  return orientation === 'landscape'
    ? { width: Math.max(base.width, base.height), height: Math.min(base.width, base.height) }
    : { width: Math.min(base.width, base.height), height: Math.max(base.width, base.height) };
}

export const STANDARD_FONTS = [
  { id: 'standard:Helvetica', family: 'Helvetica', style: 'Regular' },
  { id: 'standard:Helvetica-Bold', family: 'Helvetica', style: 'Bold' },
  { id: 'standard:Helvetica-Oblique', family: 'Helvetica', style: 'Italic' },
  { id: 'standard:Helvetica-BoldOblique', family: 'Helvetica', style: 'Bold Italic' },
  { id: 'standard:Times-Roman', family: 'Times', style: 'Regular' },
  { id: 'standard:Times-Bold', family: 'Times', style: 'Bold' },
  { id: 'standard:Times-Italic', family: 'Times', style: 'Italic' },
  { id: 'standard:Times-BoldItalic', family: 'Times', style: 'Bold Italic' },
  { id: 'standard:Courier', family: 'Courier', style: 'Regular' },
  { id: 'standard:Courier-Bold', family: 'Courier', style: 'Bold' },
  { id: 'standard:Courier-Oblique', family: 'Courier', style: 'Italic' },
  { id: 'standard:Courier-BoldOblique', family: 'Courier', style: 'Bold Italic' },
  { id: 'standard:Symbol', family: 'Symbol', style: 'Regular' },
  { id: 'standard:ZapfDingbats', family: 'ZapfDingbats', style: 'Regular' },
] as const;

/** Bundled Unicode fonts shipped in `resources/fonts` (SIL OFL 1.1). */
export const BUNDLED_FONTS = [
  { id: 'bundled:Inter-Regular', file: 'Inter-Regular.ttf', family: 'Inter', style: 'Regular', weight: 400 },
  { id: 'bundled:Inter-Bold', file: 'Inter-Bold.ttf', family: 'Inter', style: 'Bold', weight: 700 },
  {
    id: 'bundled:NotoSansDevanagari-Regular',
    file: 'NotoSansDevanagari-Regular.ttf',
    family: 'Noto Sans Devanagari',
    style: 'Regular',
    weight: 400,
  },
] as const;

export const ANNOTATION_COLORS = ['#ffd400', '#ff7a00', '#ff3b30', '#4cd964', '#34aadc', '#5856d6', '#af52de', '#000000'];

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  accent: '#2563eb',
  defaultPageSize: 'A4',
  defaultOrientation: 'portrait',
  autosaveEnabled: true,
  autosaveIntervalSeconds: 60,
  maxRecentFiles: 12,
  confirmOnClose: true,
  defaultOcrLanguages: ['eng'],
  defaultCompressionProfile: 'balanced',
  renderDpi: 150,
  showSidebar: true,
  printScale: 'fit',
  language: 'en',
  checkAssociationsOnStart: true,
};

/** Guard rails that keep the UI responsive and memory bounded. */
export const LIMITS = {
  /** Files larger than this open in "large document" mode (fewer thumbnails). */
  largeDocumentBytes: 120 * 1024 * 1024,
  /** Maximum pages rendered as thumbnails eagerly. */
  eagerThumbnails: 60,
  /** Maximum dimension of a rendered preview bitmap. */
  maxRenderDimension: 4096,
  /** Annotation payload size ceiling (base64 characters) for images. */
  maxImageBase64: 24 * 1024 * 1024,
  /** Undo history depth. */
  historyDepth: 100,
} as const;

export const APP_NAME = 'Arena PDF Studio';
export const APP_ID = 'in.arena.pdfstudio';
export const PROTOCOL_SCHEME = 'arenapdf';
export const DOC_PROTOCOL_SCHEME = 'arenapdfdoc';
