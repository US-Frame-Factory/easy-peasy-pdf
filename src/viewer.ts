// Virtualized page viewer: continuous scroll, two-up and thumbnail grid.
// Only pages near the viewport exist in the DOM; only visible tiles are requested.

import { api, DocInfo, Match, TILE, tileUrl } from './api';
import { loadInto } from './tiles';

export type Mode = 'scroll' | 'two' | 'grid';

export interface DocState {
  info: DocInfo;
  mode: Mode;
  zoom: number; // CSS px per PDF point (scroll / two-up)
  fit: boolean; // keep "fit width" on resize
  thumb: number; // grid cell size in CSS px
  scrollTop: number;
  scrollLeft: number;
  selected: Set<number>;
  anchor: number | null;
}

interface Slot {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Layer {
  scaleMilli: number;
  el: HTMLDivElement;
  tiles: Map<string, HTMLElement>;
  pending: number;
  complete: boolean;
}

interface PageView {
  page: number;
  el: HTMLDivElement;
  ph: HTMLImageElement;
  phState: 'idle' | 'loading' | 'done' | 'error';
  layers: Layer[];
  hls: HTMLDivElement | null;
  hlKey: string;
}

const GAP = 14;
const PAD = 16;
const LABEL_H = 22;
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 16;
const MAX_RENDER_SCALE = 16; // px per pt
const BUILD_MARGIN = 1.0; // keep page DOM within ±1 viewport
const DROP_MARGIN = 2.0;
const TILE_MARGIN = 256; // css px of prefetch around the viewport

export function placeholderScale(w: number, h: number): number {
  return Math.floor(Math.min(TILE / w, TILE / h) * 1000) / 1000;
}

/** zoom × dpr, rounded up to a √2 step so tiles are reused across small zoom changes. */
export function renderScaleMilli(zoom: number, dpr: number): number {
  const s = Math.min(zoom * dpr, MAX_RENDER_SCALE);
  const q = Math.pow(2, Math.ceil(Math.log2(s) * 2 - 0.01) / 2);
  return Math.round(Math.min(q, MAX_RENDER_SCALE) * 1000);
}

export interface ViewerEvents {
  onPageChange(page: number): void;
  onZoomChange(): void;
  onSelectionChange(): void;
  onOpenPage(page: number): void; // grid double-click
}

export class Viewer {
  doc: DocState | null = null;
  private slots: Slot[] = [];
  private contentW = 0;
  private contentH = 0;
  private views = new Map<number, PageView>();
  private raf = 0;
  private tileTimer = 0;
  private zooming = false;
  private dpr = window.devicePixelRatio || 1;

  // Search highlighting
  private query = '';
  private hitPages = new Set<number>();
  private current: { page: number; index: number } | null = null;
  private findCache = new Map<string, Promise<Match[]>>();
  private pendingJump: { page: number; index: number } | null = null;

  constructor(private scroller: HTMLElement, private content: HTMLElement, private ev: ViewerEvents) {
    scroller.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.onResize()).observe(scroller);
    scroller.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    content.addEventListener('click', (e) => this.onGridClick(e));
    content.addEventListener('dblclick', (e) => {
      const p = this.pageFromEvent(e);
      if (p !== null && this.doc?.mode === 'grid') this.ev.onOpenPage(p);
    });
  }

  // ---------- public API ----------

  show(doc: DocState | null) {
    if (this.doc) {
      this.doc.scrollTop = this.scroller.scrollTop;
      this.doc.scrollLeft = this.scroller.scrollLeft;
    }
    this.clearViews();
    this.findCache.clear();
    this.doc = doc;
    if (!doc) {
      this.content.style.width = this.content.style.height = '0px';
      return;
    }
    if (doc.fit) doc.zoom = this.fitWidthZoom(doc);
    this.relayout();
    this.scroller.scrollTop = doc.scrollTop;
    this.scroller.scrollLeft = doc.scrollLeft;
    this.update();
    this.ev.onZoomChange();
  }

  forget(id: number) {
    for (const k of [...this.findCache.keys()]) if (k.startsWith(`${id}:`)) this.findCache.delete(k);
  }

