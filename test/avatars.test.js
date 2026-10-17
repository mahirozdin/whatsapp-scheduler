import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Avatars, isAvatarJid } from '../src/avatars.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const MOM = '905551112233@s.whatsapp.net';
const FAMILY = '120363000000000000@g.us';

function setup({ canPause = () => true, image = JPEG, pictureInfo } = {}) {
  const calls = [];
  const pauses = [];
  const whatsapp = {
    async pictureInfo(jid, existingId) {
      calls.push({ jid, existingId });
      if (pictureInfo) return pictureInfo(jid, existingId);
      if (jid.startsWith('nopic')) throw new Error('get profile picture info: that user or group does not have a profile picture');
      if (existingId === `pic-${jid}`) return { jid, unchanged: true };
      return { jid, id: `pic-${jid}`, url: `https://pps.whatsapp.net/${jid}.jpg` };
    },
    async recentChats() {
      return [{ jid: MOM, kind: 'dm' }, { jid: FAMILY, kind: 'group' }];
    },
    async pauseSync(fn) {
      pauses.push(Date.now());
      await fn();
      return true;
    },
  };
  const fetch = async (url) => {
    assert.match(url, /^https:/);
    return new Response(image, { headers: { 'Content-Type': 'image/jpeg' } });
  };
  const dir = mkdtempSync(join(tmpdir(), 'was-avatars-'));
  const avatars = new Avatars({ dir, whatsapp, canPause, fetch, log: () => {} });
  return { avatars, calls, pauses, dir, whatsapp, fetch };
}

test('only real chat jids get avatars', () => {
  assert.equal(isAvatarJid(MOM), true);
  assert.equal(isAvatarJid(FAMILY), true);
  assert.equal(isAvatarJid('123@lid'), true);
  assert.equal(isAvatarJid('+905551112233'), false);
  assert.equal(isAvatarJid('status@broadcast'), false);
  assert.equal(isAvatarJid('../../etc/passwd@g.us'), false);
});

test('prefetch caches the pictures of recent chats', async () => {
  const { avatars, calls, dir, whatsapp, fetch } = setup();
  assert.equal(avatars.url(MOM), null);
  assert.deepEqual(await avatars.prefetch(), [MOM, FAMILY]);
  assert.deepEqual(await avatars.downloads, [MOM, FAMILY]);
  assert.equal(avatars.url(MOM), `/api/avatars/${encodeURIComponent(MOM)}`);
  assert.deepEqual(avatars.read(FAMILY), JPEG);

  // Fresh entries are not looked up again; the index survives a restart.
  const reloaded = new Avatars({ dir, whatsapp, fetch, log: () => {} });
  assert.deepEqual(await reloaded.prefetch(), []);
  assert.deepEqual(reloaded.read(MOM), JPEG);
  assert.equal(calls.length, 2);
});

test('stale pictures are refreshed with the known id, and contacts without one are remembered', async () => {
  const { avatars, calls } = setup();
  avatars.want(MOM);
  avatars.want('nopic@s.whatsapp.net');
  await avatars.flush({ force: true });
  assert.equal(avatars.url('nopic@s.whatsapp.net'), null);
  assert.equal(avatars.needsRefresh('nopic@s.whatsapp.net'), false);
  assert.equal(avatars.index['nopic@s.whatsapp.net'].none, true);

  avatars.index[MOM].fetchedAt -= 8 * 86_400_000;
  avatars.want(MOM);
  await avatars.flush({ force: true });
  assert.deepEqual(calls.at(-1), { jid: MOM, existingId: `pic-${MOM}` });
  assert.equal(avatars.needsRefresh(MOM), false);
  assert.ok(avatars.read(MOM));
});

