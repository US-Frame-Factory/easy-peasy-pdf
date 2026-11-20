// Markups, measurement, text selection and snapshots.
//
// Markups live in memory per document (shared by both split panes) and are drawn
// as an SVG overlay on each page (viewBox = page size in points, so they scale
// with zoom for free). Ctrl+S writes them into the PDF as annotations.

import { api, DocInfo } from './api';
import { formatLength, getScale, NumberFormat } from './measure';
import type { Viewer } from './viewer';

export type Kind = 'pen' | 'highlight' | 'rect' | 'ellipse' | 'text' | 'callout' | 'measure';
export type Tool = 'pan' | 'select-text' | 'snapshot' | 'calibrate' | 'edit-text' | Kind;

export type FontName = 'helvetica' | 'times' | 'courier';

export interface Style {
  font: FontName;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string;
  textColor: string;
  width: number;
  size: number;
  opacity: number;
  format: NumberFormat;
}

export interface Markup {
  id: string;
  page: number;
  kind: Kind;
  pts: [number, number][];
  box?: [number, number, number, number];
  text: string;
  /** Measure: length in real inches. */
  value?: number;
  style: Style;
}

/** A pending change to the PDF's own text (written in place on save). */
export interface TextEditM {
  id: string;
  page: number;
  /** PDFium object index of the text on the page, and its text when picked. */
  index: number;
  orig: string;
  text: string;
  /** Corners in display points: bottom-left, bottom-right, top-right, top-left. */
  quad: [Pt, Pt, Pt, Pt];
  size: number;
  color: string;
  font: string;
  bold: boolean;
  italic: boolean;
}

export interface DocMarks {
  markups: Markup[];
  edits: TextEditM[];
  undo: string[];
  redo: string[];
  dirty: boolean;
}

type Pt = [number, number];

const SVGNS = 'http://www.w3.org/2000/svg';
const FAMILIES: Record<FontName, string> = {
  helvetica: 'Helvetica, Arial, sans-serif',
  times: "'Times New Roman', Times, serif",
  courier: "'Courier New', Courier, monospace",
};
const family = (s: Style) => FAMILIES[s.font] ?? FAMILIES.helvetica;
export const cssFont = (s: Style, size = s.size) => `${s.italic ? 'italic ' : ''}${s.bold ? 'bold ' : ''}${size}px ${family(s)}`;
const TEXT_BASE = { font: 'helvetica' as FontName, bold: false, italic: false, underline: false };

// Sized for full-size plan sheets (e.g. 36"x24"): readable at "fit width".
const DEFAULTS: Record<Kind, Omit<Style, keyof typeof TEXT_BASE>> = {
  pen: { color: '#ff0000', textColor: '#ff0000', width: 3, size: 28, opacity: 1, format: 'ftinfrac' },
  highlight: { color: '#ffe600', textColor: '#000000', width: 20, size: 28, opacity: 0.4, format: 'ftinfrac' },
  rect: { color: '#ff0000', textColor: '#ff0000', width: 3, size: 28, opacity: 1, format: 'ftinfrac' },
  ellipse: { color: '#ff0000', textColor: '#ff0000', width: 3, size: 28, opacity: 1, format: 'ftinfrac' },
  text: { color: '#ff0000', textColor: '#ff0000', width: 1.5, size: 28, opacity: 1, format: 'ftinfrac' },
  callout: { color: '#ff0000', textColor: '#ff0000', width: 1.5, size: 28, opacity: 1, format: 'ftinfrac' },
  measure: { color: '#ff0000', textColor: '#ff0000', width: 6, size: 40, opacity: 1, format: 'ftinfrac' },
};

export const KIND_NAMES: Record<Kind, string> = {
  pen: 'Pen',
  highlight: 'Highlighter',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  text: 'Text',
  callout: 'Callout',
  measure: 'Measure',
};

export const isKind = (t: string): t is Kind => t in DEFAULTS;

