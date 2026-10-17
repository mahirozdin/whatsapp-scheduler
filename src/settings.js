import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { ValidationError } from './service.js';
import { localTimezone, normalizeTimezone } from './time.js';

/** User settings changed from the web UI (currently only the timezone), kept in settings.json. */
export class Settings {
  constructor(file) {
    this.file = file;
    this.values = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  }

  /** The selected timezone; defaults to the server's timezone until the user picks one. */
  get timezone() {
    return normalizeTimezone(this.values.timezone) || localTimezone();
  }

  toJSON() {
    return { timezone: this.timezone };
  }

  update({ timezone }) {
    if (timezone !== undefined) {
      const name = normalizeTimezone(timezone);
      if (!name) throw new ValidationError(`unknown timezone: ${timezone} (use an IANA name such as Europe/Istanbul)`);
      this.values.timezone = name;
    }
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.values, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.file);
    return this.toJSON();
  }
}
