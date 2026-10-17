// Timezone helpers built on Intl only (no date library).

export function localTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

let known;

/**
 * Returns `value` as an IANA timezone name Intl understands (with the usual
 * capitalization, e.g. "utc" -> "UTC"), or undefined. Names are kept as given,
 * not canonicalized, so "Asia/Kolkata" stays "Asia/Kolkata".
 */
export function normalizeTimezone(value) {
  const name = String(value || '').trim();
  // IANA names only ("Europe/Istanbul", "UTC"); no raw offsets like "+03:00".
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(name)) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
  } catch {
    return undefined;
  }
  known ??= new Map(['UTC', ...(Intl.supportedValuesOf?.('timeZone') || [])].map((tz) => [tz.toLowerCase(), tz]));
  return known.get(name.toLowerCase()) || name;
}

const formatters = new Map();

function formatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock fields of an instant in a timezone, as a UTC timestamp ("local time as if it were UTC"). */
function wallClock(ms, timeZone) {
  const parts = {};
  for (const { type, value } of formatter(timeZone).formatToParts(new Date(ms))) parts[type] = Number(value);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/** UTC offset of `timeZone` at instant `ms`, in milliseconds (e.g. +3h for Europe/Istanbul). */
export function timezoneOffset(ms, timeZone) {
  const whole = Math.floor(ms / 1000) * 1000;
  return wallClock(whole, timeZone) - whole;
}

/**
 * Converts a wall-clock time in `timeZone` to an instant. `wall` is the local
 * time expressed as a UTC timestamp (Date.UTC(y, m, d, h, min, s, ms)).
 * Ambiguous times (clocks going back) resolve to the earlier instant; times
 * that do not exist (clocks going forward) move forward by the gap, like
 * Temporal's "compatible" disambiguation.
 */
export function zonedToUtc(wall, timeZone) {
  const before = timezoneOffset(wall - 86_400_000, timeZone);
  const after = timezoneOffset(wall + 86_400_000, timeZone);
  const candidates = [...new Set([before, after])]
    .map((offset) => wall - offset)
    .filter((ms) => wallClock(ms, timeZone) === Math.floor(wall / 1000) * 1000)
    .sort((a, b) => a - b);
  if (candidates.length) return candidates[0];
  return wall - before;
}
