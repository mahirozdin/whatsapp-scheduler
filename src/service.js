import { localTimezone, zonedToUtc } from './time.js';

const MAX_TEXT = 4000;
// Gap between two sends so a burst of due messages never looks like spam.
const SEND_SPACING_MS = 5_000;
// setTimeout cannot wait longer than ~24.8 days.
const MAX_TIMER_MS = 2 ** 31 - 1;

export class ValidationError extends Error {}

export { localTimezone };

/**
 * Parses a send time. ISO 8601 with an offset (or Z) is exact; without an
 * offset it is wall-clock time in `timeZone` (the user's selected timezone).
 * Empty means "now".
 */
export function parseSendAt(value, { now = new Date(), timeZone = localTimezone() } = {}) {
  if (value === undefined || value === null || String(value).trim() === '' || value === 'now') return now;
  const text = String(value).trim().replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) {
    throw new ValidationError('sendAt must be an ISO 8601 date-time like 2026-10-18T09:00 or 2026-10-18T09:00:00+03:00');
  }
  if (/(Z|[+-]\d{2}(:?\d{2})?)$/i.test(text)) {
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) throw new ValidationError(`invalid sendAt: ${value}`);
    return date;
  }
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?$/);
  if (!match) throw new ValidationError(`invalid sendAt: ${value}`);
  const [year, month, day, hour, minute, second = 0, fraction = '0'] = match.slice(1);
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, Number(fraction.padEnd(3, '0')));
  const check = new Date(wall);
  if (
    check.getUTCFullYear() !== Number(year) || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== Number(day) ||
    check.getUTCHours() !== Number(hour) || check.getUTCMinutes() !== Number(minute)
  ) {
    throw new ValidationError(`invalid sendAt: ${value}`);
  }
  return new Date(zonedToUtc(wall, timeZone));
}

/** The scheduling logic shared by the web API and the MCP tools. */
export class Service {
  constructor({ store, whatsapp, settings, avatars, maxDelayMinutes = 60, log = console.log }) {
    this.store = store;
    this.whatsapp = whatsapp;
    this.settings = settings;
    this.avatars = avatars;
    this.maxDelayMs = maxDelayMinutes * 60_000;
    this.log = log;
    this.timer = null;
    this.nextTimer = null;
    this.running = false;
    this.ticking = false;
    this.lastSendAt = 0;
  }

  timezone() {
    return this.settings?.timezone || localTimezone();
  }

  status() {
    return {
      whatsapp: this.whatsapp.status(),
      now: new Date().toISOString(),
      timezone: this.timezone(),
      serverTimezone: localTimezone(),
    };
  }

  getSettings() {
    return { timezone: this.timezone() };
  }

  updateSettings(patch) {
    if (!this.settings) throw new ValidationError('settings are not available');
    if (patch?.timezone === undefined) throw new ValidationError('timezone is required');
    return this.settings.update({ timezone: patch.timezone });
  }

  schedule({ to, toName, text, sendAt, source }) {
    to = String(to || '').trim();
    text = String(text || '');
    if (!to) throw new ValidationError('recipient (to) is required');
    if (!text.trim()) throw new ValidationError('message text is required');
    if (text.length > MAX_TEXT) throw new ValidationError(`message is too long (max ${MAX_TEXT} characters)`);
    const date = parseSendAt(sendAt, { timeZone: this.timezone() });
    if (date.getTime() < Date.now() - 60_000) throw new ValidationError(`sendAt ${date.toISOString()} is in the past`);
    const message = this.store.create({ to, toName, text, sendAt: date.toISOString(), source });
    this.avatars?.want(to);
    this.armNext();
    setImmediate(() => this.tick());
    return this.withAvatar(message);
  }

  list({ status } = {}) {
    const messages = this.store.list();
    return (status ? messages.filter((m) => m.status === status) : messages).map((m) => this.withAvatar(m, m.status === 'scheduled'));
  }

