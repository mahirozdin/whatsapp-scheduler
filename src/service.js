const MAX_TEXT = 4000;
// Gap between two sends so a burst of due messages never looks like spam.
const SEND_SPACING_MS = 5_000;

export class ValidationError extends Error {}

export function localTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Parses a send time. ISO 8601 with an offset is exact; without an offset it is
 * read in the server's local timezone. Empty means "now".
 */
export function parseSendAt(value, now = new Date()) {
  if (value === undefined || value === null || String(value).trim() === '' || value === 'now') return now;
  const text = String(value).trim().replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) {
    throw new ValidationError('sendAt must be an ISO 8601 date-time like 2026-10-18T09:00 or 2026-10-18T09:00:00+03:00');
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`invalid sendAt: ${value}`);
  return date;
}

/** The scheduling logic shared by the web API and the MCP tools. */
export class Service {
  constructor({ store, whatsapp, maxDelayMinutes = 60, log = console.log }) {
    this.store = store;
    this.whatsapp = whatsapp;
    this.maxDelayMs = maxDelayMinutes * 60_000;
    this.log = log;
    this.timer = null;
    this.ticking = false;
    this.lastSendAt = 0;
  }

  status() {
    return {
      whatsapp: this.whatsapp.status(),
      now: new Date().toISOString(),
      timezone: localTimezone(),
    };
  }

  schedule({ to, toName, text, sendAt, source }) {
    to = String(to || '').trim();
    text = String(text || '');
    if (!to) throw new ValidationError('recipient (to) is required');
    if (!text.trim()) throw new ValidationError('message text is required');
    if (text.length > MAX_TEXT) throw new ValidationError(`message is too long (max ${MAX_TEXT} characters)`);
    const date = parseSendAt(sendAt);
    if (date.getTime() < Date.now() - 60_000) throw new ValidationError(`sendAt ${date.toISOString()} is in the past`);
    const message = this.store.create({ to, toName, text, sendAt: date.toISOString(), source });
    setImmediate(() => this.tick());
    return message;
  }

  list({ status } = {}) {
    const messages = this.store.list();
    return status ? messages.filter((m) => m.status === status) : messages;
  }

  cancel(id) {
    const message = this.store.get(id);
    if (!message) throw new ValidationError(`no message with id ${id}`);
    if (message.status !== 'scheduled') throw new ValidationError(`message ${id} is already ${message.status}`);
    return this.store.update(id, { status: 'canceled', canceledAt: new Date().toISOString() });
  }

  searchRecipients(query) {
    if (!this.whatsapp.status().linked) return Promise.resolve([]);
    return this.whatsapp.search(String(query || '').trim());
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
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const message of this.store.due()) {
        if (this.store.get(message.id)?.status !== 'scheduled') continue;
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
        await this.send(message);
      }
    } finally {
      this.ticking = false;
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
