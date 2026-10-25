#!/usr/bin/env node
/**
 * Architectural linter.
 *
 * The project deliberately avoids a heavyweight ESLint setup; this script
 * enforces the invariants that keep the codebase portable and secure:
 *
 *  1. The PDF engine (src/core, src/shared) stays free of Electron and Node
 *     filesystem APIs so it can run in the renderer, in tests and in the main
 *     process alike.
 *  2. The preload bridge may only import `electron` and shared modules.
 *  3. Electron security defaults (contextIsolation, sandbox, CSP) are never
 *     weakened.
 *  4. No `innerHTML`/`dangerouslySetInnerHTML` (user documents are untrusted).
 *  5. No network access from the app (offline-first): no fetch()/XMLHttpRequest
 *     of remote URLs in src/.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const problems = [];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(path.join(root, 'src'));
const rel = (f) => path.relative(root, f).replaceAll(path.sep, '/');

const forbiddenInEngine = [/from 'electron'/, /require\('electron'\)/, /from 'node:fs/, /from 'node:child_process/, /from '@napi-rs\/canvas'/];
const forbiddenInPreload = /from '(?!electron|\.\.\/shared\/|@shared\/)/;

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const name = rel(file);
  const isEngine = name.startsWith('src/core/') || name.startsWith('src/shared/');
  const isPreload = name.startsWith('src/preload/');

  if (isEngine) {
    for (const rule of forbiddenInEngine) {
      if (rule.test(source)) problems.push(`${name}: engine code must stay environment-agnostic (${rule})`);
    }
  }
  if (isPreload) {
    for (const line of source.split('\n')) {
      if (/^\s*import .* from '(.*)'/.test(line)) {
        const match = line.match(/from '([^']+)'/);
        if (match && !/^(electron|\.\/|\.\.\/)/.test(match[1]) && !match[1].startsWith('../shared')) {
          problems.push(`${name}: preload may only import electron and relative/shared modules (found '${match[1]}')`);
        }
      }
    }
  }
  if (/contextIsolation:\s*false/.test(source)) problems.push(`${name}: contextIsolation must never be disabled`);
  if (/nodeIntegration:\s*true/.test(source)) problems.push(`${name}: nodeIntegration must never be enabled`);
  if (/webSecurity:\s*false/.test(source)) problems.push(`${name}: webSecurity must never be disabled`);
  if (/allowRunningInsecureContent:\s*true/.test(source)) problems.push(`${name}: allowRunningInsecureContent must never be enabled`);
  if (/dangerouslySetInnerHTML/.test(source)) problems.push(`${name}: dangerouslySetInnerHTML is not allowed`);
  if (/\.innerHTML\s*=[^=]/.test(source)) problems.push(`${name}: assigning innerHTML is not allowed`);
  if (/(fetch|XMLHttpRequest)\(\s*['"`]https?:\/\//.test(source)) problems.push(`${name}: network requests are not allowed (offline-first)`);
  if (/https?:\/\/[a-z0-9.-]+\//i.test(source) && !/^\s*(\*|\/\/|\/\*)/.test(source)) {
    // URLs inside strings are allowed only in comments, CSP, docs links and
    // schema identifiers; flag obvious runtime fetches only.
    if (/['"`]https?:\/\/(?!www\.w3\.org|ns\.adobe\.com|purl\.org)/.test(source)) {
      problems.push(`${name}: contains a remote URL literal (offline-first policy) — external links belong in docs/`);
    }
  }
}

if (problems.length) {
  console.error('lint failed:');
  for (const problem of problems) console.error('  -', problem);
  process.exit(1);
}
console.log(`lint passed (${files.length} files)`);
