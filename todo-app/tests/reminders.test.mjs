// The scheduler builds reminders from the tasks stored for each account: push + email, never twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import webpush from 'web-push';
import { createCore } from '../lib/core.js';

function memoryStore() {
  const devices = new Map();
  const accounts = new Map();
  const claims = new Set();
  return {
    devices, accounts,
    async get(id) { return devices.get(id) || null; },
    async put(id, d) { devices.set(id, d); },
    async remove(id) { devices.delete(id); },
    async all() { return [...devices]; },
    async getAccount(id) { return accounts.get(id) || null; },
    async putAccount(id, a) { accounts.set(id, a); },
    async allAccounts() { return [...accounts]; },
    async claim(k) { if (claims.has(k)) return false; claims.add(k); return true; },
  };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const keys = webpush.generateVAPIDKeys();

function setup({ allowed = 'me@example.com' } = {}) {
  const store = memoryStore();
  const mails = [];
  const mailer = { async send(m) { mails.push(m); } };
  const core = createCore({ store, vapid: keys, mailer, allowedEmails: allowed, appUrl: 'https://app.example' });
  return { store, mails, core };
}

const account = 'acct-reminders-0001';
const sync = (core, tasks, settings) => core.handle('POST', '/api/sync', { account, tasks, deleted: {}, settings });

test('emails the "at the time" and "hour before" reminders once', async () => {
  const { mails, core } = setup();
  const now = Date.now();
  await sync(core, [
    { id: 'due-now', title: 'اتصل بماما', due: now - 1000, createdAt: now - 2 * HOUR, updatedAt: now - 2 * HOUR },
    { id: 'in-hour', title: 'دكتور', due: now + HOUR - 1000, createdAt: now - 3 * HOUR, updatedAt: now - 3 * HOUR },
    { id: 'later', title: 'بعدين', due: now + 5 * HOUR, createdAt: now - HOUR, updatedAt: now - HOUR },
    { id: 'done', title: 'خلصت', due: now - 1000, done: true, createdAt: now - 2 * HOUR, updatedAt: now },
  ], { remind: { day: true, hour: true, due: true }, email: 'me@example.com', at: now });

  const sent = await core.runScheduler();
  assert.equal(sent, 2);
  assert.deepEqual(mails.map((m) => m.subject).sort(), ['🔔 دلوقتي: اتصل بماما', '🔔 كمان ساعة: دكتور']);
  assert.equal(mails[0].to, 'me@example.com');
  assert.match(mails[0].html, /dir="rtl"/);
  assert.match(mails[0].html, /https:\/\/app\.example/);

  assert.equal(await core.runScheduler(), 0, 'never sent twice');
  assert.equal(mails.length, 2);
});

test('no reminder for a task added after its reminder time, and respects the settings', async () => {
  const { mails, core } = setup();
  const now = Date.now();
  await sync(core, [
    // Added 5 minutes ago for 20 minutes from now: the "hour before" time already passed before it existed.
    { id: 'quick', title: 'سريعة', due: now + 20 * MIN, createdAt: now - 5 * MIN, updatedAt: now - 5 * MIN },
    { id: 'due', title: 'ميعادها جه', due: now - 1000, createdAt: now - 2 * HOUR, updatedAt: now - 2 * HOUR },
  ], { remind: { day: true, hour: true, due: false }, email: 'me@example.com', at: now });
  assert.equal(await core.runScheduler(), 0);
  assert.equal(mails.length, 0);
});

test('only allowed addresses get email', async () => {
  const { mails, core } = setup({ allowed: 'boss@example.com' });
  const now = Date.now();
  await sync(core, [{ id: 'a', title: 'x', due: now - 1000, createdAt: now - HOUR, updatedAt: now - HOUR }],
    { remind: { day: true, hour: true, due: true }, email: 'stranger@example.com', at: now });
  await core.runScheduler();
  assert.equal(mails.length, 0);
  const res = await core.handle('POST', '/api/test-email', { account });
  assert.equal(res.status, 403);
});

test('test email goes to the saved address', async () => {
  const { mails, core } = setup();
  await sync(core, [], { remind: {}, email: 'me@example.com', at: Date.now() });
  const res = await core.handle('POST', '/api/test-email', { account });
  assert.equal(res.status, 200);
  assert.equal(mails.length, 1);
});

test('sync reports when the scheduler last ran', async () => {
  const store = memoryStore();
  const meta = new Map();
  store.getMeta = async (k) => meta.get(k) ?? null;
  store.setMeta = async (k, v) => { meta.set(k, v); };
  const core = createCore({ store, vapid: keys });
  let res = await core.handle('POST', '/api/sync', { account, tasks: [] });
  assert.equal(res.data.lastTick, null);
  await core.runScheduler(12345);
  res = await core.handle('POST', '/api/sync', { account, tasks: [] });
  assert.equal(res.data.lastTick, 12345);
});

test('a task added minutes before its time still alerts at its time, even with "at the time" off', async () => {
  const { mails, core } = setup();
  const now = Date.now();
  await sync(core, [
    { id: 'quick', title: 'Test', due: now - 1000, createdAt: now - 2 * MIN, updatedAt: now - 2 * MIN },
    { id: 'planned', title: 'Planned', due: now - 1000, createdAt: now - 3 * HOUR, updatedAt: now - 3 * HOUR },
  ], { remind: { day: true, hour: true, due: false }, email: 'me@example.com', at: now });
  assert.equal(await core.runScheduler(), 1);
  assert.deepEqual(mails.map((m) => m.subject), ['🔔 دلوقتي: Test']);
});
