import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { api, Hit } from './api';
import { formatRanges, parseRanges } from './ranges';
import { DocState, Mode, Viewer } from './viewer';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const docs: DocState[] = [];
let active: DocState | null = null;

// ---------- toasts ----------

function toast(msg: string, err = false, ms = 4000) {
  const t = document.createElement('div');
  t.className = err ? 'toast err' : 'toast';
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), err ? ms * 2 : ms);
}

// ---------- viewer ----------

const pageInput = $<HTMLInputElement>('page-input');
const viewer = new Viewer($('viewer'), $('content'), {
  onPageChange(page) {
    if (document.activeElement !== pageInput) pageInput.value = active ? String(page + 1) : '';
  },
  onZoomChange: updateToolbar,
  onSelectionChange: updateToolbar,
  onOpenPage(page) {
    viewer.setMode('scroll');
    viewer.scrollToPage(page);
    updateToolbar();
  },
});

function updateToolbar() {
  const d = active;
  document.body.classList.toggle('has-docs', docs.length > 0);
  for (const b of $('view-modes').querySelectorAll<HTMLButtonElement>('button')) {
    b.classList.toggle('on', d?.mode === b.dataset.mode);
    b.disabled = !d;
  }
  $('zoom-label').textContent = !d ? '' : d.mode === 'grid' ? `${Math.round(d.thumb)}px` : `${Math.round(d.zoom * 100)}%`;
  $('page-count').textContent = d ? `/ ${d.info.pages.length}` : '/ 0';
  const n = d?.selected.size ?? 0;
  $('btn-extract').textContent = n > 0 ? `Extract ${n}…` : 'Extract…';
  for (const id of ['btn-zoom-out', 'btn-zoom-in', 'btn-fit', 'btn-extract']) $<HTMLButtonElement>(id).disabled = !d;
  pageInput.disabled = !d;
  if (!d) pageInput.value = '';
}

// ---------- tabs ----------

function renderTabs() {
  const bar = $('tabs');
  bar.textContent = '';
  for (const d of docs) {
    const t = document.createElement('div');
    t.className = d === active ? 'tab on' : 'tab';
    t.title = d.info.path;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = d.info.name;
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
    if (d === active) requestAnimationFrame(() => t.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }
}

function activate(d: DocState | null) {
  if (active === d) return;
  active = d;
  viewer.show(d);
  renderTabs();
  updateToolbar();
  if (searchOpen()) runSearch();
  $('viewer').focus({ preventScroll: true });
}

function closeDoc(d: DocState) {
  const i = docs.indexOf(d);
  if (i < 0) return;
  docs.splice(i, 1);
  api.closeDoc(d.info.id).catch(() => {});
  viewer.forget(d.info.id);
  if (active === d) {
    active = null; // don't save scroll of a closed doc
    viewer.doc = null;
    activate(docs[Math.min(i, docs.length - 1)] ?? null);
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
    pdfs.map(async (path): Promise<DocState | null> => {
      const norm = path.toLowerCase();
      const existing = docs.find((d) => d.info.path.toLowerCase() === norm);
      if (existing) return existing;
      if (opening.has(norm)) return null;
      opening.add(norm);
      try {
        const info = await api.openDoc(path);
        const dup = docs.find((d) => d.info.path === info.path);
        if (dup) return dup;
        if (!info.pages.length) throw new Error('the PDF has no pages');
        return {
          info,
          mode: 'scroll',
          zoom: 1,
          fit: true,
          thumb: 220,
          scrollTop: 0,
          scrollLeft: 0,
          selected: new Set(),
          anchor: null,
        };
      } catch (e) {
        toast(`Could not open ${path.split(/[\\/]/).pop()}: ${e}`, true);
        return null;
      } finally {
        opening.delete(norm);
      }
    }),
  );
  let first: DocState | null = null;
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

// ---------- search ----------

const searchPanel = $('search-panel');
const searchInput = $<HTMLInputElement>('search-input');
const searchResults = $('search-results');
const searchStatus = $('search-status');
let hits: Hit[] = [];
let curHit = -1;
let searchTimer = 0;
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
    viewer.setSearch('', new Set());
    $('viewer').focus();
  }
}

async function runSearch(keepCurrent = false) {
  const q = searchInput.value.trim();
  const scope = scopeAll() ? docs.map((d) => d.info.id) : active ? [active.info.id] : [];
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
  if (!active) return;
  const id = active.info.id;
  viewer.setSearch(lastQuery, new Set(hits.filter((h) => h.doc === id).map((h) => h.page)));
}

