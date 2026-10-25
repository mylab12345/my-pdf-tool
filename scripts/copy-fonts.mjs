#!/usr/bin/env node
/**
 * Copies the bundled offline assets out of node_modules:
 *  - pdf.js runtime assets (cmaps, standard fonts, wasm decoders, ICC profiles)
 *    into src/renderer/public/pdfjs/ so the renderer can point pdf.js at local
 *    files instead of a CDN.
 *  - fonts and OCR data into resources/:
 *  - Open-licensed TTF fonts used for text creation (so Unicode text works
 *    identically on Windows and Linux without depending on system fonts).
 *  - English OCR traineddata (integer/LSTM build, ~3 MB) so OCR never needs the
 *    network.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

/* --- pdf.js runtime assets (renderer) ------------------------------------ */
const pdfjsRoot = path.join(root, 'node_modules/pdfjs-dist');
const publicRoot = path.join(root, 'src/renderer/public/pdfjs');
const pdfjsAssets = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];
for (const asset of pdfjsAssets) {
  const from = path.join(pdfjsRoot, asset);
  const to = path.join(publicRoot, asset);
  if (!existsSync(from)) {
    console.warn(`[fonts] missing pdf.js asset ${asset}`);
    continue;
  }
  mkdirSync(to, { recursive: true });
  copyTree(from, to);
}

const fontOut = path.join(root, 'resources/fonts');
const ocrOut = path.join(root, 'resources/ocr-langs');
mkdirSync(fontOut, { recursive: true });
mkdirSync(ocrOut, { recursive: true });

const fonts = [
  ['@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf', 'Inter-Regular.ttf'],
  ['@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf', 'Inter-Bold.ttf'],
  ['@expo-google-fonts/noto-sans-devanagari/400Regular/NotoSansDevanagari_400Regular.ttf', 'NotoSansDevanagari-Regular.ttf'],
];

function copyTree(from, to) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(target, { recursive: true });
      copyTree(source, target);
    } else {
      copyFileSync(source, target);
    }
  }
}

const copied = [];
for (const [from, to] of fonts) {
  const src = path.join(root, 'node_modules', from);
  if (!existsSync(src)) {
    console.warn(`[fonts] missing ${from} (run npm install first)`);
    continue;
  }
  copyFileSync(src, path.join(fontOut, to));
  copied.push({ file: to, bytes: statSync(src).size });
}

// License texts for the bundled fonts (OFL-1.1).
const licenseSources = [
  '@expo-google-fonts/inter/LICENSE',
  '@expo-google-fonts/noto-sans-devanagari/LICENSE',
];
const licenses = [];
for (const rel of licenseSources) {
  const src = path.join(root, 'node_modules', rel);
  if (existsSync(src)) licenses.push(readFileSync(src, 'utf8'));
}
if (licenses.length) {
  writeFileSync(
    path.join(fontOut, 'LICENSE-OFL.txt'),
    ['Bundled fonts are licensed under the SIL Open Font License 1.1.', '', ...licenses].join('\n'),
  );
}

const langSource = path.join(root, 'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz');
if (existsSync(langSource)) {
  copyFileSync(langSource, path.join(ocrOut, 'eng.traineddata.gz'));
  copied.push({ file: 'eng.traineddata.gz', bytes: statSync(langSource).size });
} else {
  console.warn('[fonts] missing tesseract eng traineddata');
}

console.log('[assets] prepared:', copied.map((c) => `${c.file} (${(c.bytes / 1024).toFixed(0)} KiB)`).join(', ') || 'nothing');
