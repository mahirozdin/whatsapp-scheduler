import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
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
  };
  proc = spawn(process.execPath, [bin], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  await waitFor(() => fetch(`${base}/api/session`).then((r) => r.ok));
});

after(() => proc?.kill());

test('the UI is served and the API needs a login', async () => {
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /WhatsApp Scheduler/);
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
  assert.deepEqual(family.data, [{ jid: '120363000000000000@g.us', name: 'Family', kind: 'group' }]);
});

test('a message scheduled from the web UI is sent', async () => {
  const created = await call('POST', '/api/messages', { to: '120363000000000000@g.us', toName: 'Family', text: 'Hello family', sendAt: 'now' });
  assert.equal(created.status, 201);
  assert.equal(created.data.source, 'web');
  const sent = await waitFor(async () => {
    const list = (await call('GET', '/api/messages')).data;
    return list.find((m) => m.id === created.data.id && m.status === 'sent');
  });
  assert.ok(sent.waMessageId);
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

    const sendAt = new Date(Date.now() + 86_400_000).toISOString();
    const scheduled = await client.callTool({ name: 'schedule_message', arguments: { to: '+905551112233', to_name: 'Mom', text: 'Good morning', send_at: sendAt } });
    const message = JSON.parse(scheduled.content[0].text);
    assert.equal(message.status, 'scheduled');
    assert.equal(message.source, 'mcp');

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
