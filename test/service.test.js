import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseSendAt, Service, ValidationError } from '../src/service.js';
import { Settings } from '../src/settings.js';
import { MessageStore } from '../src/store.js';
import { normalizeTimezone } from '../src/time.js';

function setup({ linked = true, sendText, settings } = {}) {
  const store = new MessageStore(join(mkdtempSync(join(tmpdir(), 'was-')), 'messages.json'));
  const sent = [];
  const whatsapp = {
    status: () => ({ linked }),
    sendText: sendText || (async (to, text) => {
      sent.push({ to, text });
      return 'WAID';
    }),
  };
  const service = new Service({ store, whatsapp, settings, log: () => {} });
  return { store, service, sent };
}

const at = (value, timeZone) => parseSendAt(value, { timeZone }).toISOString();

test('parseSendAt handles offsets, local time and now', () => {
  assert.equal(parseSendAt('2026-10-18T09:00:00+03:00').toISOString(), '2026-10-18T06:00:00.000Z');
  assert.equal(at('2026-10-18T09:00:00Z', 'Asia/Kolkata'), '2026-10-18T09:00:00.000Z');
  assert.equal(at('2026-10-18T09:00-0500', 'Asia/Kolkata'), '2026-10-18T14:00:00.000Z');
  assert.equal(parseSendAt('2026-10-18 09:00').getTime(), new Date(2026, 9, 18, 9, 0).getTime());
  const now = new Date();
  assert.equal(parseSendAt(undefined, { now }), now);
  assert.equal(parseSendAt('now', { now }), now);
  assert.throws(() => parseSendAt('tomorrow'), ValidationError);
  assert.throws(() => parseSendAt('2026-10-18'), ValidationError);
  assert.throws(() => parseSendAt('2026-02-30T09:00'), ValidationError);
  assert.throws(() => parseSendAt('2026-10-18T25:00'), ValidationError);
});

test('parseSendAt reads times without an offset in the selected timezone', () => {
  // No DST.
  assert.equal(at('2026-01-15T09:00', 'Europe/Istanbul'), '2026-01-15T06:00:00.000Z');
  assert.equal(at('2026-07-15T09:00', 'Europe/Istanbul'), '2026-07-15T06:00:00.000Z');
  // Half-hour offset.
  assert.equal(at('2026-10-18T09:30', 'Asia/Kolkata'), '2026-10-18T04:00:00.000Z');
  assert.equal(at('2026-10-18T09:30:15.250', 'Asia/Kolkata'), '2026-10-18T04:00:15.250Z');
  // New York: EST (-5) in winter, EDT (-4) in summer.
  assert.equal(at('2026-01-15T09:00', 'America/New_York'), '2026-01-15T14:00:00.000Z');
  assert.equal(at('2026-07-15T09:00', 'America/New_York'), '2026-07-15T13:00:00.000Z');
  // Around the spring-forward switch (2026-03-08 02:00 -> 03:00).
  assert.equal(at('2026-03-08T01:59', 'America/New_York'), '2026-03-08T06:59:00.000Z');
  assert.equal(at('2026-03-08T03:00', 'America/New_York'), '2026-03-08T07:00:00.000Z');
  // 02:30 does not exist that day; it moves forward by the gap (03:30 EDT).
  assert.equal(at('2026-03-08T02:30', 'America/New_York'), '2026-03-08T07:30:00.000Z');
  // 01:30 happens twice on 2026-11-01; the first (EDT) one wins.
  assert.equal(at('2026-11-01T01:30', 'America/New_York'), '2026-11-01T05:30:00.000Z');
  assert.equal(at('2026-11-01T02:30', 'America/New_York'), '2026-11-01T07:30:00.000Z');
  assert.equal(at('2026-06-01T12:00', 'UTC'), '2026-06-01T12:00:00.000Z');
});

test('timezone names are validated and normalized', () => {
  assert.equal(normalizeTimezone('Europe/Istanbul'), 'Europe/Istanbul');
  assert.equal(normalizeTimezone('utc'), 'UTC');
  assert.equal(normalizeTimezone('Mars/Olympus_Mons'), undefined);
  assert.equal(normalizeTimezone('+03:00'), undefined);
  assert.equal(normalizeTimezone(''), undefined);
  assert.equal(normalizeTimezone(undefined), undefined);
});

test('the selected timezone is stored and used for scheduling', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'was-')), 'settings.json');
  const settings = new Settings(file);
  const { service } = setup({ settings });
  assert.equal(service.getSettings().timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.throws(() => service.updateSettings({ timezone: 'Nowhere/Land' }), ValidationError);
  assert.throws(() => service.updateSettings({}), /timezone is required/);
  assert.deepEqual(service.updateSettings({ timezone: 'Asia/Kolkata' }), { timezone: 'Asia/Kolkata' });
  assert.equal(new Settings(file).timezone, 'Asia/Kolkata');

  const status = service.status();
  assert.equal(status.timezone, 'Asia/Kolkata');
  assert.equal(status.serverTimezone, Intl.DateTimeFormat().resolvedOptions().timeZone);

  const year = new Date().getUTCFullYear() + 1;
  const message = service.schedule({ to: 'x', text: 'hi', sendAt: `${year}-01-10T09:00` });
  assert.equal(message.sendAt, `${year}-01-10T03:30:00.000Z`);
});

