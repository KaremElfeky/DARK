// The Vercel functions (api/*.js) against a fake Upstash Redis REST server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

const kv = new Map();
const sets = new Map();
function run([c, ...a]) {
  switch (c.toUpperCase()) {
    case 'GET': return kv.get(a[0]) ?? null;
    case 'SET': {
      if (a.map((x) => String(x).toUpperCase()).includes('NX') && kv.has(a[0])) return null;
      kv.set(a[0], a[1]); return 'OK';
    }
    case 'DEL': return kv.delete(a[0]) ? 1 : 0;
    case 'MGET': return a.map((k) => kv.get(k) ?? null);
    case 'SADD': { const s = sets.get(a[0]) || new Set(); s.add(a[1]); sets.set(a[0], s); return 1; }
    case 'SREM': return sets.get(a[0])?.delete(a[1]) ? 1 : 0;
    case 'SMEMBERS': return [...(sets.get(a[0]) || [])];
    default: throw new Error(`unsupported ${c}`);
  }
}
let redis;
let handler;

before(async () => {
  redis = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      assert.equal(req.headers.authorization, 'Bearer test-token');
      const body = JSON.parse(b);
      const out = req.url === '/pipeline' ? body.map((cmd) => ({ result: run(cmd) })) : { result: run(body) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => redis.listen(0, '127.0.0.1', r));
  const keys = (await import('web-push')).default.generateVAPIDKeys();
  Object.assign(process.env, {
    KV_REST_API_URL: `http://127.0.0.1:${redis.address().port}`,
    KV_REST_API_TOKEN: 'test-token',
    VAPID_PUBLIC_KEY: keys.publicKey,
    VAPID_PRIVATE_KEY: keys.privateKey,
    PUSH_HOSTS: 'push.invalid',
  });
  handler = (await import('../api/reminders.js')).default; // every api/*.js shares this handler
});

after(() => new Promise((r) => redis.close(r)));

function call(method, url, body) {
  return new Promise((resolve) => {
    const res = {
      headers: {}, statusCode: 200,
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ status: this.statusCode, data: d }); },
      end() { resolve({ status: this.statusCode, data: null }); },
    };
    handler({ method, url, body }, res);
  });
}

test('config, subscribe, sync and tick through Redis', async () => {
  const cfg = await call('GET', '/api/config');
  assert.equal(cfg.data.publicKey, process.env.VAPID_PUBLIC_KEY);

  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const subscription = { endpoint: 'https://fcm.push.invalid/x', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
  assert.equal((await call('POST', '/api/subscribe', { deviceId: 'vercel-device-1', subscription })).status, 200);

  const now = Date.now();
  const put = await call('PUT', '/api/reminders', { deviceId: 'vercel-device-1', reminders: [
    { id: 'a:hour:1', taskId: 'a', kind: 'hour', at: now - 1000, title: 't', body: 'b' },
    { id: 'b:day:1', taskId: 'b', kind: 'day', at: now + 3_600_000, title: 't2', body: '' },
  ] });
  assert.deepEqual(put.data, { ok: true, count: 2 });

  const tick = await call('GET', '/api/tick');
  assert.equal(tick.status, 200);
  const stored = JSON.parse(kv.get('mahami:dev:vercel-device-1'));
  assert.ok(stored.reminders.find((r) => r.id === 'a:hour:1').sent, 'due reminder processed');
  assert.ok(!stored.reminders.find((r) => r.id === 'b:day:1').sent, 'future reminder untouched');

  assert.equal((await call('OPTIONS', '/api/reminders')).status, 204);
  assert.equal((await call('PUT', '/api/reminders', { deviceId: 'nobody-here', reminders: [] })).status, 404);
});

test('sync saves tasks in Redis and merges devices', async () => {
  const account = 'acct-0123456789abcdef';
  const t0 = Date.now();
  const a = await call('POST', '/api/sync', { account, tasks: [
    { id: 'x1', title: 'من الآيباد', due: t0 + 3_600_000, createdAt: t0, updatedAt: t0 },
    { id: 'x2', title: 'هتتمسح', createdAt: t0, updatedAt: t0 },
  ], deleted: {}, settings: { remind: { day: true, hour: true, due: true }, email: 'Me@Example.com', at: t0 } });
  assert.equal(a.status, 200);
  assert.equal(a.data.tasks.length, 2);
  assert.ok(JSON.parse(kv.get(`mahami:acct:${account}`)).tasks.length === 2, 'stored in Redis');

  // Second device: edits x1 (newer), deletes x2, adds x3, has an older copy of nothing else.
  const b = await call('POST', '/api/sync', { account, tasks: [
    { id: 'x1', title: 'اتعدلت', due: t0 + 3_600_000, createdAt: t0, updatedAt: t0 + 10 },
    { id: 'x3', title: 'من الموبايل', createdAt: t0 + 5, updatedAt: t0 + 5 },
  ], deleted: { x2: t0 + 20 } });
  assert.deepEqual(b.data.tasks.map((t) => [t.id, t.title]), [['x1', 'اتعدلت'], ['x3', 'من الموبايل']]);
  assert.equal(b.data.settings.email, 'me@example.com', 'settings kept when the other device sends none');

  // First device comes back with its stale copy: the deleted task must not return, the edit must win.
  const c = await call('POST', '/api/sync', { account, tasks: [
    { id: 'x1', title: 'من الآيباد', due: t0 + 3_600_000, createdAt: t0, updatedAt: t0 },
    { id: 'x2', title: 'هتتمسح', createdAt: t0, updatedAt: t0 },
  ], deleted: {} });
  assert.deepEqual(c.data.tasks.map((t) => t.title), ['اتعدلت', 'من الموبايل']);

  assert.equal((await call('POST', '/api/sync', { account: 'short', tasks: [] })).status, 400);
});
