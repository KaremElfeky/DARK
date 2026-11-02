// Date helpers + a small natural-language parser for Egyptian Arabic and English.
// "دكتور الأسنان بكرة الساعة ٥م" -> { title: "دكتور الأسنان", due: <tomorrow 17:00> }

export const LOCALE = 'ar-EG';
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/* ------------------------------------------------------------------ */
/* Basic date helpers                                                  */
/* ------------------------------------------------------------------ */

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(ts, n) {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d;
}

export function atTime(dayTs, h, m = 0) {
  const d = new Date(dayTs);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

export function dayDiff(ts, now = Date.now()) {
  return Math.round((startOfDay(ts) - startOfDay(now)) / DAY);
}

export const sameDay = (a, b) => dayDiff(a, b) === 0;

export function roundUp(ts, step = 5 * MIN) {
  return Math.ceil(ts / step) * step;
}

const pad = (n) => String(n).padStart(2, '0');

export function toDateInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function toTimeInput(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromInputs(dateStr, timeStr) {
  if (!dateStr) return null;
  const [y, mo, da] = dateStr.split('-').map(Number);
  const [h, mi] = (timeStr || '09:00').split(':').map(Number);
  const d = new Date(y, mo - 1, da, h || 0, mi || 0, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** Sensible "later today" default when the user says "today" without a time. */
export function defaultTodayTime(now = Date.now()) {
  const evening = atTime(now, 20, 0);
  if (evening - now >= 45 * MIN) return evening;
  return roundUp(now + HOUR, 15 * MIN);
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const numFmt = new Intl.NumberFormat(LOCALE);
const timeFmt = new Intl.DateTimeFormat(LOCALE, { hour: 'numeric', minute: '2-digit' });
const weekdayFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'long' });
const dayMonthFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
const fullFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });
const shortDayFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' });

export const num = (n) => numFmt.format(n);
export const fmtTime = (ts) => timeFmt.format(ts);
export const weekday = (ts) => weekdayFmt.format(ts);
export const shortDay = (ts) => shortDayFmt.format(ts);
export const longDate = (ts) => dayMonthFmt.format(ts);

export function dayLabel(ts, now = Date.now()) {
  const diff = dayDiff(ts, now);
  if (diff === 0) return 'النهارده';
  if (diff === 1) return 'بكرة';
  if (diff === -1) return 'امبارح';
  if (diff === 2) return 'بعد بكرة';
  if (diff > 2 && diff < 7) return weekdayFmt.format(ts);
  if (new Date(ts).getFullYear() === new Date(now).getFullYear()) return dayMonthFmt.format(ts);
  return fullFmt.format(ts);
}

export const fmtDue = (ts, now = Date.now()) => `${dayLabel(ts, now)} ${fmtTime(ts)}`;

/** Egyptian-Arabic counting: 1 ساعة, 2 ساعتين, 3-10 ساعات, 11+ ساعة */
export function count(n, [one, two, few, many]) {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${num(n)} ${few}`;
  return `${num(n)} ${many}`;
}

export const countTasks = (n) => count(n, ['مهمة واحدة', 'مهمتين', 'مهام', 'مهمة']);

export function duration(ms) {
  const a = Math.abs(ms);
  if (a < HOUR) return count(Math.max(1, Math.round(a / MIN)), ['دقيقة', 'دقيقتين', 'دقايق', 'دقيقة']);
  if (a < DAY) return count(Math.round(a / HOUR), ['ساعة', 'ساعتين', 'ساعات', 'ساعة']);
  return count(Math.round(a / DAY), ['يوم', 'يومين', 'أيام', 'يوم']);
}

export function relative(ts, now = Date.now()) {
  const d = ts - now;
  if (Math.abs(d) < MIN) return 'دلوقتي';
  return d > 0 ? `كمان ${duration(d)}` : `فاتت من ${duration(d)}`;
}

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

const CHAR_MAP = {
  'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ة': 'ه', 'ى': 'ي',
  '٫': ':', '،': ',', '؟': '?', '؛': ';',
};

/**
 * 1:1 character normalisation (keeps string indices aligned with the original):
 * Arabic-Indic digits -> ASCII, alef/ta-marbuta/ya variants unified, ASCII lower-cased.
 */
export function normalize(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const code = c.charCodeAt(0);
    if (code >= 0x660 && code <= 0x669) out += String(code - 0x660);
    else if (code >= 0x6f0 && code <= 0x6f9) out += String(code - 0x6f0);
    else if (CHAR_MAP[c]) out += CHAR_MAP[c];
    else if (code < 128) out += c.toLowerCase();
    else out += c;
  }
  return out;
}

const SEP = "[\\s,.!?:;()\\[\\]\"'«»\\-–—/]";
const rx = (body) => new RegExp(`(^|${SEP})(?:${body})(?=$|${SEP})`, 'g');

const PM_WORDS = ['بعد\\s+الضهر', 'بعد\\s+الظهر', 'مساءا', 'مساء', 'المساء', 'المسا', 'مسا', 'بالليل', 'باليل', 'بليل', 'الليل', 'العصر', 'المغرب', 'pm', 'p\\.m\\.?', 'م'];
const AM_WORDS = ['صباحا\\u064B?', 'الصبح', 'صبحا', 'الصبحيه', 'الفجر', 'بدري', 'am', 'a\\.m\\.?', 'ص'];
const NOON_WORDS = ['الضهر', 'الظهر', 'ضهرا', 'ظهرا'];
const SUFFIX = `(${[...PM_WORDS, ...AM_WORDS, ...NOON_WORDS].sort((a, b) => b.length - a.length).join('|')})`;
const FRACTION = '(ونص|و\\s+نص|ونصف|وربع|و\\s+ربع|وتلت|و\\s+تلت|الا\\s*ربع|الا\\s*تلت)';

function suffixKind(s) {
  if (!s) return null;
  const t = s.replace(/\s+/g, ' ');
  const test = (list) => list.some((w) => new RegExp(`^(?:${w})$`).test(t));
  if (test(NOON_WORDS)) return 'noon';
  if (test(AM_WORDS)) return 'am';
  if (test(PM_WORDS)) return 'pm';
  return null;
}

function makeTime(hStr, mStr, frac, suffix) {
  let h = parseInt(hStr, 10);
  let m = mStr ? parseInt(mStr, 10) : 0;
  if (Number.isNaN(h) || h > 23 || m > 59) return null;
  if (!mStr && frac) {
    const f = frac.replace(/\s+/g, '');
    if (f === 'ونص' || f === 'ونصف') m = 30;
    else if (f === 'وربع') m = 15;
    else if (f === 'وتلت') m = 20;
    else if (f === 'الاربع') { h = h - 1 || 12; m = 45; }
    else if (f === 'الاتلت') { h = h - 1 || 12; m = 40; }
  }
  const kind = suffixKind(suffix);
  let ambiguous = false;
  if (kind === 'am') h = h === 12 ? 0 : h;
  else if (kind === 'pm') h = h < 12 ? h + 12 : h;
  else if (kind === 'noon') h = h >= 11 ? h : h + 12;
  else if (h >= 1 && h <= 7) h += 12; // "الساعة ٥" in Egypt almost always means 5 PM
  else if (h >= 8 && h <= 11) ambiguous = true;
  return { h, m, ambiguous };
}

const WEEKDAYS = {
  'السبت': 6, 'الحد': 0, 'الاحد': 0, 'الاتنين': 1, 'الاثنين': 1, 'التلات': 2, 'التلاتاء': 2, 'التلاتا': 2,
  'الثلاثاء': 2, 'الثلاثا': 2, 'الاربع': 3, 'الاربعاء': 3, 'الاربعا': 3, 'الخميس': 4, 'الجمعه': 5,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
const WEEKDAY_RE = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join('|');

const MONTHS = {
  'يناير': 0, 'فبراير': 1, 'مارس': 2, 'ابريل': 3, 'مايو': 4, 'يونيو': 5, 'يونيه': 5, 'يوليو': 6, 'يوليه': 6,
  'اغسطس': 7, 'سبتمبر': 8, 'اكتوبر': 9, 'نوفمبر': 10, 'ديسمبر': 11,
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8,
  october: 9, november: 10, december: 11, jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7,
  sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

function explicitDate(day, month, year, now) {
  const d = parseInt(day, 10);
  if (!(d >= 1 && d <= 31) || month < 0 || month > 11) return null;
  let y = year ? parseInt(year, 10) : new Date(now).getFullYear();
  if (y < 100) y += 2000;
  let date = new Date(y, month, d);
  if (date.getMonth() !== month) return null;
  if (!year && date < startOfDay(now)) date = new Date(y + 1, month, d);
  return { date, kind: 'fixed' };
}

const relDay = (n, kind = 'fixed') => (now) => ({ date: addDays(startOfDay(now), n), kind });

const RULES = [
  // ---- durations: "بعد ساعتين", "in 30 minutes"
  { cat: 'dur', re: rx('بعد\\s+(?:نص|نصف)\\s+ساعه|in\\s+half\\s+an\\s+hour'), get: () => ({ ms: 30 * MIN }) },
  { cat: 'dur', re: rx('بعد\\s+ربع\\s+ساعه'), get: () => ({ ms: 15 * MIN }) },
  { cat: 'dur', re: rx('بعد\\s+ساعه\\s+و\\s*نص'), get: () => ({ ms: 90 * MIN }) },
  { cat: 'dur', re: rx('بعد\\s+ساعتين'), get: () => ({ ms: 2 * HOUR }) },
  { cat: 'dur', re: rx('بعد\\s+ساعه|in\\s+(?:an|one)\\s+hour'), get: () => ({ ms: HOUR }) },
  { cat: 'dur', re: rx('بعد\\s+دقيقتين'), get: () => ({ ms: 2 * MIN }) },
  { cat: 'dur', re: rx('(?:بعد|in)\\s+(\\d{1,3})\\s*(ساعات|ساعه|hours?|hrs?|دقايق|دقائق|دقيقه|minutes?|mins?)'),
    get: ([n, unit]) => ({ ms: parseInt(n, 10) * (/^(ساع|h)/.test(unit) ? HOUR : MIN) }) },
  { cat: 'dur', re: rx('بعد\\s+يومين'), get: () => ({ days: 2 }) },
  { cat: 'dur', re: rx('بعد\\s+اسبوعين'), get: () => ({ days: 14 }) },
  { cat: 'dur', re: rx('بعد\\s+اسبوع|in\\s+a\\s+week'), get: () => ({ days: 7 }) },
  { cat: 'dur', re: rx('(?:بعد|in)\\s+(\\d{1,3})\\s*(ايام|يوم|days?|weeks?)'),
    get: ([n, unit]) => ({ days: parseInt(n, 10) * (/^week/.test(unit) ? 7 : 1) }) },

  // ---- days
  { cat: 'day', re: rx('(?:يوم\\s+)?بعد\\s+(?:بكره|بكرا|غد|الغد)|(?:the\\s+)?day\\s+after\\s+tomorrow'), get: () => relDay(2) },
  { cat: 'day', re: rx('(?:يوم\\s+)?(?:بكره|بكرا|غدا\\u064B?|غدوه|tomorrow|tmrw|tmr)'), get: () => relDay(1) },
  { cat: 'day', re: rx('النهارده|انهارده|النهاردا|النهارد|اليوم|today'), get: () => relDay(0) },
  { cat: 'day', re: rx('(?:في\\s+|ف\\s*)?(?:الاسبوع|اسبوع)\\s+(?:الجاي|اللي\\s+جاي|القادم)|next\\s+week'), get: () => relDay(7) },
  { cat: 'day', re: rx(`(?:(?:يوم|on|في)\\s+)?(?:(next)\\s+)?(${WEEKDAY_RE})(?:\\s+(الجاي|الجايه|اللي\\s+جاي|القادم))?`),
    get: ([nextEn, name, nextAr]) => (now) => {
      const idx = WEEKDAYS[name];
      let diff = (idx - new Date(now).getDay() + 7) % 7;
      if (diff === 0 && (nextEn || nextAr)) diff = 7;
      return { date: addDays(startOfDay(now), diff), kind: diff === 0 ? 'flex' : 'fixed' };
    } },
  { cat: 'day', re: rx('(\\d{1,2})\\s*/\\s*(\\d{1,2})(?:\\s*/\\s*(\\d{2,4}))?'),
    get: ([d, m, y]) => (now) => explicitDate(d, parseInt(m, 10) - 1, y, now) },
  { cat: 'day', re: rx(`(?:يوم\\s+)?(\\d{1,2})\\s*(${MONTH_RE})(?:\\s+(\\d{4}))?`),
    get: ([d, m, y]) => (now) => explicitDate(d, MONTHS[m], y, now) },
  { cat: 'day', re: rx(`(${MONTH_RE})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?`),
    get: ([m, d, y]) => (now) => explicitDate(d, MONTHS[m], y, now) },

  // ---- times
  { cat: 'time', re: rx(`(?:الساعه|ساعه|at|@)\\s*(\\d{1,2})(?:\\s*[:.]\\s*(\\d{2}))?(?:\\s*${FRACTION})?(?:\\s*${SUFFIX})?`),
    get: ([h, m, f, s]) => makeTime(h, m, f, s) },
  { cat: 'time', re: rx(`(\\d{1,2})\\s*:\\s*(\\d{2})(?:\\s*${SUFFIX})?`), get: ([h, m, s]) => makeTime(h, m, null, s) },
  { cat: 'time', re: rx(`(\\d{1,2})(?:\\s*${FRACTION})?\\s*${SUFFIX}`), get: ([h, f, s]) => makeTime(h, null, f, s) },

  // ---- parts of the day without a number: "الصبح", "بالليل"
  { cat: 'period', re: rx('الليله\\s+دي|الليله|tonight'), get: () => ({ h: 21, today: true }) },
  { cat: 'period', re: rx('الصبح|الصبحيه|صباحا\\u064B?|بدري|(?:in\\s+the\\s+)?morning'), get: () => ({ h: 9 }) },
  { cat: 'period', re: rx('الضهر|الظهر|noon'), get: () => ({ h: 12 }) },
  { cat: 'period', re: rx('العصر|(?:in\\s+the\\s+)?afternoon'), get: () => ({ h: 16 }) },
  { cat: 'period', re: rx('المغرب|(?:in\\s+the\\s+)?evening'), get: () => ({ h: 19 }) },
  { cat: 'period', re: rx('بالليل|باليل|بليل|المسا|(?:at\\s+)?night'), get: () => ({ h: 21 }) },
];

const CATS = ['dur', 'day', 'time', 'period'];
const CONNECTORS = /(?:^|\s)(?:في|ف|يوم|الساعه|الساعة|ساعة|ع|على|علي)$/;
const LEAD_CONNECTORS = /^(?:في|ف|يوم|الساعه|الساعة)(?:\s+|$)/;
// "دكتور بكرة 5" -> a bare number right after a day word, at the end of the text, is a time.
const TAIL_TIME = new RegExp(`^\\s+(\\d{1,2})(?:\\s*[:.]\\s*(\\d{2}))?(?:\\s*${FRACTION})?(?=\\s*$|\\s*[,.!?;،])`);

function cleanTitle(s) {
  let t = s.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(/[\s,،.:;\-–—]+$/u, '').replace(/^[\s,،.:;\-–—]+/u, '');
    t = t.replace(CONNECTORS, '').trim();
    t = t.replace(LEAD_CONNECTORS, '').trim();
    if (t === before) break;
  }
  return t;
}

/**
 * Pull a due date/time out of free text.
 * @returns {{ title: string, due: number|null }}
 */
export function parseWhen(text, nowInput = Date.now()) {
  const now = typeof nowInput === 'number' ? nowInput : nowInput.getTime();
  const raw = String(text ?? '');
  const norm = normalize(raw);

  const found = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(norm))) {
      const start = m.index + m[1].length;
      const end = m.index + m[0].length;
      if (end <= start) { rule.re.lastIndex = m.index + 1; continue; }
      const val = rule.get(m.slice(2));
      if (val) found.push({ start, end, cat: rule.cat, val });
      rule.re.lastIndex = end;
    }
  }

  const chosen = {};
  const used = [];
  const overlaps = (a, b) => a.start < b.end && b.start < a.end;
  for (const cat of CATS) {
    const c = found
      .filter((x) => x.cat === cat && !used.some((u) => overlaps(u, x)))
      .sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    if (c.length) { chosen[cat] = c[0]; used.push(c[0]); }
  }

  // A "duration in hours/minutes" overrides everything else.
  if (chosen.dur && chosen.dur.val.ms) {
    delete chosen.day; delete chosen.time; delete chosen.period;
  }
  if (chosen.dur && chosen.dur.val.days) delete chosen.day;
  if (chosen.day && !chosen.time) {
    const mm = TAIL_TIME.exec(norm.slice(chosen.day.end));
    const t = mm && makeTime(mm[1], mm[2], mm[3], null);
    if (t) chosen.time = { cat: 'time', start: chosen.day.end, end: chosen.day.end + mm[0].length, val: t };
  }

  // Resolve the day
  let base = null;
  let dayKind = null;
  if (chosen.day) {
    const r = chosen.day.val(now);
    if (r) { base = r.date; dayKind = r.kind; } else delete chosen.day;
  }
  if (!Object.keys(chosen).length) return { title: raw.trim(), due: null };

  let due;
  if (chosen.dur && chosen.dur.val.ms) {
    due = roundUp(now + chosen.dur.val.ms, MIN);
  } else {
    if (chosen.dur && chosen.dur.val.days) base = addDays(startOfDay(now), chosen.dur.val.days);
    if (!base && chosen.period && chosen.period.val.today) base = startOfDay(now);

    let h; let m = 0; let ambiguous = false;
    if (chosen.time) {
      ({ h, m, ambiguous } = chosen.time.val);
      if (ambiguous && chosen.period) {
        if (chosen.period.val.h >= 12 && h < 12) h += 12;
        ambiguous = false;
      }
    } else if (chosen.period) {
      h = chosen.period.val.h;
    }

    if (h === undefined) {
      due = base && sameDay(base, now) ? defaultTodayTime(now) : atTime(base, 9, 0);
    } else {
      due = atTime(base ?? now, h, m);
      if (!base) {
        if (due <= now) {
          if (ambiguous && h < 12 && atTime(now, h + 12, m) > now) due = atTime(now, h + 12, m);
          else due = addDays(due, 1).getTime();
        }
      } else if (due <= now && ambiguous && h < 12 && sameDay(base, now)) {
        due = atTime(base, h + 12, m);
      } else if (due <= now && dayKind === 'flex') {
        due = addDays(due, 7).getTime();
      }
    }
  }

  // Strip the matched phrases from the title
  const ranges = Object.values(chosen).sort((a, b) => b.start - a.start);
  let title = raw;
  for (const r of ranges) title = `${title.slice(0, r.start)} ${title.slice(r.end)}`;
  title = cleanTitle(title);
  if (!title) title = raw.trim();

  return { title, due };
}
