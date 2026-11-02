// Reminders: "1 day before" and "1 hour before" every task (plus optional "at the time").
//
// Two delivery paths:
//  1. Push (preferred): the app syncs upcoming reminders to server.js, which sends
//     Web Push at the right moment — works even when the app is closed.
//  2. Local fallback: while the app is open (or recently backgrounded) a timer shows
//     notifications itself. Used when no server is reachable.
import { apiUrl } from './config.js';
import { fmtTime, relative, HOUR, DAY, MIN } from './dates.js';

const OFFSETS = { day: DAY, hour: HOUR, due: 0 };
const SENT_KEY = 'mahami:sent';
const CHECK_KEY = 'mahami:lastCheck';

export const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

let ctx = null;
let swReg = null;
let server = { ok: false, publicKey: null, sync: false };
let pushActive = false;
let syncTimer = null;

const hasNotification = () => 'Notification' in window;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window;
export const permission = () => (hasNotification() ? Notification.permission : 'unsupported');

/**
 * 'needs-install' | 'unsupported' | 'default' | 'denied' | 'local' | 'push'
 */
export function status() {
  if (!hasNotification()) return isIOS && !isStandalone() ? 'needs-install' : 'unsupported';
  const p = Notification.permission;
  if (p === 'denied') return 'denied';
  if (p !== 'granted') return 'default';
  return pushActive ? 'push' : 'local';
}

export const serverAvailable = () => server.ok;

/* ---------------- Reminder model ---------------- */

export function remindersFor(task, settings) {
  if (!task || task.done || !task.due) return [];
  const out = [];
  // A task added too close to its time for any earlier reminder still gets one at its time.
  const created = task.createdAt || 0;
  const hadEarlier = ['day', 'hour'].some((k) => settings.remind?.[k] && created <= task.due - OFFSETS[k]);
  for (const kind of ['day', 'hour', 'due']) {
    if (!settings.remind?.[kind] && !(kind === 'due' && !hadEarlier)) continue;
    out.push({
      id: `${task.id}:${kind}:${task.due}`,
      taskId: task.id,
      kind,
      at: task.due - OFFSETS[kind],
      ...reminderText(task, kind),
    });
  }
  return out;
}

function reminderText(task, kind) {
  const time = fmtTime(task.due);
  if (kind === 'day') return { title: `بكرة: ${task.title}`, body: `الساعة ${time} — متنساش` };
  if (kind === 'hour') return { title: `كمان ساعة: ${task.title}`, body: `الساعة ${time}` };
  return { title: `دلوقتي: ${task.title}`, body: 'جه الميعاد — خلصتها؟' };
}

/** Next upcoming reminder times for a task (used to show "you'll be reminded at…"). */
export function upcomingFor(task, settings, now = Date.now()) {
  return remindersFor(task, settings).filter((r) => r.at > now);
}

/* ---------------- Init ---------------- */

export async function init(options) {
  ctx = options; // { getTasks, getSettings, deviceId, onAction, onChange, onTick, onInApp }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    try {
      swReg = await navigator.serviceWorker.register('./sw.js');
    } catch (e) {
      console.warn('Service worker registration failed', e);
    }
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'notification-action') ctx.onAction?.(e.data);
      if (e.data?.type === 'reminder') { chime(); ctx.onInApp?.(e.data.title, e.data); }
    });
  }

  await checkServer();
  if (permission() === 'granted' && server.ok && pushSupported()) {
    try { await ensurePush(); } catch (e) { console.warn('Push setup failed', e); }
  }
  ctx.onChange?.();

  tick();
  setInterval(tick, 30_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { tick(); scheduleSync(0); }
  });
}

async function api(path, body, method = 'POST') {
  const res = await fetch(apiUrl(path), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json().catch(() => ({}));
}

async function checkServer() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(apiUrl('api/config'), { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    const json = res.ok ? await res.json() : null;
    server = { ok: !!json?.publicKey, publicKey: json?.publicKey || null, sync: !!json?.sync };
  } catch {
    server = { ok: false, publicKey: null, sync: false };
  }
}

/* ---------------- Permission & push ---------------- */

/** Must be called straight from a click/tap handler (iOS requires a user gesture). */
export async function enable() {
  if (!hasNotification()) return status();
  const p = await Notification.requestPermission();
  if (p === 'granted') {
    if (!server.ok) await checkServer();
    if (server.ok && pushSupported()) {
      try { await ensurePush(); } catch (e) { console.warn('Push setup failed', e); }
    }
  }
  ctx?.onChange?.();
  return status();
}

function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const s = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function sameKey(a, b) {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/** Resolves with the registration once a service worker is *active* (needed for push). */
function activeRegistration(ms = 10_000) {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error('service worker not active')), ms)),
  ]);
}

async function ensurePush() {
  const reg = await activeRegistration();
  const key = b64ToBytes(server.publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('api/subscribe', { deviceId: ctx.deviceId(), account: ctx.account?.(), subscription: sub.toJSON() });
  pushActive = true;
  await syncNow();
}

/** The server lost this device (e.g. its database was reset) -> subscribe again. */
export async function resubscribe() {
  if (!pushActive || permission() !== 'granted') return;
  pushActive = false;
  try { await ensurePush(); } catch (e) { console.warn('Push setup failed', e); }
  ctx?.onChange?.();
}

export function scheduleSync(delay = 800) {
  if (!pushActive) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow().catch((e) => console.warn('Reminder sync failed', e)), delay);
}

