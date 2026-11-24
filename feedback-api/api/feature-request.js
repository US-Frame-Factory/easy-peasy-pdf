// Vercel function: POST /api/feature-request
// Body (JSON): { message, name?, email?, app_version?, platform? }
// Emails the request to FEEDBACK_TO via Resend (https://resend.com).
//
// Environment variables (Vercel > Project > Settings > Environment Variables):
//   RESEND_API_KEY  - Resend API key (secret)
//   FEEDBACK_TO     - where requests go, e.g. pdf@usframefactory.com
//   FEEDBACK_FROM   - sender, e.g. "Quick Fast PDF <feedback@usframefactory.com>"
//                     (a domain verified in Resend; defaults to Resend's test sender,
//                     which can only deliver to the Resend account's own email)

const LIMIT = { max: 5, windowMs: 10 * 60 * 1000 }; // per IP, per warm instance
const recent = new Map();

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const oneLine = (s) => s.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();

function tooMany(ip) {
  const now = Date.now();
  const list = (recent.get(ip) || []).filter((t) => now - t < LIMIT.windowMs);
  list.push(now);
  recent.set(ip, list);
  if (recent.size > 5000) recent.clear();
  return list.length > LIMIT.max;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = process.env.RESEND_API_KEY;
  const to = process.env.FEEDBACK_TO;
  if (!key || !to) return res.status(503).json({ error: 'feedback email is not configured' });

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: 'invalid JSON' });
    }
  }
  body = body && typeof body === 'object' ? body : {};
  const message = clip(body.message, 5000);
  const name = oneLine(clip(body.name, 200));
  const email = oneLine(clip(body.email, 200));
  const version = oneLine(clip(body.app_version, 50)) || 'unknown';
  const platform = oneLine(clip(body.platform, 200));
  if (message.length < 3) return res.status(400).json({ error: 'message is required' });
  const validEmail = /^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/.test(email);

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (tooMany(ip)) return res.status(429).json({ error: 'too many requests, try again later' });

  const subject = `Feature request: ${oneLine(message).slice(0, 70)}${oneLine(message).length > 70 ? '…' : ''}`;
  const text = [
    message,
    '',
    '---',
    `From: ${name || '(no name)'}${email ? ` <${email}>` : ''}`,
    `App version: ${version}`,
    `Computer: ${platform || 'unknown'}`,
    `Received: ${new Date().toISOString()}`,
    validEmail ? 'Reply to this email to answer them directly.' : '',
  ]
    .filter((l) => l !== '')
    .join('\n');

  const r = await fetch(process.env.RESEND_API_URL || 'https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.FEEDBACK_FROM || 'Quick Fast PDF <onboarding@resend.dev>',
      to: to.split(',').map((s) => s.trim()).filter(Boolean),
      subject,
      text,
      ...(validEmail ? { reply_to: email } : {}),
    }),
  }).catch((e) => ({ ok: false, status: 502, text: async () => String(e) }));

  if (!r.ok) {
    console.error('resend failed', r.status, await r.text().catch(() => ''));
    return res.status(502).json({ error: 'could not send the email, try again later' });
  }
  return res.status(200).json({ ok: true });
}
