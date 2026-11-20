import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import type { DocMarks } from './markup';

export interface DocInfo {
  id: number;
  path: string;
  name: string;
  pages: [number, number][]; // page sizes in points (rotation applied)
  /** Sheet name per page (e.g. "S-208"), filled in as pages are indexed. Client-side. */
  labels?: (string | null)[];
  /** Unsaved markups. Client-side. */
  marks?: DocMarks;
}

export interface Hit {
  doc: number;
  page: number;
  before: string;
  hit: string;
  after: string;
}

export interface SearchResult {
  hits: Hit[];
  truncated: boolean;
  indexed: number;
  total: number;
}

/** Each match is one or more rects [x, y, w, h] in top-left-origin points. */
export type Match = [number, number, number, number][];

export const api = {
  openDoc: (path: string) => invoke<DocInfo>('open_doc', { path }),
  labels: (doc: number) => invoke<(string | null)[]>('labels', { doc }),
  closeDoc: (id: number) => invoke<void>('close_doc', { id }),
  search: (query: string, docs: number[]) => invoke<SearchResult>('search', { query, docs }),
  find: (doc: number, page: number, query: string) => invoke<Match[]>('find', { doc, page, query }),
  extract: (doc: number, pages: number[], dest: string) => invoke<number>('extract', { doc, pages, dest }),
  initialFiles: () => invoke<string[]>('initial_files'),
  selectText: (doc: number, page: number, rect: [number, number, number, number]) =>
    invoke<{ text: string; rects: [number, number, number, number][] }>('select_text', { doc, page, rect }),
  /** u32 LE width, u32 LE height, then RGBA. */
  renderRegion: (doc: number, page: number, scale: number, rect: [number, number, number, number]) =>
    invoke<ArrayBuffer>('render_region', { doc, page, scale, rect }),
  copyText: (text: string) => invoke<void>('copy_text', { text }),
  copyImage: (rgba: Uint8Array, w: number, h: number) =>
    invoke<void>('copy_image', rgba, { headers: { 'x-width': String(w), 'x-height': String(h) } }),
  /** Returns the path written. `dest` omitted = into the open file. */
  saveMarkups: (doc: number, markups: unknown[], dest?: string, labels?: string[], rotate?: [number, number][], edits?: TextEditReq[]) =>
    invoke<string>('save_markups', { doc, markups, dest, labels, rotate, edits }),
  textAt: (doc: number, page: number, x: number, y: number) => invoke<TextAt>('text_at', { doc, page, x, y }),
  sheetInfo: (doc: number) =>
    invoke<{ numbers: (string | null)[]; titles: (string | null)[]; labels: (string | null)[]; indexed: number; total: number }>('sheet_info', { doc }),
  crashAWorker: () => invoke<void>('crash_a_worker'),
};

export interface TextEditReq {
  page: number;
  index: number;
  orig: string;
  text: string;
}

export type TextAt =
  | { found: false; inForm?: boolean }
  | {
      found: true;
      index: number;
      text: string;
      quad: [[number, number], [number, number], [number, number], [number, number]];
      size: number;
      color: string;
      font: string;
      bold: boolean;
      italic: boolean;
      invisible: boolean;
    };

export const TILE = 512;

export function tileUrl(doc: number, page: number, scaleMilli: number, tx: number, ty: number): string {
  return convertFileSrc(`${doc}/${page}/${scaleMilli}/${tx}/${ty}`, 'tile');
}
