// Handwriting screen: a ruled notebook page you write on with Apple Pencil (or finger/mouse).
// Each written line becomes one task. Strokes are sent to Google's handwriting
// recognition engine (the same one behind Google Input Tools), which supports
// Arabic and English.
import { icon } from './icons.js';
import { apiUrl } from './config.js';
import { $ } from './ui.js';

const ENDPOINTS = [
  'https://inputtools.google.com/request?ime=handwriting&app=mobilesearch&cs=1&oe=UTF-8',
  'https://www.google.com/inputtools/request?ime=handwriting&app=mobilesearch&cs=1&oe=UTF-8',
];

let el, paper, canvas, g;
let strokes = [];
let current = null;
let penSeen = false;
let dpr = 1;
let LH = 76; // ruled line height (CSS px)
const TOP = 24;
let t0 = 0;
let opts = null;
let busy = false;

/* ---------------- DOM ---------------- */

function build() {
  el = document.createElement('section');
  el.className = 'ink';
  el.hidden = true;
  el.setAttribute('aria-label', 'الكتابة بالقلم');
  el.innerHTML = `
    <div class="ink-bar">
      <button type="button" class="btn ghost" data-ink="close">${icon('x')}<span>إلغاء</span></button>
      <div class="ink-title">
        <strong>اكتب كل مهمة في سطر</strong>
        <span>وتقدر تكتب الميعاد جنبها: «دكتور بكرة ٥م»</span>
      </div>
      <div class="ink-tools">
        <div class="seg" role="group" aria-label="لغة الكتابة">
          <button type="button" data-lang="ar">عربي</button>
          <button type="button" data-lang="en">EN</button>
        </div>
        <button type="button" class="icon-btn" data-ink="undo" aria-label="تراجع عن آخر خط">${icon('undo')}</button>
        <button type="button" class="icon-btn" data-ink="clear" aria-label="امسح الصفحة">${icon('eraser')}</button>
        <button type="button" class="btn primary" data-ink="convert">${icon('sparkle')}<span>حوّل لمهام</span></button>
      </div>
    </div>
    <div class="ink-paper">
      <canvas aria-label="مساحة الكتابة"></canvas>
      <div class="ink-hint">${icon('pen')}<span>اكتب هنا بالقلم…</span></div>
      <div class="ink-busy" hidden><div class="spinner"></div><span>بحوّل خطك لكلام…</span></div>
    </div>`;
  document.body.append(el);

  paper = $('.ink-paper', el);
  canvas = $('canvas', el);
  g = canvas.getContext('2d');

  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.lang) {
      opts.setLang(b.dataset.lang);
      updateLang();
      return;
    }
    switch (b.dataset.ink) {
      case 'close': close(); break;
      case 'undo': undo(); break;
      case 'clear': clear(); break;
      case 'convert': convert(); break;
      default:
    }
  });

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  canvas.addEventListener('lostpointercapture', onCancel);
  // Stop iOS Safari from scrolling / showing the magnifier while writing.
  for (const type of ['touchstart', 'touchmove']) {
    canvas.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }
  new ResizeObserver(resize).observe(paper);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', redraw);

  document.addEventListener('keydown', (e) => {
    if (el.hidden) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  });
}

