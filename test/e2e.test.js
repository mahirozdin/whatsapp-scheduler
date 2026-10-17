import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'whatsapp-scheduler.js');
const tmp = mkdtempSync(join(tmpdir(), 'was-e2e-'));
let env;
let base;
let proc;
let cookie;
let pictures;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);
const FAMILY = '120363000000000000@g.us';

const freePort = () =>
  new Promise((resolve) => {
    const srv = createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(100);
  }
}

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, data: await res.json().catch(() => null) };
}

before(async () => {
  // Stands in for WhatsApp's picture CDN.
  pictures = createHttpServer((req, res) => res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(JPEG));
  await new Promise((resolve) => pictures.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  env = {
    ...process.env,
    PORT: String(port),
    WA_SCHEDULER_DATA: join(tmp, 'data'),
    WA_SCHEDULER_PASSWORD: 'test-password',
    WA_SCHEDULER_TOKEN: 'test-token',
    WACLI_BIN: join(root, 'test', 'fixtures', 'fake-wacli.js'),
    FAKE_WACLI_DIR: join(tmp, 'wacli'),
    FAKE_WACLI_AVATAR_URL: `http://127.0.0.1:${pictures.address().port}/pic.jpg`,
  };
  proc = spawn(process.execPath, [bin], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  await waitFor(() => fetch(`${base}/api/session`).then((r) => r.ok));
});

after(() => {
  proc?.kill();
  pictures?.close();
});

const commands = () => readFileSync(join(tmp, 'wacli', 'commands.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('the UI is served and the API needs a login', async () => {
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /WhatsApp Scheduler/);
  for (const file of ['/app.js', '/time.js']) {
    const script = await fetch(base + file);
    assert.equal(script.status, 200, file);
    assert.match(script.headers.get('content-type'), /^text\/javascript/);
  }
  assert.equal((await call('GET', '/api/messages')).status, 401);
  assert.equal((await call('POST', '/api/login', { password: 'nope' })).status, 401);

  const login = await call('POST', '/api/login', { password: 'test-password' });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/api/messages')).status, 200);
});

test('cookie writes must be JSON (CSRF guard)', async () => {
  const res = await fetch(base + '/api/messages', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(res.status, 415);
});

test('linking shows a QR code and then connects', async () => {
  assert.equal((await call('GET', '/api/status')).data.whatsapp.linked, false);
  await call('POST', '/api/whatsapp/link', {});
  const qr = await waitFor(async () => (await call('GET', '/api/status')).data.whatsapp.pairing?.qrSvg);
  assert.match(qr, /<svg/);
  const status = await waitFor(async () => {
    const wa = (await call('GET', '/api/status')).data.whatsapp;
    return wa.linked && wa.online && wa;
  });
  assert.equal(status.pairing, null);
});

test('recipient search merges chats and contacts', async () => {
  const { data } = await call('GET', '/api/recipients?q=me');
  assert.deepEqual(data.map((r) => r.name).sort(), ['Mehmet']);
  const family = await call('GET', '/api/recipients?q=fam');
  assert.deepEqual(family.data, [{ jid: FAMILY, name: 'Family', kind: 'group', avatar: `/api/avatars/${encodeURIComponent(FAMILY)}` }]);
});

test('profile pictures of recent chats are fetched before sync starts and served', async () => {
  // picture-info needs the store lock, so it has to run while sync is stopped.
  const log = commands();
  const lookups = log.filter((c) => c.cmd === 'picture-info').map((c) => c.jid);
  assert.deepEqual(lookups.sort(), ['120363000000000000@g.us', '905551112233@s.whatsapp.net']);
  const firstSync = log.findIndex((c) => c.cmd === 'sync');
  assert.ok(log.findIndex((c) => c.cmd === 'picture-info') < firstSync);

  const res = await fetch(`${base}/api/avatars/${encodeURIComponent(FAMILY)}`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.match(res.headers.get('cache-control'), /private, max-age=\d+/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG);

  const bearer = await fetch(`${base}/api/avatars/${encodeURIComponent(FAMILY)}`, { headers: { Authorization: 'Bearer test-token' } });
  assert.equal(bearer.status, 200);
  assert.equal((await fetch(`${base}/api/avatars/${encodeURIComponent(FAMILY)}`)).status, 401);
  assert.equal((await call('GET', `/api/avatars/${encodeURIComponent('905554445566@s.whatsapp.net')}`)).status, 404);
  assert.equal((await call('GET', '/api/avatars/%E0%A4%A')).status, 400);
});

test('the timezone setting is validated, stored and used for times without an offset', async () => {
  const initial = await call('GET', '/api/settings');
  assert.equal(initial.status, 200);
  const status = (await call('GET', '/api/status')).data;
  assert.equal(status.timezone, initial.data.timezone);
  assert.equal(status.serverTimezone, initial.data.timezone);

  assert.equal((await call('PUT', '/api/settings', { timezone: 'Not/AZone' })).status, 400);
  const csrf = await fetch(base + '/api/settings', { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'text/plain' }, body: '{"timezone":"UTC"}' });
  assert.equal(csrf.status, 415);

  const updated = await call('PUT', '/api/settings', { timezone: 'America/New_York' });
  assert.deepEqual(updated.data, { timezone: 'America/New_York' });
  assert.equal((await call('GET', '/api/settings', undefined, { Cookie: '', Authorization: 'Bearer test-token' })).data.timezone, 'America/New_York');
  assert.equal((await call('GET', '/api/status')).data.timezone, 'America/New_York');

  const year = new Date().getUTCFullYear() + 1;
  const winter = await call('POST', '/api/messages', { to: FAMILY, text: 'winter', sendAt: `${year}-01-15T09:00` });
  const summer = await call('POST', '/api/messages', { to: FAMILY, text: 'summer', sendAt: `${year}-07-15T09:00` });
  assert.equal(winter.data.sendAt, `${year}-01-15T14:00:00.000Z`);
  assert.equal(summer.data.sendAt, `${year}-07-15T13:00:00.000Z`);
  assert.equal(winter.data.avatar, `/api/avatars/${encodeURIComponent(FAMILY)}`);
  const listed = (await call('GET', '/api/messages')).data.find((m) => m.id === winter.data.id);
  assert.equal(listed.avatar, `/api/avatars/${encodeURIComponent(FAMILY)}`);
  await call('DELETE', `/api/messages/${winter.data.id}`, {});
  await call('DELETE', `/api/messages/${summer.data.id}`, {});
  await call('PUT', '/api/settings', { timezone: initial.data.timezone });
});

test('a message scheduled from the web UI is sent', async () => {
  const started = Date.now();
  const created = await call('POST', '/api/messages', { to: '120363000000000000@g.us', toName: 'Family', text: 'Hello family', sendAt: 'now' });
  assert.equal(created.status, 201);
  assert.equal(created.data.source, 'web');
  const sent = await waitFor(async () => {
    const list = (await call('GET', '/api/messages')).data;
    return list.find((m) => m.id === created.data.id && m.status === 'sent');
  });
  assert.ok(sent.waMessageId);
  // Handed to the running sync right away instead of waiting for the store lock.
  assert.ok(Date.now() - started < 3_000, `send took ${Date.now() - started}ms`);
  assert.equal(commands().filter((c) => c.cmd === 'send').at(-1).via, 'delegate');
  const log = readFileSync(join(tmp, 'wacli', 'sent.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.at(-1), { to: '120363000000000000@g.us', message: 'Hello family' });
});

test('remote MCP over HTTP schedules and cancels messages', async () => {
  for (const [url, opts] of [
    [`${base}/mcp`, { requestInit: { headers: { Authorization: 'Bearer test-token' } } }],
    [`${base}/mcp/test-token`, {}],
  ]) {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), opts));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['cancel_message', 'find_recipient', 'get_status', 'list_messages', 'schedule_message']);

    const status = JSON.parse((await client.callTool({ name: 'get_status', arguments: {} })).content[0].text);
    assert.equal(status.whatsapp.linked, true);
    assert.equal(status.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.ok(status.serverTimezone);

    const sendAt = new Date(Date.now() + 86_400_000).toISOString();
    const scheduled = await client.callTool({ name: 'schedule_message', arguments: { to: '+905551112233', to_name: 'Mom', text: 'Good morning', send_at: sendAt } });
    const message = JSON.parse(scheduled.content[0].text);
    assert.equal(message.status, 'scheduled');
    assert.equal(message.source, 'mcp');
    assert.equal('avatar' in message, false);

    const canceled = JSON.parse((await client.callTool({ name: 'cancel_message', arguments: { id: message.id } })).content[0].text);
    assert.equal(canceled.status, 'canceled');

    const bad = await client.callTool({ name: 'cancel_message', arguments: { id: message.id } });
    assert.equal(bad.isError, true);
    await client.close();
  }

  const denied = await fetch(`${base}/mcp/wrong-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 401);
});

test('stdio MCP proxies to the running server', async () => {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin, 'mcp'], env }));
  const found = JSON.parse((await client.callTool({ name: 'find_recipient', arguments: { query: 'mom' } })).content[0].text);
  assert.equal(found[0].jid, '905551112233@s.whatsapp.net');

  const scheduled = await client.callTool({ name: 'schedule_message', arguments: { to: found[0].jid, to_name: 'Mom', text: 'from stdio' } });
  const id = JSON.parse(scheduled.content[0].text).id;
  await waitFor(async () => {
    const list = JSON.parse((await client.callTool({ name: 'list_messages', arguments: { status: 'sent' } })).content[0].text);
    return list.some((m) => m.id === id);
  }, 15_000);
  await client.close();
});

test('unlinking logs WhatsApp out', async () => {
  await call('POST', '/api/whatsapp/unlink', {});
  const wa = (await call('GET', '/api/status')).data.whatsapp;
  assert.equal(wa.linked, false);
});
