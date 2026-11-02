// Tiny persistent store (localStorage) with change subscriptions and cross-tab sync.

const KEY = 'mahami:v1';

const DEFAULT_SETTINGS = {
  remind: { day: true, hour: true, due: false },
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
  return { v: 1, deviceId: uid(), tasks: [], settings: clone(DEFAULT_SETTINGS) };
}

function migrate(s) {
  const base = fresh();
  return {
    ...base,
    ...s,
    deviceId: s.deviceId || base.deviceId,
    tasks: Array.isArray(s.tasks) ? s.tasks.filter((t) => t && t.id && typeof t.title === 'string') : [],
    settings: {
      ...base.settings,
      ...(s.settings || {}),
      remind: { ...base.settings.remind, ...(s.settings?.remind || {}) },
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
  persist();
  emit();
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
    commit();
    return t;
  },

  removeMany(ids) {
    const set = new Set(ids);
    const removed = state.tasks.filter((t) => set.has(t.id));
    state.tasks = state.tasks.filter((t) => !set.has(t.id));
    commit();
    return removed;
  },

  restore(tasks) {
    const list = Array.isArray(tasks) ? tasks : [tasks];
    for (const t of list) {
      if (t && !this.get(t.id)) state.tasks.push(t);
    }
    commit();
  },

  replaceTasks(tasks) {
    state.tasks = migrate({ tasks }).tasks;
    commit();
  },

  setSettings(patch) {
    state.settings = {
      ...state.settings,
      ...patch,
      remind: { ...state.settings.remind, ...(patch.remind || {}) },
      dismissed: { ...state.settings.dismissed, ...(patch.dismissed || {}) },
    };
    commit();
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
