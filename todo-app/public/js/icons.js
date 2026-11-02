// Inline SVG icon set (24x24, stroke based, inherits currentColor).

const P = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  pen: '<path d="M4 20l4.2-1 10.6-10.6a2.1 2.1 0 0 0-3-3L5.2 16 4 20z"/><path d="M14.2 6.8l3 3"/>',
  bell: '<path d="M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  bellOff: '<path d="M6 16v-5a6 6 0 0 1 9.6-4.8M18 11v5l1.5 2h-15"/><path d="M10 20.5a2 2 0 0 0 4 0M4 4l16 16"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  trash: '<path d="M4.5 7h15M10 7V4.8h4V7M6.5 7l.9 12.2a1 1 0 0 0 1 .8h7.2a1 1 0 0 0 1-.8L17.5 7"/>',
  later: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.8 4.5v3.8H16"/><path d="M12 8.5V12l2.5 1.6"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  undo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 16V5M7 10l5-5 5 5M5 20h14"/>',
  share: '<path d="M12 3.5v11M8 7.5l4-4 4 4"/><path d="M7 11H6v9h12v-9h-1"/>',
  text: '<path d="M5 7V5h14v2M12 5v14M9 19h6"/>',
  sparkle: '<path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z"/><path d="M18.5 16l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  eraser: '<path d="M8.5 20H20M4.6 14.6l8.8-8.8a2 2 0 0 1 2.8 0l2.5 2.5a2 2 0 0 1 0 2.8L11 19.5a2 2 0 0 1-1.4.5H8.4a2 2 0 0 1-1.4-.6l-2.4-2.4a2 2 0 0 1 0-2.4z"/><path d="M9 10l5 5"/>',
  chevron: '<path d="M15 6l-6 6 6 6"/>',
  inbox: '<path d="M4 13.5l2.4-7A2 2 0 0 1 8.3 5h7.4a2 2 0 0 1 1.9 1.5l2.4 7V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M4 13.5h4.5l1.5 2.5h4l1.5-2.5H20"/>',
  wifiOff: '<path d="M4 4l16 16M8.5 16.5a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 4-2.4M19 12.5a10 10 0 0 0-2.5-1.8M12 20h.01"/>',
};

export function icon(name, cls = '') {
  return `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${P[name] || ''}</svg>`;
}
