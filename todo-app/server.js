// مهامي — static host + Web Push reminder server.
//
//   npm install && npm start      -> http://localhost:8080
//
// Env vars (all optional):
//   PORT                 default 8080
//   DATA_DIR             where db.json / vapid.json live (default ./data) — put it on a persistent disk
//   VAPID_PUBLIC_KEY     \ generate once with: npx web-push generate-vapid-keys
//   VAPID_PRIVATE_KEY    /  (if unset, keys are generated and saved in DATA_DIR/vapid.json)
//   VAPID_SUBJECT        mailto:you@yourdomain.com  (Apple requires a real contact)
//   CORS_ORIGIN          allowed origin when the website is hosted elsewhere (default *)
//   TICK_MS              scheduler interval (default 15000)

import http from 'node:http';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const TICK_MS = Number(process.env.TICK_MS) || 15_000;
const RECOGNIZE_URL = process.env.RECOGNIZE_URL
  || 'https://inputtools.google.com/request?ime=handwriting&app=mobilesearch&cs=1&oe=UTF-8';
// Only ever send pushes to real push services (prevents using the server as an open proxy).
const PUSH_HOSTS = (process.env.PUSH_HOSTS
  || 'fcm.googleapis.com,android.googleapis.com,push.services.mozilla.com,push.apple.com,notify.windows.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// How late a reminder may still be delivered (e.g. after a server restart).
const LATE = { day: 6 * HOUR, hour: 30 * MIN, due: 30 * MIN };

/* ---------------- Storage ---------------- */

let db = { devices: {} };
let saving = Promise.resolve();
let saveTimer = null;

async function loadDb() {
  try {
    const parsed = JSON.parse(await readFile(DB_FILE, 'utf8'));
    db = { devices: parsed.devices || {} };
  } catch {
    db = { devices: {} };
  }
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saving = saving.then(async () => {
      await mkdir(DATA_DIR, { recursive: true });
      const tmp = `${DB_FILE}.tmp`;
      await writeFile(tmp, JSON.stringify(db));
      await rename(tmp, DB_FILE);
    }).catch((e) => console.error('[mahami] save failed', e));
  }, 300);
}

async function loadVapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  try {
    return JSON.parse(await readFile(VAPID_FILE, 'utf8'));
  } catch { /* generate below */ }
  const keys = webpush.generateVAPIDKeys();
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(VAPID_FILE, JSON.stringify(keys, null, 2));
  console.warn(`[mahami] Generated new VAPID keys in ${VAPID_FILE}.`);
  console.warn('[mahami] In production set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY so subscriptions survive redeploys.');
  return keys;
}

/* ---------------- Validation ---------------- */

const httpError = (status, message) => Object.assign(new Error(message), { status });

function checkDeviceId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw httpError(400, 'bad deviceId');
  return id;
}

function checkSubscription(sub) {
  if (!sub || typeof sub !== 'object' || typeof sub.endpoint !== 'string' || sub.endpoint.length > 2048) {
    throw httpError(400, 'bad subscription');
  }
  let url;
  try { url = new URL(sub.endpoint); } catch { throw httpError(400, 'bad endpoint'); }
  const okProto = url.protocol === 'https:';
  const okHost = PUSH_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
  if (!okProto || !okHost) throw httpError(400, 'unsupported push service');
  const { p256dh, auth } = sub.keys || {};
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 100) {
    throw httpError(400, 'bad keys');
  }
  return { endpoint: sub.endpoint, keys: { p256dh, auth } };
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function cleanReminders(list, now) {
  if (!Array.isArray(list)) throw httpError(400, 'reminders must be an array');
  return list.slice(0, 500).flatMap((r) => {
    if (!r || typeof r !== 'object') return [];
    const at = Number(r.at);
    if (!Number.isFinite(at) || at < now - DAY || at > now + 400 * DAY) return [];
    const kind = ['day', 'hour', 'due'].includes(r.kind) ? r.kind : 'hour';
    const id = str(r.id, 160);
    if (!id) return [];
    return [{ id, taskId: str(r.taskId, 64), kind, at, title: str(r.title, 240) || 'مهامي', body: str(r.body, 300) }];
  });
}

/* ---------------- Push ---------------- */

async function sendPush(deviceId, payload, ttlMs = HOUR) {
  const dev = db.devices[deviceId];
  if (!dev?.subscription) return false;
  try {
    await webpush.sendNotification(dev.subscription, JSON.stringify(payload), {
      TTL: Math.max(60, Math.round(ttlMs / 1000)),
      urgency: 'high',
    });
    return true;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      // Subscription expired / user revoked permission.
      delete db.devices[deviceId];
      saveSoon();
    } else {
      console.warn(`[mahami] push failed (${err.statusCode || err.code || err.message})`);
    }
    return false;
  }
}

let running = false;

async function runScheduler(now = Date.now()) {
  if (running) return 0;
  running = true;
  let sent = 0;
  let changed = false;
  try {
    const jobs = [];
    for (const [deviceId, dev] of Object.entries(db.devices)) {
      for (const r of dev.reminders || []) {
        if (r.sent || r.at > now) continue;
        r.sent = now;
        changed = true;
        if (now - r.at > (LATE[r.kind] ?? LATE.hour)) continue; // too late to be useful
        const payload = { title: r.title, body: r.body, tag: `${r.taskId}:${r.kind}`, taskId: r.taskId, kind: r.kind };
        jobs.push(sendPush(deviceId, payload, LATE[r.kind]).then((ok) => { if (ok) sent++; }));
      }
      const before = dev.reminders?.length || 0;
      dev.reminders = (dev.reminders || []).filter((r) => r.at > now - 2 * DAY);
      if (dev.reminders.length !== before) changed = true;
    }
    await Promise.all(jobs);
  } finally {
    running = false;
  }
  if (changed) saveSoon();
  return sent;
}

