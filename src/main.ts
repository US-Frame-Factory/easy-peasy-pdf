import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { api, DocInfo, Hit } from './api';
import { formatRanges, parseRanges } from './ranges';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { initUpdates } from './updates';
import { FontName, isKind, Kind, KIND_NAMES, Markups, marksOf, measureText, pendingCount, Tool } from './markup';
import { FORMATS, getScale, NumberFormat, parseLength, PRESETS, scaleLabel, setScale } from './measure';
import { DocState, Mode, Viewer } from './viewer';
import { feedbackConfigured, flushOutbox, OfflineError, sendFeatureRequest } from './feedback';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- toasts ----------

function toast(msg: string, err = false, ms = 4000) {
  const t = document.createElement('div');
  t.className = err ? 'toast err' : 'toast';
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), err ? ms * 2 : ms);
}

// ---------- documents & panes ----------
//
// `docs` are the open files (one tab each). The window shows one or two panes
// (split screen); each pane has its own viewer and its own view state (zoom,
// scroll, mode, selection) per document, so both panes can show the same file.

const docs: DocInfo[] = [];

const marks = new Markups({
  toast: (m, err) => toast(m, err),
  changed: () => {
    renderTabs();
    updateToolbar();
  },
  toolChanged: () => {
    updateToolbar();
    renderProps();
  },
  needScale: (info, page) => askScale(info, page, 'Set the drawing scale before measuring.'),
  calibrated: (info, page, len) => askCalibration(info, page, len),
  selectionChanged: () => {
    updateToolbar();
    renderProps();
  },
});

class Pane {
  el: HTMLDivElement;
  head: HTMLDivElement;
  scroller: HTMLDivElement;
  viewer: Viewer;
  views = new Map<number, DocState>();
  current: DocState | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'pane';
    this.head = document.createElement('div');
    this.head.className = 'pane-head';
    this.scroller = document.createElement('div');
    this.scroller.className = 'viewer';
    this.scroller.tabIndex = 0;
    const content = document.createElement('div');
    content.className = 'content';
    this.scroller.appendChild(content);
    this.el.append(this.head, this.scroller);
    this.el.addEventListener('pointerdown', () => setFocused(this), true);
    this.el.addEventListener('focusin', () => setFocused(this));
    const pane = this;
    this.viewer = new Viewer(this.scroller, content, {
      onPageChange() {
        pane.renderHead();
        if (pane === focused) updatePageBox();
      },
      onZoomChange: () => pane === focused && updateToolbar(),
      onSelectionChange: () => pane === focused && updateToolbar(),
      onOpenPage(page) {
        pane.viewer.setMode('scroll');
        pane.viewer.scrollToPage(page);
        updateToolbar();
      },
      onPageBuilt: (page, el) => marks.decorate(pane.viewer, page, el),
    });
    marks.attach(this.viewer, this.scroller);
  }

  stateFor(info: DocInfo, like?: DocState | null): DocState {
    let s = this.views.get(info.id);
    if (!s) {
      s = {
        info,
        mode: like?.mode ?? 'scroll',
        zoom: like?.zoom ?? 1,
        fit: like?.fit ?? true,
        thumb: like?.thumb ?? 220,
        scrollTop: like?.scrollTop ?? 0,
        scrollLeft: like?.scrollLeft ?? 0,
        selected: new Set(),
        anchor: null,
      };
      this.views.set(info.id, s);
    }
    return s;
  }

  show(info: DocInfo | null, like?: DocState | null) {
    const s = info ? this.stateFor(info, like) : null;
    if (this.current === s) return;
    this.current = s;
    this.viewer.show(s);
    this.renderHead();
  }

  renderHead() {
    const s = this.current;
    this.head.textContent = '';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s ? s.info.name : 'No file — click a tab to show it here';
    this.head.appendChild(name);
    if (s) {
      const p = this.viewer.currentPage();
      const lbl = s.info.labels?.[p];
      const pg = document.createElement('span');
      pg.className = 'muted';
      pg.textContent = `${lbl ? `${lbl} · ` : ''}p. ${p + 1} / ${s.info.pages.length}`;
      this.head.appendChild(pg);
    }
  }

  forget(info: DocInfo) {
    this.views.delete(info.id);
    this.viewer.forget(info.id);
  }

  destroy() {
    marks.detach(this.viewer);
    this.viewer.destroy();
    this.el.remove();
  }
}

const panesEl = $('panes');
let panes: Pane[] = [];
let focused: Pane;
let splitDir: 'v' | 'h' = 'v'; // v = side by side, h = top / bottom

function addPane(): Pane {
  const p = new Pane();
  panes.push(p);
  if (panes.length > 1) {
    const div = document.createElement('div');
    div.className = 'divider';
    setupDivider(div);
    panesEl.append(div);
  }
  panesEl.append(p.el);
  return p;
}

focused = addPane();
const active = () => focused.current;
const viewer = () => focused.viewer;

function setFocused(p: Pane) {
  if (focused === p) return;
  focused = p;
  for (const q of panes) q.el.classList.toggle('focused', q === p);
  renderTabs();
  updateToolbar();
  if (searchOpen()) runSearch(true);
}

function setSplit(mode: 'off' | 'v' | 'h') {
  if (mode === 'off') {
    for (const p of panes.slice()) if (p !== focused) p.destroy();
    panes = [focused];
    panesEl.querySelectorAll('.divider').forEach((d) => d.remove());
    focused.el.style.flex = '';
  } else {
    splitDir = mode;
    if (panes.length === 1) {
      const first = focused;
      const second = addPane();
      // Start the new pane on the same file and page, like Bluebeam.
      second.show(first.current?.info ?? null, first.current);
      if (first.current) {
        const page = first.viewer.currentPage();
        requestAnimationFrame(() => second.viewer.scrollToPage(page));
      }
      setFocused(second);
    }
  }
  panesEl.className = panes.length > 1 ? `split-${splitDir}` : '';
  for (const p of panes) {
    p.el.classList.toggle('focused', p === focused);
    p.renderHead();
  }
  renderTabs();
  updateToolbar();
}

function toggleSplit() {
  setSplit(panes.length > 1 ? 'off' : splitDir);
}

