import { store } from './store.js';
import {
  parseWhen, fmtDue, fmtTime, dayLabel, relative, num, countTasks, count, longDate,
  startOfDay, addDays, atTime, sameDay, roundUp, toDateInput, toTimeInput, fromInputs,
  defaultTodayTime, weekday, shortDay, HOUR, MIN, DAY,
} from './dates.js';
import { icon } from './icons.js';
import { $, $$, esc, openSheet, sheetOpen, toast, vibrate, autoDir } from './ui.js';
import * as notify from './notify.js';
import { openInk, isOpen as inkIsOpen } from './ink.js';
import { downloadICS, downloadBlob } from './calendar.js';

const listEl = $('#list');
const bannerEl = $('#banner');
const form = $('#composer');
const input = $('#newTitle');
const previewEl = $('#composerPreview');
const whenBtn = $('#whenBtn');

let composerDue; // undefined = auto-detect from text, null = explicitly none, number = chosen
let composerAutoOff = false; // user dismissed the auto-detected date
const completing = new Set();
let doneOpen = false;

/* ================================================================== */
/* Helpers                                                             */
/* ================================================================== */

const tasks = () => store.tasks;
const overdueTasks = (now = Date.now()) => tasks()
  .filter((t) => !t.done && t.due && t.due < now)
  .sort((a, b) => a.due - b.due);

function postponedLabel(n) {
  return n === 1 ? 'اتأجلت مرة' : `اتأجلت ${count(n, ['مرة', 'مرتين', 'مرات', 'مرة'])}`;
}

function remindersSummary(due, now = Date.now()) {
  const s = store.settings;
  const parts = [];
  if (s.remind.day && due - DAY > now) parts.push(`${fmtDue(due - DAY, now)} (قبلها بيوم)`);
  if (s.remind.hour && due - HOUR > now) parts.push(`${fmtDue(due - HOUR, now)} (قبلها بساعة)`);
  if (s.remind.due && due > now) parts.push(`${fmtDue(due, now)} (في الميعاد)`);
  return parts;
}

/* ================================================================== */
/* Rendering                                                           */
/* ================================================================== */

function render() {
  const now = Date.now();
  $('#todayLabel').textContent = longDate(now);
  renderBell();
  renderBanner(now);
  renderList(now);
  const od = overdueTasks(now).length;
  const today = tasks().filter((t) => !t.done && t.due && t.due >= now && sameDay(t.due, now)).length;
  notify.setBadge(od + today);
  document.title = od ? `(${num(od)}) مهامي` : 'مهامي';
}

function renderBell() {
  const st = notify.status();
  const btn = $('#bellBtn');
  const on = st === 'push' || st === 'local';
  btn.innerHTML = `${icon(on ? 'bell' : 'bellOff')}${on ? '<span class="dot"></span>' : ''}`;
  btn.setAttribute('aria-label', on ? 'الإشعارات شغالة' : 'فعّل الإشعارات');
}

function renderBanner(now) {
  const parts = [];
  const od = overdueTasks(now).length;
  if (od) {
    parts.push(`
      <div class="banner banner-danger">
        ${icon('alert')}
        <div class="banner-text">
          <b>${od === 1 ? 'في مهمة فاتت ومخلصتش' : `في ${countTasks(od)} فاتت ومخلصتش`}</b>
          <span>خلصتها؟ تأجلها؟ ولا تشيلها خالص؟</span>
        </div>
        <button type="button" class="btn small danger-solid" data-b="review">راجعهم</button>
      </div>`);
  }

  const st = notify.status();
  const hasUpcoming = tasks().some((t) => !t.done && t.due && t.due > now);
  const dismissed = store.settings.dismissed;
  if (hasUpcoming && !dismissed.notif) {
    if (st === 'needs-install') {
      parts.push(`
        <div class="banner banner-accent">
          ${icon('bell')}
          <div class="banner-text">
            <b>عشان الإشعارات توصلك على الآيباد/الآيفون</b>
            <span>اضغط ${icon('share', 'inline')} «مشاركة» ← «إضافة إلى الشاشة الرئيسية»، وافتح مهامي من الأيقونة.</span>
          </div>
          <button type="button" class="icon-btn ghost small" data-b="dismiss-notif" aria-label="مش دلوقتي">${icon('x')}</button>
        </div>`);
    } else if (st === 'default') {
      parts.push(`
        <div class="banner banner-accent">
          ${icon('bell')}
          <div class="banner-text">
            <b>فعّل الإشعارات</b>
            <span>هفكرك قبل كل مهمة بيوم وقبلها بساعة.</span>
          </div>
          <button type="button" class="btn small primary" data-b="enable">فعّل</button>
          <button type="button" class="icon-btn ghost small" data-b="dismiss-notif" aria-label="مش دلوقتي">${icon('x')}</button>
        </div>`);
    }
  }
  bannerEl.innerHTML = parts.join('');
}

