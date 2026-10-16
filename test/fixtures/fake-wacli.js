#!/usr/bin/env node
// A stand-in for the wacli binary used by the tests. State lives in $FAKE_WACLI_DIR.
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
const fail = (error) => {
  console.log(JSON.stringify({ success: false, data: null, error }));
  process.exit(1);
};
const event = (name, data) => console.error(JSON.stringify({ event: name, data, ts: Date.now() }));

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
  setTimeout(() => {
    writeFileSync(authed, '1');
    process.exit(0);
  }, Number(process.env.FAKE_WACLI_PAIR_MS || 800));
} else if (cmd === 'sync') {
  event('connected');
  setInterval(() => {}, 1000);
  process.on('SIGTERM', () => process.exit(0));
} else if (cmd === 'send text') {
  if (!existsSync(authed)) fail('not authenticated');
  if (flags.to === 'fail@s.whatsapp.net') fail('recipient not on WhatsApp');
  appendFileSync(join(dir, 'sent.ndjson'), JSON.stringify({ to: flags.to, message: flags.message }) + '\n');
  ok({ sent: true, to: flags.to, id: `MSG${Date.now()}` });
} else if (cmd === 'chats list') {
  ok([
    { jid: '905551112233@s.whatsapp.net', kind: 'dm', name: 'Mom' },
    { jid: '120363000000000000@g.us', kind: 'group', name: 'Family' },
    { jid: 'status@broadcast', kind: 'broadcast', name: 'Status' },
  ].filter((c) => c.name.toLowerCase().includes(String(flags.query).toLowerCase())));
} else if (cmd === `contacts search ${positional[2]}`) {
  ok([{ jid: '905554445566@s.whatsapp.net', phone: '905554445566', name: 'Mehmet', alias: '', system_name: '' }]
    .filter((c) => c.name.toLowerCase().includes(positional[2].toLowerCase())));
} else {
  fail(`fake wacli: unsupported command ${cmd}`);
}
