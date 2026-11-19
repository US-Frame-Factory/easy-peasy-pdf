// Page scales and length formatting for the Measure tool.
//
// A page scale is stored as real-world inches per PDF point (1 pt = 1/72 paper inch),
// per file and page, in localStorage (per machine).

export type NumberFormat = 'in1' | 'infrac' | 'ft2' | 'ftfrac' | 'ftin1' | 'ftinfrac';

export const FORMATS: { id: NumberFormat; example: string }[] = [
  { id: 'in1', example: '148.1in' },
  { id: 'infrac', example: '148⅛in' },
  { id: 'ft2', example: '12.34ft' },
  { id: 'ftfrac', example: '12⅜ft' },
  { id: 'ftin1', example: '12\'4.1"' },
  { id: 'ftinfrac', example: '12\'4⅛"' },
];

const EIGHTHS = ['', '⅛', '¼', '⅜', '½', '⅝', '¾', '⅞'];

/** Whole + eighths, rounded to the nearest 1/8. */
function eighths(v: number): [number, number] {
  let e = Math.round(v * 8);
  const whole = Math.floor(e / 8);
  e -= whole * 8;
  return [whole, e];
}

export function formatLength(inches: number, fmt: NumberFormat): string {
  const neg = inches < 0 ? '-' : '';
  const x = Math.abs(inches);
  switch (fmt) {
    case 'in1':
      return `${neg}${x.toFixed(1)}in`;
    case 'infrac': {
      const [w, e] = eighths(x);
      return `${neg}${w}${EIGHTHS[e]}in`;
    }
    case 'ft2':
      return `${neg}${(x / 12).toFixed(2)}ft`;
    case 'ftfrac': {
      const [w, e] = eighths(x / 12);
      return `${neg}${w}${EIGHTHS[e]}ft`;
    }
    case 'ftin1': {
      let ft = Math.floor(x / 12);
      let inch = Math.round((x - ft * 12) * 10) / 10;
      if (inch >= 12) {
        ft += 1;
        inch -= 12;
      }
      return `${neg}${ft}'${inch.toFixed(1)}"`;
    }
    case 'ftinfrac':
    default: {
      let ft = Math.floor(x / 12);
      let [w, e] = eighths(x - ft * 12);
      if (w >= 12) {
        ft += 1;
        w -= 12;
      }
      return `${neg}${ft}'${w}${EIGHTHS[e]}"`;
    }
  }
}

/**
 * Parses a typed length into inches: 17'6 1/2", 17' 6-1/2", 17'6.5", 17.5', 17.5 ft,
 * 210", 210 in, 5.2m, 520cm, 52mm, or a bare number (feet).
 */
export function parseLength(text: string): number | null {
  let t = text.trim().toLowerCase().replace(/[’′]/g, "'").replace(/[”″]/g, '"');
  if (!t) return null;
  for (const [g, f] of [['⅛', ' 1/8'], ['¼', ' 1/4'], ['⅜', ' 3/8'], ['½', ' 1/2'], ['⅝', ' 5/8'], ['¾', ' 3/4'], ['⅞', ' 7/8']]) {
    t = t.split(g).join(f);
  }
  const num = (s: string): number | null => {
    s = s.trim().replace(/-/g, ' ');
    if (!s) return 0;
    let total = 0;
    for (const part of s.split(/\s+/)) {
      const m = /^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(part);
      if (!m) return null;
      total += m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1]);
    }
    return total;
  };
  let m = /^(.*?)\s*(mm|cm|m)$/.exec(t);
  if (m) {
    const v = num(m[1]);
    if (v === null) return null;
    return (v * { mm: 1, cm: 10, m: 1000 }[m[2] as 'mm' | 'cm' | 'm']) / 25.4;
  }
  m = /^(?:(.*?)\s*(?:'|ft|feet|foot))?\s*(?:(.*?)\s*(?:"|in|inch|inches))?$/.exec(t);
  if (m && (m[1] !== undefined || m[2] !== undefined)) {
    const ft = m[1] !== undefined ? num(m[1]) : 0;
    const inch = m[2] !== undefined ? num(m[2]) : 0;
    if (ft === null || inch === null) return null;
    return ft * 12 + inch;
  }
  // 17'6 (inches without the ")
  m = /^(.*?)\s*'\s*(.+)$/.exec(t);
  if (m) {
    const ft = num(m[1]);
    const inch = num(m[2]);
    if (ft === null || inch === null) return null;
    return ft * 12 + inch;
  }
  const v = num(t);
  return v === null ? null : v * 12; // bare number = feet
}

/** Preset drawing scales: label -> real inches per PDF point. */
export const PRESETS: { label: string; inPerPt: number }[] = [
  ...(
    [
      ['1/16"', 1 / 16],
      ['3/32"', 3 / 32],
      ['1/8"', 1 / 8],
      ['3/16"', 3 / 16],
      ['1/4"', 1 / 4],
      ['3/8"', 3 / 8],
      ['1/2"', 1 / 2],
      ['3/4"', 3 / 4],
      ['1"', 1],
      ['1-1/2"', 1.5],
      ['3"', 3],
    ] as [string, number][]
  ).map(([l, paperIn]) => ({ label: `${l} = 1'-0"`, inPerPt: 12 / paperIn / 72 })),
  ...[10, 20, 30, 40, 50, 60, 100].map((ft) => ({ label: `1" = ${ft}'`, inPerPt: (ft * 12) / 72 })),
  { label: '1:1 (full size)', inPerPt: 1 / 72 },
];

export function scaleLabel(inPerPt: number): string {
  const p = PRESETS.find((x) => Math.abs(x.inPerPt - inPerPt) / x.inPerPt < 0.001);
  if (p) return p.label;
  // 1" paper = N real
  return `1" = ${formatLength(inPerPt * 72, 'ftinfrac')} (calibrated)`;
}

interface Stored {
  all?: number;
  pages?: Record<number, number>;
}

const key = (path: string) => `epp.scale:${path.toLowerCase()}`;

function load(path: string): Stored {
  const m = memo.get(key(path));
  if (m) return m;
  try {
    return JSON.parse(localStorage.getItem(key(path)) || '{}') as Stored;
  } catch {
    return {};
  }
}

export function getScale(path: string, page: number): number | null {
  const s = load(path);
  return s.pages?.[page] ?? s.all ?? null;
}

export function setScale(path: string, page: number | 'all', inPerPt: number) {
  const s = load(path);
  if (page === 'all') {
    s.all = inPerPt;
    s.pages = {};
  } else {
    s.pages = { ...(s.pages ?? {}), [page]: inPerPt };
  }
  try {
    localStorage.setItem(key(path), JSON.stringify(s));
  } catch {
    /* storage unavailable: scale lasts for this session only */
  }
  memo.set(key(path), s);
}

// Fallback when localStorage is unavailable.
const memo = new Map<string, Stored>();