function setupDivider(div: HTMLDivElement) {
  div.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    div.setPointerCapture(e.pointerId);
    const rect = panesEl.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const f =
        splitDir === 'v' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      const k = Math.min(0.85, Math.max(0.15, f));
      panes[0].el.style.flex = `${k} 1 0`;
      panes[1].el.style.flex = `${1 - k} 1 0`;
    };
    const up = () => {
      div.removeEventListener('pointermove', move);
      div.removeEventListener('pointerup', up);
    };
    div.addEventListener('pointermove', move);
    div.addEventListener('pointerup', up);
  });
  div.addEventListener('dblclick', () => panes.forEach((p) => (p.el.style.flex = '')));
}

// ---------- toolbar ----------

const pageInput = $<HTMLInputElement>('page-input');

function updatePageBox() {
  const d = active();
  const page = viewer().currentPage();
  if (document.activeElement !== pageInput) pageInput.value = d ? String(page + 1) : '';
  const lbl = d?.info.labels?.[page];
  $('sheet-label').textContent = lbl ?? '';
  $('sheet-label').title = lbl ? `Sheet ${lbl}` : '';
  const sc = d ? getScale(d.info.path, page) : null;
  $('btn-scale').innerHTML = '';
  $('btn-scale').append('Scale', document.createElement('br'), Object.assign(document.createElement('b'), { textContent: sc ? scaleLabel(sc).replace(' (calibrated)', '*') : 'not set' }));
  $('btn-scale').title = sc ? `Page scale: ${scaleLabel(sc)} (click to change)` : 'Set the page scale (click)';
}

function updateToolbar() {
  const d = active();
  document.body.classList.toggle('has-docs', docs.length > 0);
  for (const b of $('view-modes').querySelectorAll<HTMLButtonElement>('button')) {
    b.classList.toggle('on', d?.mode === b.dataset.mode);
    b.disabled = !d;
  }
  const split = panes.length > 1 ? splitDir : 'off';
  for (const b of $('split-modes').querySelectorAll<HTMLButtonElement>('button')) {
    b.classList.toggle('on', b.dataset.split === split);
    b.disabled = !docs.length;
  }
  $('zoom-label').textContent = !d ? '' : d.mode === 'grid' ? `${Math.round(d.thumb)}px` : `${Math.round(d.zoom * 100)}%`;
  $('page-count').textContent = d ? `/ ${d.info.pages.length}` : '/ 0';
  const n = d?.selected.size ?? 0;
  $('btn-extract').textContent = n > 0 ? `Extract ${n}…` : 'Extract…';
  for (const id of ['btn-zoom-out', 'btn-zoom-in', 'btn-fit', 'btn-extract']) $<HTMLButtonElement>(id).disabled = !d;
  for (const b of $('rail').querySelectorAll<HTMLButtonElement>('button[data-tool]')) {
    b.classList.toggle('on', b.dataset.tool === marks.tool);
    b.disabled = !d;
  }
  document.body.dataset.tool = marks.tool;
  const mk = d ? marksOf(d.info) : null;
  $<HTMLButtonElement>('btn-undo').disabled = !mk?.undo.length;
  $<HTMLButtonElement>('btn-redo').disabled = !mk?.redo.length;
  $<HTMLButtonElement>('btn-save').disabled = !d;
  $('btn-save').textContent = mk?.dirty && pendingCount(mk) ? `Save (${pendingCount(mk)})` : 'Save';
  $<HTMLButtonElement>('btn-scale').disabled = !d;
  for (const id of ['btn-rotate', 'btn-rename']) $<HTMLButtonElement>(id).disabled = !d;
  pageInput.disabled = !d;
  updatePageBox();
}

// ---------- tabs ----------

