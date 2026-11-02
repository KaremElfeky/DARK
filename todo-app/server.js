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
//   SMTP_USER/SMTP_PASS  email reminders (see lib/mailer.js); ALERT_EMAILS = who may receive them
//   APP_URL              link put in reminder emails

import http from 'node:http';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';
import { createCore, httpError } from './lib/core.js';
import { createMailer } from './lib/mailer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const TICK_MS = Number(process.env.TICK_MS) || 15_000;

const MIN = 60_000;

/* ---------------- Storage ---------------- */

let db = { devices: {}, accounts: {}, claims: {} };
let saving = Promise.resolve();
let saveTimer = null;

async function loadDb() {
  try {
    const parsed = JSON.parse(await readFile(DB_FILE, 'utf8'));
    db = { devices: parsed.devices || {}, accounts: parsed.accounts || {}, claims: parsed.claims || {} };
  } catch {
    db = { devices: {}, accounts: {}, claims: {} };
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

const store = {
  async get(id) { return db.devices[id] || null; },
  async put(id, dev) { db.devices[id] = dev; saveSoon(); },
  async remove(id) { delete db.devices[id]; saveSoon(); },
  async all() { return Object.entries(db.devices); },
  async getAccount(id) { return db.accounts[id] || null; },
  async putAccount(id, acct) { db.accounts[id] = acct; saveSoon(); },
  async allAccounts() { return Object.entries(db.accounts); },
  async claim(name, ttlMs) {
    const now = Date.now();
    for (const [k, exp] of Object.entries(db.claims)) if (exp < now) delete db.claims[k];
    if (db.claims[name]) return false;
    db.claims[name] = now + ttlMs;
    saveSoon();
    return true;
  },
};
let core;

async function handleApi(req, res, url) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const bucket = url.pathname === '/api/recognize' ? 'rec' : 'api';
  if (rateLimited(req, bucket, bucket === 'rec' ? 60 : 240)) { sendJson(res, 429, { error: 'slow down' }); return; }

  let body = {};
  try {
    if (req.method === 'POST' || req.method === 'PUT') body = await readJson(req);
  } catch (err) {
    sendJson(res, err.status || 400, { error: err.message });
    return;
  }
  const { status, data } = await core.handle(req.method, url.pathname, body);
  sendJson(res, status, data);
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
const vapid = await loadVapid();
core = createCore({
  store,
  vapid,
  subject: process.env.VAPID_SUBJECT,
  recognizeUrl: process.env.RECOGNIZE_URL,
  pushHosts: process.env.PUSH_HOSTS,
  mailer: createMailer(process.env),
  allowedEmails: process.env.ALERT_EMAILS || process.env.SMTP_USER,
  appUrl: process.env.APP_URL,
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) handleApi(req, res, url);
  else serveStatic(req, res, url).catch((e) => { console.error(e); res.writeHead(500); res.end(); });
});

setInterval(() => core.runScheduler().catch((e) => console.error('[mahami] scheduler', e)), TICK_MS);

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
