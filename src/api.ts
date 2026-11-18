import { convertFileSrc, invoke } from '@tauri-apps/api/core';

export interface DocInfo {
  id: number;
  path: string;
  name: string;
  pages: [number, number][]; // page sizes in points (rotation applied)
  /** Sheet name per page (e.g. "S-208"), filled in as pages are indexed. Client-side. */
  labels?: (string | null)[];
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
  crashAWorker: () => invoke<void>('crash_a_worker'),
};

export const TILE = 512;

export function tileUrl(doc: number, page: number, scaleMilli: number, tx: number, ty: number): string {
  return convertFileSrc(`${doc}/${page}/${scaleMilli}/${tx}/${ty}`, 'tile');
}