function renderTabs() {
  const bar = $('tabs');
  bar.textContent = '';
  const cur = active()?.info;
  const elsewhere = new Set(panes.filter((p) => p !== focused && p.current).map((p) => p.current!.info.id));
  for (const d of docs) {
    const t = document.createElement('div');
    t.className = d === cur ? 'tab on' : elsewhere.has(d.id) ? 'tab other' : 'tab';
    t.title = d.path;
    const name = document.createElement('span');
    name.className = 'name';
    const dirty = !!(d.marks?.dirty && pendingCount(d.marks));
    name.textContent = dirty ? `● ${d.name}` : d.name;
    if (dirty) t.title = `${d.path}\nUnsaved markups (Ctrl+S to save)`;
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Close (Ctrl+W)';
    x.onclick = (e) => {
      e.stopPropagation();
      requestClose(d);
    };
    t.onmousedown = (e) => {
      if (e.button === 1) {
        e.preventDefault();
        requestClose(d);
      }
    };
    t.onclick = () => activate(d);
    t.append(name, x);
    bar.appendChild(t);
    if (d === cur) requestAnimationFrame(() => t.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }
}

/** Show a document in the focused pane. */
function activate(d: DocInfo | null) {
  if (active()?.info !== d) focused.show(d);
  renderTabs();
  updateToolbar();
  if (searchOpen()) runSearch(true);
  focused.scroller.focus({ preventScroll: true });
}

function closeDoc(d: DocInfo) {
  const i = docs.indexOf(d);
  if (i < 0) return;
  docs.splice(i, 1);
  api.closeDoc(d.id).catch(() => {});
  const next = docs[Math.min(i, docs.length - 1)] ?? null;
  for (const p of panes) {
    const showing = p.current?.info === d;
    p.forget(d);
    if (showing) {
      p.current = null;
      p.viewer.doc = null; // don't save scroll of a closed doc
      p.show(next);
    }
  }
  renderTabs();
  updateToolbar();
  if (searchOpen()) runSearch();
}

const opening = new Set<string>();

async function openPaths(paths: string[]) {
  const pdfs = paths.filter((p) => /\.pdf$/i.test(p));
  if (paths.length && !pdfs.length) toast('Only PDF files can be opened.', true);
  // Open in parallel, but add tabs in the order the files were given.
  const results = await Promise.all(
    pdfs.map(async (path): Promise<DocInfo | null> => {
      const norm = path.toLowerCase();
      const existing = docs.find((d) => d.path.toLowerCase() === norm);
      if (existing) return existing;
      if (opening.has(norm)) return null;
      opening.add(norm);
      try {
        const info = await api.openDoc(path);
        const dup = docs.find((d) => d.path === info.path);
        if (dup) return dup;
        if (!info.pages.length) throw new Error('the PDF has no pages');
        info.labels = new Array(info.pages.length).fill(null);
        refreshLabels(info);
        return info;
      } catch (e) {
        toast(`Could not open ${path.split(/[\\/]/).pop()}: ${e}`, true);
        return null;
      } finally {
        opening.delete(norm);
      }
    }),
  );
  let first: DocInfo | null = null;
  for (const d of results) {
    if (!d) continue;
    if (!docs.includes(d)) docs.push(d);
    first ??= d;
  }
  renderTabs();
  updateToolbar();
  if (first) activate(first);
}

async function openWithDialog() {
  const sel = await openDialog({ multiple: true, filters: [{ name: 'PDF', extensions: ['pdf', 'PDF'] }] });
  if (!sel) return;
  openPaths(Array.isArray(sel) ? sel : [sel]);
}

// ---------- sheet names ----------

const labelTimers = new Map<number, number>();

async function refreshLabels(info: DocInfo) {
  try {
    info.labels = await api.labels(info.id);
  } catch {
    return;
  }
  for (const p of panes) {
    if (p.current?.info === info) {
      p.viewer.refreshLabels();
      p.renderHead();
    }
  }
  if (active()?.info === info) updatePageBox();
}

// Throttled, but never drops the last update: a progress event that arrives
// while a refresh is pending schedules one more after it.
const labelsDirty = new Set<number>();
function scheduleLabels(info: DocInfo) {
  if (labelTimers.has(info.id)) {
    labelsDirty.add(info.id);
    return;
  }
  labelTimers.set(
    info.id,
    window.setTimeout(async () => {
      await refreshLabels(info);
      labelTimers.delete(info.id);
      if (labelsDirty.delete(info.id)) scheduleLabels(info);
    }, 300),
  );
}

const indexing = new Map<number, { done: number; total: number }>();

listen<{ doc: number; done: number; total: number }>('index-progress', (e) => {
  indexing.set(e.payload.doc, { done: e.payload.done, total: e.payload.total });
  const info = docs.find((d) => d.id === e.payload.doc);
  if (info) scheduleLabels(info);
  if (!searchOpen()) return;
  clearTimeout(progressTimer);
  progressTimer = window.setTimeout(() => runSearch(true), 250);
});

/** "62" → page 62; "S-208" / "s208" / "SD-1" → the page whose sheet name matches. */
function findPage(d: DocInfo, text: string): number | null {
  const t = text.trim();
  if (/^\d+$/.test(t)) {
    const n = parseInt(t, 10);
    return n >= 1 && n <= d.pages.length ? n - 1 : null;
  }
  const norm = (s: string) => s.toLowerCase().replace(/[\s\-_.]/g, '');
  const q = norm(t);
  if (!q) return null;
  const labels = d.labels ?? [];
  let i = labels.findIndex((l) => l && norm(l) === q);
  if (i < 0) i = labels.findIndex((l) => l && norm(l).startsWith(q));
  if (i < 0) i = labels.findIndex((l) => l && norm(l).includes(q));
  return i >= 0 ? i : null;
}

// ---------- search ----------

const searchPanel = $('search-panel');
const searchInput = $<HTMLInputElement>('search-input');
const searchResults = $('search-results');
const searchStatus = $('search-status');
let hits: Hit[] = [];
let curHit = -1;
let searchTimer = 0;
let progressTimer = 0;
let lastQuery = '';
const MAX_ROWS = 1500;

const searchOpen = () => !searchPanel.hidden;
const scopeAll = () => (document.querySelector<HTMLInputElement>('input[name=scope]:checked')?.value ?? 'doc') === 'all';

function toggleSearch(show = !searchOpen()) {
  searchPanel.hidden = !show;
  $('btn-search').classList.toggle('on', show);
  if (show) {
    searchInput.focus();
    searchInput.select();
    runSearch();
  } else {
    for (const p of panes) p.viewer.setSearch('', new Set());
    focused.scroller.focus();
  }
}

async function runSearch(keepCurrent = false) {
  const q = searchInput.value.trim();
  const cur = active();
  const scope = scopeAll() ? docs.map((d) => d.id) : cur ? [cur.info.id] : [];
  const res = await api.search(q, scope);
  if (searchInput.value.trim() !== q) return; // a newer query is on its way
  const changed = q !== lastQuery;
  lastQuery = q;
  hits = res.hits;
  if (!keepCurrent || changed) curHit = -1;
  const indexing = res.indexed < res.total ? ` · indexing ${res.indexed}/${res.total} pages…` : '';
  if (!q) searchStatus.textContent = res.total ? `Type to search ${res.total} pages${indexing}` : 'Open a PDF to search';
  else searchStatus.textContent = `${hits.length}${res.truncated ? '+' : ''} result${hits.length === 1 ? '' : 's'}${indexing}`;
  renderResults();
  pushHighlights();
}

function pushHighlights() {
  for (const p of panes) {
    const id = p.current?.info.id;
    p.viewer.setSearch(lastQuery, new Set(hits.filter((h) => h.doc === id).map((h) => h.page)));
  }
}

function renderResults() {
  searchResults.textContent = '';
  const frag = document.createDocumentFragment();
  let lastDoc = -1;
  const multi = new Set(hits.map((h) => h.doc)).size > 1 || scopeAll();
  hits.slice(0, MAX_ROWS).forEach((h, i) => {
    const info = docs.find((d) => d.id === h.doc);
    if (multi && h.doc !== lastDoc) {
      lastDoc = h.doc;
      const f = document.createElement('div');
      f.className = 'res-file';
      f.textContent = info?.name ?? '?';
      frag.appendChild(f);
    }
    const r = document.createElement('div');
    r.className = i === curHit ? 'res on' : 'res';
    r.dataset.i = String(i);
    const pg = document.createElement('span');
    pg.className = 'pg';
    const lbl = info?.labels?.[h.page];
    pg.textContent = lbl ? `${lbl} · p. ${h.page + 1}` : `p. ${h.page + 1}`;
    const m = document.createElement('mark');
    m.textContent = h.hit;
    r.append(pg, h.before, m, h.after);
    frag.appendChild(r);
  });
  if (hits.length > MAX_ROWS) {
    const more = document.createElement('div');
    more.className = 'res muted';
    more.textContent = `Showing the first ${MAX_ROWS} results — refine the search to see more.`;
    frag.appendChild(more);
  }
  searchResults.appendChild(frag);
}

function gotoHit(i: number) {
  if (!hits.length) return;
  curHit = ((i % hits.length) + hits.length) % hits.length;
  const h = hits[curHit];
  const d = docs.find((x) => x.id === h.doc);
  if (!d) return;
  if (active()?.info !== d) {
    focused.show(d);
    renderTabs();
  }
  pushHighlights();
  // Index of this hit among hits on the same page = which match to emphasize.
  let index = 0;
  for (let k = curHit - 1; k >= 0 && hits[k].doc === h.doc && hits[k].page === h.page; k--) index++;
  viewer().jumpTo(h.page, index);
  for (const el of searchResults.querySelectorAll('.res.on')) el.classList.remove('on');
  const row = searchResults.querySelector<HTMLElement>(`.res[data-i="${curHit}"]`);
  row?.classList.add('on');
  row?.scrollIntoView({ block: 'nearest' });
  updateToolbar();
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => runSearch(), 120);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    gotoHit(e.shiftKey ? curHit - 1 : curHit + 1);
  } else if (e.key === 'Escape') {
    toggleSearch(false);
  }
});
for (const r of document.querySelectorAll<HTMLInputElement>('input[name=scope]')) r.addEventListener('change', () => runSearch());
searchResults.addEventListener('click', (e) => {
  const r = (e.target as HTMLElement).closest('.res') as HTMLElement | null;
  if (r?.dataset.i) gotoHit(Number(r.dataset.i));
});

