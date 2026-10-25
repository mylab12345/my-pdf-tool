# Arena PDF Studio

A local-first, offline PDF editor and toolkit, built as a single codebase for Windows 10/11 and modern Linux
(Ubuntu, Debian, Fedora, Linux Mint).

Create, edit, annotate, OCR, convert, sign, encrypt, compress, merge and split PDF files. Nothing is uploaded,
no account is required, and no feature depends on a paid API or a cloud service.

> **Verification status — read this first.**
> This repository is under active development. The engine, the desktop shell and the test suite are in place and
> pass locally (see *Verification* below), but **production installers have not been built or installed yet**, so
> no platform is claimed as supported. Support will be declared only after a release build has been produced,
> installed, upgraded and uninstalled on real Windows and Linux machines (see *Roadmap*).

## Status

| Area | State |
| --- | --- |
| PDF engine (create, edit, annotate, OCR, convert, sign, encrypt, compress, merge, split, redact) | Implemented, covered by tests |
| Electron main process (session store, dialogs, printing, recovery, IPC) | Implemented, covered by integration tests |
| Preload bridge (context isolation, sandbox, no Node in the renderer) | Implemented, contract tested |
| React UI (viewer, sidebar, tool dialogs, shortcuts, themes) | Implemented, smoke tested |
| `npm run build` (main + preload + renderer bundles) | Passing |
| Windows `.exe` installer + portable, Linux `.AppImage` / `.deb` / `.rpm` | **Not built yet** |
| Installation / upgrade / uninstall tested on real Windows + Linux | **Not done yet** |
| End-to-end tests against the packaged app | **Not written yet** |

## Stack

Everything runs in-process; there is no bundled web view pointing at remote content and no telemetry.

