# Easy Peasy PDF

A minimal, fast, crash-resistant desktop PDF viewer for big construction plan sets, with the
everyday markup and measuring tools (no editing of the drawings themselves).

## What it does

- **Opens huge, heavy vector plan PDFs fast** – pages are rendered as 512 px tiles, only for
  what's on screen, by a pool of separate render processes.
- **Never takes the window down** – PDFium runs in worker processes (the same exe started with
  `--render-worker`). If a worker crashes or hangs on a bad page (>120 s), it's killed and
  restarted, the job is retried once, and only that tile shows an error.
- **Tabs** – open several files at once: multi-select in the Open dialog, drag-and-drop onto the
  window, or "Open with" / double-click a `.pdf` (a second launch adds tabs to the running window).
- **Views** – continuous scroll, two-up, thumbnail grid.
- **Split screen** – Ctrl+H (or Ctrl+2) splits the window side by side; Ctrl+Shift+H flips to
  top / bottom. Each pane shows any open file (click a tab to put it in the focused pane), with its
  own zoom and position; drag the divider to resize, F6 switches panes.
- **Sheet names** – the grid shows each sheet's number (e.g. `S-208 · 62`), and the page box takes
  a sheet number (`S-208`, `sd7a`) as well as a page number. Names come from the PDF's bookmarks or
  page labels when it has them, otherwise from the title block text (read in the background).
- **Zoom & pan** – the wheel scrolls; Ctrl+wheel or touchpad pinch zooms around the cursor; drag
  with the left mouse button (or middle button, in any view) to pan. Ctrl + / Ctrl − / Ctrl 0
  (fit width), Ctrl 1 (100 %).
- **Deep search** – every page's text is indexed in the background after a file opens. Search the
  current file or all open files; the results list shows file, page and a snippet; hits are
  highlighted on the sheet; click a result (or Enter / F3) to jump to it.
- **Extract sheets** – pick pages in the Grid view (click, Ctrl+click, Shift+click, Ctrl+A) or type a
  range like `1-3, 7`, then **Save As…**. The new PDF is made by copying the original pages, so the
  sheets stay vector (not images).

- **Rename sheets** – reads each sheet's number and title from its title block ("DWG TITLE",
  "SHEET TITLE", "Drawing Title" …, including two-line titles) and, after you check and edit them
  in a table, saves them into the PDF as page labels (`S-5A - FIRST FLOOR ANCHOR SCREW & HOLDOWN
  LOCATION PLAN`). Bluebeam shows page labels in its thumbnails; this app shows them in the grid,
  page box and search results.
- **Rotate pages** – this page, the pages selected in Grid, or all pages, clockwise or counter-
  clockwise; saved into the PDF.
- **Select text** – drag a box around text, Ctrl+C copies it.
- **Snapshot** – drag a box to copy that area (with any markups) to the clipboard as an image.
- **Markups** – pen, highlighter, rectangle, ellipse, text box and callout (arrow + text), from the
  tool rail on the left (one-key shortcuts: V pan, X select text, G snapshot, P pen, H highlight,
  R rectangle, E ellipse, T text, C callout, M measure, K calibrate). The properties bar shows the
  style of the current tool or selected markup: colour swatches + colour picker, line width,
  font (Helvetica / Times / Courier), bold / italic / underline, text size, opacity. Pan tool: click a markup to select,
  drag to move, Delete to remove, double-click a text box to edit. Ctrl+Z / Ctrl+Y undo / redo.
