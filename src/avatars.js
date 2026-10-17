import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 1024 * 1024;
const STALE_MS = 7 * 86_400_000;
// After a failed lookup (network, timeout) wait this long before trying again.
const RETRY_MS = 6 * 3_600_000;
// whatsmeow's ErrProfilePictureNotSet / ErrProfilePictureUnauthorized, plus the raw IQ errors.
const NO_PICTURE = /does not have a profile picture|no profile picture|hidden their profile picture|item-not-found|not-authorized/i;
const LOCKED = /store is locked/i;

export function isAvatarJid(jid) {
  return /^[\w.:-]+@(s\.whatsapp\.net|g\.us|lid)$/.test(String(jid || ''));
}

function isJpeg(buffer) {
  return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

/** https only; plain http is allowed for loopback addresses (used by the tests). */
function allowedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

/**
 * Profile picture cache for contacts and groups.
 *
 * `wacli profile picture-info` needs the store lock and, unlike `send`, is not
 * handed over to the running `sync --follow`; every call also opens its own
 * short WhatsApp connection. So lookups happen only while sync is stopped, in
 * small batches: once before sync starts (a few recent chats), and then at
 * most every `flushIntervalMs` (the first one already `firstFlushMs` after
 * the prefetch, so chats beyond the first batch fill in soon), briefly pausing sync, and only when
 * `canPause()` says no message is about to be sent. The pictures themselves
 * are downloaded after sync is back.
 *
 * Files: <dir>/<sha256(jid)>.jpg plus <dir>/index.json
 *   { [jid]: { id, fetchedAt } | { none: true, fetchedAt } | { failedAt } }
 */
export class Avatars {
  constructor({
    dir,
    whatsapp,
    canPause = () => true,
    fetch = globalThis.fetch,
    log = console.log,
    flushIntervalMs = 30 * 60_000,
    firstFlushMs = 5 * 60_000,
    batchSize = 5,
    batchTimeMs = 20_000,
  }) {
    this.dir = dir;
    this.whatsapp = whatsapp;
    this.canPause = canPause;
    this.fetch = fetch;
    this.log = log;
    this.flushIntervalMs = flushIntervalMs;
    this.firstFlushMs = firstFlushMs;
    this.batchSize = batchSize;
    this.batchTimeMs = batchTimeMs;
    this.queue = new Set();
    this.lastFlushAt = Date.now();
    this.timer = null;
    this.downloads = Promise.resolve([]); // the prefetch downloads, which run after sync started
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.indexFile = join(dir, 'index.json');
    try {
      this.index = existsSync(this.indexFile) ? JSON.parse(readFileSync(this.indexFile, 'utf8')) : {};
    } catch {
      this.index = {};
    }
  }

  file(jid) {
    return join(this.dir, `${createHash('sha256').update(jid).digest('hex').slice(0, 32)}.jpg`);
  }

  /** The API path of the cached picture, or null when none is cached. */
  url(jid) {
    if (!isAvatarJid(jid) || !this.index[jid]?.id) return null;
    if (!existsSync(this.file(jid))) {
      this.forget(jid);
      return null;
    }
    return `/api/avatars/${encodeURIComponent(jid)}`;
  }

  /** The cached JPEG, or undefined. */
  read(jid) {
    if (!isAvatarJid(jid) || !this.index[jid]?.id) return undefined;
    try {
      return readFileSync(this.file(jid));
    } catch (err) {
      if (err.code === 'ENOENT') this.forget(jid);
      return undefined;
    }
  }

  /** Drops an index entry whose file is gone, so it is fetched again. */
  forget(jid) {
    delete this.index[jid];
    this.save();
  }

  needsRefresh(jid, now = Date.now()) {
    if (!isAvatarJid(jid)) return false;
    const entry = this.index[jid];
    if (!entry) return true;
    if (entry.failedAt) return now - entry.failedAt > RETRY_MS;
    return now - entry.fetchedAt > STALE_MS;
  }

  /** Queues a jid whose picture is missing or stale; fetched on the next flush. */
  want(jid) {
    if (this.needsRefresh(jid)) this.queue.add(jid);
  }

  save() {
    const tmp = `${this.indexFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.index) + '\n', { mode: 0o600 });
    renameSync(tmp, this.indexFile);
  }

  /**
   * Looks up the picture metadata of one jid (needs sync stopped). Returns
   * { jid, info } or { jid, error }, or false when the store is locked (stop
   * the batch).
   */
  async info(jid) {
    try {
      return { jid, info: await this.whatsapp.pictureInfo(jid, this.index[jid]?.id) };
    } catch (err) {
      if (LOCKED.test(err.message)) return false;
      return { jid, error: err };
    }
  }

  /** Applies a lookup result: downloads a new picture (sync may run again) and updates the index. */
  async apply({ jid, info, error }) {
    const previous = this.index[jid];
    if (error) {
      if (NO_PICTURE.test(error.message)) {
        rmSync(this.file(jid), { force: true });
        this.index[jid] = { none: true, fetchedAt: Date.now() };
      } else {
        this.index[jid] = { ...previous, failedAt: Date.now() };
        this.log(`profile picture for ${jid} failed: ${error.message}`);
      }
      return;
    }
    if (info.unchanged && previous?.id) {
      this.index[jid] = { id: previous.id, fetchedAt: Date.now() };
      return;
    }
    if (!info.url || !info.id) {
      rmSync(this.file(jid), { force: true });
      this.index[jid] = { none: true, fetchedAt: Date.now() };
      return;
    }
    try {
      const image = await this.download(info.url);
      const file = this.file(jid);
      writeFileSync(`${file}.tmp`, image, { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
      this.index[jid] = { id: info.id, fetchedAt: Date.now() };
    } catch (err) {
      this.index[jid] = { ...previous, failedAt: Date.now() };
      this.log(`profile picture download for ${jid} failed: ${err.message}`);
    }
  }

  /** Applies lookup results, drops them from the queue and saves the index. Returns their jids. */
  async store(results) {
    for (const result of results) {
      await this.apply(result);
      this.queue.delete(result.jid);
    }
    if (results.length) {
      this.save();
      this.log(`refreshed ${results.length} profile picture(s)`);
    }
    return results.map((result) => result.jid);
  }

  async download(url) {
    if (!allowedUrl(url)) throw new Error('refusing a non-https picture URL');
    const res = await this.fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('picture is too large');
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new Error('picture is too large');
      chunks.push(chunk);
    }
    const image = Buffer.concat(chunks);
    if (!isJpeg(image)) throw new Error('picture is not a JPEG');
    return image;
  }

  /**
   * Looks up `jids` one by one until the batch size or time budget is used up,
   * or `canPause()` turns false (a message became due). Must run while sync is
   * stopped. Returns the lookup results, to pass to store() once sync runs.
   */
  async lookup(jids) {
    const deadline = Date.now() + this.batchTimeMs;
    const results = [];
    for (const jid of jids) {
      if (results.length >= this.batchSize || Date.now() > deadline || !this.canPause()) break;
      const result = await this.info(jid);
      if (!result) break;
      results.push(result);
    }
    return results;
  }

  /**
   * Before sync starts: looks up one batch of the most recent chats and queues
   * the rest for later flushes. The downloads run in the background (see
   * `this.downloads`) so sync is not held back by them. Returns the looked-up jids.
   */
  async prefetch(limit = 15) {
    // Lets the first flush run `firstFlushMs` from now instead of a full interval.
    this.lastFlushAt = Date.now() - Math.max(0, this.flushIntervalMs - this.firstFlushMs);
    if (!this.canPause()) return [];
    const chats = await this.whatsapp.recentChats(limit);
    const jids = chats.map((chat) => chat.jid).filter((jid) => this.needsRefresh(jid));
    const results = await this.lookup(jids);
    for (const jid of jids.slice(results.length)) this.queue.add(jid);
    this.downloads = this.store(results).catch((err) => {
      this.log(`profile pictures: ${err.message}`);
      return [];
    });
    return results.map((result) => result.jid);
  }

  /** Pauses sync to look up queued jids, if the queue is non-empty and the interval has passed. */
  async flush({ force = false } = {}) {
    if (!this.queue.size || this.flushing) return false;
    if (!force && Date.now() - this.lastFlushAt < this.flushIntervalMs) return false;
    if (!this.canPause()) return false;
    this.flushing = true;
    this.lastFlushAt = Date.now();
    try {
      const jids = [...this.queue].filter((jid) => this.needsRefresh(jid));
      this.queue = new Set(jids);
      if (!jids.length) return false;
      let results = [];
      const started = await this.whatsapp.pauseSync(async () => {
        results = await this.lookup(jids);
      });
      await this.store(results);
      return started;
    } finally {
      this.flushing = false;
    }
  }

  start(checkEveryMs = 60_000) {
    this.timer = setInterval(() => this.flush().catch((err) => this.log(`profile pictures: ${err.message}`)), checkEveryMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }
}
