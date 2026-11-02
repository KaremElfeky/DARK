// Shared backend logic (used by server.js and by the Vercel functions in api/).
// Storage is pluggable: a JSON file for server.js, Upstash Redis on Vercel.
//
// A store implements:
//   get(id) -> device | null      put(id, device)      remove(id)      all() -> [[id, device], ...]
//   getAccount(id) -> account | null   putAccount(id, account)   allAccounts() -> [[id, account], ...]
//   getMeta(name) / setMeta(name, value)   small values, e.g. when the scheduler last ran
//   claim(key, ttlMs) -> true the first time a key is claimed (until it expires), false after that
// where device  = { subscription, account?, reminders: [...] (legacy clients), updatedAt }
//       account = { tasks: [...], deleted: { taskId: deletedAt }, settings: { remind, email, at }, updatedAt }
//
// An "account" is the sync code shown in Settings: every device that uses the same code shares the
// same tasks, and the server sends reminders (push + email) from those tasks.

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

const TOMBSTONE_TTL = 60 * DAY;
const MAX_TASKS = 2000;
export const DEFAULT_REMIND = { day: true, hour: true, due: true };

/** Turn a comma-separated list of emails into a lowercase Set. */
export const emailSet = (list) => new Set(String(list || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));

export function createCore({ store, vapid, subject, recognizeUrl, pushHosts, mailer = null, allowedEmails = '', appUrl = '' }) {
  const ALLOWED_EMAILS = emailSet(allowedEmails);
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
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

  const checkAccount = (id) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) throw httpError(400, 'bad account');
    return id;
  };

  function cleanEmail(v) {
    const e = str(v, 254).trim().toLowerCase();
    if (!e) return '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw httpError(400, 'bad email');
    return e;
  }

  const emailAllowed = (e) => !!e && (ALLOWED_EMAILS.size === 0 || ALLOWED_EMAILS.has(e));

  function cleanTask(t) {
    if (!t || typeof t !== 'object') return null;
    const id = str(t.id, 64);
    const title = str(t.title, 500);
    if (!id || typeof t.title !== 'string') return null;
    return {
      id,
      title,
      due: num(t.due),
      done: !!t.done,
      doneAt: num(t.doneAt),
      postponed: Math.max(0, Math.min(999, num(t.postponed) || 0)),
      source: str(t.source, 16) || 'text',
      createdAt: num(t.createdAt) || Date.now(),
      updatedAt: num(t.updatedAt) || 0,
    };
  }

  function cleanSettings(s) {
    if (!s || typeof s !== 'object') return null;
    const r = s.remind || {};
    return {
      remind: { day: r.day !== false, hour: r.hour !== false, due: r.due !== false },
      email: cleanEmail(s.email),
      at: num(s.at) || 0,
    };
  }

  /**
   * Last-write-wins merge, per task (by updatedAt). A deleted task leaves a tombstone so a device that
   * still has the old copy doesn't bring it back.
   */
  function mergeAccount(acct, incoming, now) {
    const tasks = new Map((acct.tasks || []).map((t) => [t.id, t]));
    const deleted = { ...(acct.deleted || {}) };

    for (const [id, at] of Object.entries(incoming.deleted || {})) {
      const ts = num(at);
      if (typeof id === 'string' && id.length <= 64 && ts) deleted[id] = Math.max(deleted[id] || 0, ts);
    }
    for (const raw of Array.isArray(incoming.tasks) ? incoming.tasks.slice(0, MAX_TASKS) : []) {
      const t = cleanTask(raw);
      if (!t) continue;
      const cur = tasks.get(t.id);
      if (!cur || t.updatedAt > cur.updatedAt) tasks.set(t.id, t);
    }
    for (const [id, at] of Object.entries(deleted)) {
      const t = tasks.get(id);
      if (t && t.updatedAt <= at) tasks.delete(id);
      if (at < now - TOMBSTONE_TTL) delete deleted[id];
    }

    let settings = acct.settings || null;
    const s = cleanSettings(incoming.settings);
    if (s && (!settings || s.at >= (settings.at || 0))) settings = s;

    return {
      tasks: [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_TASKS),
      deleted,
      settings: settings || { remind: { ...DEFAULT_REMIND }, email: '', at: 0 },
      updatedAt: now,
    };
  }

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

  /* ---------------- Email ---------------- */

  const fmtWhen = (ts) => new Intl.DateTimeFormat('ar-EG', {
    timeZone: process.env.TZ_DISPLAY || 'Africa/Cairo', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit',
  }).format(ts);

  const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  async function sendEmail(to, { title, body, due }) {
    if (!mailer || !emailAllowed(to)) return false;
    const when = due ? fmtWhen(due) : '';
    const link = appUrl ? `<p style="margin:24px 0 0"><a href="${escHtml(appUrl)}" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none">افتح مهامي</a></p>` : '';
    try {
      await mailer.send({
        to,
        subject: `🔔 ${title}`,
        text: [title, body, when, appUrl].filter(Boolean).join('\n'),
        html: `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;font-size:16px;line-height:1.7;color:#111">
          <h2 style="margin:0 0 8px">${escHtml(title)}</h2>
          ${body ? `<p style="margin:0">${escHtml(body)}</p>` : ''}
          ${when ? `<p style="margin:8px 0 0;color:#555">${escHtml(when)}</p>` : ''}${link}</div>`,
      });
      return true;
    } catch (err) {
      console.warn(`[mahami] email failed (${err.code || err.message})`);
      return false;
    }
  }

  /* ---------------- Reminders from stored tasks ---------------- */

  const OFFSETS = { day: DAY, hour: HOUR, due: 0 };
  const fmtTime = (ts) => new Intl.DateTimeFormat('ar-EG', { timeZone: process.env.TZ_DISPLAY || 'Africa/Cairo', hour: 'numeric', minute: '2-digit' }).format(ts);

  function reminderText(task, kind) {
    const time = fmtTime(task.due);
    if (kind === 'day') return { title: `بكرة: ${task.title}`, body: `الساعة ${time} — متنساش` };
    if (kind === 'hour') return { title: `كمان ساعة: ${task.title}`, body: `الساعة ${time}` };
    return { title: `دلوقتي: ${task.title}`, body: 'جه الميعاد — خلصتها؟' };
  }

  /** Reminders of this account that are due now (not yet claimed). */
  function dueReminders(acct, now) {
    const remind = acct.settings?.remind || DEFAULT_REMIND;
    const out = [];
    for (const t of acct.tasks || []) {
      if (t.done || !t.due) continue;
      for (const kind of ['day', 'hour', 'due']) {
        if (!remind[kind]) continue;
        const at = t.due - OFFSETS[kind];
        if (at > now || now - at > LATE[kind]) continue;
        if (t.createdAt > at) continue; // task was added after this reminder's time — don't nag right away
        out.push({ task: t, kind, at, key: `${t.id}:${kind}:${t.due}`, ...reminderText(t, kind) });
      }
    }
    return out;
  }

  let running = false;

  async function runScheduler(now = Date.now()) {
    if (running) return 0;
    running = true;
    let sent = 0;
    try {
      await store.setMeta?.('lastTick', String(now));
      const [devices, accounts] = await Promise.all([store.all(), store.allAccounts ? store.allAccounts() : []]);
      const gone = new Set();

      // 1) Reminders computed from each account's stored tasks -> push to its devices + email.
      await Promise.all(accounts.map(async ([acctId, acct]) => {
        const targets = devices.filter(([, d]) => d.account === acctId && d.subscription);
        const email = acct.settings?.email;
        for (const r of dueReminders(acct, now)) {
          if (!(await store.claim(`sent:${acctId}:${r.key}`, 3 * DAY))) continue;
          const payload = { title: r.title, body: r.body, tag: `${r.task.id}:${r.kind}`, taskId: r.task.id, kind: r.kind };
          const results = await Promise.all(targets.map(async ([id, d]) => {
            const res = await sendPush(d.subscription, payload, LATE[r.kind]);
            if (res === 'gone') gone.add(id);
            return res;
          }));
          sent += results.filter((x) => x === 'ok').length;
          if (email && (await sendEmail(email, { ...r, due: r.task.due }))) sent++;
        }
      }));
      for (const id of gone) await store.remove(id);

      // 2) Legacy: reminder lists pushed by older app versions.
      await Promise.all(devices.filter(([id]) => !gone.has(id)).map(async ([id, dev]) => {
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

    'GET /api/config': async () => ({ publicKey: vapid.publicKey, email: !!mailer, sync: !!store.putAccount }),

    // Save this device's tasks on the server and get back the merged list from all devices.
    'POST /api/sync': async (body) => {
      const id = checkAccount(body.account);
      const now = Date.now();
      const acct = mergeAccount((await store.getAccount(id)) || {}, body, now);
      await store.putAccount(id, acct);
      let device = null;
      if (body.deviceId) {
        const devId = checkDeviceId(body.deviceId);
        const dev = await store.get(devId);
        device = !!dev;
        if (dev && dev.account !== id) { dev.account = id; dev.reminders = []; await store.put(devId, dev); }
      }
      const email = acct.settings.email;
      const lastTick = Number(await store.getMeta?.('lastTick')) || null;
      return {
        ok: true,
        lastTick,
        tasks: acct.tasks,
        deleted: acct.deleted,
        settings: acct.settings,
        email: { configured: !!mailer, allowed: emailAllowed(email) },
        device,
        serverTime: now,
      };
    },

    'POST /api/test-email': async (body) => {
      const acct = await store.getAccount(checkAccount(body.account));
      const to = acct?.settings?.email;
      if (!mailer) throw httpError(503, 'email is not configured on the server');
      if (!to) throw httpError(400, 'no email saved');
      if (!emailAllowed(to)) throw httpError(403, 'this email is not allowed on this server');
      const ok = await sendEmail(to, { title: 'ده إيميل تجربة من مهامي', body: 'لو وصلك يبقى تنبيهات الإيميل شغالة ✓', due: null });
      if (!ok) throw httpError(502, 'email failed');
      return { ok: true };
    },

    'POST /api/subscribe': async (body) => {
      const id = checkDeviceId(body.deviceId);
      const subscription = checkSubscription(body.subscription);
      const dev = (await store.get(id)) || { reminders: [] };
      dev.subscription = subscription;
      if (body.account) {
        dev.account = checkAccount(body.account);
        dev.reminders = []; // the server now builds reminders from the account's tasks
      }
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