  cancel(id) {
    const message = this.store.get(id);
    if (!message) throw new ValidationError(`no message with id ${id}`);
    if (message.status !== 'scheduled') throw new ValidationError(`message ${id} is already ${message.status}`);
    const canceled = this.store.update(id, { status: 'canceled', canceledAt: new Date().toISOString() });
    this.armNext();
    return this.withAvatar(canceled);
  }

  async searchRecipients(query) {
    if (!this.whatsapp.status().linked) return [];
    const results = await this.whatsapp.search(String(query || '').trim());
    return results.map((r) => this.withAvatar(r, true, r.jid));
  }

  /** Adds the avatar URL (or null) and, if asked, queues a missing avatar for fetching. */
  withAvatar(item, queue = false, jid = item.to) {
    if (!this.avatars) return { ...item, avatar: null };
    if (queue) this.avatars.want(jid);
    return { ...item, avatar: this.avatars.url(jid) };
  }

  /**
   * True while a send is in flight or one is due within `windowMs`. Used to keep
   * maintenance (pausing the WhatsApp connection) away from send times.
   */
  busy(windowMs = 2 * 60_000) {
    const limit = Date.now() + windowMs;
    return this.store.list().some((m) => m.status === 'sending' || (m.status === 'scheduled' && new Date(m.sendAt).getTime() <= limit));
  }

  start(intervalMs = 5_000) {
    // A send that was in flight when the process died has an unknown outcome;
    // never resend it automatically.
    for (const message of this.store.list()) {
      if (message.status === 'sending') {
        this.store.update(message.id, {
          status: 'failed',
          error: 'The scheduler stopped while sending, so the outcome is unknown. Check the chat in WhatsApp before resending.',
        });
      }
    }
    this.running = true;
    // The interval is a safety net (and retries while WhatsApp is not linked);
    // armNext() fires a timer at the exact time of the next message.
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.tick();
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    clearTimeout(this.nextTimer);
  }

  /** Arms a timer for the next scheduled message that is not due yet. */
  armNext() {
    clearTimeout(this.nextTimer);
    this.nextTimer = null;
    if (!this.running) return;
    const now = Date.now();
    const next = this.store
      .list()
      .filter((m) => m.status === 'scheduled')
      .map((m) => new Date(m.sendAt).getTime())
      .find((t) => t > now);
    if (next === undefined) return;
    this.nextTimer = setTimeout(() => this.tick(), Math.min(next - now + 5, MAX_TIMER_MS));
    this.nextTimer.unref?.();
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      // Re-read the due list after every send, so messages that became due
      // while an earlier one was sending go out right after it.
      const seen = new Set();
      for (;;) {
        const message = this.store.due().find((m) => !seen.has(m.id));
        if (!message) break;
        seen.add(message.id);
        const late = Date.now() - new Date(message.sendAt).getTime();
        if (late > this.maxDelayMs) {
          this.store.update(message.id, {
            status: 'failed',
            error: `Missed: the scheduler was offline or WhatsApp was not linked at the scheduled time (${Math.round(late / 60_000)} min late).`,
          });
          continue;
        }
        if (!this.whatsapp.status().linked) continue; // retry on a later tick until it is too late

        const wait = this.lastSendAt + SEND_SPACING_MS - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        if (this.store.get(message.id)?.status !== 'scheduled') continue; // canceled while waiting
        await this.send(message);
      }
    } finally {
      this.ticking = false;
      this.armNext();
    }
  }

  async send(message) {
    this.store.update(message.id, { status: 'sending' });
    try {
      const waId = await this.whatsapp.sendText(message.to, message.text);
      this.store.update(message.id, { status: 'sent', sentAt: new Date().toISOString(), waMessageId: waId });
      this.log(`sent ${message.id} to ${message.toName}`);
    } catch (err) {
      this.store.update(message.id, { status: 'failed', error: err.message });
      this.log(`failed ${message.id} to ${message.toName}: ${err.message}`);
    } finally {
      this.lastSendAt = Date.now();
    }
  }
}
