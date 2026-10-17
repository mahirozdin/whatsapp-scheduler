// Timezone helpers for the web UI, built on Intl only (no date library).
// Every time the UI shows or reads is wall-clock time in the user's selected
// timezone, which can differ from the browser's own timezone.

export const LOCALE = 'en-GB';
const DAY = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');

const formatters = new Map();

/** A cached Intl.DateTimeFormat for `timeZone`. */
export function formatter(timeZone, options) {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) formatters.set(key, (f = new Intl.DateTimeFormat(LOCALE, { timeZone, ...options })));
  return f;
}

const PARTS = { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' };

/** Wall-clock time of an instant in `timeZone`, as a UTC timestamp ("local time as if it were UTC"). */
export function wallClock(ms, timeZone) {
  const p = {};
  for (const { type, value } of formatter(timeZone, PARTS).formatToParts(new Date(ms))) p[type] = Number(value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** UTC offset of `timeZone` at instant `ms`, in milliseconds. */
export function timezoneOffset(ms, timeZone) {
  const whole = Math.floor(ms / 1000) * 1000;
  return wallClock(whole, timeZone) - whole;
}

/**
 * Converts a wall-clock time in `timeZone` to an instant, the same way the
 * server does (src/time.js): ambiguous times take the earlier instant,
 * skipped times move forward by the gap.
 */
export function zonedToUtc(wall, timeZone) {
  const before = timezoneOffset(wall - DAY, timeZone);
  const after = timezoneOffset(wall + DAY, timeZone);
  const candidates = [...new Set([before, after])]
    .map((offset) => wall - offset)
    .filter((ms) => wallClock(ms, timeZone) === Math.floor(wall / 1000) * 1000)
    .sort((a, b) => a - b);
  return candidates.length ? candidates[0] : wall - before;
}

/** A wall-clock timestamp as a datetime-local value ("YYYY-MM-DDTHH:MM"). */
export function wallToInput(wall) {
  const d = new Date(wall);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** The instant a datetime-local value means in `timeZone`, or NaN. */
export function inputToInstant(value, timeZone) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return NaN;
  return zonedToUtc(Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5]), timeZone);
}

/** Midnight (wall clock) of the day `ms` falls on in `timeZone`. */
function wallMidnight(ms, timeZone) {
  const wall = wallClock(ms, timeZone);
  return wall - (((wall % DAY) + DAY) % DAY);
}

/** Calendar days between today and the day of `ms`, both in `timeZone` (0 = today, 1 = tomorrow). */
export function dayDiff(ms, timeZone, now = Date.now()) {
  return Math.round((wallMidnight(ms, timeZone) - wallMidnight(now, timeZone)) / DAY);
}

/** "14:05" */
export function clockTime(ms, timeZone) {
  return formatter(timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
}

/** "Sat 19 Oct" (with the year when it is not this year). */
export function dateLabel(ms, timeZone, now = Date.now()) {
  const sameYear = formatter(timeZone, { year: 'numeric' }).format(ms) === formatter(timeZone, { year: 'numeric' }).format(now);
  return formatter(timeZone, { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).format(ms);
}

/** Day group header: "Today", "Tomorrow", "Yesterday" or "Sat 19 Oct". */
export function dayLabel(ms, timeZone, now = Date.now()) {
  const diff = dayDiff(ms, timeZone, now);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return dateLabel(ms, timeZone, now);
}

/** Compact absolute time: "today 09:00", "tomorrow 09:00", "Tue 09:00" or "28 Oct 09:00". */
export function shortWhen(ms, timeZone, now = Date.now()) {
  const diff = dayDiff(ms, timeZone, now);
  const time = clockTime(ms, timeZone);
  if (diff === 0) return `today ${time}`;
  if (diff === 1) return `tomorrow ${time}`;
  if (diff > 1 && diff < 7) return `${formatter(timeZone, { weekday: 'short' }).format(ms)} ${time}`;
  return `${formatter(timeZone, { day: 'numeric', month: 'short' }).format(ms)} ${time}`;
}

/** "in 25m", "in 3h", "in 2d", or a date further out. */
export function relativeTime(ms, timeZone, now = Date.now()) {
  const diff = ms - now;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `in ${Math.ceil(diff / 60_000)}m`;
  if (diff < DAY) return `in ${Math.round(diff / 3_600_000)}h`;
  if (diff < 6.5 * DAY) return `in ${Math.round(diff / DAY)}d`;
  return formatter(timeZone, { day: 'numeric', month: 'short' }).format(ms);
}

/** "GMT+03:00" (style longOffset) or "GMT+3" (shortOffset) for `timeZone` at `ms`. */
export function offsetLabel(timeZone, ms = Date.now(), style = 'longOffset') {
  try {
    const part = new Intl.DateTimeFormat('en', { timeZone, timeZoneName: style }).formatToParts(ms).find((p) => p.type === 'timeZoneName');
    return part?.value || '';
  } catch {
    return '';
  }
}

/** Default send time: one hour from now, rounded up to a quarter hour, in `timeZone`. */
export function defaultSendAt(timeZone, now = Date.now()) {
  const wall = wallClock(now + 3_600_000, timeZone);
  return wallToInput(Math.ceil(wall / 900_000) * 900_000);
}

/** Quick picks for the send time, as datetime-local values in `timeZone`. Passed times are left out. */
export function quickTimes(timeZone, now = Date.now()) {
  const today = wallMidnight(now, timeZone);
  const at = (days, hour) => today + days * DAY + hour * 3_600_000;
  const future = (wall) => zonedToUtc(wall, timeZone) > now + 5 * 60_000;
  const picks = [{ label: 'In 1 hour', value: wallToInput(Math.ceil(wallClock(now + 3_600_000, timeZone) / 300_000) * 300_000) }];
  if (future(at(0, 20))) picks.push({ label: 'Tonight 20:00', value: wallToInput(at(0, 20)) });
  picks.push({ label: 'Tomorrow 09:00', value: wallToInput(at(1, 9)) });
  const toMonday = (8 - new Date(today).getUTCDay()) % 7 || 7;
  if (toMonday > 1) picks.push({ label: 'Mon 09:00', value: wallToInput(at(toMonday, 9)) });
  return picks;
}

/** The browser's own timezone. */
export function deviceTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
