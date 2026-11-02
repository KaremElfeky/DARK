// Export tasks as an .ics file with alarms 1 day + 1 hour before.
// Every calendar app (Apple, Google, Outlook) will then remind you natively — a solid
// backup that works even without the push server.
import { MIN } from './dates.js';

const enc = new TextEncoder();

function utc(ts) {
  return new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Fold lines at 75 octets without splitting multi-byte characters (RFC 5545 §3.1). */
function fold(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const limit = out.length ? 74 : 75;
    if (bytes + b > limit) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function buildICS(tasks, settings) {
  const stamp = utc(Date.now());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Mahami//Todo//AR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:مهامي',
  ];
  const alarms = [];
  if (settings.remind?.day) alarms.push('-P1D');
  if (settings.remind?.hour) alarms.push('-PT1H');
  if (settings.remind?.due) alarms.push('PT0M');

  for (const t of tasks) {
    if (!t.due || t.done) continue;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${t.id}@mahami`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${utc(t.due)}`,
      `DTEND:${utc(t.due + 30 * MIN)}`,
      `SUMMARY:${escText(t.title)}`,
    );
    for (const trig of alarms) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escText(t.title)}`, `TRIGGER:${trig}`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function downloadICS(tasks, settings, filename = 'mahami.ics') {
  const blob = new Blob([buildICS(tasks, settings)], { type: 'text/calendar;charset=utf-8' });
  downloadBlob(blob, filename);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
