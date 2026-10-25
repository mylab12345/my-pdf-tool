/**
 * Page range parsing and formatting.
 *
 * Accepts the syntax users expect from print dialogs and PDF tools:
 *   "1-3, 5, 8-"  (1-based, inclusive, open ended)
 *   "all" / ""    (every page)
 *   "n" (odd pages), "even"
 * Also accepts negative indices for "from the end" in API calls.
 */

export interface ParseRangeResult {
  /** Zero-based page indices, de-duplicated and sorted. */
  pages: number[];
  invalid: string[];
}

export function parsePageRanges(input: string | null | undefined, pageCount: number): ParseRangeResult {
  const pages = new Set<number>();
  const invalid: string[] = [];
  const text = (input ?? '').trim().toLowerCase();
  if (!text || text === 'all' || text === '*') {
    return { pages: Array.from({ length: pageCount }, (_, i) => i), invalid };
  }
  if (text === 'odd') {
    return { pages: Array.from({ length: pageCount }, (_, i) => i).filter((i) => (i + 1) % 2 === 1), invalid };
  }
  if (text === 'even') {
    return { pages: Array.from({ length: pageCount }, (_, i) => i).filter((i) => (i + 1) % 2 === 0), invalid };
  }

  for (const rawPart of text.split(/[,;]/)) {
    const part = rawPart.trim();
    if (!part) continue;
    const match = part.match(/^(\d+)\s*(?:-\s*(\d+)?)?$/);
    if (!match) {
      invalid.push(rawPart.trim());
      continue;
    }
    const start = Number(match[1]);
    const hasDash = part.includes('-');
    const end = match[2] !== undefined ? Number(match[2]) : start;
    if (start < 1) {
      invalid.push(rawPart.trim());
      continue;
    }
    const from = Math.min(start, hasDash ? end : start);
    const to = hasDash ? (match[2] !== undefined ? Math.max(start, end) : pageCount) : start;
    if (from > pageCount) {
      invalid.push(rawPart.trim());
      continue;
    }
    for (let page = from; page <= Math.min(to, pageCount); page += 1) pages.add(page - 1);
  }

  return { pages: [...pages].sort((a, b) => a - b), invalid };
}

/** Formats zero-based indices as a compact 1-based range string ("1-3,7"). */
export function formatPageRanges(indices: number[]): string {
  if (!indices.length) return '';
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const parts: string[] = [];
  let runStart = sorted[0]!;
  let previous = runStart;
  for (const index of sorted.slice(1)) {
    if (index === previous + 1) {
      previous = index;
      continue;
    }
    parts.push(runStart === previous ? `${runStart + 1}` : `${runStart + 1}-${previous + 1}`);
    runStart = index;
    previous = index;
  }
  parts.push(runStart === previous ? `${runStart + 1}` : `${runStart + 1}-${previous + 1}`);
  return parts.join(',');
}

/** Splits a page list into contiguous chunks of at most `size` pages. */
export function chunkPages(indices: number[], size: number): number[][] {
  if (size <= 0) throw new Error('chunk size must be positive');
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  return Array.from({ length: Math.ceil(sorted.length / size) }, (_, i) => sorted.slice(i * size, (i + 1) * size));
}

/** Splits pages into `every` groups, e.g. every=1 produces one file per page. */
export function splitEvery(indices: number[], every: number): number[][] {
  if (every < 1) throw new Error('split size must be >= 1');
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (let i = 0; i < sorted.length; i += every) groups.push(sorted.slice(i, i + every));
  return groups;
}

/** Splits at explicit page boundaries (1-based, boundary page starts a new file). */
export function splitAtBoundaries(pageCount: number, boundaries: number[]): number[][] {
  const points = [...new Set(boundaries.filter((b) => b >= 1 && b <= pageCount))].sort((a, b) => a - b);
  const groups: number[][] = [];
  let start = 1;
  for (const boundary of points) {
    if (boundary > start) {
      groups.push(range(start, boundary - 1));
      start = boundary;
    }
  }
  groups.push(range(start, pageCount));
  return groups.filter((g) => g.length > 0);
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);
}