function taskRow(t, now) {
  const overdue = !t.done && t.due && t.due < now;
  const meta = [];
  if (t.due) {
    if (overdue) {
      meta.push(`<span class="chip chip-danger">${icon('clock')}${esc(relative(t.due, now))}</span>`);
      meta.push(`<span class="meta-text">${esc(fmtDue(t.due, now))}</span>`);
    } else {
      meta.push(`<span class="chip ${t.done ? '' : 'chip-soft'}">${icon('clock')}${esc(fmtDue(t.due, now))}</span>`);
      if (!t.done && notify.upcomingFor(t, store.settings, now).length && ['push', 'local'].includes(notify.status())) {
        meta.push(`<span class="chip chip-icon" title="هيوصلك تنبيه">${icon('bell')}</span>`);
      }
    }
  }
  if (!t.done && t.postponed) meta.push(`<span class="meta-text">${esc(postponedLabel(t.postponed))}</span>`);
  if (t.source === 'ink') meta.push(`<span class="meta-text" title="مكتوبة بالقلم">${icon('pen', 'tiny')}</span>`);

  return `
    <li class="task${t.done ? ' done' : ''}${overdue ? ' overdue' : ''}${completing.has(t.id) ? ' completing' : ''}" data-id="${t.id}">
      <button type="button" class="check" data-act="toggle" aria-label="${t.done ? 'رجّعها مش خلصانة' : 'خلصت'}" aria-pressed="${t.done}">${icon('check')}</button>
      <button type="button" class="task-main" data-act="edit">
        <span class="task-title" dir="auto">${esc(t.title)}</span>
        ${meta.length ? `<span class="task-meta">${meta.join('')}</span>` : ''}
      </button>
      ${overdue ? `
        <div class="task-quick">
          <button type="button" class="mini" data-act="postpone" aria-label="أجّل">${icon('later')}<span>أجّل</span></button>
          <button type="button" class="mini danger" data-act="delete" aria-label="شيلها">${icon('trash')}<span>شيلها</span></button>
        </div>` : ''}
    </li>`;
}

function group(key, title, list, now, extra = '') {
  if (!list.length) return '';
  return `
    <section class="group group-${key}">
      <h2 class="group-title"><span>${title}</span><span class="count">${num(list.length)}</span></h2>
      <ul class="tasks">${list.map((t) => taskRow(t, now)).join('')}</ul>
      ${extra}
    </section>`;
}

function renderList(now) {
  const open = tasks().filter((t) => !t.done || completing.has(t.id));
  const buckets = { overdue: [], today: [], tomorrow: [], later: [], someday: [] };
  const tomorrow = addDays(now, 1);
  for (const t of open) {
    if (!t.due) buckets.someday.push(t);
    else if (t.due < now && !t.done) buckets.overdue.push(t);
    else if (sameDay(t.due, now)) buckets.today.push(t);
    else if (sameDay(t.due, tomorrow)) buckets.tomorrow.push(t);
    else if (t.due < now) buckets.today.push(t); // completing animation of an overdue task
    else buckets.later.push(t);
  }
  for (const k of ['overdue', 'today', 'tomorrow', 'later']) buckets[k].sort((a, b) => a.due - b.due);
  buckets.someday.sort((a, b) => a.createdAt - b.createdAt);
  const done = tasks().filter((t) => t.done && !completing.has(t.id)).sort((a, b) => b.doneAt - a.doneAt);

  if (!open.length && !done.length) {
    listEl.innerHTML = `
      <div class="empty">
        <div class="empty-art">${icon('pen')}</div>
        <h2>ابدأ بأول مهمة</h2>
        <p>اكتبها فوق، أو اضغط <b>«اكتب بالقلم»</b> واكتبها بخط إيدك.</p>
        <div class="examples">
          <span>جرّب:</span>
          <button type="button" class="chip" data-example="ادفع فاتورة النت بكرة ٨م">ادفع فاتورة النت بكرة ٨م</button>
          <button type="button" class="chip" data-example="اتصل بماما النهارده بالليل">اتصل بماما النهارده بالليل</button>
          <button type="button" class="chip" data-example="جيم بعد ساعتين">جيم بعد ساعتين</button>
        </div>
      </div>`;
    return;
  }

  let html = '';
  html += group('overdue', 'فاتت ومخلصتش', buckets.overdue, now,
    buckets.overdue.length > 1 ? `<div class="group-actions"><button type="button" class="btn small" data-act="review">${icon('later')} راجعهم كلهم مرة واحدة</button></div>` : '');
  html += group('today', 'النهارده', buckets.today, now);
  html += group('tomorrow', 'بكرة', buckets.tomorrow, now);
  html += group('later', 'الأيام الجاية', buckets.later, now);
  html += group('someday', 'من غير ميعاد', buckets.someday, now);

  if (!open.length) {
    html = `<div class="empty small"><div class="empty-art ok">${icon('check')}</div><h2>كله خلصان!</h2><p>عاش يا بطل 👏</p></div>` + html;
  }

  if (done.length) {
    html += `
      <details class="group group-done" ${doneOpen ? 'open' : ''}>
        <summary class="group-title"><span>خلصت</span><span class="count">${num(done.length)}</span>${icon('chevron', 'chev')}</summary>
        <ul class="tasks">${done.slice(0, 100).map((t) => taskRow(t, now)).join('')}</ul>
        <div class="group-actions"><button type="button" class="btn small ghost" data-act="clear-done">${icon('trash')} امسح اللي خلصت</button></div>
      </details>`;
  }
  listEl.innerHTML = html;
}

/* ================================================================== */
/* Actions                                                             */
/* ================================================================== */