async function syncNow() {
  if (!pushActive || !ctx) return;
  if (server.sync) { await ctx.syncTasks?.(); return; } // the server builds reminders from the synced tasks
  const now = Date.now();
  const reminders = ctx.getTasks()
    .flatMap((t) => remindersFor(t, ctx.getSettings()))
    .filter((r) => r.at > now)
    .sort((a, b) => a.at - b.at)
    .slice(0, 500);
  try {
    await api('api/reminders', { deviceId: ctx.deviceId(), reminders }, 'PUT');
  } catch (e) {
    if (e.status === 404) {
      // Server forgot us (e.g. it was redeployed) -> subscribe again.
      pushActive = false;
      await ensurePush();
    } else {
      throw e;
    }
  }
}

export async function sendTest() {
  if (pushActive) {
    await api('api/test', { deviceId: ctx.deviceId() });
    return 'push';
  }
  await show('ده إشعار تجربة', { body: 'لو شايفه يبقى الإشعارات شغالة تمام', tag: 'test' });
  return 'local';
}

/* ---------------- Local scheduler ---------------- */

function loadSent() {
  try { return JSON.parse(localStorage.getItem(SENT_KEY) || '{}'); } catch { return {}; }
}

function saveSent(sent, now) {
  for (const [id, at] of Object.entries(sent)) if (at < now - 3 * DAY) delete sent[id];
  try { localStorage.setItem(SENT_KEY, JSON.stringify(sent)); } catch { /* ignore */ }
}

function tick() {
  if (!ctx) return;
  if (!document.hidden) ctx.onTick?.();
  const now = Date.now();
  const last = Number(localStorage.getItem(CHECK_KEY)) || now;
  try { localStorage.setItem(CHECK_KEY, String(now)); } catch { /* ignore */ }
  if (pushActive) return; // the server takes care of it

  const sent = loadSent();
  let changed = false;
  for (const task of ctx.getTasks()) {
    for (const r of remindersFor(task, ctx.getSettings())) {
      if (sent[r.id] || r.at > now || r.at <= last - 1000) continue;
      const stillUseful = r.kind === 'due' ? now - task.due < 15 * MIN : task.due > now;
      if (!stillUseful) continue;
      sent[r.id] = r.at;
      changed = true;
      const late = now - r.at > 2 * MIN && r.kind !== 'due';
      const title = late ? `${relative(task.due, now)}: ${task.title}` : r.title;
      fire(title, r);
    }
  }
  if (changed) saveSent(sent, now);
}

/* ---------------- Alarm sound (while the app is open) ---------------- */

let audio = null;
// Browsers only allow sound after the user touched the page once.
['pointerdown', 'keydown'].forEach((ev) => addEventListener(ev, () => {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch { /* no audio */ }
}, { passive: true }));

export function chime() {
  try { navigator.vibrate?.([300, 120, 300, 120, 600]); } catch { /* ignore */ }
  if (!audio || audio.state !== 'running') return;
  const t0 = audio.currentTime;
  [[880, 0], [660, 0.25], [880, 0.5], [660, 0.75], [988, 1.0]].forEach(([f, dt]) => {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + dt);
    g.gain.exponentialRampToValueAtTime(0.35, t0 + dt + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.22);
    o.connect(g).connect(audio.destination);
    o.start(t0 + dt);
    o.stop(t0 + dt + 0.25);
  });
}

function fire(title, r) {
  if (!document.hidden) chime();
  if (permission() === 'granted') {
    show(title, { body: r.body, tag: `${r.taskId}:${r.kind}`, data: { taskId: r.taskId, kind: r.kind }, kind: r.kind });
  }
  ctx.onInApp?.(title, r);
}

async function show(title, { body, tag, data = {}, kind } = {}) {
  const opts = {
    body,
    tag,
    renotify: !!tag,
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    lang: 'ar',
    dir: 'rtl',
    data,
    silent: false,
    requireInteraction: !!kind && kind !== 'day',
    vibrate: [300, 120, 300, 120, 600],
  };
  try {
    const reg = 'serviceWorker' in navigator && swReg ? await activeRegistration(3000).catch(() => null) : null;
    if (reg) {
      const actions = kind === 'day'
        ? [{ action: 'done', title: 'خلصتها ✓' }]
        : kind ? [{ action: 'done', title: 'خلصتها ✓' }, { action: 'snooze', title: 'أجّل ساعة' }] : [];
      await reg.showNotification(title, { ...opts, actions });
      return;
    }
  } catch (e) {
    console.warn('showNotification failed, falling back', e);
  }
  try { new Notification(title, opts); } catch { /* not allowed here (e.g. Android without SW) */ }
}

/* ---------------- App badge ---------------- */

export function setBadge(n) {
  try {
    if (n > 0) navigator.setAppBadge?.(n);
    else navigator.clearAppBadge?.();
  } catch { /* unsupported */ }
}
