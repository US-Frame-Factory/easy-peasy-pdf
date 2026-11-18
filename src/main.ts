import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { api, DocInfo, Hit } from './api';
import { formatRanges, parseRanges } from './ranges';
import { initUpdates } from './updates';
import { DocState, Mode, Viewer } from './viewer';

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
    });
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
    name.textContent = d.name;
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Close (Ctrl+W)';
    x.onclick = (e) => {
      e.stopPropagation();
      closeDoc(d);
    };
    t.onmousedown = (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeDoc(d);
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

// ---------- keyboard ----------

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  const inField = e.target instanceof HTMLInputElement;
  const d = active();
  if (mod && key === 'o') {
    e.preventDefault();
    openWithDialog();
  } else if (mod && key === 'w') {
    e.preventDefault();
    if (d) closeDoc(d.info);
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
  } else if (e.key === 'F3') {
    e.preventDefault();
    gotoHit(e.shiftKey ? curHit - 1 : curHit + 1);
  } else if (e.key === 'Escape' && !inField && d?.selected.size) {
    d.selected.clear();
    viewer().refreshSelection();
  } else if (mod && e.shiftKey && e.altKey && key === 'k') {
    // Hidden: kill a render worker to demonstrate crash recovery.
    api.crashAWorker();
    toast('Killed a render worker (it will be restarted).');
  }
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

focused.el.classList.add('focused');
focused.renderHead();
updateToolbar();
api.initialFiles().then((files) => {
  if (files.length) openPaths(files);
});
