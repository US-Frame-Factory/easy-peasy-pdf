// "Request a feature": posts the request to the feedback endpoint (a small Vercel
// function in feedback-api/, which emails it). The endpoint URL is baked in at build
// time (VITE_FEEDBACK_URL); no keys or passwords are in the app.
// Requests that can't be sent (offline, server busy or down) wait in an outbox and go
// out on a later start.

import { getVersion } from '@tauri-apps/api/app';

const ENDPOINT = String(import.meta.env.VITE_FEEDBACK_URL ?? '').trim();
const OUTBOX = 'qfp.featureOutbox';

export interface FeatureRequest {
  message: string;
  name: string | null;
  email: string | null;
  app_version: string;
  platform: string;
  created_at?: string;
}

export const feedbackConfigured = () => /^https?:\/\//.test(ENDPOINT);

/** The request couldn't be delivered right now (kept in the outbox, retried later). */
export class OfflineError extends Error {}

async function post(row: FeatureRequest): Promise<void> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(row),
      signal: ctl.signal,
    });
  } catch (e) {
    throw new OfflineError(String(e));
  } finally {
    clearTimeout(timer);
  }
  if (res.ok) return;
  let why = '';
  try {
    why = (await res.json()).error ?? '';
  } catch {
    /* not JSON */
  }
  // Busy, rate-limited or temporarily down: keep it and try again later.
  if (res.status >= 500 || res.status === 429 || res.status === 408) throw new OfflineError(`${res.status} ${why}`);
  throw new Error(why || `the server said ${res.status}`);
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
    await post(row);
  } catch (e) {
    if (e instanceof OfflineError) writeOutbox([...readOutbox(), row]);
    throw e;
  }
}

/** Sends requests saved while offline. Quiet: failures just stay queued. */
export async function flushOutbox(): Promise<number> {
  const rows = readOutbox();
  if (!rows.length || !feedbackConfigured()) return 0;
  let sent = 0;
  const keep: FeatureRequest[] = [];
  for (const [i, row] of rows.entries()) {
    try {
      await post(row);
      sent++;
    } catch (e) {
      // Still can't deliver: keep this one and the rest for next time.
      // Rejected outright (bad request): drop it rather than retry forever.
      if (e instanceof OfflineError) {
        keep.push(...rows.slice(i));
        break;
      }
    }
  }
  writeOutbox(keep);
  return sent;
}
