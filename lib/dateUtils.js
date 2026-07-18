// lib/dateUtils.js
// All date handling is local-timezone based, since a timesheet should
// reflect the user's own working day, not UTC.

/** Returns YYYY-MM-DD for a given Date (or now), in local time. */
export function dateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parses a YYYY-MM-DD string back into a local Date at midnight. */
export function parseDateStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Monday-based week start (YYYY-MM-DD) for a given date. */
export function weekStartStr(d = new Date()) {
  const day = d.getDay(); // 0 = Sunday .. 6 = Saturday
  const diff = (day === 0 ? -6 : 1) - day; // shift to Monday
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return dateStr(monday);
}

export function weekEndStr(weekStart) {
  const start = parseDateStr(weekStart);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return dateStr(end);
}

/** Human label like "Mon, 7 Jul" */
export function friendlyDate(s, opts = {}) {
  const d = parseDateStr(s);
  const today = dateStr();
  const yesterday = dateStr(new Date(Date.now() - 86400000));
  if (!opts.noRelative) {
    if (s === today) return 'Today';
    if (s === yesterday) return 'Yesterday';
  }
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function friendlyWeekRange(weekStart) {
  const start = parseDateStr(weekStart);
  const end = parseDateStr(weekEndStr(weekStart));
  const startLabel = start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const endLabel = end.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return `${startLabel} – ${endLabel}`;
}

/** Formats milliseconds as "Hh MMm" or "MMm SSs" for short durations. */
export function formatDuration(ms, { seconds = false } = {}) {
  if (!ms || ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (seconds) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Formats a timestamp as a local time string, e.g. "9:41 AM". */
export function formatClock(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function isSameDay(ts, ds) {
  return dateStr(new Date(ts)) === ds;
}