// ---------- extract ----------

const dlg = $<HTMLDialogElement>('extract-dialog');
const rangeInput = $<HTMLInputElement>('extract-range');
const extractErr = $('extract-error');

function openExtract() {
  const d = active();
  if (!d) return;
  $('extract-doc').textContent = `${d.info.name} — ${d.info.pages.length} pages`;
  const sel = [...d.selected].sort((a, b) => a - b);
  rangeInput.value = sel.length ? formatRanges(sel) : String(viewer().currentPage() + 1);
  extractErr.textContent = '';
  dlg.showModal();
  rangeInput.focus();
  rangeInput.select();
}

$('extract-go').addEventListener('click', async (e) => {
  e.preventDefault();
  const d = active();
  if (!d) return;
  let pages: number[];
  try {
    pages = parseRanges(rangeInput.value, d.info.pages.length);
  } catch (err) {
    extractErr.textContent = String(err instanceof Error ? err.message : err);
    return;
  }
  const base = d.info.name.replace(/\.pdf$/i, '');
  const label = formatRanges(pages).replace(/,\s*/g, '_').replace(/\s/g, '');
  const dir = d.info.path.slice(0, Math.max(d.info.path.lastIndexOf('/'), d.info.path.lastIndexOf('\\')) + 1);
  const dest = await saveDialog({
    defaultPath: `${dir}${base} (p${label}).pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (!dest) return;
  const target = /\.pdf$/i.test(dest) ? dest : `${dest}.pdf`;
  dlg.close();
  toast(`Extracting ${pages.length} page${pages.length === 1 ? '' : 's'}…`, false, 1500);
  try {
    const n = await api.extract(d.info.id, pages, target);
    toast(`Saved ${n} page${n === 1 ? '' : 's'} to ${target}`);
  } catch (err) {
    toast(`Extract failed: ${err}`, true);
  }
});
rangeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('extract-go').click();
  }
});

// ---------- toolbar wiring ----------

$('btn-open').onclick = openWithDialog;
$('btn-open-big').onclick = openWithDialog;
$('btn-zoom-in').onclick = () => viewer().zoomBy(1.25);
$('btn-zoom-out').onclick = () => viewer().zoomBy(0.8);
$('btn-fit').onclick = () => viewer().fitWidth();
$('btn-search').onclick = () => toggleSearch();
$('btn-extract').onclick = openExtract;
for (const b of $('view-modes').querySelectorAll<HTMLButtonElement>('button')) {
  b.onclick = () => {
    viewer().setMode(b.dataset.mode as Mode);
    updateToolbar();
    focused.scroller.focus();
  };
}
for (const b of $('split-modes').querySelectorAll<HTMLButtonElement>('button')) {
  b.onclick = () => setSplit(b.dataset.split as 'off' | 'v' | 'h');
}
pageInput.addEventListener('keydown', (e) => {
  const d = active();
  if (e.key !== 'Enter' || !d) return;
  const p = findPage(d.info, pageInput.value);
  if (p === null) {
    const ix = indexing.get(d.info.id);
    const busy = !ix || ix.done < ix.total;
    toast(
      busy
        ? `Still reading sheet names (${ix?.done ?? 0}/${d.info.pages.length}) — try "${pageInput.value.trim()}" again in a moment`
        : `No page or sheet "${pageInput.value.trim()}"`,
      !busy,
      2500,
    );
    return;
  }
  viewer().scrollToPage(p);
  focused.scroller.focus();
});
pageInput.addEventListener('focus', () => pageInput.select());
pageInput.addEventListener('blur', () => updatePageBox());

// ---------- markups: save, close guard ----------

const unsavedCount = (d: DocInfo) => (d.marks?.dirty ? pendingCount(d.marks) : 0);

interface SaveOpts {
  saveAs?: boolean;
  /** New page labels ("Rename sheets"). */
  labels?: string[];
  /** [page, quarter turns clockwise] */
  rotate?: [number, number][];
}

/** Writes markups (and page names / rotation) into the PDF (or a copy) and reloads it in place. */
async function saveDoc(d: DocInfo, opts: SaveOpts | boolean = {}): Promise<boolean> {
  const o: SaveOpts = typeof opts === 'boolean' ? { saveAs: opts } : opts;
  const saveAs = !!o.saveAs;
  marks.commitEdit();
  marks.commitTextEdit();
  const mk = marksOf(d);
  if (!pendingCount(mk) && !saveAs && !o.labels && !o.rotate) {
    toast('No new markups to save.');
    return true;
  }
  let dest: string | undefined;
  if (saveAs) {
    const picked = await saveDialog({
      defaultPath: d.path.replace(/\.pdf$/i, '') + ' (marked up).pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (!picked) return false;
    dest = /\.pdf$/i.test(picked) ? picked : `${picked}.pdf`;
  }
  const payload = mk.markups.map((m) => ({ ...m, text: m.kind === 'measure' ? measureText(m) : m.text }));
  const edits = mk.edits.map((e) => ({ page: e.page, index: e.index, orig: e.orig, text: e.text }));
  const what = [
    payload.length ? `${payload.length} markup${payload.length === 1 ? '' : 's'}` : '',
    edits.length ? `${edits.length} text edit${edits.length === 1 ? '' : 's'}` : '',
    o.labels ? 'sheet names' : '',
    o.rotate ? `rotation of ${o.rotate.length} page${o.rotate.length === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join(' + ');
  toast(`Saving ${what}…`, false, 1500);
  try {
    const written = await api.saveMarkups(d.id, payload, dest, o.labels, o.rotate, edits.length ? edits : undefined);
    const info = await api.openDoc(written);
    info.labels = d.labels?.length === info.pages.length ? d.labels : new Array(info.pages.length).fill(null);
    marks.clearSaved(d);
    replaceDoc(d, info);
    scheduleLabels(info);
    toast(`Saved ${what} into ${info.name}`);
    return true;
  } catch (err) {
    toast(`Save failed: ${err}`, true);
    return false;
  }
}

/** Swap a document for its re-opened (saved) version, keeping each pane's view. */
function replaceDoc(old: DocInfo, info: DocInfo) {
  const i = docs.indexOf(old);
  if (i >= 0) docs[i] = info;
  else docs.push(info);
  for (const p of panes) {
    const st = p.views.get(old.id);
    p.views.delete(old.id);
    if (st) {
      st.info = info;
      p.views.set(info.id, st);
    }
    if (p.current?.info === info || st === p.current) {
      if (st) {
        // Keep where the user was looking (the state only holds it after a tab switch).
        st.scrollTop = p.scroller.scrollTop;
        st.scrollLeft = p.scroller.scrollLeft;
      }
      p.current = null;
      p.viewer.doc = null; // keep the saved scroll position in `st`
      p.show(info, st);
    }
  }
  api.closeDoc(old.id).catch(() => {});
  renderTabs();
  updateToolbar();
  renderProps();
  if (searchOpen()) runSearch(true);
}

const unsavedDlg = $<HTMLDialogElement>('unsaved-dialog');

function askUnsaved(text: string): Promise<'save' | 'discard' | 'cancel'> {
  $('unsaved-text').textContent = text;
  unsavedDlg.returnValue = 'cancel';
  unsavedDlg.showModal();
  return new Promise((resolve) => {
    unsavedDlg.addEventListener('close', () => resolve((unsavedDlg.returnValue || 'cancel') as 'save' | 'discard' | 'cancel'), { once: true });
  });
}

async function requestClose(d: DocInfo) {
  const n = unsavedCount(d);
  if (n) {
    const r = await askUnsaved(`${d.name} has ${n} unsaved markup${n === 1 ? '' : 's'}. Save them into the PDF?`);
    if (r === 'cancel') return;
    if (r === 'save' && !(await saveDoc(d))) return;
    // after a save the doc was replaced; close whatever now holds its path
    d = docs.find((x) => x.path === d.path) ?? d;
  }
  closeDoc(d);
}

getCurrentWindow()
  .onCloseRequested(async (e) => {
    const dirty = docs.filter((d) => unsavedCount(d) > 0);
    if (!dirty.length) return;
    e.preventDefault();
    const total = dirty.reduce((n, d) => n + unsavedCount(d), 0);
    const r = await askUnsaved(
      `${total} unsaved markup${total === 1 ? '' : 's'} in ${dirty.map((d) => d.name).join(', ')}. Save before closing?`,
    );
    if (r === 'cancel') return;
    if (r === 'save') {
      for (const d of dirty) if (!(await saveDoc(d))) return;
    }
    await getCurrentWindow().destroy();
  })
  .catch(() => {});

// ---------- page scale & calibration ----------

const scaleDlg = $<HTMLDialogElement>('scale-dialog');
const scaleSel = $<HTMLSelectElement>('scale-preset');
for (const p of PRESETS) scaleSel.add(new Option(p.label, String(p.inPerPt)));

function askScale(info: DocInfo, page: number, note = ''): Promise<number | null> {
  const cur = getScale(info.path, page);
  $('scale-info').textContent = `${note ? note + ' ' : ''}Page ${page + 1}${info.labels?.[page] ? ` (${info.labels[page]})` : ''} — current: ${cur ? scaleLabel(cur) : 'not set'}.`;
  const idx = cur ? PRESETS.findIndex((p) => Math.abs(p.inPerPt - cur) / cur < 0.001) : PRESETS.findIndex((p) => p.label.startsWith('1/8"'));
  scaleSel.selectedIndex = Math.max(0, idx);
  scaleDlg.returnValue = 'cancel';
  scaleDlg.showModal();
  return new Promise((resolve) => {
    scaleDlg.addEventListener(
      'close',
      () => {
        const v = scaleDlg.returnValue;
        if (v === 'ok') {
          const s = Number(scaleSel.value);
          const all = (document.querySelector<HTMLInputElement>('input[name=scale-apply]:checked')?.value ?? 'all') === 'all';
          setScale(info.path, all ? 'all' : page, s);
          updatePageBox();
          resolve(s);
        } else {
          if (v === 'calibrate') {
            marks.setTool('calibrate');
            toast('Calibrate: click both ends of a dimension you know (Shift keeps it straight).');
          }
          resolve(null);
        }
      },
      { once: true },
    );
  });
}

// Calibration: a floating panel (not a modal) so you can still pan / zoom to check the line.
const calibPanel = $('calib-panel');
const calibInput = $<HTMLInputElement>('calib-length');
let calibPending: { info: DocInfo; page: number; len: number } | null = null;

function askCalibration(info: DocInfo, page: number, len: number) {
  const first = calibPanel.hidden;
  calibPending = { info, page, len };
  $('calib-error').textContent = '';
  calibPanel.hidden = false;
  if (first) {
    calibInput.value = '';
    calibInput.focus();
  }
}

function closeCalibration(applied: boolean) {
  calibPanel.hidden = true;
  calibPending = null;
  marks.clearCalib();
  if (!applied && marks.tool === 'calibrate') marks.setTool('pan');
}

function applyCalibration() {
  const c = calibPending;
  if (!c) return closeCalibration(false);
  const inches = parseLength(calibInput.value);
  if (!inches || inches <= 0) {
    $('calib-error').textContent = 'Type a length, e.g. 17\'6 1/2" or 210" or 5.3m';
    return;
  }
  const all = (document.querySelector<HTMLInputElement>('input[name=calib-apply]:checked')?.value ?? 'all') === 'all';
  const s = inches / c.len;
  setScale(c.info.path, all ? 'all' : c.page, s);
  closeCalibration(true);
  marks.setTool('measure');
  updatePageBox();
  toast(`Scale set: ${scaleLabel(s)}. Measure tool is on.`);
}

$('calib-ok').onclick = applyCalibration;
$('calib-cancel').onclick = () => closeCalibration(false);
calibInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') applyCalibration();
  else if (e.key === 'Escape') closeCalibration(false);
});

$('btn-scale').onclick = () => {
  const d = active();
  if (d) askScale(d.info, viewer().currentPage());
};

// ---------- properties bar (style of the current tool or selected markup) ----------

const SWATCHES = ['#ff0000', '#ff7a00', '#ffe600', '#00a650', '#0050ff', '#9b30ff', '#ff00c8', '#000000', '#ffffff'];
const SHOW: Record<Kind, string[]> = {
  pen: ['color', 'width', 'opacity'],
  highlight: ['color', 'width', 'opacity'],
  rect: ['color', 'width', 'opacity'],
  ellipse: ['color', 'width', 'opacity'],
  text: ['color', 'textColor', 'width', 'font', 'size', 'opacity'],
  callout: ['color', 'textColor', 'width', 'font', 'size', 'opacity'],
  measure: ['color', 'textColor', 'width', 'font', 'size', 'opacity', 'format'],
};
const HINTS: Record<string, string> = {
  pan: 'Drag to move around · click a markup to select, drag to move, Delete to remove · double-click a text box to edit',
  'select-text': 'Drag a box around text, then Ctrl+C to copy',
  snapshot: 'Drag a box to copy that area (with markups) as an image',
  calibrate: 'Click both ends of a dimension you know, then type its length',
  'edit-text': "Click a line of the drawing's own text to change it · Enter keeps it, Esc cancels · clear it to delete · written into the PDF on Save",
};
const fmtSel = $<HTMLSelectElement>('p-format');
for (const f of FORMATS) fmtSel.add(new Option(f.example, f.id));

for (const box of document.querySelectorAll<HTMLElement>('#props .swatches')) {
  const key = box.dataset.for as 'color' | 'textColor';
  for (const c of SWATCHES) {
    const b = document.createElement('button');
    b.className = 'sw';
    b.style.background = c;
    b.dataset.c = c;
    b.title = c;
    b.onclick = () => {
      marks.setStyle({ [key]: c });
      renderProps();
    };
    box.appendChild(b);
  }
}

function renderProps() {
  const cur = marks.currentStyle();
  const bar = $('props');
  const tool = marks.tool;
  $('props-title').textContent = cur ? `${KIND_NAMES[cur.kind]}${marks.selected ? ' (selected)' : ''}` : TOOL_NAMES[tool] ?? '';
  $('props-hint').textContent = cur ? '' : HINTS[tool] ?? '';
  const show = new Set(cur ? SHOW[cur.kind] : []);
  for (const g of bar.querySelectorAll<HTMLElement>('.pgroup')) g.hidden = !show.has(g.dataset.p!);
  $<HTMLButtonElement>('p-delete').hidden = !marks.selected;
  if (!cur) return;
  const s = cur.style;
  const setV = (id: string, v: string | number) => {
    const el = $<HTMLInputElement>(id);
    if (document.activeElement !== el) el.value = String(v);
  };
  setV('p-color', s.color);
  setV('p-textColor', s.textColor);
  setV('p-width', s.width);
  setV('p-width-n', s.width);
  setV('p-size', s.size);
  setV('p-opacity', Math.round(s.opacity * 100));
  $('p-opacity-v').textContent = `${Math.round(s.opacity * 100)}%`;
  $<HTMLSelectElement>('p-font').value = s.font;
  fmtSel.value = s.format;
  $('p-bold').classList.toggle('on', s.bold);
  $('p-italic').classList.toggle('on', s.italic);
  $('p-underline').classList.toggle('on', s.underline);
  for (const sw of bar.querySelectorAll<HTMLElement>('.sw')) {
    const key = (sw.parentElement as HTMLElement).dataset.for as 'color' | 'textColor';
    sw.classList.toggle('on', s[key].toLowerCase() === sw.dataset.c);
  }
}

const propInput = (id: string, ev: 'input' | 'change', apply: (v: string) => void) => {
  const el = $<HTMLInputElement>(id);
  el.addEventListener(ev, () => {
    apply(el.value);
    renderProps();
  });
  el.addEventListener('keydown', (e) => e.stopPropagation());
};
propInput('p-color', 'input', (v) => marks.setStyle({ color: v }));
propInput('p-textColor', 'input', (v) => marks.setStyle({ textColor: v }));
propInput('p-width', 'input', (v) => marks.setStyle({ width: Number(v) }));
propInput('p-width-n', 'change', (v) => Number(v) >= 0 && marks.setStyle({ width: Number(v) }));
propInput('p-size', 'change', (v) => Number(v) >= 4 && marks.setStyle({ size: Number(v) }));
propInput('p-opacity', 'input', (v) => marks.setStyle({ opacity: Number(v) / 100 }));
propInput('p-font', 'change', (v) => marks.setStyle({ font: v as FontName }));
propInput('p-format', 'change', (v) => marks.setStyle({ format: v as NumberFormat }));
for (const k of ['bold', 'italic', 'underline'] as const) {
  $(`p-${k}`).onclick = () => {
    const cur = marks.currentStyle();
    if (cur) marks.setStyle({ [k]: !cur.style[k] });
    renderProps();
  };
}
$('p-delete').onclick = () => marks.deleteSelected();

// ---------- tool rail ----------

const TOOL_NAMES: Record<string, string> = {};
for (const b of $('rail').querySelectorAll<HTMLButtonElement>('button[data-tool]')) {
  TOOL_NAMES[b.dataset.tool!] = b.querySelector('span')?.textContent ?? '';
  b.onclick = () => selectTool(b.dataset.tool as Tool);
}
TOOL_NAMES['select-text'] = 'Select text';
TOOL_NAMES['edit-text'] = 'Edit PDF text';

function selectTool(t: Tool) {
  if (!active()) return;
  if (t !== 'calibrate' && !calibPanel.hidden) closeCalibration(false);
  marks.setTool(t);
  if ((isKind(marks.tool) || t === 'calibrate' || t === 'edit-text') && active()?.mode === 'grid') viewer().setMode('scroll');
  renderProps();
  focused.scroller.focus({ preventScroll: true });
}

$('btn-undo').onclick = () => active() && marks.undo(active()!.info);
$('btn-redo').onclick = () => active() && marks.redo(active()!.info);
$('btn-save').onclick = () => active() && saveDoc(active()!.info);

// ---------- rotate ----------

const rotateMenu = $('rotate-menu');
$('btn-rotate').onclick = (e) => {
  e.stopPropagation();
  const d = active();
  if (!d) return;
  for (const b of rotateMenu.querySelectorAll<HTMLButtonElement>('.needs-sel')) b.hidden = !(d.mode === 'grid' && d.selected.size);
  rotateMenu.hidden = !rotateMenu.hidden;
};
document.addEventListener('click', () => (rotateMenu.hidden = true));
for (const b of rotateMenu.querySelectorAll<HTMLButtonElement>('button[data-rot]')) {
  b.onclick = async () => {
    rotateMenu.hidden = true;
    const d = active();
    if (!d) return;
    const [which, t] = b.dataset.rot!.split(':');
    const turns = Number(t);
    const pages =
      which === 'all'
        ? d.info.pages.map((_, i) => i)
        : which === 'sel'
          ? [...d.selected].sort((a, b) => a - b)
          : [viewer().currentPage()];
    if (!pages.length) return;
    await saveDoc(d.info, { rotate: pages.map((p) => [p, turns] as [number, number]) });
  };
}

// ---------- rename sheets ----------

const renameDlg = $<HTMLDialogElement>('rename-dialog');
const renameBody = $('rename-table').querySelector('tbody')!;
let renameRows: { num: HTMLInputElement; title: HTMLInputElement; out: HTMLElement; touched: boolean }[] = [];
let renameTimer = 0;

function renameName(i: number): string {
  const r = renameRows[i];
  const n = r.num.value.trim();
  const t = r.title.value.trim();
  const f = $<HTMLSelectElement>('rename-format').value;
  if (f === 'n') return n || t;
  if (f === 't') return t || n;
  return n && t ? `${n} - ${t}` : n || t;
}

function renameRefresh() {
  renameRows.forEach((r, i) => (r.out.textContent = renameName(i) || `(page ${i + 1})`));
}

async function renameFill(d: DocInfo) {
  try {
    const info = await api.sheetInfo(d.id);
    info.numbers.forEach((n, i) => {
      const r = renameRows[i];
      if (!r || r.touched) return;
      if (n && !r.num.value) r.num.value = n;
      const t = info.titles[i];
      if (t && !r.title.value) r.title.value = t;
    });
    renameRefresh();
    const busy = info.indexed < info.total;
    const found = info.numbers.filter(Boolean).length;
    $('rename-status').textContent = busy
      ? `Reading title blocks… ${info.indexed}/${info.total}`
      : `Found ${found} of ${info.total} sheet numbers. Fill in any blanks.`;
    if (busy && renameDlg.open) renameTimer = window.setTimeout(() => renameFill(d), 500);
  } catch (e) {
    $('rename-status').textContent = `Couldn't read sheet names: ${e}`;
  }
}

function openRename() {
  const d = active();
  if (!d) return;
  clearTimeout(renameTimer);
  renameBody.textContent = '';
  renameRows = d.info.pages.map((_, i) => {
    const tr = document.createElement('tr');
    const pg = document.createElement('td');
    pg.textContent = String(i + 1);
    pg.className = 'pg';
    const mk = (cls: string) => {
      const td = document.createElement('td');
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = cls;
      inp.spellcheck = false;
      td.appendChild(inp);
      tr.appendChild(td);
      return inp;
    };
    tr.appendChild(pg);
    const num = mk('num');
    const title = mk('title');
    const out = document.createElement('td');
    out.className = 'out';
    tr.appendChild(out);
    renameBody.appendChild(tr);
    const row = { num, title, out, touched: false };
    for (const inp of [num, title]) {
      inp.addEventListener('input', () => {
        row.touched = true;
        renameRefresh();
      });
      inp.addEventListener('focus', () => viewer().scrollToPage(i));
    }
    return row;
  });
  $('rename-error').textContent = '';
  renameDlg.returnValue = 'cancel';
  renameDlg.showModal();
  renameFill(d.info);
}

$('rename-format').addEventListener('change', renameRefresh);
$('btn-rename').onclick = openRename;
renameDlg.addEventListener('close', () => clearTimeout(renameTimer));
$('rename-go').addEventListener('click', async (e) => {
  e.preventDefault();
  const d = active();
  if (!d) return;
  const labels = renameRows.map((_, i) => renameName(i));
  if (!labels.some(Boolean)) {
    $('rename-error').textContent = 'No names to apply.';
    return;
  }
  renameDlg.close();
  await saveDoc(d.info, { labels });
});

// ---------- keyboard ----------

const TOOL_KEYS: Record<string, Tool> = {};
for (const b of $('rail').querySelectorAll<HTMLButtonElement>('button[data-tool]')) {
  if (b.dataset.key) TOOL_KEYS[b.dataset.key.toLowerCase()] = b.dataset.tool as Tool;
}

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  const d = active();
  if (mod && key === 'o') {
    e.preventDefault();
    openWithDialog();
  } else if (mod && key === 's') {
    e.preventDefault();
    if (d) saveDoc(d.info, e.shiftKey);
  } else if (mod && (key === 'z' || key === 'y') && !inField) {
    e.preventDefault();
    if (d) (key === 'y' || e.shiftKey ? marks.redo : marks.undo).call(marks, d.info);
  } else if (mod && key === 'c' && !inField && marks.textSel) {
    e.preventDefault();
    marks.copySelection();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && !inField && marks.selected) {
    e.preventDefault();
    marks.deleteSelected();
  } else if (e.key === ' ' && !inField) {
    // Hold Space to pan with any tool.
    e.preventDefault();
    marks.spaceDown = true;
    document.body.classList.add('space-pan');
  } else if (mod && key === 'w') {
    e.preventDefault();
    if (d) requestClose(d.info);
  } else if (mod && e.key === 'Tab') {
    e.preventDefault();
    const cur = d?.info;
    if (docs.length && cur) activate(docs[(docs.indexOf(cur) + (e.shiftKey ? docs.length - 1 : 1)) % docs.length]);
  } else if (mod && key === 'h' && e.shiftKey) {
    // Flip the split between side by side and top / bottom.
    e.preventDefault();
    setSplit(splitDir === 'v' ? 'h' : 'v');
  } else if (mod && (key === 'h' || e.key === '2')) {
    e.preventDefault();
    if (docs.length) toggleSplit();
  } else if (e.key === 'F6' && panes.length > 1) {
    e.preventDefault();
    const next = panes[(panes.indexOf(focused) + 1) % panes.length];
    setFocused(next);
    next.scroller.focus();
  } else if (mod && key === 'f') {
    e.preventDefault();
    toggleSearch(true);
  } else if (mod && key === 'e') {
    e.preventDefault();
    openExtract();
  } else if (mod && key === 'g') {
    e.preventDefault();
    pageInput.focus();
  } else if (mod && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    viewer().zoomBy(1.25);
  } else if (mod && e.key === '-') {
    e.preventDefault();
    viewer().zoomBy(0.8);
  } else if (mod && e.key === '0') {
    e.preventDefault();
    viewer().fitWidth();
  } else if (mod && e.key === '1') {
    e.preventDefault();
    viewer().setZoom(1);
  } else if (mod && key === 'a' && !inField && d?.mode === 'grid') {
    e.preventDefault();
    viewer().selectAll();
  } else if (!mod && !e.altKey && !inField && TOOL_KEYS[key] && d) {
    e.preventDefault();
    selectTool(TOOL_KEYS[key]);
  } else if (e.key === 'F3') {
    e.preventDefault();
    gotoHit(e.shiftKey ? curHit - 1 : curHit + 1);
  } else if (e.key === 'Escape' && !inField) {
    if (d?.mode === 'grid' && d.selected.size) {
      d.selected.clear();
      viewer().refreshSelection();
    } else {
      if (!calibPanel.hidden) closeCalibration(false);
      else marks.escape();
    }
  } else if (mod && e.shiftKey && e.altKey && key === 'k') {
    // Hidden: kill a render worker to demonstrate crash recovery.
    api.crashAWorker();
    toast('Killed a render worker (it will be restarted).');
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    marks.spaceDown = false;
    document.body.classList.remove('space-pan');
  }
});
window.addEventListener('blur', () => {
  marks.spaceDown = false;
  document.body.classList.remove('space-pan');
});

