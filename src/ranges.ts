/** "1-3, 7" → [0, 1, 2, 6] (0-based, in the order typed, duplicates removed). */
export function parseRanges(text: string, pageCount: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const norm = text.replace(/\s*(?:-|–|—|\bto\b)\s*/gi, '-');
  const parts = norm.split(/[,;\s]+/).filter(Boolean);
  if (!parts.length) throw new Error('Type the pages to extract, e.g. 1-3, 7');
  for (const part of parts) {
    const m = /^(\d+)?-(\d+)?$/.exec(part) ?? /^(\d+)$/.exec(part);
    if (!m) throw new Error(`Not a page or range: "${part}"`);
    let a: number;
    let b: number;
    if (m.length === 2) {
      a = b = Number(m[1]);
    } else {
      a = m[1] ? Number(m[1]) : 1;
      b = m[2] ? Number(m[2]) : pageCount;
    }
    for (const n of [a, b]) {
      if (n < 1 || n > pageCount) throw new Error(`Page ${n} is out of range (1–${pageCount})`);
    }
    const step = a <= b ? 1 : -1;
    for (let p = a; ; p += step) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p - 1);
      }
      if (p === b) break;
    }
  }
  return out;
}

/** [0, 1, 2, 6] → "1-3, 7" */
export function formatRanges(pages: number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < pages.length) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    parts.push(j > i ? `${pages[i] + 1}-${pages[j] + 1}` : `${pages[i] + 1}`);
    i = j + 1;
  }
  return parts.join(', ');
}
