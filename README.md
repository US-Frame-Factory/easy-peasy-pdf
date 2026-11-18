# Easy Peasy PDF

A minimal, fast, crash-resistant desktop PDF viewer for big construction plan sets.
Built for people who only *view* plans (no markups, measuring or editing).

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

### Keyboard

| Keys | Action |
| --- | --- |
| Ctrl+O | Open PDFs |
| Ctrl+H or Ctrl+2 / Ctrl+Shift+H / F6 | Split on/off / flip orientation / switch pane |
| Ctrl+G | Go to page or sheet number |
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
- `src/viewer.ts` – virtualized layout. Only pages near the viewport are in the DOM and only
  visible tiles are requested. Each page has a one-tile low-res placeholder (also the grid
  thumbnail); the render scale is zoom × devicePixelRatio rounded up to √2 steps (max 16 px/pt).
  Tiles are positioned in % of the page so the old layer stretches while a new zoom level loads.

Debug aid: Ctrl+Shift+Alt+K kills a render worker so you can watch the app recover.
