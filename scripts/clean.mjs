#!/usr/bin/env node
/** Removes build output (dist, release, coverage, playwright artifacts). */
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
for (const dir of ['dist', 'release', 'coverage', 'test-results', 'playwright-report', 'artifacts']) {
  rmSync(path.join(root, dir), { recursive: true, force: true });
}
console.log('[clean] done');