function updateLang() {
  const lang = opts.getLang();
  for (const b of el.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
}

function updateButtons() {
  const empty = strokes.length === 0;
  $('[data-ink="convert"]', el).disabled = empty || busy;
  $('[data-ink="undo"]', el).disabled = empty || busy;
  $('[data-ink="clear"]', el).disabled = empty || busy;
  $('.ink-hint', el).classList.toggle('hidden', !empty);
}

/* ---------------- Public API ---------------- */

export function openInk(options) {
  opts = options; // { getLang, setLang, penOnly(), onResult(results, api), onError(retry) }
  if (!el) build();
  el.hidden = false;
  document.documentElement.classList.add('ink-open');
  updateLang();
  updateButtons();
  requestAnimationFrame(resize);
}

export function close() {
  if (!el) return;
  el.hidden = true;
  document.documentElement.classList.remove('ink-open');
}

export function clear() {
  strokes = [];
  current = null;
  redraw();
  updateButtons();
}

export const isOpen = () => !!el && !el.hidden;

/* ---------------- Canvas ---------------- */

function resize() {
  if (!paper || el.hidden) return;
  const r = paper.getBoundingClientRect();
  if (!r.width || !r.height) return;
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  canvas.style.width = `${r.width}px`;
  canvas.style.height = `${r.height}px`;
  LH = r.width < 560 ? 64 : 80;
  paper.style.setProperty('--lh', `${LH}px`);
  paper.style.setProperty('--top', `${TOP}px`);
  redraw();
}

function strokeColor() {
  return getComputedStyle(el).getPropertyValue('--ink-stroke').trim() || '#1f2a44';
}

function widthFor(p) {
  const base = LH > 70 ? 3 : 2.6;
  return base * (0.55 + (p.p ?? 0.5) * 0.9);
}

function drawStroke(s) {
  const pts = s.pts;
  g.strokeStyle = strokeColor();
  g.fillStyle = g.strokeStyle;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  if (pts.length === 1) {
    g.beginPath();
    g.arc(pts[0].x, pts[0].y, widthFor(pts[0]) * 0.75, 0, Math.PI * 2);
    g.fill();
    return;
  }
  for (let i = 1; i < pts.length; i++) drawSegment(pts, i);
}

/** Smooth curve through midpoints: segment i goes from mid(i-2,i-1) to mid(i-1,i). */
function drawSegment(pts, i) {
  const a = pts[i - 1];
  const b = pts[i];
  const start = i === 1 ? a : { x: (pts[i - 2].x + a.x) / 2, y: (pts[i - 2].y + a.y) / 2 };
  const end = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  g.lineWidth = widthFor(a);
  g.beginPath();
  g.moveTo(start.x, start.y);
  g.quadraticCurveTo(a.x, a.y, end.x, end.y);
  g.stroke();
}

function finishTail(s) {
  const n = s.pts.length;
  if (n < 2) return;
  const a = s.pts[n - 2];
  const b = s.pts[n - 1];
  g.lineWidth = widthFor(b);
  g.beginPath();
  g.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
  g.lineTo(b.x, b.y);
  g.stroke();
}

function redraw() {
  if (!g) return;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const s of strokes) { drawStroke(s); finishTail(s); }
  if (current) drawStroke(current);
}

/* ---------------- Pointer input ---------------- */

function accepts(e) {
  if (e.pointerType === 'pen') { penSeen = true; return true; }
  const mode = opts.penOnly();
  if (mode === 'on') return false;
  if (mode === 'auto' && penSeen) return false; // palm rejection once a pencil was used
  if (e.pointerType === 'mouse' && e.button !== 0) return false;
  return true;
}

function point(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: e.clientX - r.left,
    y: e.clientY - r.top,
    t: Math.max(0, Math.round(performance.now() - t0)),
    p: e.pressure > 0 ? e.pressure : 0.5,
  };
}

function onDown(e) {
  if (busy) return;
  // A pencil touching down while a "finger" stroke is in progress => that was the palm.
  if (current && current.type !== 'pen' && e.pointerType === 'pen') {
    current = null;
    redraw();
  }
  if (current || !accepts(e)) return;
  e.preventDefault();
  try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  if (!strokes.length) t0 = performance.now();
  current = { id: e.pointerId, type: e.pointerType, pts: [point(e)] };
  $('.ink-hint', el).classList.add('hidden');
}

function onMove(e) {
  if (!current || e.pointerId !== current.id) return;
  e.preventDefault();
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  for (const ce of events.length ? events : [e]) {
    const p = point(ce);
    const last = current.pts[current.pts.length - 1];
    if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) < 0.8) continue;
    current.pts.push(p);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.strokeStyle = strokeColor();
    g.lineCap = 'round';
    drawSegment(current.pts, current.pts.length - 1);
  }
}

function onUp(e) {
  if (!current || e.pointerId !== current.id) return;
  const s = current;
  current = null;
  strokes.push(s);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (s.pts.length === 1) drawStroke(s); else finishTail(s);
  updateButtons();
}

function onCancel(e) {
  if (!current || e.pointerId !== current.id) return;
  if (current.pts.length > 2) onUp(e);
  else { current = null; redraw(); updateButtons(); }
}

function undo() {
  strokes.pop();
  redraw();
  updateButtons();
}

/* ---------------- Line detection ---------------- */

function bbox(list) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const s of list) {
    for (const p of s.pts) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY, cy: (minY + maxY) / 2 };
}

/**
 * Group strokes into text lines. Big strokes are clustered by their vertical centre;
 * small marks (Arabic dots, hamza, i-dots) are then attached to the nearest line,
 * so dots under a letter that dip below the ruled line don't become their own task.
 */
