import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSendAt } from '../src/service.js';
import {
  dayLabel,
  defaultSendAt,
  inputToInstant,
  offsetLabel,
  quickTimes,
  relativeTime,
  shortWhen,
  wallToInput,
} from '../public/time.js';

// The web UI's helpers (public/time.js) run in the browser but use only Intl,
// so they can be tested here against the server's own parsing.

test('datetime-local values are read in the selected timezone, like the server does', () => {
  for (const [value, tz] of [
    ['2026-01-15T09:00', 'America/New_York'],
    ['2026-07-15T09:00', 'America/New_York'],
    ['2026-03-08T02:30', 'America/New_York'], // skipped by the spring-forward change
    ['2026-11-01T01:30', 'America/New_York'], // happens twice
    ['2026-10-18T09:00', 'Europe/Istanbul'],
    ['2026-10-18T09:00', 'Asia/Kolkata'],
  ]) {
    assert.equal(inputToInstant(value, tz), parseSendAt(value, { timeZone: tz }).getTime(), `${value} ${tz}`);
  }
  assert.ok(Number.isNaN(inputToInstant('', 'UTC')));
});

test('the default send time is an hour ahead, rounded up to a quarter hour, in the selected timezone', () => {
  const now = Date.parse('2026-10-17T12:07:00Z');
  assert.equal(defaultSendAt('Europe/Istanbul', now), '2026-10-17T16:15');
  assert.equal(defaultSendAt('America/New_York', now), '2026-10-17T09:15');
  assert.equal(wallToInput(Date.UTC(2026, 0, 2, 3, 4)), '2026-01-02T03:04');
});

test('quick picks skip passed times and a Monday that is already tomorrow', () => {
  // Saturday 17 Oct 2026, 15:00 in Istanbul.
  const sat = Date.parse('2026-10-17T12:00:00Z');
  assert.deepEqual(
    quickTimes('Europe/Istanbul', sat).map((p) => `${p.label}=${p.value}`),
    ['In 1 hour=2026-10-17T16:00', 'Tonight 20:00=2026-10-17T20:00', 'Tomorrow 09:00=2026-10-18T09:00', 'Mon 09:00=2026-10-19T09:00'],
  );
  // Sunday 22:00: tonight has passed and tomorrow is Monday.
  const sunNight = Date.parse('2026-10-18T19:00:00Z');
  assert.deepEqual(quickTimes('Europe/Istanbul', sunNight).map((p) => p.label), ['In 1 hour', 'Tomorrow 09:00']);
});

test('labels use calendar days in the selected timezone', () => {
  const now = Date.parse('2026-10-17T22:30:00Z'); // 01:30 on the 18th in Istanbul, still the 17th in New York
  const later = Date.parse('2026-10-18T06:00:00Z');
  assert.equal(dayLabel(later, 'Europe/Istanbul', now), 'Today');
  assert.equal(dayLabel(later, 'America/New_York', now), 'Tomorrow');
  assert.equal(dayLabel(now - 86_400_000, 'Europe/Istanbul', now), 'Yesterday');
  assert.equal(shortWhen(later, 'Europe/Istanbul', now), 'today 09:00');
  assert.equal(relativeTime(now + 25 * 60_000, 'UTC', now), 'in 25m');
  assert.equal(relativeTime(now + 3 * 3_600_000, 'UTC', now), 'in 3h');
  assert.equal(relativeTime(now + 2 * 86_400_000, 'UTC', now), 'in 2d');
  assert.equal(offsetLabel('Europe/Istanbul', now), 'GMT+03:00');
});
