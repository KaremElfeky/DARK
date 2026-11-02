// Tiny persistent store (localStorage) with change subscriptions and cross-tab sync.
// It is also synced to the server (see sync.js): `account` is the sync code shared by your devices,
// `deleted` remembers removed tasks so other devices drop them too.

const KEY = 'mahami:v1';

const DEFAULT_SETTINGS = {
  remind: { day: true, hour: true, due: true },
  email: '',
  syncAt: 0, // when remind/email last changed (newest wins across devices)
  inkLang: 'ar',
  penOnly: 'auto', // 'auto' | 'on' | 'off'
  dismissed: {},
  lastReviewDay: null,
};

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const a = new Uint8Array(10);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const clone = (o) => JSON.parse(JSON.stringify(o));

function fresh() {
  return { v: 2, deviceId: uid(), account: uid() + uid().slice(0, 4), tasks: [], deleted: {}, settings: clone(DEFAULT_SETTINGS) };
}

const ACCOUNT_RE = /^[A-Za-z0-9_-]{16,64}$/;

function migrate(s) {
  const base = fresh();
  // v1 -> v2: "remind me at the task time" is now on by default.
  const remind = (s.v || 1) < 2 ? { ...(s.settings?.remind || {}), due: true } : s.settings?.remind;
  return {
    ...base,
    ...s,
    v: 2,
    deviceId: s.deviceId || base.deviceId,
    account: ACCOUNT_RE.test(s.account || '') ? s.account : base.account,
    deleted: s.deleted && typeof s.deleted === 'object' ? s.deleted : {},
    tasks: Array.isArray(s.tasks) ? s.tasks.filter((t) => t && t.id && typeof t.title === 'string') : [],
    settings: {
      ...base.settings,
      ...(s.settings || {}),
      remind: { ...base.settings.remind, ...(remind || {}) },
      dismissed: { ...(s.settings?.dismissed || {}) },
    },
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch { /* corrupted or unavailable storage */ }
  return fresh();
}

let state = load();
const listeners = new Set();
const localListeners = new Set(); // only local edits (these need uploading)
let rev = 0;

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Could not save tasks', e);
  }
}

function emit() {
  for (const fn of listeners) {
    try { fn(state); } catch (e) { console.error(e); }
  }
}

function commit() {
  rev++;
  persist();
  emit();
  for (const fn of localListeners) { try { fn(); } catch (e) { console.error(e); } }
}

const tombstone = (ids) => { const now = Date.now(); for (const id of ids) state.deleted[id] = now; };

/** Newest copy of each task wins; deleted tasks stay deleted. Same rule as the server. */
function mergeTasks(a, b, deleted) {
  const map = new Map(a.map((t) => [t.id, t]));
  for (const t of b) {
    const cur = map.get(t.id);
    if (!cur || (t.updatedAt || 0) > (cur.updatedAt || 0)) map.set(t.id, t);
  }
  for (const [id, at] of Object.entries(deleted)) {
    const t = map.get(id);
    if (t && (t.updatedAt || 0) <= at) map.delete(id);
  }
  return [...map.values()].sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
}

window.addEventListener('storage', (e) => {
  if (e.key === KEY) {
    state = load();
    emit();
  }
});

export const store = {
  get tasks() { return state.tasks; },
  get settings() { return state.settings; },
  get deviceId() { return state.deviceId; },
  get account() { return state.account; },
  get deleted() { return state.deleted; },
  get rev() { return rev; },

  get(id) { return state.tasks.find((t) => t.id === id) || null; },

  add({ title, due = null, source = 'text' }) {
    const now = Date.now();
    const task = {
      id: uid(),
      title: String(title).trim().slice(0, 500),
      due: due ?? null,
      done: false,
      doneAt: null,
      postponed: 0,
      source,
      createdAt: now,
      updatedAt: now,
    };
    state.tasks.push(task);
    commit();
    return task;
  },

  addMany(items) {
    const now = Date.now();
    const created = items.map((it, i) => ({
      id: uid(),
      title: String(it.title).trim().slice(0, 500),
      due: it.due ?? null,
      done: false,
      doneAt: null,
      postponed: 0,
      source: it.source || 'text',
      createdAt: now + i,
      updatedAt: now,
    }));
    state.tasks.push(...created);
    commit();
    return created;
  },

  update(id, patch) {
    const t = this.get(id);
    if (!t) return null;
    Object.assign(t, patch, { updatedAt: Date.now() });
    commit();
    return t;
  },

  updateMany(patches) {
    for (const [id, patch] of patches) {
      const t = this.get(id);
      if (t) Object.assign(t, patch, { updatedAt: Date.now() });
    }
    commit();
  },

  remove(id) {
    const i = state.tasks.findIndex((t) => t.id === id);
    if (i < 0) return null;
    const [t] = state.tasks.splice(i, 1);
    tombstone([t.id]);
    commit();
    return t;
  },

  removeMany(ids) {
    const set = new Set(ids);
    const removed = state.tasks.filter((t) => set.has(t.id));
    state.tasks = state.tasks.filter((t) => !set.has(t.id));
    tombstone(ids);
    commit();
    return removed;
  },

  restore(tasks) {
    const list = Array.isArray(tasks) ? tasks : [tasks];
    for (const t of list) {
      if (t && !this.get(t.id)) {
        delete state.deleted[t.id];
        state.tasks.push({ ...t, updatedAt: Date.now() });
      }
    }
    commit();
  },

  replaceTasks(tasks) {
    state.tasks = migrate({ tasks }).tasks;
    commit();
  },

  setSettings(patch) {
    const synced = 'remind' in patch || 'email' in patch;
    state.settings = {
      ...state.settings,
      ...patch,
      remind: { ...state.settings.remind, ...(patch.remind || {}) },
      dismissed: { ...state.settings.dismissed, ...(patch.dismissed || {}) },
      ...(synced ? { syncAt: Date.now() } : {}),
    };
    commit();
  },

  /** Merge what the server has (tasks from all your devices) into this device. */
  applyServer({ tasks, deleted, settings }) {
    state.deleted = { ...state.deleted };
    for (const [id, at] of Object.entries(deleted || {})) state.deleted[id] = Math.max(state.deleted[id] || 0, at);
    const merged = mergeTasks(state.tasks, migrate({ tasks: tasks || [] }).tasks, state.deleted);
    const changed = JSON.stringify(merged) !== JSON.stringify(state.tasks);
    state.tasks = merged;
    if (settings && (settings.at || 0) > (state.settings.syncAt || 0)) {
      state.settings = { ...state.settings, remind: { ...state.settings.remind, ...settings.remind }, email: settings.email || '', syncAt: settings.at };
    }
    persist();
    if (changed) emit();
  },

  /** Use another device's sync code (its tasks get merged with the ones here). */
  setAccount(code) {
    const c = String(code || '').replace(/[\s-]+/g, '');
    if (!ACCOUNT_RE.test(c)) return false;
    state.account = c;
    commit();
    return true;
  },

  onLocalChange(fn) {
    localListeners.add(fn);
    return () => localListeners.delete(fn);
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
