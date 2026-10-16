import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * Message statuses:
 *   scheduled -> sending -> sent | failed
 *   scheduled -> canceled
 */
export class MessageStore {
  constructor(file) {
    this.file = file;
    this.messages = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).messages : [];
  }

  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ messages: this.messages }, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  list() {
    return [...this.messages].sort((a, b) => a.sendAt.localeCompare(b.sendAt));
  }

  get(id) {
    return this.messages.find((m) => m.id === id);
  }

  create({ to, toName, text, sendAt, source }) {
    const message = {
      id: randomUUID().slice(0, 8),
      to,
      toName: toName || to,
      text,
      sendAt,
      status: 'scheduled',
      source: source || 'web',
      createdAt: new Date().toISOString(),
    };
    this.messages.push(message);
    this.save();
    return message;
  }

  update(id, patch) {
    const message = this.get(id);
    if (!message) return undefined;
    Object.assign(message, patch);
    this.save();
    return message;
  }

  due(now = new Date()) {
    return this.list().filter((m) => m.status === 'scheduled' && new Date(m.sendAt) <= now);
  }
}