test('a scheduled message fires at its exact time, not on the next interval tick', async () => {
  const { service, store, sent } = setup();
  service.start(60_000);
  try {
    const m = service.schedule({ to: 'x', text: 'on time', sendAt: new Date(Date.now() + 300).toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(store.get(m.id).status, 'sent');
    assert.ok(new Date(store.get(m.id).sentAt) - new Date(m.sendAt) < 250);
    assert.equal(sent.length, 1);
  } finally {
    service.stop();
  }
});

test('a message that becomes due during a send goes out right after it, with spacing', async () => {
  const { service, store, sent } = setup();
  service.lastSendAt = 0;
  const first = service.schedule({ to: 'a', text: 'first' });
  const second = service.schedule({ to: 'b', text: 'second', sendAt: new Date(Date.now() + 100).toISOString() });
  service.start(60_000);
  try {
    // The first send happens now; the second waits for the 5s spacing, not for a later tick.
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    assert.equal(store.get(first.id).status, 'sent');
    assert.equal(store.get(second.id).status, 'sent');
    const gap = new Date(store.get(second.id).sentAt) - new Date(store.get(first.id).sentAt);
    assert.ok(gap >= 4_900, `gap ${gap}`);
    assert.deepEqual(sent.map((s) => s.text), ['first', 'second']);
  } finally {
    service.stop();
  }
});

test('busy() is true while a message is sending or due soon', () => {
  const { service, store } = setup();
  assert.equal(service.busy(), false);
  const m = service.schedule({ to: 'x', text: 'later', sendAt: new Date(Date.now() + 10 * 60_000).toISOString() });
  assert.equal(service.busy(), false);
  store.update(m.id, { sendAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(service.busy(), true);
  store.update(m.id, { sendAt: new Date(Date.now() + 10 * 60_000).toISOString(), status: 'sending' });
  assert.equal(service.busy(), true);
});

test('schedule validates input', () => {
  const { service } = setup();
  assert.throws(() => service.schedule({ to: '', text: 'hi' }), /recipient/);
  assert.throws(() => service.schedule({ to: 'x', text: '  ' }), /text/);
  assert.throws(() => service.schedule({ to: 'x', text: 'hi', sendAt: '2020-01-01T00:00:00Z' }), /past/);
});

test('due messages are sent, future ones wait, canceled ones never go', async () => {
  const { service, store, sent } = setup();
  const now = service.schedule({ to: 'a@s.whatsapp.net', toName: 'A', text: 'now' });
  const later = service.schedule({ to: 'b@s.whatsapp.net', text: 'later', sendAt: new Date(Date.now() + 3_600_000).toISOString() });
  const canceled = service.schedule({ to: 'c@s.whatsapp.net', text: 'nope' });
  service.cancel(canceled.id);
  await service.tick();

  assert.deepEqual(sent, [{ to: 'a@s.whatsapp.net', text: 'now' }]);
  assert.equal(store.get(now.id).status, 'sent');
  assert.equal(store.get(now.id).waMessageId, 'WAID');
  assert.equal(store.get(later.id).status, 'scheduled');
  assert.equal(store.get(canceled.id).status, 'canceled');
  assert.throws(() => service.cancel(now.id), /already sent/);
});

test('send errors are recorded and not retried', async () => {
  const { service, store } = setup({
    sendText: async () => {
      throw new Error('recipient not on WhatsApp');
    },
  });
  const m = service.schedule({ to: 'x', text: 'hi' });
  await service.tick();
  assert.equal(store.get(m.id).status, 'failed');
  assert.equal(store.get(m.id).error, 'recipient not on WhatsApp');
});

test('messages wait while unlinked and are marked missed when too late', async () => {
  const { service, store, sent } = setup({ linked: false });
  const m = service.schedule({ to: 'x', text: 'hi' });
  await service.tick();
  assert.equal(store.get(m.id).status, 'scheduled');

  store.update(m.id, { sendAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
  await service.tick();
  assert.equal(store.get(m.id).status, 'failed');
  assert.match(store.get(m.id).error, /Missed/);
  assert.equal(sent.length, 0);
});

test('an interrupted send is never resent after a restart', () => {
  const { service, store, sent } = setup();
  const m = store.create({ to: 'x', text: 'hi', sendAt: new Date().toISOString() });
  store.update(m.id, { status: 'sending' });
  service.start(60_000);
  service.stop();
  assert.equal(store.get(m.id).status, 'failed');
  assert.match(store.get(m.id).error, /outcome is unknown/);
  assert.equal(sent.length, 0);
});

test('the store survives a reload', () => {
  const { store } = setup();
  const m = store.create({ to: 'x', text: 'persist me', sendAt: new Date().toISOString() });
  const reloaded = new MessageStore(store.file);
  assert.equal(reloaded.get(m.id).text, 'persist me');
});