// Block the webview's own pinch/ctrl+wheel page zoom everywhere (the viewer handles it).
window.addEventListener('wheel', (e) => e.ctrlKey && e.preventDefault(), { passive: false });

// ---------- drag & drop, "open with", second instance ----------

const overlay = $('drop-overlay');
getCurrentWebview()
  .onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === 'enter' || p.type === 'over') overlay.hidden = false;
    else if (p.type === 'leave') overlay.hidden = true;
    else if (p.type === 'drop') {
      overlay.hidden = true;
      openPaths(p.paths);
    }
  })
  .catch(() => {});

listen<string[]>('open-files', (e) => openPaths(e.payload));

initUpdates(toast);
renderProps();

focused.el.classList.add('focused');
focused.renderHead();
updateToolbar();
api.initialFiles().then((files) => {
  if (files.length) openPaths(files);
});

// ---------- request a feature ----------

const featureDlg = $<HTMLDialogElement>('feature-dialog');
const featureText = $<HTMLTextAreaElement>('feature-text');
const featureName = $<HTMLInputElement>('feature-name');
const featureEmail = $<HTMLInputElement>('feature-email');
const featureErr = $('feature-error');
const featureSend = $<HTMLButtonElement>('feature-send');
const remembered = (k: string) => {
  try {
    return localStorage.getItem(k) ?? '';
  } catch {
    return '';
  }
};
const featureCount = () => ($('feature-count').textContent = `${featureText.value.length} / 5000`);
featureText.addEventListener('input', featureCount);
featureDlg.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') e.stopPropagation(); // typing must not trigger app shortcuts
});

