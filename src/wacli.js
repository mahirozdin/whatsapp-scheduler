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

// wacli's error when another process holds the store lock and nothing took the
// command over; the command did not run.
const LOCKED = /store is locked/i;

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
    this.unlinking = false; // set for the whole unlink(), so no pause restarts sync meanwhile
    this.restartDelay = 2000;
    this.sending = 0; // sends in flight
    this.paused = null; // promise while sync is paused for maintenance (see pauseSync)
    this.beforeSync = null; // optional async hook run before sync starts (avatar prefetch)
  }

  run(args, { timeoutMs = 60_000 } = {}) {
    return new Promise((resolve) => {
      execFile(this.bin, ['--store', this.store, '--json', ...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        // wacli prints the result envelope to stdout and, with --json, errors to stderr.
        const envelope = parseEnvelope(stdout) || parseEnvelope(stderr || '');
        if (envelope) return resolve({ ...envelope, error: envelope.error ?? null });
        const message = (stderr || err?.message || 'wacli failed').trim().split('\n').pop();
        resolve({ success: false, data: null, error: message });
      });
    });
  }

  async start() {
    mkdirSync(this.store, { recursive: true, mode: 0o700 });
    const status = await this.run(['auth', 'status']);
    this.linked = Boolean(status.success && status.data?.authenticated);
    if (!this.linked) return;
    if (this.beforeSync) {
      // Commands that need the store lock (profile pictures) run before sync
      // takes the lock; sync starts right after, even if the hook fails.
      this.pauseSync(this.beforeSync);
    } else {
      this.startSync();
    }
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
    if (this.sync || this.stopping || this.unlinking || this.paused || !this.linked) return;
    // --lock-wait: if a one-shot command still holds the store lock (a send that
    // could not be delegated), wait for it instead of exiting right away.
    const proc = spawn(this.bin, ['--store', this.store, '--lock-wait', '60s', 'sync', '--follow', '--events', '--presence-mode', 'quiet'], {
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
      if (this.sync === proc) this.sync = null;
      this.online = false;
      if (this.stopping || proc.expectedExit) return;
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

  /** Stops the sync process cleanly (SIGTERM, then SIGKILL after 15s) without the auto-restart. */
  async stopSync() {
    const proc = this.sync;
    if (!proc) return;
    proc.expectedExit = true;
    this.sync = null;
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise((resolve) => {
      const force = setTimeout(() => proc.kill('SIGKILL'), 15_000);
      proc.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      proc.kill('SIGTERM');
    });
  }

  /**
   * Runs `fn` with sync stopped, for wacli commands that need the store lock
   * and are not delegated to the running sync (profile pictures). Sync is
   * always restarted afterwards, also when `fn` throws. Returns false if a
   * pause is already running or WhatsApp is being unlinked.
   */
  pauseSync(fn) {
    if (this.paused || this.unlinking) return Promise.resolve(false);
    const waitForSends = async () => {
      while (this.sending) await new Promise((resolve) => setTimeout(resolve, 200));
    };
    this.paused = (async () => {
      try {
        // Never stop sync under a send that was handed to it.
        await waitForSends();
        await this.stopSync();
        await fn();
      } catch (err) {
        this.log(`maintenance failed: ${err.message}`);
      } finally {
        // A send that started during the pause is waiting for the store lock;
        // let it finish first, or it would wait out its whole --lock-wait
        // behind the restarted sync.
        await waitForSends();
        this.paused = null;
        this.startSync();
      }
      return true;
    })();
    return this.paused;
  }

  async unlink() {
    this.unlinking = true;
    try {
      this.cancelLink();
      await this.paused;
      await this.stopSync();
      await this.run(['--lock-wait', '30s', 'auth', 'logout']);
      this.linked = false;
      this.online = false;
    } finally {
      this.unlinking = false;
    }
  }

  stop() {
    this.stopping = true;
    this.authProc?.kill();
    this.sync?.kill();
  }

  /** Sends a text message. Resolves to the WhatsApp message id or throws with wacli's error. */
  async sendText(to, text) {
    const args = ['send', 'text', '--to', to, '--message', text];
    this.sending += 1;
    try {
      // No --lock-wait while sync runs: `sync --follow` holds the store lock
      // and wacli hands the send to it over the store's .send.sock right away.
      // With a lock-wait it would first wait the whole duration for the lock
      // (every send took ~30s). While sync is stopped or stopping (a pause, a
      // restart) the send could be handed to a sync that is shutting down, so
      // then wait for the lock and send directly.
      const direct = !this.sync;
      let result = await this.run(direct ? ['--lock-wait', '60s', ...args] : args, { timeoutMs: 3 * 60_000 });
      if (!direct && !result.success && LOCKED.test(result.error || '')) {
        // Locked and nobody to hand the send to (sync is restarting, or a
        // profile picture lookup holds the lock): nothing was sent, so wait for
        // the lock and send directly.
        result = await this.run(['--lock-wait', '60s', ...args], { timeoutMs: 3 * 60_000 });
      }
      if (!result.success) throw new Error(result.error || 'send failed');
      return result.data?.id;
    } finally {
      this.sending -= 1;
    }
  }

  /**
   * Profile picture metadata ({ id, url } or { unchanged: true } when
   * `existingId` is still current). Needs the store lock, so it only works
   * while sync is stopped (see pauseSync). Throws with wacli's error.
   */
  async pictureInfo(jid, existingId) {
    const args = ['--timeout', '15s', 'profile', 'picture-info', '--jid', jid, '--preview'];
    if (existingId) args.push('--existing-id', existingId);
    const result = await this.run(args, { timeoutMs: 20_000 });
    if (!result.success) throw new Error(result.error || 'picture-info failed');
    return result.data || {};
  }

  /** The most recent chats (people and groups), newest first. */
  async recentChats(limit = 40) {
    const result = await this.run(['--read-only', 'chats', 'list', '--limit', String(limit)]);
    return (result.data || []).filter((chat) => chat.kind === 'dm' || chat.kind === 'group');
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