- **Measure** – set the page scale from presets (1/8" = 1'-0", 1" = 20', …) or calibrate by
  clicking both ends of a known dimension (the calibration panel doesn't block panning / zooming,
  so you can double-check the line); then click two points (or drag) to measure. Number formats: 148.1in, 148⅛in,
  12.34ft, 12⅜ft, 12'4.1", 12'4⅛". Shift keeps lines at 0/45/90°. Scales are remembered per file.
- **Save** – Ctrl+S writes the markups into the PDF as standard annotations (Square, Circle, Ink,
  FreeText, Line) that Bluebeam and Acrobat show and can edit; Ctrl+Shift+S saves a copy. It's an
  *incremental* save: the original bytes are kept and only the new annotations and their pages are
  appended, so stamped/digitally-signed sets keep a valid signature. You're asked before closing
  with unsaved markups.

### Keyboard

| Keys | Action |
| --- | --- |
| Ctrl+O | Open PDFs |
| Ctrl+H or Ctrl+2 / Ctrl+Shift+H / F6 | Split on/off / flip orientation / switch pane |
| Ctrl+G | Go to page or sheet number |
| Ctrl+S / Ctrl+Shift+S | Save markups into the PDF / Save As |
| Ctrl+Z / Ctrl+Y, Delete | Undo / redo, delete selected markup |
| Esc / hold Space | Finish or cancel, back to Pan / pan with any tool |
| Ctrl+C | Copy selected text |
| Ctrl+W / Ctrl+Tab | Close tab / next tab |
| Ctrl+F, Enter / Shift+Enter, F3 | Search, next / previous hit |
| Ctrl+E | Extract sheets |
| Ctrl + / − / 0 / 1 | Zoom in / out / fit width / 100 % |
| Ctrl+A, Esc (Grid) | Select all / clear selection |

## Download (Windows)

Latest installer: **[EasyPeasyPDF-setup.exe](https://github.com/US-Frame-Factory/easy-peasy-pdf/releases/latest/download/EasyPeasyPDF-setup.exe)**
(installs for the current user, no admin needed, registers "Open with" for `.pdf`).
An `.msi` for per-machine installs is on the [Releases](https://github.com/US-Frame-Factory/easy-peasy-pdf/releases) page.

## Updates

The app checks for a new version a few seconds after it starts (and every 4 hours), and shows an
**Update & restart** bar when one is out. Click the version number at the top right to check by hand.

Updates are published from GitHub Releases and are signed: the app only installs packages signed
with the project's update key (its public half is in `src-tauri/tauri.conf.json`).

**To ship a new version:** Actions → *Windows build* → *Run workflow*. Optionally type a version
(e.g. `0.2.0`; empty = `<major>.<minor>.<run number>` from tauri.conf.json) and release notes. The workflow builds the installers and
publishes a release; installed copies offer the update within a few hours (or on next start).

**One-time setup:** add the private update key as repository secrets
(*Settings → Secrets and variables → Actions*): `TAURI_SIGNING_PRIVATE_KEY` (the key file's
contents) and, if the key has one, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Without the secret the
workflow still publishes installers, but those releases can't be delivered as in-app updates.
Keep a backup of the key: if it's lost, installed copies can't verify new updates and everyone must
reinstall once from a build with a new key.

## Development

Prerequisites: Node 20+, Rust (stable), and the
[Tauri 2 system dependencies](https://v2.tauri.app/start/prerequisites/) for your OS
(on Windows: WebView2 – preinstalled on Windows 10/11 – and the MSVC build tools).

```sh
npm install
npm run fetch-pdfium      # downloads the pinned PDFium build into src-tauri/pdfium/
npx tauri dev             # run the app with hot reload
npx tauri build           # release build + installers (src-tauri/target/release/bundle/)
```

PDFium comes from [bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries),
pinned in `scripts/fetch-pdfium.mjs` (`chromium/8125`, the API version `pdfium-render`'s
`pdfium_latest` feature targets). The binary is git-ignored and bundled as a Tauri resource. At
runtime the app looks for it in `resource_dir/pdfium/`, next to the exe, then `src-tauri/pdfium/`.

### Headless benchmark

```sh
src-tauri/target/release/easy-peasy-pdf --bench path/to/plans.pdf [workers]
```

Runs the real pool + worker processes and prints open time, first-page tile times, deep-zoom
tile time, placeholder/thumbnail time for every page, text indexing, find, extract, and a
crash-recovery check. `EPP_WORKERS=n` overrides the worker count in the app
(default: CPU cores − 1, between 1 and 4).

## How it's built

- **Tauri 2** (Rust) + plain TypeScript + Vite, no UI framework.
- **PDFium** via [`pdfium-render`](https://crates.io/crates/pdfium-render) (BSD/Apache licensed).
- `src-tauri/src/worker.rs` – render worker process: line-delimited JSON requests on stdin; framed
  responses on stdout (`u32` header length, JSON header, `u32` body length, body). Keeps LRUs of
  ~6 open documents and ~6 loaded pages.
- `src-tauri/src/pool.rs` – worker pool and job queues: interactive (info/find/extract) first, then
  tiles LIFO (newest = on screen; capped at 64, older ones fail as "stale" and the viewer re-asks
  if they're still visible), then background text indexing (never on all workers at once).
  A watchdog kills workers that run a job for more than 120 s.
- `src-tauri/src/lib.rs` – Tauri commands, the in-memory search index, and the async `tile:` URI
  scheme (`{doc}/{page}/{scale_milli}/{tx}/{ty}` → uncompressed 32-bit BMP, which PDFium's BGRA
  output maps onto with no encoding cost).
- `src-tauri/src/pdfwrite.rs` – writes markups as annotations with their own appearance streams in
  a minimal incremental update (lopdf); `annotate.rs` runs it in a separate `--save-markups`
  process (PDFium incremental save as fallback).
- `src/markup.ts`, `src/measure.ts` – tools, SVG overlay per page, undo, scales and formats.
- `src/viewer.ts` – virtualized layout. Only pages near the viewport are in the DOM and only
  visible tiles are requested. Each page has a one-tile low-res placeholder (also the grid
  thumbnail); the render scale is zoom × devicePixelRatio rounded up to √2 steps (max 16 px/pt).
  Tiles are positioned in % of the page so the old layer stretches while a new zoom level loads.

Debug aid: Ctrl+Shift+Alt+K kills a render worker so you can watch the app recover.