// Only shown in builds that know where to send requests (FEEDBACK_URL).
$('btn-feature').hidden = !feedbackConfigured();
$('btn-feature').onclick = () => {
  featureErr.textContent = '';
  featureName.value ||= remembered('qfp.name');
  featureEmail.value ||= remembered('qfp.email');
  featureCount();
  featureDlg.showModal();
  featureText.focus();
};

featureSend.onclick = async (e) => {
  e.preventDefault();
  const text = featureText.value.trim();
  if (text.length < 3) {
    featureErr.textContent = 'Please describe the feature you would like.';
    return featureText.focus();
  }
  if (featureEmail.value.trim() && !featureEmail.checkValidity()) {
    featureErr.textContent = 'That email address doesn\'t look right (or leave it empty).';
    return featureEmail.focus();
  }
  if (!feedbackConfigured()) {
    featureErr.textContent = 'Sending requests isn\'t set up in this version yet.';
    return;
  }
  featureErr.textContent = '';
  featureSend.disabled = true;
  featureSend.textContent = 'Sending…';
  try {
    localStorage.setItem('qfp.name', featureName.value.trim());
    localStorage.setItem('qfp.email', featureEmail.value.trim());
  } catch {
    /* ignore */
  }
  try {
    await sendFeatureRequest(text, featureName.value, featureEmail.value);
    featureText.value = '';
    featureDlg.close();
    toast('Thanks! Your request was sent.');
  } catch (err) {
    if (err instanceof OfflineError) {
      featureText.value = '';
      featureDlg.close();
      toast("Couldn't reach the server right now: your request is saved and will be sent automatically next time Quick Fast PDF starts.");
    } else {
      featureErr.textContent = `Couldn't send it: ${err instanceof Error ? err.message : err}`;
    }
  } finally {
    featureSend.disabled = false;
    featureSend.textContent = 'Send';
  }
};

// Requests written while offline go out a little after start-up.
setTimeout(() => {
  flushOutbox().then((n) => n && toast(`Sent ${n} saved feature request${n === 1 ? '' : 's'}.`));
}, 12000);