function toggleDone(id) {
  const t = store.get(id);
  if (!t) return;
  if (!t.done) {
    vibrate(15);
    completing.add(id);
    store.update(id, { done: true, doneAt: Date.now() });
    setTimeout(() => { completing.delete(id); render(); }, 700);
    toast('عاش! خلصتها ✓', { action: () => store.update(id, { done: false, doneAt: null }) });
  } else {
    store.update(id, { done: false, doneAt: null });
  }
}

function removeTask(id, { silent = false } = {}) {
  const t = store.remove(id);
  if (t && !silent) toast('اتشالت', { action: () => store.restore(t) });
  return t;
}

function postpone(id, ts) {
  const t = store.get(id);
  if (!t) return;
  const prev = { due: t.due, postponed: t.postponed || 0 };
  store.update(id, { due: ts, postponed: prev.postponed + 1 });
  toast(`اتأجلت لـ ${fmtDue(ts)}`, { action: () => store.update(id, prev) });
}

function postponeOptions(t, now = Date.now()) {
  const opts = [];
  if (t.due && t.due > now) {
    // Not late yet: push it later relative to its own time.
    opts.push({ label: 'ساعة كمان', ts: t.due + HOUR });
    opts.push({ label: 'يوم كمان', ts: addDays(t.due, 1).getTime() });
    opts.push({ label: 'أسبوع كمان', ts: addDays(t.due, 7).getTime() });
    return opts;
  }
  const d = t.due ? new Date(t.due) : null;
  const h = d ? d.getHours() : 9;
  const m = d ? d.getMinutes() : 0;
  opts.push({ label: 'ساعة كمان', ts: roundUp(now + HOUR, 5 * MIN) });
  const tonight = atTime(now, 21, 0);
  if (tonight - now > 90 * MIN) opts.push({ label: 'النهارده بالليل', ts: tonight });
  opts.push({ label: 'بكرة', ts: atTime(addDays(now, 1), h, m) });
  opts.push({ label: 'بعد بكرة', ts: atTime(addDays(now, 2), h, m) });
  opts.push({ label: 'الأسبوع الجاي', ts: atTime(addDays(now, 7), h, m) });
  return opts;
}

function postponeButtons(t) {
  const now = Date.now();
  return postponeOptions(t, now).map((o) => `
    <button type="button" class="opt" data-ts="${o.ts}">
      <b>${esc(o.label)}</b><span>${esc(fmtDue(o.ts, now))}</span>
    </button>`).join('') + `
    <button type="button" class="opt" data-custom>
      <b>${icon('calendar')} ميعاد تاني</b><span>اختار يوم وساعة</span>
    </button>`;
}

/* ---------------- When picker ---------------- */

function whenPickerHTML() {
  const now = Date.now();
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(startOfDay(now), i).getTime();
    const label = i === 0 ? 'النهارده' : i === 1 ? 'بكرة' : weekday(d);
    days.push(`<button type="button" class="pick" data-day="${toDateInput(d)}"><b>${label}</b><small>${shortDay(d)}</small></button>`);
  }
  const times = [['09:00', 9], ['12:00', 12], ['15:00', 15], ['18:00', 18], ['21:00', 21]]
    .map(([v, h]) => `<button type="button" class="pick" data-time="${v}"><b>${fmtTime(atTime(now, h))}</b></button>`);
  return `
    <div class="when">
      <div class="when-summary" aria-live="polite"></div>
      <div class="chip-row" role="group" aria-label="اليوم">${days.join('')}</div>
      <div class="chip-row" role="group" aria-label="الساعة">${times.join('')}</div>
      <div class="when-inputs">
        <label class="input-icon">${icon('calendar')}<input type="date" class="input" data-w="date" aria-label="التاريخ"></label>
        <label class="input-icon">${icon('clock')}<input type="time" class="input" data-w="time" step="300" aria-label="الساعة"></label>
      </div>
      <button type="button" class="link-btn" data-w="clear">${icon('x')} من غير ميعاد</button>
    </div>`;
}

function bindWhenPicker(root, initial, onChange) {
  let dateStr = initial ? toDateInput(initial) : '';
  let timeStr = initial ? toTimeInput(initial) : '';
  const dateIn = $('[data-w="date"]', root);
  const timeIn = $('[data-w="time"]', root);
  const summary = $('.when-summary', root);

  const value = () => (dateStr ? fromInputs(dateStr, timeStr || '09:00') : null);

  function sync() {
    dateIn.value = dateStr;
    timeIn.value = timeStr;
    for (const b of $$('[data-day]', root)) b.setAttribute('aria-pressed', String(b.dataset.day === dateStr));
    for (const b of $$('[data-time]', root)) b.setAttribute('aria-pressed', String(b.dataset.time === timeStr));
    const v = value();
    summary.innerHTML = v
      ? `${icon('clock')}<b>${esc(fmtDue(v))}</b><span>${esc(relative(v))}</span>`
      : `<span class="muted">من غير ميعاد — مش هيوصلك تنبيه</span>`;
    summary.classList.toggle('past', !!v && v < Date.now());
    onChange?.(v);
  }

  function defaultTimeFor(day) {
    const now = Date.now();
    if (day === toDateInput(now)) return toTimeInput(defaultTodayTime(now));
    return '09:00';
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !root.contains(b)) return;
    if (b.dataset.day) {
      dateStr = b.dataset.day;
      if (!timeStr) timeStr = defaultTimeFor(dateStr);
    } else if (b.dataset.time) {
      timeStr = b.dataset.time;
      if (!dateStr) {
        const now = Date.now();
        dateStr = toDateInput(now);
        if (fromInputs(dateStr, timeStr) <= now) dateStr = toDateInput(addDays(now, 1));
      }
    } else if (b.dataset.w === 'clear') {
      dateStr = '';
      timeStr = '';
    } else return;
    sync();
  });
  dateIn.addEventListener('change', () => {
    dateStr = dateIn.value;
    if (dateStr && !timeStr) timeStr = defaultTimeFor(dateStr);
    sync();
  });
  timeIn.addEventListener('change', () => {
    timeStr = timeIn.value;
    if (timeStr && !dateStr) dateStr = toDateInput(Date.now());
    sync();
  });
  sync();
  return { value };
}