let seq = 0;
const newId = () => `epp-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function marksOf(info: DocInfo): DocMarks {
  const mk = (info.marks ??= { markups: [], edits: [], undo: [], redo: [], dirty: false });
  mk.edits ??= [];
  return mk;
}

/** Unsaved changes: markups plus text edits. */
export const pendingCount = (mk: DocMarks | undefined) => (mk ? mk.markups.length + (mk.edits?.length ?? 0) : 0);

const snap = (markups: Markup[], edits: TextEditM[]) => JSON.stringify({ markups, edits });

/** CSS font family resembling a PDF font name. */
function pdfFamily(name: string): string {
  const n = name.toLowerCase();
  if (/courier|mono|consol/.test(n)) return FAMILIES.courier;
  if (/times|roman|serif|georgia|garamond|cambria/.test(n) && !/sans/.test(n)) return FAMILIES.times;
  if (/narrow|condensed/.test(n)) return "'Arial Narrow', Arial, sans-serif";
  return 'Arial, Helvetica, sans-serif';
}

function editGeom(e: TextEditM) {
  const [p1, p2, , p4] = e.quad;
  const angle = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
  const height = Math.max(0.5, Math.hypot(p4[0] - p1[0], p4[1] - p1[1]));
  const width = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  const up: Pt = [(p4[0] - p1[0]) / height, (p4[1] - p1[1]) / height];
  // Bounds include the font's descent; the baseline sits about that far above the bottom.
  const desc = Math.min(height * 0.3, e.size * 0.21);
  const base: Pt = [p1[0] + up[0] * desc, p1[1] + up[1] * desc];
  return { angle, height, width, up, base };
}

/** Preview of a text edit: the old text whited out, the new text in its place. */
function drawTextEdit(g: SVGGElement, e: TextEditM, withText: boolean) {
  const { angle, up, base } = editGeom(e);
  const pad = 0.8;
  const [a, b] = [Math.cos(angle), Math.sin(angle)];
  const q = e.quad.map(([x, y], i) => {
    const sx = i === 0 || i === 3 ? -pad : pad; // along the baseline
    const sy = i >= 2 ? pad : -pad; // along "up"
    return [x + a * sx + up[0] * sy, y + b * sx + up[1] * sy];
  });
  el('polygon', { class: 'tedit-cover', points: q.map((p) => p.join(',')).join(' '), fill: '#ffffff' }, g);
  if (!withText || !e.text) return;
  const t = el('text', {
    x: 0,
    y: 0,
    transform: `translate(${base[0]} ${base[1]}) rotate(${(angle * 180) / Math.PI})`,
    'font-size': e.size,
    'font-family': pdfFamily(e.font),
    'font-weight': e.bold ? 'bold' : 'normal',
    'font-style': e.italic ? 'italic' : 'normal',
    fill: e.color,
  }, g);
  t.setAttribute('xml:space', 'preserve');
  t.textContent = e.text;
  el('polygon', { class: 'tedit-mark', points: q.map((p) => p.join(',')).join(' ') }, g);
}

function inQuad(e: TextEditM, p: Pt): boolean {
  const { angle, height, width } = editGeom(e);
  const [x, y] = [p[0] - e.quad[0][0], p[1] - e.quad[0][1]];
  const along = x * Math.cos(angle) + y * Math.sin(angle);
  const across = -(x * -Math.sin(angle) + y * Math.cos(angle)); // towards "up"
  return along >= -2 && along <= Math.max(width, 1) + 2 && across >= -2 && across <= height + 2;
}

// ---------- geometry ----------

function bbox(m: Markup): [number, number, number, number] {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of m.pts) {
    xs.push(x);
    ys.push(y);
  }
  if (m.box) {
    xs.push(m.box[0], m.box[0] + m.box[2]);
    ys.push(m.box[1], m.box[1] + m.box[3]);
  }
  const pad = m.style.width / 2 + (m.kind === 'measure' ? m.style.size + 6 : 0);
  return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Distance (pt) from p to the markup's drawn shape. */
function hitDist(m: Markup, p: Pt): number {
  const inBox = (b: [number, number, number, number]) =>
    p[0] >= b[0] && p[0] <= b[0] + b[2] && p[1] >= b[1] && p[1] <= b[1] + b[3];
  switch (m.kind) {
    case 'pen':
    case 'highlight': {
      let d = Infinity;
      for (let i = 1; i < m.pts.length; i++) d = Math.min(d, segDist(p, m.pts[i - 1], m.pts[i]));
      if (m.pts.length === 1) d = Math.hypot(p[0] - m.pts[0][0], p[1] - m.pts[0][1]);
      return Math.max(0, d - m.style.width / 2);
    }
    case 'measure': {
      const [a, b] = m.pts;
      const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      return Math.min(segDist(p, a, b) - m.style.width / 2, Math.hypot(p[0] - mid[0], p[1] - mid[1]) - m.style.size);
    }
    case 'text':
    case 'callout': {
      if (m.box && inBox(m.box)) return 0;
      if (m.kind === 'callout' && m.box && m.pts[0]) return segDist(p, m.pts[0], calloutFrom(m));
      return Infinity;
    }
    case 'rect':
    case 'ellipse': {
      const [x0, y0, x1, y1] = bbox(m);
      return p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1 ? 0 : Infinity;
    }
  }
}

function calloutFrom(m: Markup): Pt {
  const [x, y, w, h] = m.box!;
  const tip = m.pts[0];
  return [Math.max(x, Math.min(x + w, tip[0])), Math.max(y, Math.min(y + h, tip[1]))];
}

const measureCtx = document.createElement('canvas').getContext('2d')!;
function textWidth(s: string, style: Style): number {
  measureCtx.font = cssFont(style);
  return measureCtx.measureText(s).width;
}

/** Text box size that fits `text` (matches the saved layout in annotate.rs). */
function fitBox(text: string, style: Style): [number, number] {
  const size = style.size;
  const lines = (text || ' ').split('\n');
  const pad = size * 0.3;
  const w = Math.max(...lines.map((l) => textWidth(l, style))) + pad * 2 + size * 0.2;
  const h = pad * 2 + size * (0.9 + (lines.length - 1) * 1.2) + size * 0.3;
  return [Math.max(w, size * 2), h];
}

export function measureText(m: Markup): string {
  return m.value === undefined ? m.text : formatLength(m.value, m.style.format);
}

// ---------- SVG drawing ----------

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

function drawMarkup(g: SVGGElement, m: Markup) {
  const s = m.style;
  const stroke = { stroke: s.color, 'stroke-width': s.width, 'stroke-opacity': s.opacity, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const textAttrs = (x: number, y: number) => ({
    x,
    y,
    'font-size': s.size,
    'font-family': family(s),
    'font-weight': s.bold ? 'bold' : 'normal',
    'font-style': s.italic ? 'italic' : 'normal',
    'text-decoration': s.underline ? 'underline' : 'none',
    fill: s.textColor,
    'fill-opacity': s.opacity,
  });
  switch (m.kind) {
    case 'pen':
    case 'highlight':
      el('polyline', { points: m.pts.map((p) => p.join(',')).join(' '), ...stroke }, g);
      break;
    case 'rect': {
      const [[x0, y0], [x1, y1]] = m.pts;
      el('rect', { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0), ...stroke }, g);
      break;
    }
    case 'ellipse': {
      const [[x0, y0], [x1, y1]] = m.pts;
      el('ellipse', { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, rx: Math.abs(x1 - x0) / 2, ry: Math.abs(y1 - y0) / 2, ...stroke }, g);
      break;
    }
    case 'text':
    case 'callout': {
      const [x, y, w, h] = m.box!;
      if (m.kind === 'callout' && m.pts[0]) {
        const tip = m.pts[0];
        const from = calloutFrom(m);
        const len = Math.max(0.001, Math.hypot(tip[0] - from[0], tip[1] - from[1]));
        const [ux, uy] = [(tip[0] - from[0]) / len, (tip[1] - from[1]) / len];
        const ah = Math.min(s.width * 3 + 6, len * 0.8);
        const base: Pt = [tip[0] - ux * ah, tip[1] - uy * ah];
        el('line', { x1: from[0], y1: from[1], x2: base[0], y2: base[1], ...stroke }, g);
        const half = ah * 0.45;
        const tri = [tip, [base[0] - uy * half, base[1] + ux * half], [base[0] + uy * half, base[1] - ux * half]];
        el('polygon', { points: tri.map((p) => p.join(',')).join(' '), fill: s.color, 'fill-opacity': s.opacity }, g);
      }
      if (s.width > 0) el('rect', { x, y, width: w, height: h, ...stroke, fill: '#ffffff', 'fill-opacity': 0.0001 }, g);
      const pad = s.size * 0.3;
      m.text.split('\n').forEach((line, i) => {
        const t = el('text', textAttrs(x + pad, y + pad + s.size * (0.9 + i * 1.2)), g);
        t.setAttribute('xml:space', 'preserve');
        t.textContent = line;
      });
      break;
    }
    case 'measure': {
      const [a, b] = m.pts;
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const len = Math.max(0.001, Math.hypot(dx, dy));
      const [nx, ny] = [-dy / len, dx / len];
      const tick = Math.max(s.width * 2.5, 5);
      el('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], ...stroke, 'stroke-linecap': 'butt' }, g);
      for (const p of [a, b]) {
        el('line', { x1: p[0] - nx * tick, y1: p[1] - ny * tick, x2: p[0] + nx * tick, y2: p[1] + ny * tick, ...stroke, 'stroke-linecap': 'butt' }, g);
      }
      let ang = Math.atan2(dy, dx);
      if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
      const up: Pt = [Math.sin(ang), -Math.cos(ang)];
      const gap = Math.max(tick, s.width) + s.size * 0.25;
      const mx = (a[0] + b[0]) / 2 + up[0] * gap;
      const my = (a[1] + b[1]) / 2 + up[1] * gap;
      const t = el('text', { ...textAttrs(mx, my), 'text-anchor': 'middle', transform: `rotate(${(ang * 180) / Math.PI} ${mx} ${my})` }, g);
      t.textContent = measureText(m);
      break;
    }
  }
}

// ---------- controller ----------

interface Draft {
  tool: Tool;
  page: number;
  a: Pt;
  b: Pt;
  pts: Pt[];
  /** Click-click mode: first point placed, waiting for the second click. */
  awaiting?: boolean;
}

/** A dimension line with end bars (calibration line, measure preview). */
function drawCalibLine(svg: Element, a: Pt, b: Pt, pageW: number) {
  const len = Math.max(0.001, Math.hypot(b[0] - a[0], b[1] - a[1]));
  const [nx, ny] = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
  const t = Math.max(6, pageW * 0.004);
  el('line', { class: 'calib', x1: a[0], y1: a[1], x2: b[0], y2: b[1] }, svg);
  for (const p of [a, b]) el('line', { class: 'calib end', x1: p[0] - nx * t, y1: p[1] - ny * t, x2: p[0] + nx * t, y2: p[1] + ny * t }, svg);
}

interface Move {
  id: string;
  start: Pt;
  orig: string;
  moved: boolean;
}

export interface Hooks {
  toast(msg: string, err?: boolean): void;
  /** Markups of this doc changed (dirty flag / tab dot / toolbar). */
  changed(info: DocInfo): void;
  toolChanged(tool: Tool): void;
  /** Ask for a page scale (opens the scale dialog). Resolves with in/pt or null. */
  needScale(info: DocInfo, page: number): Promise<number | null>;
  /** A calibration line was drawn: ask for its real length. */
  calibrated(info: DocInfo, page: number, lengthPt: number): void;
  selectionChanged(): void;
}

interface Attached {
  viewer: Viewer;
  scroller: HTMLElement;
}

export class Markups {
  tool: Tool = 'pan';
  styles: Record<Kind, Style>;
  selected: { info: DocInfo; id: string } | null = null;
  textSel: { info: DocInfo; page: number; text: string; rects: [number, number, number, number][] } | null = null;
  private draft: Draft | null = null;
  private draftInfo: DocInfo | null = null;
  private move: Move | null = null;
  private attached: Attached[] = [];
  private editing: { info: DocInfo; id: string; ta: HTMLTextAreaElement; isNew: boolean } | null = null;
  /** Inline editor for the PDF's own text. */
  private tedit: { info: DocInfo; id: string; input: HTMLInputElement; isNew: boolean; before: string } | null = null;
  spaceDown = false;
  /** Last calibration line, shown while its length is being entered. */
  calib: { info: DocInfo; page: number; a: Pt; b: Pt } | null = null;

  clearCalib() {
    const c = this.calib;
    this.calib = null;
    if (c) this.refresh(c.info, c.page);
  }

  constructor(private hooks: Hooks) {
    let saved: Partial<Record<Kind, Style>> = {};
    try {
      saved = JSON.parse(localStorage.getItem('epp.styles') || '{}');
    } catch {
      /* ignore */
    }
    this.styles = Object.fromEntries(
      (Object.keys(DEFAULTS) as Kind[]).map((k) => [k, { ...TEXT_BASE, ...DEFAULTS[k], ...(saved[k] ?? {}) }]),
    ) as Record<Kind, Style>;
  }

  // ----- wiring -----

  attach(viewer: Viewer, scroller: HTMLElement) {
    this.attached.push({ viewer, scroller });
    viewer.leftDragPans = () => (this.tool === 'pan' && !this.move) || this.spaceDown;
    scroller.addEventListener('pointerdown', (e) => this.down(viewer, scroller, e), true);
    scroller.addEventListener('pointermove', (e) => this.moveEv(viewer, e));
    scroller.addEventListener('pointerup', (e) => this.up(viewer, scroller, e));
    scroller.addEventListener('pointercancel', () => this.cancelDraft());
    scroller.addEventListener('dblclick', (e) => this.dbl(viewer, e));
  }

  detach(viewer: Viewer) {
    this.attached = this.attached.filter((a) => a.viewer !== viewer);
  }

  /** Viewer created a page element: give it an overlay. */
  decorate(viewer: Viewer, page: number, pageEl: HTMLDivElement) {
    const info = viewer.doc?.info;
    if (!info) return;
    const [pw, ph] = info.pages[page];
    const svg = el('svg', { class: 'mk', viewBox: `0 0 ${pw} ${ph}`, preserveAspectRatio: 'none' });
    pageEl.appendChild(svg);
    this.drawPage(svg as SVGSVGElement, info, page);
  }

  /** Redraw a page (or every page) of a document in every pane showing it. */
  refresh(info: DocInfo, page?: number) {
    for (const { viewer } of this.attached) {
      if (viewer.doc?.info !== info) continue;
      for (const [p, pageEl] of viewer.pageElements()) {
        if (page !== undefined && p !== page) continue;
        const svg = pageEl.querySelector<SVGSVGElement>('svg.mk');
        if (svg) this.drawPage(svg, info, p);
      }
    }
  }

  private drawPage(svg: SVGSVGElement, info: DocInfo, page: number) {
    svg.textContent = '';
    for (const e of info.marks?.edits ?? []) {
      if (e.page === page) drawTextEdit(el('g', {}, svg) as SVGGElement, e, this.tedit?.id !== e.id);
    }
    const marks = info.marks?.markups ?? [];
    for (const m of marks) {
      if (m.page !== page) continue;
      if (this.editing?.id === m.id && (m.kind === 'text' || m.kind === 'callout')) {
        // Editor shows the text; still draw the leader of a callout.
        const g = el('g', {}, svg) as SVGGElement;
        drawMarkup(g, { ...m, text: '' });
        continue;
      }
      drawMarkup(el('g', {}, svg) as SVGGElement, m);
    }
    // Selection outline
    const sel = this.selected;
    if (sel && sel.info === info) {
      const m = marks.find((x) => x.id === sel.id && x.page === page);
      if (m) {
        const [x0, y0, x1, y1] = bbox(m);
        el('rect', { class: 'sel', x: x0 - 3, y: y0 - 3, width: x1 - x0 + 6, height: y1 - y0 + 6 }, svg);
      }
    }
    // Text selection
    const ts = this.textSel;
    if (ts && ts.info === info && ts.page === page) {
      for (const [x, y, w, h] of ts.rects) el('rect', { class: 'tsel', x, y, width: w, height: h }, svg);
    }
    // Calibration line being confirmed
    const c = this.calib;
    if (c && c.info === info && c.page === page && !(this.draft && this.draft.tool === 'calibrate')) drawCalibLine(svg, c.a, c.b, info.pages[page][0]);
    // Draft (in progress)
    const d = this.draft;
    if (d && this.draftInfo === info && d.page === page) this.drawDraft(svg, d);
  }

  private drawDraft(svg: SVGSVGElement, d: Draft) {
    const [ax, ay] = d.a;
    const [bx, by] = d.b;
    const rectAttrs = { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
    if (d.tool === 'select-text' || d.tool === 'snapshot') {
      el('rect', { class: d.tool === 'snapshot' ? 'marquee snap' : 'marquee', ...rectAttrs }, svg);
      return;
    }
    if (d.tool === 'calibrate') {
      drawCalibLine(svg, d.a, d.b, this.draftInfo!.pages[d.page][0]);
      return;
    }
    if (!isKind(d.tool)) return;
    const m = this.fromDraft(d, this.draftInfo!, true);
    if (m) drawMarkup(el('g', {}, svg) as SVGGElement, m);
  }

  // ----- tools & styles -----

  setTool(t: Tool) {
    this.cancelDraft();
    this.commitEdit();
    this.commitTextEdit();
    if (t !== 'select-text') this.clearTextSel();
    this.tool = t;
    this.hooks.toolChanged(t);
  }

  /** Style shown in the style panel: the selected markup's, else the tool's. */
  currentStyle(): { kind: Kind; style: Style } | null {
    const m = this.selectedMarkup();
    if (m) return { kind: m.kind, style: m.style };
    if (isKind(this.tool)) return { kind: this.tool, style: this.styles[this.tool] };
    return null;
  }

  setStyle(patch: Partial<Style>) {
    const m = this.selectedMarkup();
    if (m && this.selected) {
      this.record(this.selected.info);
      m.style = { ...m.style, ...patch };
      if (m.box && (m.kind === 'text' || m.kind === 'callout')) {
        const [w, h] = fitBox(m.text, m.style);
        m.box = [m.box[0], m.box[1], w, h];
      }
      this.changed(this.selected.info, m.page);
    }
    const kind = m?.kind ?? (isKind(this.tool) ? this.tool : null);
    if (kind) {
      this.styles[kind] = { ...this.styles[kind], ...patch };
      try {
        localStorage.setItem('epp.styles', JSON.stringify(this.styles));
      } catch {
        /* ignore */
      }
    }
  }

  selectedMarkup(): Markup | null {
    const s = this.selected;
    return s ? (marksOf(s.info).markups.find((m) => m.id === s.id) ?? null) : null;
  }

  // ----- editing model -----

  private record(info: DocInfo) {
    const mk = marksOf(info);
    mk.undo.push(snap(mk.markups, mk.edits));
    if (mk.undo.length > 200) mk.undo.shift();
    mk.redo = [];
  }

  private changed(info: DocInfo, page?: number) {
    marksOf(info).dirty = true;
    this.refresh(info, page);
    this.hooks.changed(info);
  }

  undo(info: DocInfo) {
    const mk = marksOf(info);
    const prev = mk.undo.pop();
    if (prev === undefined) return;
    mk.redo.push(snap(mk.markups, mk.edits));
    this.restore(mk, prev);
    this.selected = null;
    this.changed(info);
  }

  redo(info: DocInfo) {
    const mk = marksOf(info);
    const next = mk.redo.pop();
    if (next === undefined) return;
    mk.undo.push(snap(mk.markups, mk.edits));
    this.restore(mk, next);
    this.selected = null;
    this.changed(info);
  }

  private restore(mk: DocMarks, state: string) {
    const s = JSON.parse(state);
    mk.markups = s.markups;
    mk.edits = s.edits ?? [];
  }

  deleteSelected(): boolean {
    const s = this.selected;
    if (!s) return false;
    const mk = marksOf(s.info);
    const m = mk.markups.find((x) => x.id === s.id);
    if (!m) return false;
    this.record(s.info);
    mk.markups = mk.markups.filter((x) => x !== m);
    this.selected = null;
    this.changed(s.info, m.page);
    this.hooks.selectionChanged();
    return true;
  }

  private add(info: DocInfo, m: Markup) {
    this.record(info);
    marksOf(info).markups.push(m);
    this.changed(info, m.page);
  }

  /** After a successful save the markups are in the file itself. */
  clearSaved(info: DocInfo) {
    info.marks = { markups: [], edits: [], undo: [], redo: [], dirty: false };
    if (this.selected?.info === info) this.selected = null;
  }

  private select(info: DocInfo | null, id: string | null) {
    const prev = this.selected;
    this.selected = info && id ? { info, id } : null;
    if (prev) this.refresh(prev.info);
    if (info) this.refresh(info);
    this.hooks.selectionChanged();
  }

  clearTextSel() {
    const t = this.textSel;
    this.textSel = null;
    if (t) this.refresh(t.info, t.page);
  }

  cancelDraft() {
    const d = this.draft;
    const info = this.draftInfo;
    this.draft = null;
    this.draftInfo = null;
    if (d && info) this.refresh(info, d.page);
  }

  /** Escape: cancel what's in progress, then clear selection, then back to Pan. */
  escape() {
    if (this.tedit) return this.commitTextEdit(true);
    if (this.editing) return this.commitEdit();
    if (this.draft) return this.cancelDraft();
    if (this.textSel) return this.clearTextSel();
    if (this.selected) return this.select(null, null);
    if (this.tool !== 'pan') this.setTool('pan');
  }

  // ----- pointer handling -----

  private hitTest(info: DocInfo, page: number, p: Pt, tol: number): Markup | null {
    const marks = info.marks?.markups ?? [];
    for (let i = marks.length - 1; i >= 0; i--) {
      const m = marks[i];
      if (m.page === page && hitDist(m, p) <= tol) return m;
    }
    return null;
  }

  private down(viewer: Viewer, scroller: HTMLElement, e: PointerEvent) {
    const info = viewer.doc?.info;
    if (!info || viewer.doc?.mode === 'grid' || e.button !== 0 || e.pointerType === 'touch') return;
    if (this.spaceDown) return; // Space + drag pans with any tool
    const sr = scroller.getBoundingClientRect();
    if (e.clientX - sr.left >= scroller.clientWidth || e.clientY - sr.top >= scroller.clientHeight) return; // scrollbars
    if (this.editing && !(e.target as Element).closest?.('textarea.mk-edit')) this.commitEdit();
    if ((e.target as Element).closest?.('textarea.mk-edit')) return;
    if ((e.target as Element).closest?.('input.mk-tedit')) return;
    if (this.tedit) this.commitTextEdit();
    const at = viewer.pageAt(e.clientX, e.clientY);
    const tol = 6 / viewer.cssScale();

    if (this.tool === 'pan') {
      const hit = at ? this.hitTest(info, at.page, [at.x, at.y], tol) : null;
      if (!hit) {
        if (this.selected) this.select(null, null);
        return; // the viewer pans
      }
      e.preventDefault();
      e.stopPropagation();
      this.select(info, hit.id);
      this.move = { id: hit.id, start: [at!.x, at!.y], orig: JSON.stringify(hit), moved: false };
      scroller.setPointerCapture(e.pointerId);
      return;
    }

    const pending = this.draft;
    if (pending?.awaiting && this.draftInfo === info) {
      // Second click of a click-click line.
      e.preventDefault();
      e.stopPropagation();
      const at2 = viewer.pageAt(e.clientX, e.clientY, pending.page);
      if (at2) {
        const [pw, ph] = info.pages[pending.page];
        let p2: Pt = [Math.max(0, Math.min(pw, at2.x)), Math.max(0, Math.min(ph, at2.y))];
        if (e.shiftKey) p2 = this.constrain(pending, p2);
        pending.b = p2;
      }
      this.draft = null;
      this.draftInfo = null;
      this.finish(viewer, info, pending);
      return;
    }
    if (!at) return;
    e.preventDefault();
    e.stopPropagation();
    scroller.setPointerCapture(e.pointerId);
    scroller.focus({ preventScroll: true });
    const p: Pt = [at.x, at.y];

    if (this.tool === 'edit-text') {
      void this.pickText(viewer, info, at.page, p);
      return;
    }
    if (this.tool === 'text') {
      // Click to place a text box and type.
      this.startText(info, at.page, p, null);
      return;
    }
    if (this.tool !== 'select-text') this.clearTextSel();
    if (this.selected) this.select(null, null);
    this.draft = { tool: this.tool, page: at.page, a: p, b: p, pts: [p] };
    this.draftInfo = info;
    this.refresh(info, at.page);
  }

  private moveEv(viewer: Viewer, e: PointerEvent) {
    const info = viewer.doc?.info;
    if (!info) return;
    if (this.move && this.selected?.info === info) {
      const m = this.selectedMarkup();
      if (!m) return;
      const at = viewer.pageAt(e.clientX, e.clientY, m.page);
      if (!at) return;
      const orig = JSON.parse(this.move.orig) as Markup;
      const [dx, dy] = [at.x - this.move.start[0], at.y - this.move.start[1]];
      if (!this.move.moved && Math.hypot(dx, dy) * viewer.cssScale() < 3) return;
      if (!this.move.moved) this.record(info);
      this.move.moved = true;
      m.pts = orig.pts.map(([x, y]) => [x + dx, y + dy] as Pt);
      if (orig.box) m.box = [orig.box[0] + dx, orig.box[1] + dy, orig.box[2], orig.box[3]];
      this.changed(info, m.page);
      return;
    }
    const d = this.draft;
    if (!d || this.draftInfo !== info) return;
    const at = viewer.pageAt(e.clientX, e.clientY, d.page);
    if (!at) return;
    const [pw, ph] = info.pages[d.page];
    let p: Pt = [Math.max(0, Math.min(pw, at.x)), Math.max(0, Math.min(ph, at.y))];
    if (e.shiftKey) p = this.constrain(d, p);
    if (d.tool === 'pen' || d.tool === 'highlight') {
      const last = d.pts[d.pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) * viewer.cssScale() >= 2) d.pts.push(p);
    }
    d.b = p;
    this.refresh(info, d.page);
  }

  /** Shift: square / circle, or 0°/45°/90° lines. */
  private constrain(d: Draft, p: Pt): Pt {
    const [dx, dy] = [p[0] - d.a[0], p[1] - d.a[1]];
    if (d.tool === 'rect' || d.tool === 'ellipse' || d.tool === 'snapshot') {
      const s = Math.max(Math.abs(dx), Math.abs(dy));
      return [d.a[0] + Math.sign(dx || 1) * s, d.a[1] + Math.sign(dy || 1) * s];
    }
    if (d.tool === 'measure' || d.tool === 'calibrate' || d.tool === 'callout') {
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      return [d.a[0] + Math.cos(ang) * len, d.a[1] + Math.sin(ang) * len];
    }
    return p;
  }

  private async up(viewer: Viewer, scroller: HTMLElement, e: PointerEvent) {
    if (scroller.hasPointerCapture(e.pointerId)) scroller.releasePointerCapture(e.pointerId);
    if (this.move) {
      this.move = null;
      return;
    }
    const d = this.draft;
    const info = this.draftInfo;
    if (!d || !info || viewer.doc?.info !== info || d.awaiting) return;
    const clickOnly = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) * viewer.cssScale() < 4;
    if (clickOnly && (d.tool === 'measure' || d.tool === 'calibrate')) {
      // A click (no drag) starts a click-click line: the next click sets the other end.
      d.awaiting = true;
      this.hooks.toast(d.tool === 'measure' ? 'Click the second point (Esc to cancel)' : 'Click the other end of the known dimension');
      return;
    }
    this.draft = null;
    this.draftInfo = null;
    await this.finish(viewer, info, d);
  }

  private async finish(viewer: Viewer, info: DocInfo, d: Draft) {
    const sizePx = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) * viewer.cssScale();
    switch (d.tool) {
      case 'select-text': {
        this.refresh(info, d.page);
        if (sizePx < 4) return this.clearTextSel();
        try {
          const r = await api.selectText(info.id, d.page, [d.a[0], d.a[1], d.b[0], d.b[1]]);
          this.textSel = { info, page: d.page, text: r.text, rects: r.rects };
          this.refresh(info, d.page);
          this.hooks.toast(r.text.trim() ? 'Text selected: Ctrl+C to copy' : 'No text there');
          this.hooks.selectionChanged();
        } catch (err) {
          this.hooks.toast(`Text selection failed: ${err}`, true);
        }
        return;
      }
      case 'snapshot': {
        this.refresh(info, d.page);
        if (sizePx < 4) return;
        const x = Math.min(d.a[0], d.b[0]);
        const y = Math.min(d.a[1], d.b[1]);
        await this.snapshot(viewer, info, d.page, [x, y, Math.abs(d.b[0] - d.a[0]), Math.abs(d.b[1] - d.a[1])]);
        return;
      }
      case 'calibrate': {
        if (sizePx < 6) {
          this.refresh(info, d.page);
          return this.hooks.toast('Click both ends of a known dimension.');
        }
        this.calib = { info, page: d.page, a: d.a, b: d.b };
        this.refresh(info, d.page);
        this.hooks.calibrated(info, d.page, Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]));
        return;
      }
      case 'callout': {
        this.refresh(info, d.page);
        const tip = d.a;
        const at = sizePx < 6 ? ([d.a[0] + 40, d.a[1] - 30] as Pt) : d.b;
        this.startText(info, d.page, at, tip);
        return;
      }
    }
    if (!isKind(d.tool)) return;
    if ((d.tool === 'pen' || d.tool === 'highlight') && d.pts.length < 2) d.pts.push([d.a[0] + 0.5, d.a[1]]);
    else if (d.tool !== 'pen' && d.tool !== 'highlight' && sizePx < 4) {
      this.refresh(info, d.page);
      return;
    }
    if (d.tool === 'measure' && getScale(info.path, d.page) === null) {
      this.refresh(info, d.page);
      const s = await this.hooks.needScale(info, d.page);
      if (s === null) return;
    }
    const m = this.fromDraft(d, info, false);
    if (m) {
      this.add(info, m);
      this.select(info, m.id);
    }
  }

  private fromDraft(d: Draft, info: DocInfo, preview: boolean): Markup | null {
    if (!isKind(d.tool)) return null;
    const style = { ...this.styles[d.tool] };
    const base = { id: preview ? 'draft' : newId(), page: d.page, kind: d.tool, text: '', style };
    switch (d.tool) {
      case 'pen':
      case 'highlight':
        return { ...base, pts: d.pts.slice() };
      case 'rect':
      case 'ellipse':
        return { ...base, pts: [d.a, d.b] };
      case 'measure': {
        const s = getScale(info.path, d.page);
        const lenPt = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]);
        const value = s === null ? undefined : lenPt * s;
        return { ...base, pts: [d.a, d.b], value, text: s === null ? 'set scale' : formatLength(value!, style.format) };
      }
      default:
        return null;
    }
  }

  private dbl(viewer: Viewer, e: MouseEvent) {
    const info = viewer.doc?.info;
    if (!info || this.tool !== 'pan') return;
    const at = viewer.pageAt(e.clientX, e.clientY);
    if (!at) return;
    const hit = this.hitTest(info, at.page, [at.x, at.y], 6 / viewer.cssScale());
    if (hit && (hit.kind === 'text' || hit.kind === 'callout')) {
      e.preventDefault();
      this.openEditor(viewer, info, hit, false);
    }
  }

  // ----- text boxes -----

  private startText(info: DocInfo, page: number, at: Pt, tip: Pt | null) {
    const kind: Kind = tip ? 'callout' : 'text';
    const style = { ...this.styles[kind] };
    const [w, h] = fitBox('', style);
    const box: [number, number, number, number] = tip ? [at[0], at[1] - h / 2, w, h] : [at[0], at[1], w, h];
    const m: Markup = { id: newId(), page, kind, pts: tip ? [tip] : [], box, text: '', style };
    // Not recorded yet: an empty box is dropped when editing ends.
    marksOf(info).markups.push(m);
    const viewer = this.attached.find((a) => a.viewer.doc?.info === info)?.viewer;
    if (viewer) this.openEditor(viewer, info, m, true);
  }

  private openEditor(viewer: Viewer, info: DocInfo, m: Markup, isNew: boolean) {
    this.commitEdit();
    const pageEl = viewer.pageElements().find(([p]) => p === m.page)?.[1];
    if (!pageEl || !m.box) return;
    const [pw, ph] = info.pages[m.page];
    const ta = document.createElement('textarea');
    ta.className = 'mk-edit';
    ta.value = m.text;
    ta.spellcheck = false;
    const k = viewer.cssScale();
    const place = () => {
      const [x, y] = m.box!;
      const [w, h] = fitBox(ta.value, m.style);
      m.box = [x, y, w, h];
      Object.assign(ta.style, {
        left: `${(x / pw) * 100}%`,
        top: `${(y / ph) * 100}%`,
        width: `${(w + m.style.size) * k}px`,
        height: `${h * k}px`,
        fontSize: `${m.style.size * k}px`,
        fontFamily: family(m.style),
        fontWeight: m.style.bold ? 'bold' : 'normal',
        fontStyle: m.style.italic ? 'italic' : 'normal',
        textDecoration: m.style.underline ? 'underline' : 'none',
        lineHeight: `${m.style.size * 1.2 * k}px`,
        padding: `${m.style.size * 0.3 * k}px`,
        color: m.style.textColor,
        borderColor: m.style.color,
      });
    };
    place();
    ta.addEventListener('input', () => {
      place();
      this.refresh(info, m.page);
    });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing must not trigger shortcuts
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        this.commitEdit();
      }
    });
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    ta.addEventListener('blur', () => setTimeout(() => this.editing?.ta === ta && this.commitEdit(), 0));
    pageEl.appendChild(ta);
    this.editing = { info, id: m.id, ta, isNew };
    if (!isNew) this.record(info);
    this.select(info, m.id);
    requestAnimationFrame(() => ta.focus());
  }

  commitEdit() {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    ed.ta.remove();
    const mk = marksOf(ed.info);
    const m = mk.markups.find((x) => x.id === ed.id);
    if (!m) return;
    const text = ed.ta.value.replace(/\s+$/, '');
    if (!text) {
      mk.markups = mk.markups.filter((x) => x !== m);
      if (!ed.isNew) mk.dirty = true;
      this.selected = null;
      this.refresh(ed.info, m.page);
      this.hooks.changed(ed.info);
      return;
    }
    if (ed.isNew) {
      // Record the state without the new box, so one undo removes it.
      mk.undo.push(snap(mk.markups.filter((x) => x !== m), mk.edits));
      mk.redo = [];
    }
    m.text = text;
    const [w, h] = fitBox(text, m.style);
    m.box = [m.box![0], m.box![1], w, h];
    this.changed(ed.info, m.page);
  }

  // ----- editing the PDF's own text -----

  private async pickText(viewer: Viewer, info: DocInfo, page: number, p: Pt) {
    const mk = marksOf(info);
    const existing = mk.edits.find((e) => e.page === page && inQuad(e, p));
    if (existing) return this.openTextEdit(viewer, info, existing, false);
    let r;
    try {
      r = await api.textAt(info.id, page, p[0], p[1]);
    } catch (err) {
      return this.hooks.toast(`Could not read the text there: ${err}`, true);
    }
    if (!r.found) {
      return this.hooks.toast(
        r.inForm ? "That text is inside a grouped block (like a title block or symbol) and can't be edited here." : 'No text there. Click on a word to edit it.',
        !!r.inForm,
      );
    }
    if (r.invisible) return this.hooks.toast("That's hidden (OCR) text behind a scanned image; it can't be edited visibly.", true);
    const dup = mk.edits.find((e) => e.page === page && e.index === r.index);
    if (dup) return this.openTextEdit(viewer, info, dup, false);
    const ed: TextEditM = {
      id: newId(),
      page,
      index: r.index,
      orig: r.text,
      text: r.text.replace(/\s+$/, ''),
      quad: r.quad,
      size: r.size,
      color: r.color,
      font: r.font,
      bold: r.bold,
      italic: r.italic,
    };
    this.openTextEdit(viewer, info, ed, true);
  }

  private openTextEdit(viewer: Viewer, info: DocInfo, ed: TextEditM, isNew: boolean) {
    this.commitEdit();
    this.commitTextEdit();
    const pageEl = viewer.pageElements().find(([p]) => p === ed.page)?.[1];
    if (!pageEl) return;
    const [pw, ph] = info.pages[ed.page];
    const { angle, height, width } = editGeom(ed);
    const k = viewer.cssScale();
    const input = document.createElement('input');
    input.className = 'mk-tedit';
    input.value = ed.text;
    input.spellcheck = false;
    const font = `${ed.italic ? 'italic ' : ''}${ed.bold ? 'bold ' : ''}${ed.size * k}px ${pdfFamily(ed.font)}`;
    const fit = () => {
      measureCtx.font = font;
      input.style.width = `${Math.max(width * k, measureCtx.measureText(input.value || ' ').width) + 24}px`;
    };
    const tl = ed.quad[3];
    Object.assign(input.style, {
      left: `${(tl[0] / pw) * 100}%`,
      top: `${(tl[1] / ph) * 100}%`,
      height: `${Math.max(height * k, ed.size * k * 1.15) + 6}px`,
      font,
      color: ed.color,
      transform: `rotate(${(angle * 180) / Math.PI}deg)`,
    });
    fit();
    input.addEventListener('input', fit);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commitTextEdit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.commitTextEdit(true);
      }
    });
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    input.addEventListener('blur', () => setTimeout(() => this.tedit?.input === input && this.commitTextEdit(), 0));
    pageEl.appendChild(input);
    const mk = marksOf(info);
    if (isNew) mk.edits.push(ed);
    this.tedit = { info, id: ed.id, input, isNew, before: snap(mk.markups, mk.edits.filter((x) => !isNew || x !== ed)) };
    this.refresh(info, ed.page);
    if (isNew) this.hooks.toast('Edit the text, Enter to keep it (Esc cancels). It is written into the PDF when you save. Clear it to delete the text.');
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }

  /** Ends inline text editing; `cancel` drops this round of changes. */
  commitTextEdit(cancel = false) {
    const t = this.tedit;
    if (!t) return;
    this.tedit = null;
    t.input.remove();
    const mk = marksOf(t.info);
    const ed = mk.edits.find((x) => x.id === t.id);
    if (!ed) return;
    const text = t.input.value.replace(/\s+$/, '');
    const unchanged = text === ed.text;
    if (cancel || (unchanged && !t.isNew)) {
      if (t.isNew) mk.edits = mk.edits.filter((x) => x !== ed);
      this.refresh(t.info, ed.page);
      return;
    }
    if (text === ed.orig.replace(/\s+$/, '')) {
      // Back to the original: nothing to change.
      mk.edits = mk.edits.filter((x) => x !== ed);
      if (t.isNew) return this.refresh(t.info, ed.page);
    } else {
      ed.text = text;
    }
    mk.undo.push(t.before);
    if (mk.undo.length > 200) mk.undo.shift();
    mk.redo = [];
    this.changed(t.info, ed.page);
    if (!text) this.hooks.toast('The text will be removed when you save.');
  }

  // ----- snapshot & copy -----

  async copySelection(): Promise<boolean> {
    const t = this.textSel;
    if (!t || !t.text.trim()) return false;
    try {
      await api.copyText(t.text.replace(/\r\n/g, '\n'));
      this.hooks.toast('Copied text');
    } catch (err) {
      this.hooks.toast(`Copy failed: ${err}`, true);
    }
    return true;
  }

  private async snapshot(viewer: Viewer, info: DocInfo, page: number, r: [number, number, number, number]) {
    let scale = Math.max(2, Math.min(8, viewer.cssScale() * (window.devicePixelRatio || 1)));
    while (r[2] * scale * r[3] * scale > 30e6) scale *= 0.85;
    this.hooks.toast('Copying snapshot…');
    try {
      const buf = await api.renderRegion(info.id, page, scale, r);
      const dv = new DataView(buf);
      const w = dv.getUint32(0, true);
      const h = dv.getUint32(4, true);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(buf, 8, w * h * 4), w, h), 0, 0);
      // Unsaved markups on top.
      const marks = (info.marks?.markups ?? []).filter((m) => m.page === page);
      if (marks.length) {
        const svg = el('svg', { xmlns: SVGNS, width: w, height: h, viewBox: `${r[0]} ${r[1]} ${r[2]} ${r[3]}`, preserveAspectRatio: 'none' });
        for (const m of marks) drawMarkup(el('g', {}, svg) as SVGGElement, m);
        const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
        try {
          const img = new Image();
          img.src = url;
          await img.decode();
          ctx.drawImage(img, 0, 0, w, h);
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      const rgba = ctx.getImageData(0, 0, w, h).data;
      await api.copyImage(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), w, h);
      this.hooks.toast(`Snapshot copied (${w}×${h}) — paste it into an email, Teams, Word…`);
    } catch (err) {
      this.hooks.toast(`Snapshot failed: ${err}`, true);
    }
  }
}
