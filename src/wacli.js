import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { WACLI_VERSION } from './config.js';

const RELEASES = `https://github.com/openclaw/wacli/releases/download/v${WACLI_VERSION}`;

function releaseAsset() {
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  if (process.platform === 'darwin') return `wacli_${WACLI_VERSION}_universal_darwin_all.tar.gz`;
  if (process.platform === 'linux' && arch) return `wacli_${WACLI_VERSION}_linux_${arch}.tar.gz`;
  if (process.platform === 'win32' && arch === 'amd64') return `wacli_${WACLI_VERSION}_windows_amd64.zip`;
  return undefined;
}

function onPath(name) {
  const which = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(which, [name], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.split(/\r?\n/)[0].trim() : undefined;
}

/**
 * Finds the wacli binary: $WACLI_BIN, then `wacli` on PATH, then a pinned
 * release downloaded (and checksum-verified) into the data directory.
 */
export async function resolveWacli(dataDir, log = console.log) {
  if (process.env.WACLI_BIN) return process.env.WACLI_BIN;
  const fromPath = onPath('wacli');
  if (fromPath) return fromPath;

  const exe = process.platform === 'win32' ? 'wacli.exe' : 'wacli';
  const dir = join(dataDir, 'bin', `wacli-${WACLI_VERSION}`);
  const bin = join(dir, exe);
  if (existsSync(bin)) return bin;

  const asset = releaseAsset();
  if (!asset) {
    throw new Error(`No prebuilt wacli for ${process.platform}/${process.arch}. Install it yourself (https://github.com/openclaw/wacli) and set WACLI_BIN.`);
  }

  log(`Downloading wacli ${WACLI_VERSION} (${asset})...`);
  const [archive, checksums] = await Promise.all([
    fetch(`${RELEASES}/${asset}`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`download failed: HTTP ${r.status}`)))),
    fetch(`${RELEASES}/checksums.txt`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`checksum download failed: HTTP ${r.status}`)))),
  ]);
  const expected = checksums.split('\n').find((line) => line.trim().endsWith(asset))?.split(/\s+/)[0];
  const actual = createHash('sha256').update(Buffer.from(archive)).digest('hex');
  if (!expected || expected !== actual) throw new Error(`wacli checksum mismatch for ${asset}`);

  mkdirSync(dir, { recursive: true });
  const archivePath = join(dir, asset);
  writeFileSync(archivePath, Buffer.from(archive));
  const untar = spawnSync('tar', ['-xf', archivePath, '-C', dir], { stdio: 'inherit' });
  rmSync(archivePath);
  if (untar.status !== 0 || !existsSync(bin)) throw new Error('could not extract the wacli archive (is `tar` installed?)');
  return bin;
}