/* ---------------- Sheets ---------------- */

function openPostpone(id) {
  const t = store.get(id);
  if (!t) return;
  openSheet({
    title: 'أجّلها لإمتى؟',
    body: `
      <p class="sheet-task" dir="auto">${esc(t.title)}</p>
      <div class="opts">${postponeButtons(t)}</div>
      <div class="custom-when" hidden>${whenPickerHTML()}<button type="button" class="btn primary block" data-save>أجّل للميعاد ده</button></div>
      <button type="button" class="link-btn danger" data-delete>${icon('trash')} ولا أقولك، شيلها خالص</button>`,
    onMount(el, ctl) {
      let picker = null;
      el.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.ts) { postpone(id, Number(b.dataset.ts)); ctl.close(); }
        else if ('custom' in b.dataset) {
          const box = $('.custom-when', el);
          box.hidden = false;
          picker = picker || bindWhenPicker(box, t.due && t.due > Date.now() ? t.due : addDays(Date.now(), 1).setHours(9, 0, 0, 0));
          box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else if ('save' in b.dataset && picker) {
          const v = picker.value();
          if (v) postpone(id, v);
          else store.update(id, { due: null });
          ctl.close();
        } else if ('delete' in b.dataset) { removeTask(id); ctl.close(); }
      });
    },
  });
}

function openReview() {
  let openId = null;
  let unsub = null;
  const ctl = openSheet({
    title: 'حاجات فاتت ومخلصتش',
    className: 'sheet-review',
    body: '',
    onClose: () => unsub?.(),
  });

  function draw() {
    const now = Date.now();
    const items = overdueTasks(now);
    if (!items.length) {
      ctl.setBody(`<div class="empty small"><div class="empty-art ok">${icon('check')}</div><h2>كله تمام!</h2><p>مفيش حاجة متأخرة.</p></div>`);
      setTimeout(() => ctl.close(), 1100);
      unsub?.();
      return;
    }
    ctl.setBody(`
      <p class="sheet-sub">لكل مهمة اختار: خلصتها، تأجلها، ولا تشيلها خالص.</p>
      ${items.map((t) => `
        <article class="review-card" data-id="${t.id}">
          <div class="review-title" dir="auto">${esc(t.title)}</div>
          <div class="review-when">${icon('clock')}كانت ${esc(fmtDue(t.due, now))} · ${esc(relative(t.due, now))}</div>
          <div class="review-actions">
            <button type="button" class="btn ok" data-r="done">${icon('check')}خلصتها</button>
            <button type="button" class="btn" data-r="postpone" aria-expanded="${openId === t.id}">${icon('later')}أجّلها</button>
            <button type="button" class="btn danger-ghost" data-r="delete">${icon('trash')}شيلها</button>
          </div>
          <div class="review-postpone opts" ${openId === t.id ? '' : 'hidden'}>${postponeButtons(t)}</div>
          <div class="custom-when" hidden>${whenPickerHTML()}<button type="button" class="btn primary block" data-save>أجّل للميعاد ده</button></div>
        </article>`).join('')}
      ${items.length > 1 ? `
        <div class="review-bulk">
          <button type="button" class="btn" data-r="all-tomorrow">${icon('later')}أجّل الكل لبكرة</button>
          <button type="button" class="btn danger-ghost" data-r="all-delete">${icon('trash')}شيل الكل</button>
        </div>` : ''}`);
  }

  const pickers = new Map();
  ctl.el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const card = b.closest('.review-card');
    const id = card?.dataset.id;
    const r = b.dataset.r;
    if (r === 'done') { vibrate(15); store.update(id, { done: true, doneAt: Date.now() }); toast('عاش! خلصتها ✓', { action: () => store.update(id, { done: false, doneAt: null }) }); }
    else if (r === 'delete') removeTask(id);
    else if (r === 'postpone') { openId = openId === id ? null : id; draw(); }
    else if (b.dataset.ts && id) { openId = null; postpone(id, Number(b.dataset.ts)); }
    else if ('custom' in b.dataset && card) {
      const box = $('.custom-when', card);
      box.hidden = false;
      if (!pickers.has(id)) pickers.set(id, bindWhenPicker(box, addDays(Date.now(), 1).setHours(9, 0, 0, 0)));
    } else if ('save' in b.dataset && card) {
      const v = pickers.get(id)?.value();
      openId = null;
      if (v) postpone(id, v); else store.update(id, { due: null });
    } else if (r === 'all-tomorrow') {
      const items = overdueTasks();
      const prev = items.map((t) => [t.id, { due: t.due, postponed: t.postponed || 0 }]);
      store.updateMany(items.map((t) => {
        const d = new Date(t.due);
        return [t.id, { due: atTime(addDays(Date.now(), 1), d.getHours(), d.getMinutes()), postponed: (t.postponed || 0) + 1 }];
      }));
      toast(`اتأجلت ${countTasks(items.length)} لبكرة`, { action: () => store.updateMany(prev) });
    } else if (r === 'all-delete') {
      const removed = store.removeMany(overdueTasks().map((t) => t.id));
      toast(`اتشالت ${countTasks(removed.length)}`, { action: () => store.restore(removed) });
    }
  });

  draw();
  unsub = store.subscribe(() => { if (!ctl.closed) draw(); });
}