test('the queue is flushed at most once per interval and never when pausing is unsafe', async () => {
  let safe = false;
  const { avatars, pauses, calls } = setup({ canPause: () => safe });
  avatars.want(MOM);
  avatars.want('+905551112233'); // not a jid: ignored
  assert.equal(avatars.queue.size, 1);

  assert.equal(await avatars.flush(), false); // interval not over yet
  avatars.lastFlushAt -= avatars.flushIntervalMs;
  assert.equal(await avatars.flush(), false); // a message is due soon
  assert.equal(pauses.length, 0);

  safe = true;
  assert.equal(await avatars.flush(), true);
  assert.equal(pauses.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(avatars.queue.size, 0);
  assert.equal(await avatars.flush({ force: true }), false); // nothing queued
});

test('a batch stops when a send becomes due or the store is locked', async () => {
  let budget = 2; // flush() checks once, then lookup() before each jid
  const { avatars, calls } = setup({ canPause: () => budget-- > 0 });
  avatars.queue = new Set([MOM, FAMILY]);
  await avatars.flush({ force: true });
  assert.equal(calls.length, 1);
  assert.deepEqual([...avatars.queue], [FAMILY]);

  const locked = setup({
    pictureInfo: async () => {
      throw new Error('store is locked (another wacli is running?)');
    },
  });
  locked.avatars.queue = new Set([MOM, FAMILY]);
  await locked.avatars.flush({ force: true });
  assert.equal(locked.calls.length, 1);
  assert.equal(locked.avatars.queue.size, 2);
  assert.equal(locked.avatars.index[MOM], undefined);
});

test('downloads must be small JPEGs over https', async () => {
  const notJpeg = setup({ image: Buffer.from('<html>') });
  await notJpeg.avatars.prefetch();
  await notJpeg.avatars.downloads;
  assert.equal(notJpeg.avatars.url(MOM), null);
  assert.ok(notJpeg.avatars.index[MOM].failedAt);
  assert.equal(notJpeg.avatars.needsRefresh(MOM), false); // retried later, not on every request

  const huge = setup({ image: Buffer.concat([JPEG, Buffer.alloc(1024 * 1024)]) });
  await huge.avatars.prefetch();
  await huge.avatars.downloads;
  assert.equal(huge.avatars.url(MOM), null);

  const { avatars } = setup();
  await assert.rejects(avatars.download('http://example.com/a.jpg'), /non-https/);
  await assert.rejects(avatars.download('file:///etc/passwd'), /non-https/);
});

test('prefetch looks up one small batch and queues the rest', async () => {
  const { avatars, whatsapp, calls } = setup();
  const jids = Array.from({ length: 8 }, (_, i) => `90555000000${i}@s.whatsapp.net`);
  whatsapp.recentChats = async () => jids.map((jid) => ({ jid, kind: 'dm' }));
  assert.deepEqual(await avatars.prefetch(), jids.slice(0, avatars.batchSize));
  await avatars.downloads;
  assert.equal(calls.length, avatars.batchSize);
  assert.deepEqual([...avatars.queue], jids.slice(avatars.batchSize));

  // The rest is looked up `firstFlushMs` after the prefetch, not a full interval later.
  assert.equal(await avatars.flush(), false);
  avatars.lastFlushAt -= avatars.firstFlushMs;
  assert.equal(await avatars.flush(), true);
  assert.equal(calls.length, 8);
});

test('pictures are downloaded after sync is restarted', async () => {
  const { avatars, whatsapp } = setup();
  let paused = false;
  let downloadedWhilePaused = false;
  whatsapp.pauseSync = async (fn) => {
    paused = true;
    await fn();
    paused = false;
    return true;
  };
  const fetch = avatars.fetch;
  avatars.fetch = (...args) => {
    downloadedWhilePaused ||= paused;
    return fetch(...args);
  };
  avatars.want(MOM);
  assert.equal(await avatars.flush({ force: true }), true);
  assert.equal(downloadedWhilePaused, false);
  assert.ok(avatars.read(MOM));
});

test('an index entry whose file is missing is dropped and fetched again', async () => {
  const { avatars } = setup();
  await avatars.prefetch();
  await avatars.downloads;
  rmSync(avatars.file(MOM));
  assert.equal(avatars.url(MOM), null);
  assert.equal(avatars.needsRefresh(MOM), true);

  rmSync(avatars.file(FAMILY));
  assert.equal(avatars.read(FAMILY), undefined);
  assert.equal(avatars.index[FAMILY], undefined);
});
