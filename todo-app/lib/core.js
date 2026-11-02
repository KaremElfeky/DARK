// Shared backend logic (used by server.js and by the Vercel functions in api/).
// Storage is pluggable: a JSON file for server.js, Upstash Redis on Vercel.
//
// A store implements:
//   get(id) -> device | null      put(id, device)      remove(id)      all() -> [[id, device], ...]
// where device = { subscription, reminders: [...], updatedAt }

import webpush from 'web-push';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// How late a reminder may still be delivered (e.g. after downtime).
const LATE = { day: 6 * HOUR, hour: 30 * MIN, due: 30 * MIN };

export const DEFAULT_RECOGNIZE_URL = 'https://inputtools.google.com/request?ime=handwriting&app=mobilesearch&cs=1&oe=UTF-8';
// Only ever send pushes to real push services (prevents using the server as an open proxy).
const DEFAULT_PUSH_HOSTS = 'fcm.googleapis.com,android.googleapis.com,push.services.mozilla.com,push.apple.com,notify.windows.com';

export const httpError = (status, message) => Object.assign(new Error(message), { status });

export function createCore({ store, vapid, subject, recognizeUrl, pushHosts }) {
  const RECOGNIZE_URL = recognizeUrl || DEFAULT_RECOGNIZE_URL;
  const PUSH_HOSTS = (pushHosts || DEFAULT_PUSH_HOSTS).split(',').map((s) => s.trim()).filter(Boolean);
  webpush.setVapidDetails(subject || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);

  /* ---------------- Validation ---------------- */

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
    const okHost = PUSH_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
    if (url.protocol !== 'https:' || !okHost) throw httpError(400, 'unsupported push service');
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

  /** @returns 'ok' | 'gone' | 'failed' */
  async function sendPush(subscription, payload, ttlMs = HOUR) {
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload), {
        TTL: Math.max(60, Math.round(ttlMs / 1000)),
        urgency: 'high',
      });
      return 'ok';
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) return 'gone'; // expired / permission revoked
      console.warn(`[mahami] push failed (${err.statusCode || err.code || err.message})`);
      return 'failed';
    }
  }

  let running = false;

  async function runScheduler(now = Date.now()) {
    if (running) return 0;
    running = true;
    let sent = 0;
    try {
      const devices = await store.all();
      await Promise.all(devices.map(async ([id, dev]) => {
        let changed = false;
        const jobs = [];
        for (const r of dev.reminders || []) {
          if (r.sent || r.at > now) continue;
          r.sent = now;
          changed = true;
          if (!dev.subscription || now - r.at > (LATE[r.kind] ?? LATE.hour)) continue; // too late to be useful
          const payload = { title: r.title, body: r.body, tag: `${r.taskId}:${r.kind}`, taskId: r.taskId, kind: r.kind };
          jobs.push(sendPush(dev.subscription, payload, LATE[r.kind]));
        }
        const before = dev.reminders?.length || 0;
        dev.reminders = (dev.reminders || []).filter((r) => r.at > now - 2 * DAY);
        if (dev.reminders.length !== before) changed = true;
        const results = await Promise.all(jobs);
        sent += results.filter((x) => x === 'ok').length;
        if (results.includes('gone')) await store.remove(id);
        else if (changed) await store.put(id, dev);
      }));
    } finally {
      running = false;
    }
    return sent;
  }

  /* ---------------- Routes ---------------- */

  const routes = {
    'GET /api/health': async () => ({ ok: true }),

    'GET /api/config': async () => ({ publicKey: vapid.publicKey }),

    'POST /api/subscribe': async (body) => {
      const id = checkDeviceId(body.deviceId);
      const subscription = checkSubscription(body.subscription);
      const dev = (await store.get(id)) || { reminders: [] };
      dev.subscription = subscription;
      dev.updatedAt = Date.now();
      await store.put(id, dev);
      return { ok: true };
    },

    'POST /api/unsubscribe': async (body) => {
      await store.remove(checkDeviceId(body.deviceId));
      return { ok: true };
    },

    'PUT /api/reminders': async (body) => {
      const id = checkDeviceId(body.deviceId);
      const dev = await store.get(id);
      if (!dev?.subscription) throw httpError(404, 'unknown device — subscribe first');
      const now = Date.now();
      const old = new Map((dev.reminders || []).map((r) => [r.id, r]));
      dev.reminders = cleanReminders(body.reminders, now)
        .map((r) => (old.get(r.id)?.sent ? { ...r, sent: old.get(r.id).sent } : r));
      dev.updatedAt = now;
      await store.put(id, dev);
      return { ok: true, count: dev.reminders.length };
    },

    'POST /api/test': async (body) => {
      const id = checkDeviceId(body.deviceId);
      const dev = await store.get(id);
      if (!dev?.subscription) throw httpError(404, 'unknown device');
      const result = await sendPush(dev.subscription, { title: 'ده إشعار تجربة', body: 'لو شايفه يبقى الإشعارات شغالة حتى والأبلكيشن مقفول', kind: 'test', tag: 'test' }, 10 * MIN);
      if (result === 'gone') await store.remove(id);
      if (result !== 'ok') throw httpError(502, 'push failed');
      return { ok: true };
    },

    // Called every minute by the built-in timer (server.js) or an external cron (Vercel / free hosts).
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
  routes['POST /api/tick'] = routes['GET /api/tick'];

  /** Run a route; returns { status, data }. */
  async function handle(method, pathname, body) {
    const route = routes[`${method} ${pathname}`];
    if (!route) return { status: 404, data: { error: 'not found' } };
    try {
      return { status: 200, data: await route(body || {}) };
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error('[mahami]', err);
      return { status, data: { error: status === 500 ? 'server error' : err.message } };
    }
  }

  return { handle, runScheduler, routes };
}
