// "Request a feature": sends the request to the feature_requests table in Supabase.
//
// The project URL and its public "anon" key are baked in at build time
// (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY). The anon key is meant to be public:
// the table's row-level security lets the app add requests but not read any back.
// Requests that can't be sent (offline) wait in an outbox and go out on a later start.

import { getVersion } from '@tauri-apps/api/app';

const BASE = String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
const KEY = String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? '');
const OUTBOX = 'qfp.featureOutbox';

export interface FeatureRequest {
  message: string;
  name: string | null;
  email: string | null;
  app_version: string;
  platform: string;
  created_at?: string;
}

export const feedbackConfigured = () => !!BASE && !!KEY;

/** Thrown when the request could not reach the server (kept in the outbox). */
export class OfflineError extends Error {}

async function post(rows: FeatureRequest[]): Promise<void> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  let res: Response;
  try {
    res = await fetch(`${BASE}/rest/v1/feature_requests`, {
      method: 'POST',
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(rows),
      signal: ctl.signal,
    });
  } catch (e) {
    throw new OfflineError(String(e));
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`the server said ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
}

function readOutbox(): FeatureRequest[] {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX) || '[]');
  } catch {
    return [];
  }
}

function writeOutbox(rows: FeatureRequest[]) {
  try {
    if (rows.length) localStorage.setItem(OUTBOX, JSON.stringify(rows.slice(-50)));
    else localStorage.removeItem(OUTBOX);
  } catch {
    /* ignore */
  }
}

export async function sendFeatureRequest(message: string, name: string, email: string): Promise<void> {
  if (!feedbackConfigured()) throw new Error('feature requests are not set up in this build');
  const row: FeatureRequest = {
    message: message.trim(),
    name: name.trim() || null,
    email: email.trim() || null,
    app_version: await getVersion().catch(() => 'unknown'),
    platform: navigator.userAgent.slice(0, 200),
    created_at: new Date().toISOString(),
  };
  try {
    await post([row]);
  } catch (e) {
    if (e instanceof OfflineError) writeOutbox([...readOutbox(), row]);
    throw e;
  }
}

/** Sends requests saved while offline. Quiet: failures just stay queued. */
export async function flushOutbox(): Promise<number> {
  const rows = readOutbox();
  if (!rows.length || !feedbackConfigured()) return 0;
  try {
    await post(rows);
    writeOutbox([]);
    return rows.length;
  } catch (e) {
    if (!(e instanceof OfflineError)) writeOutbox([]); // rejected by the server: don't retry forever
    return 0;
  }
}
