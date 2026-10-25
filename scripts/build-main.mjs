#!/usr/bin/env node
/**
 * Bundles the Electron main process and preload script with esbuild.
 *
 * Main process: CommonJS, Node platform. Runtime dependencies stay external so
 * that native modules (@napi-rs/canvas), worker-thread based libraries
 * (tesseract.js) and asset-heavy packages (pdfjs-dist standard fonts) keep
 * working from node_modules inside the packaged app.
 *
 * Preload: CommonJS, sandbox-compatible. Only `electron` stays external, so the
 * bundle has no `require()` of anything that a sandboxed preload cannot load.
 */
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const watch = process.argv.includes('--watch');
const production = process.env.NODE_ENV === 'production' || !watch;

const shared = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  target: 'node20',
  define: {
    'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
  },
};

rmSync(path.join(root, 'dist/main'), { recursive: true, force: true });
rmSync(path.join(root, 'dist/preload'), { recursive: true, force: true });

const mainConfig = {
  ...shared,
  entryPoints: [path.join(root, 'src/main/index.ts')],
  outfile: path.join(root, 'dist/main/index.cjs'),
  platform: 'node',
  format: 'cjs',
  external: ['electron', ...Object.keys(pkg.dependencies ?? {})],
};

const preloadConfig = {
  ...shared,
  entryPoints: [path.join(root, 'src/preload/index.ts')],
  outfile: path.join(root, 'dist/preload/index.cjs'),
  platform: 'browser',
  format: 'cjs',
  external: ['electron'],
};

if (watch) {
  const { context } = await import('esbuild');
  const contexts = await Promise.all([context(mainConfig), context(preloadConfig)]);
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[build-main] watching…');
} else {
  await Promise.all([build(mainConfig), build(preloadConfig)]);
  console.log('[build-main] done');
}
