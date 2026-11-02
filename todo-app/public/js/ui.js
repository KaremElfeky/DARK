// Small UI primitives: escaping, bottom sheets, toasts.
import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Set dir=rtl/ltr on an input based on its first strong character. */
export function autoDir(el) {
  const v = el.value || '';
  const m = v.match(/[A-Za-z֐-ࣿיִ-ﻼ]/);
  el.dir = m && /[A-Za-z]/.test(m[0]) ? 'ltr' : 'rtl';
}

/* ---------------- Sheets ---------------- */

const stack = [];

export function openSheet({ title, body, className = '', onClose, onMount, footer = '' }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `
    <div class="sheet ${className}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-grip" aria-hidden="true"></div>
      <header class="sheet-head">
        <h2>${esc(title)}</h2>
        <button class="icon-btn ghost" data-close aria-label="قفل">${icon('x')}</button>
      </header>
      <div class="sheet-body">${body}</div>
      ${footer ? `<footer class="sheet-foot">${footer}</footer>` : ''}
    </div>`;
  document.body.append(backdrop);
  const el = backdrop.firstElementChild;
  const prevFocus = document.activeElement;

  const ctl = {
    el,
    closed: false,
    close(reason = 'done') {
      if (ctl.closed) return;
      ctl.closed = true;
      backdrop.classList.remove('open');
      backdrop.classList.add('closing');
      setTimeout(() => backdrop.remove(), 260);
      stack.splice(stack.indexOf(ctl), 1);
      document.documentElement.classList.toggle('has-sheet', stack.length > 0);
      onClose?.(reason);
      if (prevFocus && document.contains(prevFocus)) prevFocus.focus?.({ preventScroll: true });
    },
    setBody(html) { $('.sheet-body', el).innerHTML = html; },
  };

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop || e.target.closest('[data-close]')) ctl.close('dismiss');
  });

  stack.push(ctl);
  document.documentElement.classList.add('has-sheet');
  requestAnimationFrame(() => requestAnimationFrame(() => backdrop.classList.add('open')));
  onMount?.(el, ctl);
  return ctl;
}

export const sheetOpen = () => stack.length > 0;

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stack.length) stack[stack.length - 1].close('dismiss');
});

/* ---------------- Toast ---------------- */

let toastTimer = null;

export function toast(message, { action, actionLabel = 'تراجع', duration = 5000 } = {}) {
  const el = $('#toast');
  if (!el) return;
  el.innerHTML = `<span class="toast-msg">${esc(message)}</span>${action ? `<button type="button">${esc(actionLabel)}</button>` : ''}`;
  el.classList.add('show');
  const hide = () => el.classList.remove('show');
  if (action) {
    el.querySelector('button').onclick = () => { hide(); action(); };
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hide, duration);
}

export function vibrate(ms = 12) {
  try { navigator.vibrate?.(ms); } catch { /* not supported */ }
}
