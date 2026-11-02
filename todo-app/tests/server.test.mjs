// End-to-end test of server.js: subscribe -> schedule reminder -> receive & decrypt the Web Push.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ece = require('http_ece');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let proc;
let pushServer;
let dataDir;
const received = [];
const PORT = 18000 + Math.floor(Math.random() * 1000);
const PUSH_PORT = PORT + 1000;
const base = `http://127.0.0.1:${PORT}`;

// A fake browser subscription with real keys, so web-push really encrypts for us.
const ecdh = crypto.createECDH('prime256v1');
ecdh.generateKeys();
const authSecret = crypto.randomBytes(16);
const subscription = {
  endpoint: `https://127.0.0.1:${PUSH_PORT}/push/abc`,
  keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') },
};

const api = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'mahami-'));
  // web-push only speaks HTTPS, so the fake push service gets a throwaway self-signed cert.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-keyout', path.join(dataDir, 'key.pem'), '-out', path.join(dataDir, 'cert.pem')], { stdio: 'ignore' });
  const tls = { key: await readFile(path.join(dataDir, 'key.pem')), cert: await readFile(path.join(dataDir, 'cert.pem')) };
  pushServer = https.createServer(tls, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(201); res.end();
    });
  });
  await new Promise((r) => pushServer.listen(PUSH_PORT, '127.0.0.1', r));

  proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, TICK_MS: '250', PUSH_HOSTS: '127.0.0.1', NODE_TLS_REJECT_UNAUTHORIZED: '0', HTTPS_PROXY: '', https_proxy: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* not up yet */ }
    await wait(100);
  }
  throw new Error('server did not start');
});

after(async () => {
  proc?.kill('SIGTERM');
  await new Promise((r) => pushServer.close(r));
  await rm(dataDir, { recursive: true, force: true });
});

test('serves the app with security headers', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await res.text(), /مهامي/);
  assert.equal((await fetch(`${base}/sw.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(`${base}/nope.js`)).status, 404);
  assert.equal((await fetch(`${base}/some/route`)).status, 200); // SPA fallback
});

test('blocks path traversal', async () => {
  const res = await fetch(`${base}/..%2fserver.js`);
  assert.ok([403, 404].includes(res.status));
});

test('config exposes a VAPID public key', async () => {
  const { status, json } = await api('GET', '/api/config');
  assert.equal(status, 200);
  assert.match(json.publicKey, /^[A-Za-z0-9_-]{80,}$/);
});

test('rejects bad input', async () => {
  assert.equal((await api('POST', '/api/subscribe', { deviceId: 'x', subscription })).status, 400);
  const evil = { ...subscription, endpoint: 'https://169.254.169.254/latest' };
  assert.equal((await api('POST', '/api/subscribe', { deviceId: 'device-12345', subscription: evil })).status, 400);
  const plainHttp = { ...subscription, endpoint: `http://127.0.0.1:${PUSH_PORT}/push/abc` };
  assert.equal((await api('POST', '/api/subscribe', { deviceId: 'device-12345', subscription: plainHttp })).status, 400);
  assert.equal((await api('PUT', '/api/reminders', { deviceId: 'never-subscribed', reminders: [] })).status, 404);
});

test('delivers a scheduled reminder as an encrypted push', async () => {
  const deviceId = 'device-abcdef123';
  assert.equal((await api('POST', '/api/subscribe', { deviceId, subscription })).status, 200);

  const now = Date.now();
  const reminders = [
    { id: 't1:hour:1', taskId: 't1', kind: 'hour', at: now + 600, title: 'كمان ساعة: دكتور الأسنان', body: 'الساعة ٥:٠٠ م' },
    { id: 't2:day:1', taskId: 't2', kind: 'day', at: now + 60 * 60 * 1000, title: 'later', body: '' },
  ];
  const put = await api('PUT', '/api/reminders', { deviceId, reminders });
  assert.equal(put.status, 200);
  assert.equal(put.json.count, 2);

  for (let i = 0; i < 40 && !received.length; i++) await wait(100);
  assert.equal(received.length, 1, 'exactly one push should be sent (the other is an hour away)');

  const msg = received[0];
  assert.match(msg.headers.authorization, /^vapid t=/);
  assert.equal(msg.headers['content-encoding'], 'aes128gcm');
  const plain = ece.decrypt(msg.body, { version: 'aes128gcm', privateKey: ecdh, authSecret: authSecret.toString('base64url') });
  const payload = JSON.parse(plain.toString('utf8'));
  assert.equal(payload.title, 'كمان ساعة: دكتور الأسنان');
  assert.equal(payload.taskId, 't1');
  assert.equal(payload.kind, 'hour');

  // Re-syncing the same reminders must not send it twice.
  await api('PUT', '/api/reminders', { deviceId, reminders });
  await wait(800);
  assert.equal(received.length, 1);
});

test('test endpoint sends immediately', async () => {
  const before = received.length;
  const { status } = await api('POST', '/api/test', { deviceId: 'device-abcdef123' });
  assert.equal(status, 200);
  assert.equal(received.length, before + 1);
});

test('CORS preflight works for a separately hosted frontend', async () => {
  const res = await fetch(`${base}/api/reminders`, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('sends a push from tasks saved with /api/sync (no reminder list needed)', async () => {
  const account = 'acct-e2e-000000001';
  const deviceId = 'device-sync-0001';
  assert.equal((await api('POST', '/api/subscribe', { deviceId, account, subscription })).status, 200);
  const before = received.length;
  const now = Date.now();
  const res = await api('POST', '/api/sync', { account, deviceId, deleted: {}, tasks: [
    { id: 'meet', title: 'اجتماع', due: now + 300, createdAt: now - 3_600_000, updatedAt: now },
  ], settings: { remind: { day: true, hour: true, due: true }, email: '', at: now } });
  assert.equal(res.status, 200);
  assert.equal(res.json.device, true);
  for (let i = 0; i < 40 && received.length === before; i++) await wait(100);
  // The first subscription test registered the same endpoint for another device, so only count ours.
  const mine = received.slice(before).map((m) => JSON.parse(ece.decrypt(m.body, { version: 'aes128gcm', privateKey: ecdh, authSecret: authSecret.toString('base64url') }).toString('utf8')));
  assert.ok(mine.some((p) => p.title === 'دلوقتي: اجتماع' && p.kind === 'due'));
  await wait(800);
  assert.equal(received.slice(before).length, mine.length, 'not sent again');
});