function openEdit(id) {
  const t = store.get(id);
  if (!t) return;
  let picker;
  openSheet({
    title: 'تعديل المهمة',
    body: `
      <label class="field">
        <span>المهمة</span>
        <textarea class="input" id="eTitle" rows="2" dir="auto">${esc(t.title)}</textarea>
      </label>
      <div class="field"><span>الميعاد</span>${whenPickerHTML()}</div>
      <div class="reminder-info" id="eRem"></div>
      <button type="button" class="btn primary block" data-e="save">حفظ</button>
      <div class="row-actions">
        <button type="button" class="btn" data-e="toggle">${t.done ? `${icon('undo')}رجّعها` : `${icon('check')}خلصتها`}</button>
        ${!t.done ? `<button type="button" class="btn" data-e="postpone">${icon('later')}أجّل</button>` : ''}
        ${t.due && !t.done ? `<button type="button" class="btn" data-e="ics">${icon('calendar')}ضيفها للتقويم</button>` : ''}
        <button type="button" class="btn danger-ghost" data-e="delete">${icon('trash')}امسحها</button>
      </div>`,
    onMount(el, ctl) {
      const rem = $('#eRem', el);
      picker = bindWhenPicker($('.when', el), t.due, (v) => {
        if (!rem) return;
        if (!v) { rem.innerHTML = ''; return; }
        const st = notify.status();
        const list = remindersSummary(v);
        if (st !== 'push' && st !== 'local') {
          rem.innerHTML = `${icon('bellOff')}<span>الإشعارات مش متفعلة — فعّلها من ${icon('settings', 'inline')} عشان أفكرك.</span>`;
        } else if (list.length) {
          rem.innerHTML = `${icon('bell')}<span>هيوصلك تنبيه: ${list.map(esc).join(' · ')}</span>`;
        } else {
          rem.innerHTML = `${icon('bell')}<span>الميعاد قريب أوي — مفيش تنبيهات فاضلة قبله.</span>`;
        }
      });
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-e]');
        if (!b) return;
        const act = b.dataset.e;
        if (act === 'save') {
          const title = $('#eTitle', el).value.trim();
          if (!title) { $('#eTitle', el).focus(); return; }
          store.update(id, { title, due: picker.value() });
          ctl.close();
          toast('اتحفظت ✓');
        } else if (act === 'toggle') { ctl.close(); toggleDone(id); }
        else if (act === 'postpone') { ctl.close(); setTimeout(() => openPostpone(id), 280); }
        else if (act === 'delete') { ctl.close(); removeTask(id); }
        else if (act === 'ics') downloadICS([store.get(id)], store.settings, 'mahami-task.ics');
      });
    },
  });
}

function openComposerWhen() {
  const parsed = parseWhen(input.value);
  const initial = composerDue !== undefined ? composerDue : (!composerAutoOff ? parsed.due : null);
  let picker;
  openSheet({
    title: 'امتى؟',
    body: `${whenPickerHTML()}<button type="button" class="btn primary block" data-ok>تمام</button>`,
    onMount(el, ctl) {
      picker = bindWhenPicker($('.when', el), initial);
      $('[data-ok]', el).addEventListener('click', () => {
        composerDue = picker.value();
        updatePreview();
        ctl.close();
        input.focus({ preventScroll: true });
      });
    },
  });
}