export function groupLines(list = strokes, lh = LH) {
  const items = list.map((s, i) => ({ s, i, b: bbox([s]) }));
  const small = (it) => Math.max(it.b.w, it.b.h) < lh * 0.22;
  const main = items.filter((it) => !small(it)).sort((a, b) => a.b.cy - b.b.cy);
  const marks = items.filter(small);

  const lines = [];
  for (const it of main) {
    const line = lines[lines.length - 1];
    if (line && it.b.cy - line.cy < lh * 0.55) {
      line.items.push(it);
      line.cy = line.items.reduce((sum, x) => sum + x.b.cy, 0) / line.items.length;
      line.minY = Math.min(line.minY, it.b.minY);
      line.maxY = Math.max(line.maxY, it.b.maxY);
    } else {
      lines.push({ items: [it], cy: it.b.cy, minY: it.b.minY, maxY: it.b.maxY });
    }
  }
  if (!lines.length && marks.length) lines.push({ items: [], cy: marks[0].b.cy, minY: marks[0].b.minY, maxY: marks[0].b.maxY });

  for (const m of marks) {
    let best = null;
    let bestD = Infinity;
    for (const line of lines) {
      const d = m.b.cy < line.minY ? line.minY - m.b.cy : m.b.cy > line.maxY ? m.b.cy - line.maxY : 0;
      if (d < bestD) { bestD = d; best = line; }
    }
    best.items.push(m);
  }

  return lines
    .map((l) => l.items.sort((a, b) => a.i - b.i).map((x) => x.s))
    .filter((l) => l.length);
}

/* ---------------- Recognition ---------------- */

function payload(lineStrokes, lang, withTime) {
  const b = bbox(lineStrokes);
  const ink = lineStrokes.map((s) => [
    s.pts.map((p) => Math.round(p.x - b.minX)),
    s.pts.map((p) => Math.round(p.y - b.minY)),
    withTime ? s.pts.map((p) => p.t) : [],
  ]);
  return {
    options: 'enable_pre_space',
    requests: [{
      writing_guide: {
        writing_area_width: Math.max(Math.round(b.w) + 1, LH),
        writing_area_height: Math.max(Math.round(b.h) + 1, LH),
      },
      ink,
      language: lang,
      max_num_results: 6,
      max_completions: 0,
    }],
  };
}

function parseResponse(data) {
  if (!Array.isArray(data) || data[0] !== 'SUCCESS') return null;
  const c = data?.[1]?.[0]?.[1];
  return Array.isArray(c) ? c.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : null;
}

async function post(url, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return parseResponse(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

export async function recognize(lineStrokes, lang) {
  const urls = [...ENDPOINTS, apiUrl('api/recognize')];
  for (const url of urls) {
    for (const withTime of [true, false]) {
      try {
        const cands = await post(url, payload(lineStrokes, lang, withTime));
        if (cands && cands.length) return [...new Set(cands)];
        if (cands) break; // valid answer but empty -> try next endpoint
      } catch {
        break; // network/CORS error -> next endpoint
      }
    }
  }
  throw new Error('recognition-failed');
}

/** Small SVG preview of a line, shown next to the recognised text so it's easy to compare. */
export function lineSVG(lineStrokes) {
  const b = bbox(lineStrokes);
  const pad = 8;
  const d = lineStrokes.map((s) => {
    const pts = s.pts.map((p) => `${(p.x - b.minX + pad).toFixed(1)} ${(p.y - b.minY + pad).toFixed(1)}`);
    return pts.length === 1 ? `M${pts[0]}l0.1 0` : `M${pts.join('L')}`;
  }).join('');
  const w = Math.max(b.w + pad * 2, 1);
  const h = Math.max(b.h + pad * 2, 1);
  return `<svg class="ink-svg" viewBox="0 0 ${w.toFixed(0)} ${h.toFixed(0)}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function setBusy(on) {
  busy = on;
  el.classList.toggle('busy', on);
  $('.ink-busy', el).hidden = !on;
  updateButtons();
}

async function convert() {
  if (busy) return;
  const lines = groupLines();
  if (!lines.length) return;
  setBusy(true);
  const lang = opts.getLang();
  const results = await Promise.all(lines.map(async (ls) => {
    const svg = lineSVG(ls);
    try {
      return { svg, candidates: await recognize(ls, lang) };
    } catch {
      return { svg, candidates: [], error: true };
    }
  }));
  setBusy(false);
  if (results.every((r) => r.error)) {
    opts.onError?.(convert);
    return;
  }
  opts.onResult(results, { clear, close });
}