/* ---------------- HTTP helpers ---------------- */

function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(httpError(413, 'payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(httpError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Simple fixed-window rate limit per IP.
const hits = new Map();
function rateLimited(req, bucket, max) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.start > MIN) { hits.set(key, { start: now, n: 1 }); return false; }
  h.n++;
  return h.n > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (now - h.start > MIN) hits.delete(k);
}, 5 * MIN).unref();

/* ---------------- API ---------------- */

let vapid;

const routes = {
  'GET /api/health': async () => ({ ok: true }),

  'GET /api/config': async () => ({ publicKey: vapid.publicKey }),

  'POST /api/subscribe': async (body) => {
    const id = checkDeviceId(body.deviceId);
    const subscription = checkSubscription(body.subscription);
    const dev = db.devices[id] || { reminders: [] };
    dev.subscription = subscription;
    dev.updatedAt = Date.now();
    db.devices[id] = dev;
    saveSoon();
    return { ok: true };
  },

  'POST /api/unsubscribe': async (body) => {
    const id = checkDeviceId(body.deviceId);
    delete db.devices[id];
    saveSoon();
    return { ok: true };
  },

  'PUT /api/reminders': async (body) => {
    const id = checkDeviceId(body.deviceId);
    const dev = db.devices[id];
    if (!dev?.subscription) throw httpError(404, 'unknown device — subscribe first');
    const now = Date.now();
    const old = new Map((dev.reminders || []).map((r) => [r.id, r]));
    dev.reminders = cleanReminders(body.reminders, now).map((r) => (old.get(r.id)?.sent ? { ...r, sent: old.get(r.id).sent } : r));
    dev.updatedAt = now;
    saveSoon();
    return { ok: true, count: dev.reminders.length };
  },

  'POST /api/test': async (body) => {
    const id = checkDeviceId(body.deviceId);
    if (!db.devices[id]?.subscription) throw httpError(404, 'unknown device');
    const ok = await sendPush(id, { title: 'ده إشعار تجربة', body: 'لو شايفه يبقى الإشعارات شغالة حتى والأبلكيشن مقفول', kind: 'test', tag: 'test' }, 10 * MIN);
    if (!ok) throw httpError(502, 'push failed');
    return { ok: true };
  },

  // Lets an external cron (e.g. cron-job.org) wake a sleeping free-tier host every minute.
  'GET /api/tick': async () => ({ ok: true, sent: await runScheduler() }),

  // Fallback handwriting proxy (used if the browser can't reach Google directly).
  'POST /api/recognize': async (body) => {
    const reqs = body?.requests;
    if (!Array.isArray(reqs) || reqs.length < 1 || reqs.length > 4) throw httpError(400, 'bad request');
    for (const r of reqs) {
      if (!Array.isArray(r.ink) || r.ink.length > 600) throw httpError(400, 'bad ink');
      if (typeof r.language !== 'string' || !/^[a-z]{2,3}(?:[_-][A-Za-z]{2,4})?$/.test(r.language)) throw httpError(400, 'bad language');
    }
    const upstream = await fetch(RECOGNIZE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!upstream?.ok) throw httpError(502, 'recognizer unavailable');
    return upstream.json();
  },
};

async function handleApi(req, res, url) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const route = routes[`${req.method} ${url.pathname}`];
  if (!route) { sendJson(res, 404, { error: 'not found' }); return; }

  const bucket = url.pathname === '/api/recognize' ? 'rec' : 'api';
  if (rateLimited(req, bucket, bucket === 'rec' ? 60 : 240)) { sendJson(res, 429, { error: 'slow down' }); return; }

  try {
    const body = req.method === 'POST' || req.method === 'PUT' ? await readJson(req) : {};
    sendJson(res, 200, await route(body, req));
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[mahami]', err);
    sendJson(res, status, { error: status === 500 ? 'server error' : err.message });
  }
}

/* ---------------- Static files ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self' https://inputtools.google.com https://www.google.com",
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); res.end(); return; }
  if (rel.endsWith('/')) rel += 'index.html';
  let file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }

  let st = await stat(file).catch(() => null);
  if (!st?.isFile()) {
    if (path.extname(rel)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    file = path.join(PUBLIC_DIR, 'index.html'); // SPA fallback
    st = await stat(file);
  }

  const ext = path.extname(file);
  const lastModified = st.mtime.toUTCString();
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Last-Modified': lastModified,
    'Cache-Control': ext === '.png' || ext === '.svg' ? 'public, max-age=604800' : 'no-cache',
  };
  if (path.basename(file) === 'sw.js') headers['Service-Worker-Allowed'] = '/';
  if (req.headers['if-modified-since'] === lastModified) { res.writeHead(304, headers); res.end(); return; }
  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(file).pipe(res);
}

/* ---------------- Boot ---------------- */

await loadDb();
vapid = await loadVapid();
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) handleApi(req, res, url);
  else serveStatic(req, res, url).catch((e) => { console.error(e); res.writeHead(500); res.end(); });
});

setInterval(() => runScheduler().catch((e) => console.error('[mahami] scheduler', e)), TICK_MS);

server.listen(PORT, HOST, () => {
  console.log(`[mahami] running on http://localhost:${PORT}`);
});

async function shutdown() {
  clearTimeout(saveTimer);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DB_FILE, JSON.stringify(db)).catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
