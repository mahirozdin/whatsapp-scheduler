import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseSendAt, Service, ValidationError } from '../src/service.js';
import { MessageStore } from '../src/store.js';

function setup({ linked = true, sendText } = {}) {
  const store = new MessageStore(join(mkdtempSync(join(tmpdir(), 'was-')), 'messages.json'));
  const sent = [];
  const whatsapp = {
    status: () => ({ linked }),
    sendText: sendText || (async (to, text) => {
      sent.push({ to, text });
      return 'WAID';
    }),
  };
  const service = new Service({ store, whatsapp, log: () => {} });
  return { store, service, sent };
}

test('parseSendAt handles offsets, local time and now', () => {
  assert.equal(parseSendAt('2026-10-18T09:00:00+03:00').toISOString(), '2026-10-18T06:00:00.000Z');
  assert.equal(parseSendAt('2026-10-18 09:00').getTime(), new Date(2026, 9, 18, 9, 0).getTime());
  const now = new Date();
  assert.equal(parseSendAt(undefined, now), now);
  assert.equal(parseSendAt('now', now), now);
  assert.throws(() => parseSendAt('tomorrow'), ValidationError);
  assert.throws(() => parseSendAt('2026-10-18'), ValidationError);
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