| Concern | Library | License |
| --- | --- | --- |
| PDF object model, creation, forms, encryption | [`@cantoo/pdf-lib`](https://www.npmjs.com/package/@cantoo/pdf-lib) 2.11.1 | MIT |
| Rendering, text extraction, validation | [`pdfjs-dist`](https://www.npmjs.com/package/pdfjs-dist) 6.4.299 | Apache-2.0 |
| Offline OCR | [`tesseract.js`](https://www.npmjs.com/package/tesseract.js) 7.0.0 | Apache-2.0 |
| Rasterisation in the main process | [`@napi-rs/canvas`](https://www.npmjs.com/package/@napi-rs/canvas) 1.0.13 | MIT |
| Digital signatures | [`@signpdf/*`](https://www.npmjs.com/package/@signpdf/signpdf) 4.0.0 + [`node-forge`](https://www.npmjs.com/package/node-forge) 1.4.0 | MIT / BSD-3-Clause |
| Fonts (Unicode embedding) | `@pdf-lib/fontkit` 1.1.1, Inter, Noto Sans Devanagari | MIT / OFL-1.1 |
| IPC validation | [`zod`](https://www.npmjs.com/package/zod) 4.6.7 | MIT |
| Archive export | [`fflate`](https://www.npmjs.com/package/fflate) 0.8.3 | MIT |
| UI | React 19, zustand 5, lucide-react | MIT / ISC |
| Desktop shell | Electron 45 + electron-builder | MIT |

### Note on the original Tauri 2 requirement

The initial plan was Tauri 2 (Rust backend). That path was abandoned for this build because the toolchain could not
be installed or exercised in the build environment (no `rustc`/`cargo`, crates.io unreachable), so no Tauri build
could be produced or verified. Rather than ship unverified Rust, the same architecture was implemented on Electron:
the PDF engine (`src/core`) is UI- and runtime-agnostic and contains **no** Electron or filesystem imports, so the
engine can be moved behind a Tauri or CLI host later without touching feature code.

If Tauri is still a hard requirement, the engine layer is the part that carries over unchanged; only `src/main`,
`src/preload` and the packaging configuration would be replaced — and that port must be built and verified before
any support claim is made.

## Architecture

```
src/
  shared/     domain types, IPC channel names, formatting helpers   (no Electron, no Node)
  core/       PDF + raster engines                                  (no Electron, no Node, no fs)
    pdf/      loader, create, pages, annotations, forms, security,
              watermark, compress, convert, ocr, redact, validate,
              metadata, operations, info, fonts, text layout
    raster/   pdf.js rasteriser and text extraction
  main/       Electron main process
    documents/session-store.ts   open documents, operation replay, undo/redo, save
    tools.ts                     merge, split, compress, OCR, sign, redact, export, forms…
    protocol.ts                  arenadoc:// (range-served documents) + arenapdf:// (app bundle)
    files.ts, print.ts, fonts.ts, ocr-engine.ts, preferences.ts,
    recovery.ts, tasks.ts, menu.ts, ipc.ts, app.ts
  preload/    the only bridge: one method per channel, every reply a Result<T>
  renderer/   React UI (viewer, sidebar, annotation layer, tool dialogs)
tests/
  unit/         engine tests
  integration/  main-process session store + tool service
  renderer/     React shell smoke tests
```

Design decisions worth knowing:

- **Undo/redo is operation replay.** A session keeps the bytes it was opened with plus the list of edits applied on
  top. Undo pops an edit, redo pushes it back, and the oldest half of the history is folded into the base bytes when
  the stack gets deep (`LIMITS.historyDepth`). Every edit is deterministic and testable.
- **The renderer never touches the filesystem or Node.** Everything goes through the preload bridge, every handler is
  zod-validated, and every reply is `{ ok: true, value } | { ok: false, error }` so no UI code can throw on a failed
  operation.
- **Documents are streamed, not copied.** pdf.js reads them over `arenadoc://session/<id>?rev=N`, which implements
  HTTP range requests, so a large file is not duplicated over IPC.
- **OCR and rendering stay offline.** tesseract is pointed at the bundled `resources/ocr-langs` directory and pdf.js at
  the bundled `public/pdfjs` assets — no CDN at runtime.
- **Writes are atomic.** Files are written to a temporary name in the same directory and renamed into place, keeping
  the original permissions and optionally a `.bak`.

## Requirements

- Node.js 20 or newer (developed on Node 22).
- Windows 10/11 (x64) or a modern glibc Linux distribution.

## Development

```bash
npm install
npm run fonts        # copies bundled fonts, OCR data and pdf.js assets (offline)
npm run dev          # Vite dev server + Electron
```

Useful scripts:

| Script | Purpose |
| --- | --- |
| `npm run typecheck` | TypeScript for renderer + main (two tsconfigs) |
| `npm run lint` | Architectural linter (engine purity, Electron hardening, offline policy) |
| `npm test` | Unit, integration and renderer test suites |
| `npm run verify` | `typecheck` + `lint` + `test` |
| `npm run build` | Production bundles into `dist/` |
| `npm run dist:win` | Windows NSIS installer + portable executable (needs a Windows host or CI) |
| `npm run dist:linux` | Linux AppImage, `.deb` and `.rpm` (needs a Linux host or CI) |

## Verification

The commands below were run on the development branch and pass. They cover behaviour, not packaging.

```bash
npm run typecheck   # no errors
npm run lint        # 63 files, no violations
npx vitest run      # 82 tests in 8 files
```

What the tests actually prove:

- **Engine (57 tests):** create/edit, annotation round-trips, AES-256 encryption that pdf.js also honours, offline OCR
  on synthetic scans (including rotated pages), compression profiles with progress + cancellation, text/markdown/HTML
  export, watermark tiling, header/footer tokens, redaction that removes text from the content stream *and* the raw
  bytes, form create/fill/flatten, detached PKCS#7 signing and verification (including tamper detection), validation
  and repair.
- **Main process (12 tests):** session store history, save-through-filesystem, annotation persistence, merge,
  compression, watermark, metadata/outline, attachments, form fill, validation.
- **IPC contract (5 tests):** every channel the preload exposes has a main-process handler, no duplicates, every pushed
  event is both emitted and subscribed.
- **Renderer (8 tests):** welcome screen, document creation, viewer/status bar, annotation list + delete, settings
  persistence, every tool dialog opens, task progress + cancel, error toasts.

Known limitations of the current test coverage: the packaged installers, printing to a physical printer, native
dialog behaviour and file associations are **not** exercised yet.

## Roadmap to a support claim

1. CI that builds the Windows `.exe` (NSIS) + portable and the Linux `.AppImage`, `.deb`, `.rpm` on real runners.
2. Playwright end-to-end tests driven against the packaged application.
3. Install → upgrade → uninstall verification, file associations, large-document and printing checks on real Windows
   and Linux machines.
4. Installation instructions and a feature-parity matrix published only for combinations that passed.

## License

MIT. Bundled fonts are OFL-1.1 (see `resources/fonts/LICENSE-OFL.txt`); third-party components keep their own
licenses as listed above.
