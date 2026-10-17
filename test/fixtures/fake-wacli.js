#!/usr/bin/env node
// A stand-in for the wacli binary used by the tests. State lives in $FAKE_WACLI_DIR.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_WACLI_DIR;
mkdirSync(dir, { recursive: true });
const authed = join(dir, 'authed');

const args = process.argv.slice(2);
const positional = [];
const flags = {};
const BOOLEAN = new Set(['json', 'read-only', 'events', 'follow', 'version']);
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    if (BOOLEAN.has(args[i].slice(2))) flags[args[i].slice(2)] = true;
    else flags[args[i].slice(2)] = args[++i];
  } else positional.push(args[i]);
}
const cmd = positional.join(' ');
const ok = (data) => console.log(JSON.stringify({ success: true, data, error: null }));
// Like real wacli with --json: errors go to stderr.
const fail = (error) => {
  console.error(JSON.stringify({ success: false, data: null, error }));
  process.exit(1);
};
const event = (name, data) => console.error(JSON.stringify({ event: name, data, ts: Date.now() }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const duration = (value) => {
  const match = String(value || '').match(/^(\d+)(ms|s|m)$/);
  return match ? Number(match[1]) * { ms: 1, s: 1000, m: 60_000 }[match[2]] : 0;
};

// The store lock, like real wacli: `sync --follow` holds it for its lifetime.
// While sync runs, `send` is handed to it over a socket (unless the
// `no-delegate` file exists); other lock-needing commands fail with
// "store is locked", or wait for it with --lock-wait.
const lockFile = join(dir, 'lock');
const LOCKED_ERROR = 'store is locked (another wacli is running?): lock held';
function locked() {
  if (!existsSync(lockFile)) return false;
  try {
    process.kill(Number(readFileSync(lockFile, 'utf8')), 0);
    return true;
  } catch {
    return false;
  }
}
async function acquire() {
  const end = Date.now() + duration(flags['lock-wait']);
  while (locked()) {
    if (Date.now() >= end) return false;
    await sleep(50);
  }
  return true;
}
const canDelegate = () => locked() && !existsSync(join(dir, 'no-delegate'));
const record = (file, data) => appendFileSync(join(dir, file), JSON.stringify(data) + '\n');

if (flags.version) {
  console.log('wacli 0.0.0-fake');
} else if (cmd === 'auth status') {
  ok({ authenticated: existsSync(authed) });
} else if (cmd === 'auth logout') {
  rmSync(authed, { force: true });
  ok({ logged_out: true });
} else if (cmd === 'auth') {
  event('auth_starting');
  if (flags.phone) event('pair_code', { phone: flags.phone, code: 'ABCD-EFGH' });
  else event('qr_code', { code: 'https://wa.me/settings/linked_devices#fake' });
  // Like real wacli, auth keeps running (history sync) after pairing succeeds.
  setTimeout(() => writeFileSync(authed, '1'), Number(process.env.FAKE_WACLI_PAIR_MS || 800));
  setInterval(() => {}, 1000);
  process.on('SIGTERM', () => process.exit(0));
} else if (cmd === 'sync') {
  if (!(await acquire())) fail(LOCKED_ERROR);
  writeFileSync(lockFile, String(process.pid));
  record('commands.ndjson', { cmd: 'sync', at: Date.now() });
  event('connected');
  setInterval(() => {}, 1000);
  // FAKE_WACLI_SYNC_EXIT_MS: like real wacli, sync can take a while to shut down
  // (it keeps the lock and the send socket meanwhile).
  process.on('SIGTERM', () => {
    setTimeout(() => {
      rmSync(lockFile, { force: true });
      process.exit(0);
    }, Number(process.env.FAKE_WACLI_SYNC_EXIT_MS || 0));
  });
} else if (cmd === 'send text') {
  let via = 'direct';
  if (locked()) {
    // Real wacli waits the whole --lock-wait for the lock before it tries to
    // hand the send to the running sync.
    if (flags['lock-wait'] && !(await acquire()) && !canDelegate()) fail(LOCKED_ERROR);
    if (canDelegate()) via = 'delegate';
    else if (locked()) {
      record('commands.ndjson', { cmd: 'send-locked', at: Date.now() });
      fail(LOCKED_ERROR);
    }
  }
  if (!existsSync(authed)) fail('not authenticated');
  if (flags.to === 'fail@s.whatsapp.net') fail('recipient not on WhatsApp');
  record('sent.ndjson', { to: flags.to, message: flags.message });
  record('commands.ndjson', { cmd: 'send', via, lockWait: flags['lock-wait'] || null, at: Date.now() });
  ok({ sent: true, to: flags.to, id: `MSG${Date.now()}` });
} else if (cmd === 'profile picture-info') {
  if (flags['read-only']) fail('read-only mode: command would connect to WhatsApp');
  if (!(await acquire())) fail(LOCKED_ERROR);
  record('commands.ndjson', { cmd: 'picture-info', jid: flags.jid, existingId: flags['existing-id'] || null, at: Date.now() });
  if (flags.jid.startsWith('nopic')) fail('get profile picture info: that user or group does not have a profile picture');
  const id = `pic-${flags.jid.split('@')[0]}`;
  if (flags['existing-id'] === id) ok({ jid: flags.jid, unchanged: true });
  else ok({ jid: flags.jid, id, url: `${process.env.FAKE_WACLI_AVATAR_URL}?jid=${encodeURIComponent(flags.jid)}`, type: 'preview' });
} else if (cmd === 'chats list') {
  ok([
    { jid: '905551112233@s.whatsapp.net', kind: 'dm', name: 'Mom' },
    { jid: '120363000000000000@g.us', kind: 'group', name: 'Family' },
    { jid: 'status@broadcast', kind: 'broadcast', name: 'Status' },
  ].filter((c) => c.name.toLowerCase().includes(String(flags.query || '').toLowerCase())));
} else if (cmd === `contacts search ${positional[2]}`) {
  ok([{ jid: '905554445566@s.whatsapp.net', phone: '905554445566', name: 'Mehmet', alias: '', system_name: '' }]
    .filter((c) => c.name.toLowerCase().includes(positional[2].toLowerCase())));
} else {
  fail(`fake wacli: unsupported command ${cmd}`);
}