function openSettings() {
  const ctl = openSheet({ title: 'الإعدادات', className: 'sheet-settings', body: '' });

  function draw() {
    const s = store.settings;
    const st = notify.status();
    const statusHTML = {
      push: `<div class="status ok">${icon('bell')}<div><b>الإشعارات شغالة</b><span>هتوصلك حتى لو الأبلكيشن مقفول.</span></div></div>`,
      local: `<div class="status warn">${icon('bell')}<div><b>الإشعارات شغالة وانت فاتح الأبلكيشن بس</b><span>${notify.serverAvailable() ? 'المتصفح ده مش بيدعم إشعارات الخلفية.' : 'عشان توصلك والأبلكيشن مقفول لازم سيرفر الإشعارات يكون شغال (شوف README).'} وكحل احتياطي: صدّر المهام للتقويم تحت.</span></div></div>`,
      default: `<div class="status">${icon('bellOff')}<div><b>الإشعارات مقفولة</b><span>فعّلها عشان أفكرك قبل كل مهمة.</span></div><button type="button" class="btn small primary" data-s="enable">فعّل</button></div>`,
      denied: `<div class="status bad">${icon('bellOff')}<div><b>انت رافض الإشعارات</b><span>افتحها من إعدادات المتصفح/الجهاز للموقع ده وارجع هنا.</span></div></div>`,
      'needs-install': `<div class="status warn">${icon('share')}<div><b>لازم تضيف الأبلكيشن للشاشة الرئيسية</b><span>في Safari: اضغط «مشاركة» ← «إضافة إلى الشاشة الرئيسية»، وبعدين افتحه من الأيقونة وفعّل الإشعارات.</span></div></div>`,
      unsupported: `<div class="status bad">${icon('bellOff')}<div><b>المتصفح ده مش بيدعم الإشعارات</b><span>استخدم تصدير التقويم تحت كبديل.</span></div></div>`,
    }[st];

    ctl.setBody(`
      <section class="set-group">
        <h3>الإشعارات</h3>
        ${statusHTML}
        <label class="switch"><span>قبل المهمة بيوم</span><input type="checkbox" role="switch" data-remind="day" ${s.remind.day ? 'checked' : ''}></label>
        <label class="switch"><span>قبل المهمة بساعة</span><input type="checkbox" role="switch" data-remind="hour" ${s.remind.hour ? 'checked' : ''}></label>
        <label class="switch"><span>في الميعاد نفسه</span><input type="checkbox" role="switch" data-remind="due" ${s.remind.due ? 'checked' : ''}></label>
        ${st === 'push' || st === 'local' ? `<button type="button" class="btn small" data-s="test">${icon('bell')}جرّب إشعار</button>` : ''}
      </section>

      <section class="set-group">
        <h3>الكتابة بالقلم</h3>
        <div class="set-row"><span>لغة الخط</span>
          <div class="seg" role="group">
            <button type="button" data-ink-lang="ar" aria-pressed="${s.inkLang === 'ar'}">عربي</button>
            <button type="button" data-ink-lang="en" aria-pressed="${s.inkLang === 'en'}">English</button>
          </div>
        </div>
        <div class="set-row"><span>تجاهل لمس الإيد <small>(القلم بس)</small></span>
          <div class="seg" role="group">
            <button type="button" data-pen="auto" aria-pressed="${s.penOnly === 'auto'}">تلقائي</button>
            <button type="button" data-pen="on" aria-pressed="${s.penOnly === 'on'}">القلم بس</button>
            <button type="button" data-pen="off" aria-pressed="${s.penOnly === 'off'}">الكل</button>
          </div>
        </div>
        <p class="hint">«تلقائي»: أول ما تكتب بالقلم، لمس الإيد بيتجاهل عشان كفك ميرسمش.</p>
      </section>

      <section class="set-group">
        <h3>التقويم</h3>
        <p class="hint">نزّل المهام اللي ليها ميعاد كملف تقويم بتنبيهات قبلها بيوم وبساعة — تقويم الجهاز هيفكرك حتى من غير نت.</p>
        <button type="button" class="btn" data-s="ics">${icon('calendar')}صدّر المهام للتقويم</button>
      </section>

      <section class="set-group">
        <h3>بياناتك</h3>
        <p class="hint">المهام محفوظة على الجهاز ده. خد نسخة احتياطية من وقت للتاني.</p>
        <div class="row-actions">
          <button type="button" class="btn" data-s="export">${icon('download')}نسخة احتياطية</button>
          <button type="button" class="btn" data-s="import">${icon('upload')}رجّع نسخة</button>
        </div>
        <input type="file" accept="application/json,.json" hidden data-s-file>
      </section>`);
  }

  ctl.el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.remind) store.setSettings({ remind: { [t.dataset.remind]: t.checked } });
    if ('sFile' in t.dataset && t.files?.[0]) importBackup(t.files[0]);
  });
  ctl.el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.inkLang) { store.setSettings({ inkLang: b.dataset.inkLang }); draw(); }
    else if (b.dataset.pen) { store.setSettings({ penOnly: b.dataset.pen }); draw(); }
    else if (b.dataset.s === 'enable') { await enableNotifications(); draw(); }
    else if (b.dataset.s === 'test') {
      try {
        const via = await notify.sendTest();
        toast(via === 'push' ? 'اتبعت إشعار تجربة من السيرفر' : 'اتبعت إشعار تجربة');
      } catch { toast('معرفتش أبعت الإشعار — جرب تاني'); }
    } else if (b.dataset.s === 'ics') {
      const n = tasks().filter((t) => t.due && !t.done).length;
      if (!n) { toast('مفيش مهام ليها ميعاد'); return; }
      downloadICS(tasks(), store.settings);
    } else if (b.dataset.s === 'export') {
      const data = JSON.stringify({ app: 'mahami', exportedAt: new Date().toISOString(), tasks: tasks() }, null, 2);
      downloadBlob(new Blob([data], { type: 'application/json' }), `mahami-backup-${toDateInput(Date.now())}.json`);
    } else if (b.dataset.s === 'import') {
      $('[data-s-file]', ctl.el).click();
    }
  });
  draw();
}