  setMode(mode: Mode) {
    const d = this.doc;
    if (!d || d.mode === mode) return;
    const page = this.currentPage();
    d.mode = mode;
    if (d.fit && mode !== 'grid') d.zoom = this.fitWidthZoom(d);
    this.clearViews();
    this.relayout();
    this.scrollToPage(page, 'start');
    this.ev.onZoomChange();
  }

  fitWidth() {
    const d = this.doc;
    if (!d) return;
    if (d.mode === 'grid') {
      d.thumb = 220;
      this.clearViews();
      this.relayout();
      this.update();
    } else {
      this.zoomAt(this.fitWidthZoom(d), null);
      d.fit = true;
    }
    this.ev.onZoomChange();
  }

  zoomBy(factor: number, clientX?: number, clientY?: number) {
    const d = this.doc;
    if (!d) return;
    const anchor = clientX === undefined ? null : { x: clientX, y: clientY! };
    if (d.mode === 'grid') {
      const t = Math.min(900, Math.max(80, d.thumb * factor));
      this.zoomAt(t, anchor);
    } else {
      this.zoomAt(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, d.zoom * factor)), anchor);
    }
  }

  setZoom(z: number) {
    if (this.doc && this.doc.mode !== 'grid') this.zoomAt(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)), null);
  }

  currentPage(): number {
    if (!this.doc || !this.slots.length) return 0;
    const mid = this.scroller.scrollTop + this.scroller.clientHeight / 2;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      const d = mid < s.y ? s.y - mid : mid > s.y + s.h ? mid - s.y - s.h : 0;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
      if (s.y > mid + this.scroller.clientHeight) break;
    }
    return best;
  }

  scrollToPage(page: number, align: 'start' | 'center' = 'start') {
    const s = this.slots[page];
    if (!s) return;
    const vh = this.scroller.clientHeight;
    const vw = this.scroller.clientWidth;
    this.scroller.scrollTop = align === 'start' ? s.y - PAD : s.y + s.h / 2 - vh / 2;
    if (s.x < this.scroller.scrollLeft || s.x + s.w > this.scroller.scrollLeft + vw) {
      this.scroller.scrollLeft = s.x + s.w / 2 - vw / 2;
    }
    this.update();
  }

  /** Search state: which pages have hits, and the "current" hit to emphasize. */
  setSearch(query: string, hitPages: Set<number>) {
    if (query !== this.query) this.findCache.clear();
    this.query = query;
    this.hitPages = hitPages;
    for (const v of this.views.values()) v.hlKey = '';
    this.update();
  }

  /** Jump to the `index`-th match on `page` and center it. */
  jumpTo(page: number, index: number) {
    if (!this.doc) return;
    if (this.doc.mode === 'grid') this.setMode('scroll');
    this.current = { page, index };
    this.pendingJump = { page, index };
    for (const v of this.views.values()) v.hlKey = '';
    this.scrollToPage(page, 'center');
    this.matchesFor(page).then((m) => {
      if (this.pendingJump?.page !== page || this.pendingJump.index !== index) return;
      this.pendingJump = null;
      const match = m[Math.min(index, m.length - 1)];
      const s = this.slots[page];
      if (!match || !s) return;
      const [pw, ph] = this.doc!.info.pages[page];
      const r = match[0];
      const cx = s.x + ((r[0] + r[2] / 2) / pw) * s.w;
      const cy = s.y + ((r[1] + r[3] / 2) / ph) * s.h;
      this.scroller.scrollTop = cy - this.scroller.clientHeight / 2;
      this.scroller.scrollLeft = cx - this.scroller.clientWidth / 2;
      this.update();
    });
  }

  selectAll() {
    const d = this.doc;
    if (!d) return;
    d.selected = new Set(d.info.pages.map((_, i) => i));
    this.refreshSelection();
  }

  refreshSelection() {
    for (const v of this.views.values()) v.el.classList.toggle('sel', !!this.doc?.selected.has(v.page));
    this.ev.onSelectionChange();
  }

  // ---------- layout ----------

  private fitWidthZoom(d: DocState): number {
    const avail = Math.max(100, this.scroller.clientWidth - 2 * PAD - 2);
    let maxW = 1;
    if (d.mode === 'two') {
      for (let i = 0; i < d.info.pages.length; i += 2) {
        const w = d.info.pages[i][0] + (d.info.pages[i + 1]?.[0] ?? 0);
        maxW = Math.max(maxW, w);
      }
      return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (avail - GAP) / maxW));
    }
    for (const [w] of d.info.pages) maxW = Math.max(maxW, w);
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, avail / maxW));
  }

  private relayout() {
    const d = this.doc;
    if (!d) return;
    const pages = d.info.pages;
    const vw = this.scroller.clientWidth;
    const slots: Slot[] = new Array(pages.length);
    if (d.mode === 'grid') {
      const cell = d.thumb;
      const cols = Math.max(1, Math.floor((vw - PAD) / (cell + GAP + 8)));
      const rowW = cols * (cell + GAP + 8) - GAP - 8;
      const x0 = Math.max(PAD, (vw - rowW) / 2);
      for (let i = 0; i < pages.length; i++) {
        const [w, h] = pages[i];
        const s = Math.min(cell / w, cell / h);
        const tw = w * s;
        const th = h * s;
        const col = i % cols;
        const row = Math.floor(i / cols);
        slots[i] = {
          x: x0 + col * (cell + GAP + 8) + (cell - tw) / 2,
          y: PAD + row * (cell + GAP + LABEL_H) + (cell - th),
          w: tw,
          h: th,
        };
      }
      const rows = Math.ceil(pages.length / cols);
      this.contentW = vw;
      this.contentH = PAD * 2 + rows * (cell + GAP + LABEL_H);
    } else {
      const z = d.zoom;
      const per = d.mode === 'two' ? 2 : 1;
      let maxRow = 0;
      const rows: { start: number; w: number; h: number }[] = [];
      for (let i = 0; i < pages.length; i += per) {
        let w = 0;
        let h = 0;
        for (let k = i; k < Math.min(i + per, pages.length); k++) {
          w += pages[k][0] * z + (k > i ? GAP : 0);
          h = Math.max(h, pages[k][1] * z);
        }
        rows.push({ start: i, w, h });
        maxRow = Math.max(maxRow, w);
      }
      this.contentW = Math.max(vw, maxRow + 2 * PAD);
      let y = PAD;
      for (const r of rows) {
        let x = (this.contentW - r.w) / 2;
        for (let k = r.start; k < Math.min(r.start + per, pages.length); k++) {
          const w = pages[k][0] * z;
          const h = pages[k][1] * z;
          slots[k] = { x, y: y + (r.h - h) / 2, w, h };
          x += w + GAP;
        }
        y += r.h + GAP;
      }
      this.contentH = y - GAP + PAD;
    }
    this.slots = slots;
    this.content.style.width = `${Math.ceil(this.contentW)}px`;
    this.content.style.height = `${Math.ceil(this.contentH)}px`;
    for (const v of this.views.values()) this.place(v);
  }

  private place(v: PageView) {
    const s = this.slots[v.page];
    const st = v.el.style;
    st.left = `${s.x}px`;
    st.top = `${s.y}px`;
    st.width = `${s.w}px`;
    st.height = `${s.h}px`;
  }

  private zoomAt(value: number, anchor: { x: number; y: number } | null) {
    const d = this.doc;
    if (!d) return;
    const rect = this.scroller.getBoundingClientRect();
    const ax = anchor ? anchor.x - rect.left : this.scroller.clientWidth / 2;
    const ay = anchor ? anchor.y - rect.top : this.scroller.clientHeight / 2;
    const cx = this.scroller.scrollLeft + ax;
    const cy = this.scroller.scrollTop + ay;
    // Find the page under the anchor (or nearest) and the relative position on it.
    let page = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      const dx = cx < s.x ? s.x - cx : cx > s.x + s.w ? cx - s.x - s.w : 0;
      const dy = cy < s.y ? s.y - cy : cy > s.y + s.h ? cy - s.y - s.h : 0;
      const dd = dx * dx + dy * dy;
      if (dd < bestD) {
        bestD = dd;
        page = i;
      }
    }
    const s0 = this.slots[page];
    const fx = s0 ? (cx - s0.x) / s0.w : 0;
    const fy = s0 ? (cy - s0.y) / s0.h : 0;

    if (d.mode === 'grid') {
      d.thumb = value;
      this.clearViews();
    } else {
      d.zoom = value;
      d.fit = false;
    }
    this.relayout();
    const s1 = this.slots[page];
    if (s1) {
      this.scroller.scrollLeft = s1.x + fx * s1.w - ax;
      this.scroller.scrollTop = s1.y + fy * s1.h - ay;
    }
    // While zooming, let the old tile layers stretch; request new tiles once it settles.
    this.zooming = true;
    clearTimeout(this.tileTimer);
    this.tileTimer = window.setTimeout(() => {
      this.zooming = false;
      this.update();
    }, 160);
    this.update();
    this.ev.onZoomChange();
  }

  private onResize() {
    const d = this.doc;
    if (!d) return;
    this.dpr = window.devicePixelRatio || 1;
    if (d.fit && d.mode !== 'grid') {
      const page = this.currentPage();
      d.zoom = this.fitWidthZoom(d);
      this.relayout();
      this.scrollToPage(page, 'start');
      this.ev.onZoomChange();
    } else {
      this.relayout();
      this.update();
    }
  }

  private onWheel(e: WheelEvent) {
    if (!e.ctrlKey || !this.doc) return;
    e.preventDefault();
    // Trackpad pinch arrives as ctrl+wheel with small deltas; mouse wheels with ±100ish.
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.zoomBy(Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.0022), e.clientX, e.clientY);
  }

  // ---------- grid selection ----------

  private pageFromEvent(e: MouseEvent): number | null {
    const el = (e.target as HTMLElement).closest('.page') as HTMLElement | null;
    return el ? Number(el.dataset.page) : null;
  }

  private onGridClick(e: MouseEvent) {
    const d = this.doc;
    if (!d || d.mode !== 'grid') return;
    const p = this.pageFromEvent(e);
    if (p === null) {
      if (!e.ctrlKey && !e.shiftKey) {
        d.selected.clear();
        this.refreshSelection();
      }
      return;
    }
    if (e.shiftKey && d.anchor !== null) {
      if (!e.ctrlKey) d.selected.clear();
      const [a, b] = d.anchor < p ? [d.anchor, p] : [p, d.anchor];
      for (let i = a; i <= b; i++) d.selected.add(i);
    } else if (e.ctrlKey || e.metaKey) {
      if (d.selected.has(p)) d.selected.delete(p);
      else d.selected.add(p);
      d.anchor = p;
    } else {
      d.selected = new Set([p]);
      d.anchor = p;
    }
    this.refreshSelection();
  }

  // ---------- rendering ----------

  schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.update());
  }

  private clearViews() {
    for (const v of this.views.values()) v.el.remove();
    this.views.clear();
  }

  update() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    const d = this.doc;
    if (!d) return;
    const top = this.scroller.scrollTop;
    const vh = this.scroller.clientHeight;
    const left = this.scroller.scrollLeft;
    const vw = this.scroller.clientWidth;
    const buildTop = top - vh * BUILD_MARGIN;
    const buildBot = top + vh * (1 + BUILD_MARGIN);
    const dropTop = top - vh * DROP_MARGIN;
    const dropBot = top + vh * (1 + DROP_MARGIN);

    for (const [p, v] of this.views) {
      const s = this.slots[p];
      if (!s || s.y + s.h < dropTop || s.y > dropBot) {
        v.el.remove();
        this.views.delete(p);
      }
    }
    const visible: number[] = [];
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.y > buildBot) break;
      if (s.y + s.h < buildTop) continue;
      if (!this.views.has(i)) this.build(i);
      if (s.y + s.h >= top && s.y <= top + vh && s.x + s.w >= left && s.x <= left + vw) visible.push(i);
    }
    // Tiles first, then placeholders: the backend's tile queue is LIFO, so the
    // placeholders (pushed last) render first.
    if (d.mode !== 'grid' && !this.zooming) {
      for (const p of visible) this.updateTiles(this.views.get(p)!, { top, left, vw, vh });
    }
    for (const p of visible) this.loadPlaceholder(this.views.get(p)!);
    for (const v of this.views.values()) if (!visible.includes(v.page)) this.loadPlaceholder(v);
    for (const p of visible) this.updateHighlights(this.views.get(p)!);
    this.ev.onPageChange(this.currentPage());
  }

  private build(page: number) {
    const d = this.doc!;
    const el = document.createElement('div');
    el.className = d.mode === 'grid' ? 'page grid' : 'page';
    el.dataset.page = String(page);
    if (d.mode === 'grid') {
      if (d.selected.has(page)) el.classList.add('sel');
      const lbl = document.createElement('div');
      lbl.className = 'lbl';
      lbl.textContent = String(page + 1);
      el.appendChild(lbl);
    }
    const ph = document.createElement('img');
    ph.className = 'ph';
    ph.draggable = false;
    ph.alt = '';
    el.appendChild(ph);
    const v: PageView = { page, el, ph, phState: 'idle', layers: [], hls: null, hlKey: '' };
    this.views.set(page, v);
    this.place(v);
    this.content.appendChild(el);
  }

  private loadPlaceholder(v: PageView) {
    if (v.phState !== 'idle') return;
    const d = this.doc!;
    const [w, h] = d.info.pages[v.page];
    v.phState = 'loading';
    const url = tileUrl(d.info.id, v.page, Math.round(placeholderScale(w, h) * 1000), 0, 0);
    loadInto(v.ph, url, () => v.el.isConnected, (msg) => {
      v.phState = 'error';
      this.errorTile(v.el, 0, 0, 100, 100, `Page ${v.page + 1} could not be rendered: ${msg}`);
    }).then((ok) => {
      if (ok) v.phState = 'done';
      else if (v.phState === 'loading') v.phState = 'idle';
    });
  }

  private errorTile(parent: HTMLElement, l: number, t: number, w: number, h: number, msg: string) {
    const e = document.createElement('div');
    e.className = 'err';
    e.style.cssText = `left:${l}%;top:${t}%;width:${w}%;height:${h}%`;
    e.title = msg;
    e.textContent = '⚠ render failed';
    parent.appendChild(e);
    return e;
  }

  private updateTiles(v: PageView, vp: { top: number; left: number; vw: number; vh: number }) {
    const d = this.doc!;
    const [pw, ph] = d.info.pages[v.page];
    const milli = renderScaleMilli(d.zoom, this.dpr);
    const scale = milli / 1000;
    if (scale <= placeholderScale(pw, ph) * 1.15) {
      // The placeholder is already sharp enough.
      for (const l of v.layers) l.el.remove();
      v.layers = [];
      return;
    }
    let layer = v.layers[v.layers.length - 1];
    if (!layer || layer.scaleMilli !== milli) {
      // Keep at most one older *complete* layer to stretch under the new one.
      const keep = [...v.layers].reverse().find((l) => l.complete);
      for (const l of v.layers) if (l !== keep) l.el.remove();
      const el = document.createElement('div');
      el.className = 'layer';
      v.el.insertBefore(el, v.hls);
      layer = { scaleMilli: milli, el, tiles: new Map(), pending: 0, complete: false };
      v.layers = keep ? [keep, layer] : [layer];
    }
    const W = Math.max(1, Math.round(pw * scale));
    const H = Math.max(1, Math.round(ph * scale));
    const s = this.slots[v.page];
    const k = W / s.w; // render px per css px
    const x0 = (vp.left - TILE_MARGIN - s.x) * k;
    const x1 = (vp.left + vp.vw + TILE_MARGIN - s.x) * k;
    const y0 = (vp.top - TILE_MARGIN - s.y) * k;
    const y1 = (vp.top + vp.vh + TILE_MARGIN - s.y) * k;
    const nx = Math.ceil(W / TILE);
    const ny = Math.ceil(H / TILE);
    const tx0 = Math.max(0, Math.floor(x0 / TILE));
    const tx1 = Math.min(nx - 1, Math.floor(x1 / TILE));
    const ty0 = Math.max(0, Math.floor(y0 / TILE));
    const ty1 = Math.min(ny - 1, Math.floor(y1 / TILE));

    // Drop far-away tiles of this layer (deep zoom on a huge sheet).
    const span = Math.max(tx1 - tx0, ty1 - ty0) + 2;
    for (const [key, img] of layer.tiles) {
      const [tx, ty] = key.split(',').map(Number);
      if (tx < tx0 - span || tx > tx1 + span || ty < ty0 - span || ty > ty1 + span) {
        img.remove();
        layer.tiles.delete(key);
      }
    }

    const L = layer;
    // Request tiles nearest the viewport center last (LIFO = rendered first).
    const want: [number, number, number][] = [];
    const cxT = (x0 + x1) / 2 / TILE;
    const cyT = (y0 + y1) / 2 / TILE;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (!L.tiles.has(`${tx},${ty}`)) want.push([tx, ty, (tx + 0.5 - cxT) ** 2 + (ty + 0.5 - cyT) ** 2]);
      }
    }
    want.sort((a, b) => b[2] - a[2]);
    for (const [tx, ty] of want) {
      const key = `${tx},${ty}`;
      const tw = Math.min(TILE, W - tx * TILE);
      const th = Math.min(TILE, H - ty * TILE);
      const l = (tx * TILE * 100) / W;
      const t = (ty * TILE * 100) / H;
      const wp = (tw * 100) / W;
      const hp = (th * 100) / H;
      const img = document.createElement('img');
      img.draggable = false;
      img.alt = '';
      // A hair of overlap hides seams between tiles at fractional positions.
      img.style.cssText = `left:${l}%;top:${t}%;width:calc(${wp}% + 0.6px);height:calc(${hp}% + 0.6px)`;
      img.style.visibility = 'hidden';
      L.el.appendChild(img);
      L.tiles.set(key, img);
      L.pending++;
      const url = tileUrl(d.info.id, v.page, milli, tx, ty);
      loadInto(img, url, () => img.isConnected, (msg) => {
        const e = this.errorTile(L.el, l, t, wp, hp, `Tile failed: ${msg}`);
        img.replaceWith(e);
        L.tiles.set(key, e);
      }).then((ok) => {
        if (ok) img.style.visibility = '';
        L.pending--;
        if (L.pending === 0 && !L.complete) {
          L.complete = true;
          // New layer is in: drop the stretched older ones underneath.
          if (v.layers[v.layers.length - 1] === L) {
            for (const o of v.layers) if (o !== L) o.el.remove();
            v.layers = [L];
          }
        }
      });
    }
  }

  // ---------- search highlights ----------

  private matchesFor(page: number): Promise<Match[]> {
    const d = this.doc!;
    const key = `${d.info.id}:${page}:${this.query}`;
    let p = this.findCache.get(key);
    if (!p) {
      p = api.find(d.info.id, page, this.query).catch(() => []);
      this.findCache.set(key, p);
    }
    return p;
  }

  private updateHighlights(v: PageView) {
    const d = this.doc!;
    const show = d.mode !== 'grid' && this.query !== '' && this.hitPages.has(v.page);
    const cur = this.current && this.current.page === v.page ? this.current.index : -1;
    const key = show ? `${this.query}|${cur}` : '';
    if (key === v.hlKey) return;
    v.hlKey = key;
    v.hls?.remove();
    v.hls = null;
    if (!show) return;
    const box = document.createElement('div');
    box.className = 'hls';
    v.hls = box;
    v.el.appendChild(box);
    const [pw, ph] = d.info.pages[v.page];
    this.matchesFor(v.page).then((matches) => {
      if (v.hls !== box) return;
      const curIdx = cur >= 0 ? Math.min(cur, matches.length - 1) : -1;
      matches.forEach((m, i) => {
        for (const [x, y, w, h] of m) {
          const e = document.createElement('div');
          e.className = i === curIdx ? 'hl cur' : 'hl';
          const padX = 1;
          const padY = h * 0.15;
          e.style.cssText = `left:${((x - padX) / pw) * 100}%;top:${((y - padY) / ph) * 100}%;width:${((w + 2 * padX) / pw) * 100}%;height:${((h + 2 * padY) / ph) * 100}%`;
          box.appendChild(e);
        }
      });
    });
  }
}
