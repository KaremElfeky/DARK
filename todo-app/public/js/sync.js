// Keeps the tasks saved on the server (Upstash Redis on Vercel), so they survive a cleared browser
// and show up on every device that uses the same sync code. The server also sends the reminders
// (push + email) from these saved tasks, so they arrive even when the app is closed.
import { store } from './store.js';
import { apiUrl } from './config.js';

const MIN = 60_000;

let state = { ok: null, at: 0, email: { configured: false, allowed: false }, error: null };
let timer = null;
let inFlight = null;
let onChange = () => {};
let onDeviceMissing = () => {};

export const status = () => state;

/** Is the server checking for due reminders? (cron-job.org must call /api/tick every minute) */
export const schedulerOk = () => !state.ok || (state.lastTick && state.serverTime - state.lastTick < 5 * MIN);

export function init(opts = {}) {
  onChange = opts.onChange || onChange;
  onDeviceMissing = opts.onDeviceMissing || onDeviceMissing;
  store.onLocalChange(() => schedule(1500));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(0); });
  window.addEventListener('online', () => schedule(0));
  setInterval(() => { if (!document.hidden) schedule(0); }, MIN);
  schedule(0);
}

export function schedule(delay = 1500) {
  clearTimeout(timer);
  timer = setTimeout(() => { syncNow().catch(() => {}); }, delay);
}

export async function syncNow() {
  if (inFlight) { await inFlight.catch(() => {}); }
  inFlight = run();
  try { return await inFlight; } finally { inFlight = null; }
}

async function run() {
  const rev = store.rev;
  const s = store.settings;
  try {
    const res = await fetch(apiUrl('api/sync'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account: store.account,
        deviceId: store.deviceId,
        tasks: store.tasks,
        deleted: store.deleted,
        settings: { remind: s.remind, email: s.email || '', at: s.syncAt || 0 },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    store.applyServer(data);
    state = { ok: true, at: Date.now(), email: data.email || state.email, error: null, lastTick: data.lastTick || null, serverTime: data.serverTime || Date.now() };
    if (data.device === false) onDeviceMissing();
    if (store.rev !== rev) schedule(500); // edited while we were syncing -> upload that too
    return true;
  } catch (e) {
    state = { ...state, ok: false, error: e.message };
    return false;
  } finally {
    onChange(state);
  }
}

export async function testEmail() {
  await syncNow();
  const res = await fetch(apiUrl('api/test-email'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: store.account }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return true;
}

/** "ab12cd34…" -> "ab12 cd34 …" so it's easy to read and type on another device. */
export const prettyCode = (c) => String(c).match(/.{1,4}/g).join(' ');