async function importBackup(file) {
  try {
    const json = JSON.parse(await file.text());
    const list = Array.isArray(json) ? json : json.tasks;
    if (!Array.isArray(list)) throw new Error('bad');
    const existing = new Set(tasks().map((t) => t.id));
    const fresh = list.filter((t) => t && t.id && typeof t.title === 'string' && !existing.has(t.id));
    store.replaceTasks([...tasks(), ...fresh]);
    toast(`اترجعت ${countTasks(fresh.length)}`);
  } catch {
    toast('الملف ده مش نسخة احتياطية سليمة');
  }
}

async function enableNotifications() {
  const st = await notify.enable();
  render();
  if (st === 'push') toast('تمام! هفكرك قبل كل مهمة بيوم وبساعة 🔔');
  else if (st === 'local') toast('الإشعارات اتفعلت (وانت فاتح الأبلكيشن)');
  else if (st === 'denied') toast('الإشعارات اترفضت — تقدر تفتحها من إعدادات المتصفح');
  return st;
}

/* ---------------- Handwriting ---------------- */

function startInk() {
  openInk({
    getLang: () => store.settings.inkLang,
    setLang: (l) => store.setSettings({ inkLang: l }),
    penOnly: () => store.settings.penOnly,
    onResult: reviewInk,
    onError: (retry) => {
      openSheet({
        title: 'معرفتش أحوّل الكتابة',
        body: `
          <div class="empty small"><div class="empty-art bad">${icon('wifiOff')}</div>
          <p>التحويل محتاج إنترنت. اتأكد إن النت شغال وجرب تاني — خطك لسه موجود مش هيضيع.</p></div>
          <button type="button" class="btn primary block" data-retry>جرب تاني</button>`,
        onMount(el, ctl) { $('[data-retry]', el).onclick = () => { ctl.close(); retry(); }; },
      });
    },
  });
}

function reviewInk(results, inkApi) {
  const rows = results.map((r, i) => {
    const first = r.candidates[0] || '';
    const alts = r.candidates.slice(1, 5);
    return `
      <div class="ink-item" data-i="${i}">
        <div class="ink-thumb">${r.svg}</div>
        <div class="ink-item-main">
          <input class="input" type="text" value="${esc(first)}" placeholder="${r.error ? 'معرفتش أقراها — اكتبها هنا' : 'المهمة'}" dir="auto">
          ${alts.length ? `<div class="cands" aria-label="اقتراحات تانية">${alts.map((c) => `<button type="button" class="cand" data-cand="${esc(c)}" dir="auto">${esc(c)}</button>`).join('')}</div>` : ''}
          <div class="ink-due"></div>
        </div>
        <button type="button" class="icon-btn ghost small" data-x aria-label="شيل السطر ده">${icon('x')}</button>
      </div>`;
  }).join('');

  openSheet({
    title: 'راجع قبل ما أضيفهم',
    className: 'sheet-ink',
    body: `<p class="sheet-sub">صحّح أي كلمة لو محتاج — أو اختار من الاقتراحات.</p><div class="ink-items">${rows}</div>`,
    footer: `<button type="button" class="btn primary block" data-add></button><button type="button" class="btn ghost block" data-back>ارجع للكتابة</button>`,
    onMount(el, ctl) {
      const addBtn = $('[data-add]', el);
      const refresh = () => {
        let n = 0;
        for (const item of $$('.ink-item', el)) {
          const inp = $('input', item);
          const p = parseWhen(inp.value);
          if (inp.value.trim()) n++;
          $('.ink-due', item).innerHTML = p.due ? `<span class="chip chip-soft">${icon('clock')}${esc(fmtDue(p.due))}</span>` : '';
        }
        addBtn.innerHTML = n ? `${icon('plus')}ضيف ${countTasks(n)}` : 'مفيش حاجة تتضاف';
        addBtn.disabled = !n;
      };
      el.addEventListener('input', refresh);
      el.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.cand !== undefined) {
          const inp = $('input', b.closest('.ink-item'));
          const old = inp.value;
          inp.value = b.dataset.cand;
          b.dataset.cand = old;
          b.textContent = old;
          refresh();
        } else if ('x' in b.dataset) {
          b.closest('.ink-item').remove();
          refresh();
        } else if ('back' in b.dataset) {
          ctl.close();
        } else if ('add' in b.dataset) {
          const items = $$('.ink-item input', el)
            .map((inp) => inp.value.trim())
            .filter(Boolean)
            .map((text) => {
              const p = parseWhen(text);
              return { title: p.due ? p.title : text, due: p.due, source: 'ink' };
            });
          if (!items.length) return;
          store.addMany(items);
          ctl.close();
          inkApi.clear();
          inkApi.close();
          toast(`اتضافت ${countTasks(items.length)} ✓`);
          maybeNudgeNotifications(items);
        }
      });
      refresh();
    },
  });
}

/* ---------------- Composer ---------------- */

function updatePreview() {
  autoDir(input);
  const text = input.value.trim();
  let html = '';
  if (composerDue !== undefined) {
    html = composerDue
      ? `<button type="button" class="chip chip-accent" data-p="edit">${icon('clock')}${esc(fmtDue(composerDue))}</button><button type="button" class="chip-x" data-p="reset" aria-label="شيل الميعاد">${icon('x')}</button>`
      : `<button type="button" class="chip" data-p="edit">${icon('clock')}من غير ميعاد</button><button type="button" class="chip-x" data-p="reset" aria-label="رجّع">${icon('x')}</button>`;
  } else if (text && !composerAutoOff) {
    const p = parseWhen(text);
    if (p.due) {
      html = `<button type="button" class="chip chip-accent" data-p="edit">${icon('sparkle')}${esc(fmtDue(p.due))}</button><button type="button" class="chip-x" data-p="off" aria-label="من غير ميعاد">${icon('x')}</button>`;
    }
  }
  previewEl.innerHTML = html;
  previewEl.hidden = !html;
  whenBtn.classList.toggle('set', composerDue !== undefined && composerDue !== null);
  form.classList.toggle('has-text', !!text);
}

