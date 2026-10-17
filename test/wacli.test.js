import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WhatsApp } from '../src/wacli.js';

const bin = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-wacli.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(25);
  }
}

// A linked WhatsApp with `sync --follow` running against the fake wacli.
async function linked(t) {
  const dir = mkdtempSync(join(tmpdir(), 'was-wacli-'));
  process.env.FAKE_WACLI_DIR = dir;
  writeFileSync(join(dir, 'authed'), '1');
  const whatsapp = new WhatsApp({ bin, store: join(dir, 'store'), log: () => {} });
  t.after(() => whatsapp.stop());
  await whatsapp.start();
  await waitFor(() => whatsapp.online && existsSync(join(dir, 'lock')));
  const commands = () => readFileSync(join(dir, 'commands.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { dir, whatsapp, commands };
}

test('the fake wacli models the lock-wait delay that made sends slow', async (t) => {
  const { whatsapp } = await linked(t);
  const started = Date.now();
  const result = await whatsapp.run(['--lock-wait', '1s', 'send', 'text', '--to', 'a@s.whatsapp.net', '--message', 'slow']);
  assert.equal(result.success, true);
  assert.ok(Date.now() - started >= 1_000);
});

test('a send while sync runs is handed to sync right away', async (t) => {
  const { whatsapp, commands } = await linked(t);
  const started = Date.now();
  const id = await whatsapp.sendText('a@s.whatsapp.net', 'fast');
  assert.ok(id);
  assert.ok(Date.now() - started < 1_000, `send took ${Date.now() - started}ms`);
  const send = commands().filter((c) => c.cmd === 'send').at(-1);
  assert.equal(send.via, 'delegate');
  assert.equal(send.lockWait, null);
});

test('a locked store without sync to delegate to waits for the lock instead of failing', async (t) => {
  const { dir, whatsapp, commands } = await linked(t);
  writeFileSync(join(dir, 'no-delegate'), '1');
  const sending = whatsapp.sendText('a@s.whatsapp.net', 'after the lock');
  await waitFor(() => commands().some((c) => c.cmd === 'send-locked'));
  await whatsapp.stopSync();
  assert.ok(await sending);
  const send = commands().filter((c) => c.cmd === 'send').at(-1);
  assert.equal(send.via, 'direct');
  assert.equal(send.lockWait, '60s');
});

test('wacli errors from stderr are reported as plain messages', async (t) => {
  const { whatsapp } = await linked(t);
  await assert.rejects(whatsapp.sendText('fail@s.whatsapp.net', 'hi'), { message: 'recipient not on WhatsApp' });
});

test('pauseSync frees the store lock and always restarts sync', async (t) => {
  const { whatsapp } = await linked(t);
  await assert.rejects(whatsapp.pictureInfo('905551112233@s.whatsapp.net'), /store is locked/);

  let info;
  assert.equal(await whatsapp.pauseSync(async () => {
    assert.equal(whatsapp.sync, null);
    info = await whatsapp.pictureInfo('905551112233@s.whatsapp.net');
  }), true);
  assert.equal(info.id, 'pic-905551112233');
  await waitFor(() => whatsapp.online);

  await whatsapp.pauseSync(async () => {
    throw new Error('boom');
  });
  await waitFor(() => whatsapp.online);
  assert.ok(whatsapp.sync);
});

test('a send while sync is shutting down waits for the lock instead of being handed to it', async (t) => {
  process.env.FAKE_WACLI_SYNC_EXIT_MS = '500';
  t.after(() => delete process.env.FAKE_WACLI_SYNC_EXIT_MS);
  const { whatsapp, commands } = await linked(t);
  const stopping = whatsapp.stopSync();
  assert.ok(await whatsapp.sendText('a@s.whatsapp.net', 'during stop'));
  await stopping;
  const send = commands().filter((c) => c.cmd === 'send').at(-1);
  assert.equal(send.via, 'direct');
  assert.equal(send.lockWait, '60s');
});

test('no pause can restart sync while unlinking', async (t) => {
  process.env.FAKE_WACLI_SYNC_EXIT_MS = '300';
  t.after(() => delete process.env.FAKE_WACLI_SYNC_EXIT_MS);
  const { whatsapp, commands } = await linked(t);
  const unlinking = whatsapp.unlink();
  assert.equal(await whatsapp.pauseSync(async () => {}), false);
  await unlinking;
  assert.equal(whatsapp.linked, false);
  await sleep(300);
  assert.equal(whatsapp.sync, null);
  assert.equal(commands().filter((c) => c.cmd === 'sync').length, 1);
});