function renderResults() {
  searchResults.textContent = '';
  const frag = document.createDocumentFragment();
  let lastDoc = -1;
  const multi = new Set(hits.map((h) => h.doc)).size > 1 || scopeAll();
  hits.slice(0, MAX_ROWS).forEach((h, i) => {
    if (multi && h.doc !== lastDoc) {
      lastDoc = h.doc;
      const f = document.createElement('div');
      f.className = 'res-file';
      f.textContent = docs.find((d) => d.info.id === h.doc)?.info.name ?? '?';
      frag.appendChild(f);
    }
    const r = document.createElement('div');
    r.className = i === curHit ? 'res on' : 'res';
    r.dataset.i = String(i);
    const pg = document.createElement('span');
    pg.className = 'pg';
    pg.textContent = `p. ${h.page + 1}`;
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
  const d = docs.find((x) => x.info.id === h.doc);
  if (!d) return;
  activate(d);
  pushHighlights();
  // Index of this hit among hits on the same page = which match to emphasize.
  let index = 0;
  for (let k = curHit - 1; k >= 0 && hits[k].doc === h.doc && hits[k].page === h.page; k--) index++;
  viewer.jumpTo(h.page, index);
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

let progressTimer = 0;
listen<{ doc: number; done: number; total: number }>('index-progress', () => {
  if (!searchOpen()) return;
  clearTimeout(progressTimer);
  progressTimer = window.setTimeout(() => runSearch(true), 250);
});

// ---------- extract ----------

const dlg = $<HTMLDialogElement>('extract-dialog');
const rangeInput = $<HTMLInputElement>('extract-range');
const extractErr = $('extract-error');

function openExtract() {
  const d = active;
  if (!d) return;
  $('extract-doc').textContent = `${d.info.name} — ${d.info.pages.length} pages`;
  const sel = [...d.selected].sort((a, b) => a - b);
  rangeInput.value = sel.length ? formatRanges(sel) : String(viewer.currentPage() + 1);
  extractErr.textContent = '';
  dlg.showModal();
  rangeInput.focus();
  rangeInput.select();
}

$('extract-go').addEventListener('click', async (e) => {
  e.preventDefault();
  const d = active;
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
$('btn-zoom-in').onclick = () => viewer.zoomBy(1.25);
$('btn-zoom-out').onclick = () => viewer.zoomBy(0.8);
$('btn-fit').onclick = () => viewer.fitWidth();
$('btn-search').onclick = () => toggleSearch();
$('btn-extract').onclick = openExtract;
for (const b of $('view-modes').querySelectorAll<HTMLButtonElement>('button')) {
  b.onclick = () => {
    viewer.setMode(b.dataset.mode as Mode);
    updateToolbar();
    $('viewer').focus();
  };
}
pageInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !active) return;
  const n = parseInt(pageInput.value, 10);
  if (n >= 1 && n <= active.info.pages.length) viewer.scrollToPage(n - 1);
  $('viewer').focus();
});
pageInput.addEventListener('focus', () => pageInput.select());
pageInput.addEventListener('blur', () => (pageInput.value = active ? String(viewer.currentPage() + 1) : ''));

// ---------- keyboard ----------

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const inField = e.target instanceof HTMLInputElement;
  if (mod && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    openWithDialog();
  } else if (mod && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    if (active) closeDoc(active);
  } else if (mod && e.key === 'Tab') {
    e.preventDefault();
    if (docs.length && active) activate(docs[(docs.indexOf(active) + (e.shiftKey ? docs.length - 1 : 1)) % docs.length]);
  } else if (mod && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    toggleSearch(true);
  } else if (mod && e.key.toLowerCase() === 'e') {
    e.preventDefault();
    openExtract();
  } else if (mod && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    viewer.zoomBy(1.25);
  } else if (mod && e.key === '-') {
    e.preventDefault();
    viewer.zoomBy(0.8);
  } else if (mod && e.key === '0') {
    e.preventDefault();
    viewer.fitWidth();
  } else if (mod && e.key === '1') {
    e.preventDefault();
    viewer.setZoom(1);
  } else if (mod && e.key.toLowerCase() === 'a' && !inField && active?.mode === 'grid') {
    e.preventDefault();
    viewer.selectAll();
  } else if (e.key === 'F3') {
    e.preventDefault();
    gotoHit(e.shiftKey ? curHit - 1 : curHit + 1);
  } else if (e.key === 'Escape' && !inField && active?.selected.size) {
    active.selected.clear();
    viewer.refreshSelection();
  } else if (mod && e.shiftKey && e.altKey && e.key.toLowerCase() === 'k') {
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

updateToolbar();
api.initialFiles().then((files) => {
  if (files.length) openPaths(files);
});