function parseEnvelope(stdout) {
  const line = stdout.trim().split('\n').filter(Boolean).pop();
  if (!line) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function readEvents(stream, onEvent) {
  createInterface({ input: stream }).on('line', (line) => {
    try {
      onEvent(JSON.parse(line));
    } catch {
      // Not an NDJSON event (plain log line); ignore.
    }
  });
}

/**
 * Owns the wacli processes: pairing (`wacli auth`), the long-running
 * `wacli sync --follow` connection, and one-shot commands like `send`.
 */
export class WhatsApp {
  constructor({ bin, store, log = console.log }) {
    this.bin = bin;
    this.store = store;
    this.log = log;
    this.linked = false;
    this.online = false;
    this.pairing = null; // { qr, code, phone } while `wacli auth` runs
    this.error = null;
    this.sync = null;
    this.authProc = null;
    this.stopping = false;
    this.restartDelay = 2000;
  }

  run(args, { timeoutMs = 60_000 } = {}) {
    return new Promise((resolve) => {
      execFile(this.bin, ['--store', this.store, '--json', ...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        const envelope = parseEnvelope(stdout);
        if (envelope) return resolve(envelope);
        const message = (stderr || err?.message || 'wacli failed').trim().split('\n').pop();
        resolve({ success: false, data: null, error: message });
      });
    });
  }

  async start() {
    mkdirSync(this.store, { recursive: true, mode: 0o700 });
    const status = await this.run(['auth', 'status']);
    this.linked = Boolean(status.success && status.data?.authenticated);
    if (this.linked) this.startSync();
  }

  status() {
    return {
      linked: this.linked,
      online: this.online,
      pairing: this.pairing,
      error: this.error,
    };
  }

  /** Starts pairing. Without a phone number a QR code is shown; with one, an 8-character pairing code. */
  link({ phone } = {}) {
    if (this.linked) return;
    if (this.authProc) this.authProc.kill();
    this.error = null;
    this.pairing = { qr: null, code: null, phone: phone || null };

    const args = ['--store', this.store, 'auth', '--events', '--qr-format', 'text', '--idle-exit', '20s'];
    if (phone) args.push('--phone', phone);
    const proc = spawn(this.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.authProc = proc;

    readEvents(proc.stderr, (event) => {
      if (proc !== this.authProc) return;
      if (event.event === 'qr_code') this.pairing.qr = event.data.code;
      if (event.event === 'pair_code') this.pairing.code = event.data.code;
      if (event.event === 'error') this.error = event.data?.message;
    });

    // `wacli auth` keeps running after pairing to download history, so poll the
    // session instead of waiting for it to exit; once linked, hand over to `sync`.
    const poll = setInterval(async () => {
      if (proc !== this.authProc) return clearInterval(poll);
      const status = await this.run(['auth', 'status'], { timeoutMs: 10_000 });
      if (proc !== this.authProc || !status.success || !status.data?.authenticated) return;
      clearInterval(poll);
      this.linked = true;
      this.pairing = null;
      proc.kill('SIGTERM');
    }, 2000);

    proc.on('exit', async () => {
      clearInterval(poll);
      if (proc !== this.authProc) return;
      this.authProc = null;
      this.pairing = null;
      await this.start();
      if (this.linked) this.error = null;
      else if (!this.error) this.error = 'Pairing did not complete. Try again.';
    });
  }

  cancelLink() {
    const proc = this.authProc;
    this.authProc = null;
    this.pairing = null;
    proc?.kill();
  }

  startSync() {
    if (this.sync || this.stopping) return;
    const proc = spawn(this.bin, ['--store', this.store, 'sync', '--follow', '--events', '--presence-mode', 'quiet'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.sync = proc;
    let loggedOut = false;

    readEvents(proc.stderr, (event) => {
      if (event.event === 'connected') {
        this.online = true;
        this.error = null;
        this.restartDelay = 2000;
      }
      if (event.event === 'disconnected') this.online = false;
      if (event.event === 'logged_out') loggedOut = true;
      if (event.event === 'error') this.error = event.data?.message;
    });

    proc.on('exit', (code) => {
      this.sync = null;
      this.online = false;
      if (this.stopping) return;
      if (loggedOut) {
        this.linked = false;
        this.error = 'WhatsApp logged this device out. Link it again.';
        return;
      }
      this.log(`wacli sync exited (code ${code}); restarting in ${this.restartDelay / 1000}s`);
      setTimeout(() => this.startSync(), this.restartDelay);
      this.restartDelay = Math.min(this.restartDelay * 2, 60_000);
    });
  }

  async unlink() {
    this.cancelLink();
    const proc = this.sync;
    if (proc) {
      this.stopping = true;
      await new Promise((resolve) => {
        proc.once('exit', resolve);
        proc.kill();
      });
      this.stopping = false;
    }
    await this.run(['auth', 'logout']);
    this.linked = false;
    this.online = false;
  }

  stop() {
    this.stopping = true;
    this.authProc?.kill();
    this.sync?.kill();
  }

  /** Sends a text message. Resolves to the WhatsApp message id or throws with wacli's error. */
  async sendText(to, text) {
    const result = await this.run(['--lock-wait', '30s', 'send', 'text', '--to', to, '--message', text], { timeoutMs: 3 * 60_000 });
    if (!result.success) throw new Error(result.error || 'send failed');
    return result.data?.id;
  }

  /** Searches synced chats (people and groups) and contacts. */
  async search(query, limit = 15) {
    const [chats, contacts] = await Promise.all([
      this.run(['--read-only', 'chats', 'list', '--query', query, '--limit', String(limit)]),
      this.run(['--read-only', 'contacts', 'search', query, '--limit', String(limit)]),
    ]);
    const results = new Map();
    for (const chat of chats.data || []) {
      if (chat.kind !== 'dm' && chat.kind !== 'group') continue;
      results.set(chat.jid, { jid: chat.jid, name: chat.name || chat.jid.split('@')[0], kind: chat.kind });
    }
    for (const contact of contacts.data || []) {
      if (results.has(contact.jid)) continue;
      const name = contact.alias || contact.system_name || contact.name || contact.phone;
      results.set(contact.jid, { jid: contact.jid, name: name || contact.jid.split('@')[0], kind: 'dm', phone: contact.phone });
    }
    return [...results.values()].slice(0, limit);
  }
}

/** Reads the version of a wacli binary (used by `doctor`-style startup logging). */
export function wacliVersion(bin) {
  const result = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  return (result.stdout || '').trim();
}

export function isPhoneNumber(value) {
  return /^\+?[\d\s().-]{7,}$/.test(value.trim());
}