function maybeNudgeNotifications(items) {
  if (!items.some((t) => t.due) || notify.status() !== 'default') return;
  if (store.settings.dismissed.notif) return;
  // The banner will show; scroll it into view gently.
  requestAnimationFrame(() => bannerEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) { input.focus(); return; }
  const p = parseWhen(text);
  let due;
  let title = text;
  if (composerDue !== undefined) {
    due = composerDue;
    if (p.due) title = p.title;
  } else if (!composerAutoOff && p.due) {
    due = p.due;
    title = p.title;
  } else {
    due = null;
  }
  store.add({ title, due, source: 'text' });
  input.value = '';
  composerDue = undefined;
  composerAutoOff = false;
  updatePreview();
  toast(due ? `اتضافت · ${fmtDue(due)}` : 'اتضافت ✓');
  maybeNudgeNotifications([{ due }]);
});

input.addEventListener('input', () => {
  if (!input.value.trim()) composerAutoOff = false;
  updatePreview();
});

previewEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-p]');
  if (!b) return;
  if (b.dataset.p === 'edit') openComposerWhen();
  else if (b.dataset.p === 'reset') { composerDue = undefined; composerAutoOff = false; updatePreview(); }
  else if (b.dataset.p === 'off') { composerAutoOff = true; updatePreview(); }
});

whenBtn.addEventListener('click', openComposerWhen);

/* ---------------- Global listeners ---------------- */

listEl.addEventListener('click', (e) => {
  const ex = e.target.closest('[data-example]');
  if (ex) {
    input.value = ex.dataset.example;
    updatePreview();
    input.focus();
    return;
  }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('[data-id]')?.dataset.id;
  switch (btn.dataset.act) {
    case 'toggle': toggleDone(id); break;
    case 'edit': openEdit(id); break;
    case 'postpone': openPostpone(id); break;
    case 'delete': removeTask(id); break;
    case 'review': openReview(); break;
    case 'clear-done': {
      const removed = store.removeMany(tasks().filter((t) => t.done).map((t) => t.id));
      toast(`اتمسحت ${countTasks(removed.length)}`, { action: () => store.restore(removed) });
      break;
    }
    default:
  }
});

listEl.addEventListener('toggle', (e) => {
  if (e.target.matches('.group-done')) doneOpen = e.target.open;
}, true);

bannerEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-b]');
  if (!b) return;
  if (b.dataset.b === 'review') openReview();
  else if (b.dataset.b === 'enable') enableNotifications();
  else if (b.dataset.b === 'dismiss-notif') store.setSettings({ dismissed: { notif: Date.now() } });
});

$('#bellBtn').addEventListener('click', () => {
  if (notify.status() === 'default') enableNotifications();
  else openSettings();
});
$('#settingsBtn').addEventListener('click', openSettings);
$('#penFab').addEventListener('click', startInk);

document.addEventListener('keydown', (e) => {
  if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !sheetOpen() && !inkIsOpen() && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
    e.preventDefault();
    input.focus();
  }
});

/* ---------------- Notification actions ---------------- */

function handleAction({ taskId, action }) {
  const t = store.get(taskId);
  if (!t) return;
  if (action === 'done') {
    if (!t.done) store.update(taskId, { done: true, doneAt: Date.now() });
    toast(`خلصت: ${t.title} ✓`, { action: () => store.update(taskId, { done: false, doneAt: null }) });
  } else if (action === 'snooze') {
    postpone(taskId, Math.max(t.due || 0, Date.now()) + HOUR);
  } else {
    openEdit(taskId);
  }
}

/* ================================================================== */
/* Boot                                                                */
/* ================================================================== */

store.subscribe(() => {
  render();
  notify.scheduleSync();
});

render();
updatePreview();

notify.init({
  getTasks: tasks,
  getSettings: () => store.settings,
  deviceId: () => store.deviceId,
  onAction: handleAction,
  onChange: render,
  onTick: render,
  onInApp: (title) => { if (!document.hidden) toast(`🔔 ${title}`, { duration: 8000 }); },
});

const params = new URLSearchParams(location.search);
let handledParam = false;
if (params.get('task')) {
  handledParam = true;
  handleAction({ taskId: params.get('task'), action: params.get('do') || 'open' });
} else if (params.has('ink')) {
  handledParam = true;
  startInk();
} else if (params.has('new')) {
  input.focus();
}
if ([...params.keys()].length) history.replaceState(null, '', location.pathname);

// Once a day, if something is overdue, ask what to do with it.
const todayKey = toDateInput(Date.now());
if (!handledParam && overdueTasks().length && store.settings.lastReviewDay !== todayKey) {
  store.setSettings({ lastReviewDay: todayKey });
  setTimeout(openReview, 500);
}

try { navigator.storage?.persist?.(); } catch { /* ignore */ }
