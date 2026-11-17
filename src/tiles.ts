// Fetches tiles from the `tile:` protocol with an in-memory LRU of blobs so
// scrolling back over a page doesn't re-render it. HTTP 503 = "stale" (the
// backend dropped it from its LIFO queue); the caller retries if still needed.

const MAX_BYTES = 384 * 1024 * 1024;

export class TileError extends Error {
  constructor(message: string, public stale: boolean) {
    super(message);
  }
}

const cache = new Map<string, Blob>();
let bytes = 0;
const inflight = new Map<string, Promise<Blob>>();

function remember(url: string, blob: Blob) {
  cache.set(url, blob);
  bytes += blob.size;
  while (bytes > MAX_BYTES && cache.size > 1) {
    const [k, v] = cache.entries().next().value as [string, Blob];
    cache.delete(k);
    bytes -= v.size;
  }
}

// Our own LIFO limiter: the webview caps concurrent requests per host and would
// otherwise queue them FIFO, so stale tiles from a fling would render first.
const MAX_INFLIGHT = 8;
let active = 0;
const waiting: { run: () => void; wanted: () => boolean; skip: () => void }[] = [];

function pump() {
  while (active < MAX_INFLIGHT && waiting.length) {
    const job = waiting.pop()!; // newest first
    if (!job.wanted()) {
      job.skip();
      continue;
    }
    active++;
    job.run();
  }
}

function limited(url: string, wanted: () => boolean): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    waiting.push({
      wanted,
      skip: () => reject(new TileError('abandoned', false)),
      run: () =>
        fetchTile(url)
          .then(resolve, reject)
          .finally(() => {
            active--;
            pump();
          }),
    });
    pump();
  });
}

export function fetchTile(url: string): Promise<Blob> {
  const hit = cache.get(url);
  if (hit) {
    cache.delete(url);
    cache.set(url, hit); // refresh LRU position
    return Promise.resolve(hit);
  }
  let p = inflight.get(url);
  if (!p) {
    p = fetch(url)
      .then(async (r) => {
        if (!r.ok) {
          const msg = await r.text().catch(() => r.statusText);
          throw new TileError(msg || `HTTP ${r.status}`, r.status === 503);
        }
        const b = await r.blob();
        remember(url, b);
        return b;
      })
      .finally(() => inflight.delete(url));
    inflight.set(url, p);
  }
  return p;
}

export function dropDocTiles(prefixTest: (url: string) => boolean) {
  for (const [k, v] of cache) {
    if (prefixTest(k)) {
      cache.delete(k);
      bytes -= v.size;
    }
  }
}

/**
 * Loads a tile into an <img>. Retries stale tiles while `stillWanted()` holds.
 * Resolves true on success, false if abandoned or failed (onError called on failure).
 */
export async function loadInto(
  img: HTMLImageElement,
  url: string,
  stillWanted: () => boolean,
  onError: (msg: string) => void,
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    if (!stillWanted()) return false;
    try {
      const blob = cache.has(url) ? await fetchTile(url) : await limited(url, stillWanted);
      if (!stillWanted()) return false;
      const obj = URL.createObjectURL(blob);
      img.src = obj;
      try {
        await img.decode();
      } catch {
        /* removed before decode; fine */
      }
      URL.revokeObjectURL(obj);
      return true;
    } catch (e) {
      if (e instanceof TileError && e.stale && attempt < 50) {
        await new Promise((r) => setTimeout(r, 30 + attempt * 20));
        continue;
      }
      if (stillWanted()) onError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }
}
