import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const WACLI_VERSION = '0.22.0';

export function dataDir() {
  if (process.env.WA_SCHEDULER_DATA) return process.env.WA_SCHEDULER_DATA;
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'whatsapp-scheduler');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'whatsapp-scheduler');
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'whatsapp-scheduler');
}

function secret(bytes) {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Loads (or creates on first run) the config file holding the UI password,
 * the API/MCP token and the cookie signing secret.
 */
export function loadConfig() {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'config.json');

  let stored = {};
  if (existsSync(file)) stored = JSON.parse(readFileSync(file, 'utf8'));

  let changed = false;
  for (const [key, size] of [['password', 12], ['token', 32], ['sessionSecret', 32]]) {
    if (!stored[key]) {
      stored[key] = secret(size);
      changed = true;
    }
  }
  if (changed) writeFileSync(file, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 });

  const port = Number(process.env.PORT || process.env.WA_SCHEDULER_PORT || stored.port || 3737);
  return {
    dir,
    file,
    port,
    host: process.env.HOST || process.env.WA_SCHEDULER_HOST || stored.host || '127.0.0.1',
    // Env vars win so the password can be managed by a service manager.
    password: process.env.WA_SCHEDULER_PASSWORD || stored.password,
    token: process.env.WA_SCHEDULER_TOKEN || stored.token,
    sessionSecret: stored.sessionSecret,
    // A message that is overdue by more than this (e.g. the machine was off) is
    // marked as missed instead of being sent late.
    maxDelayMinutes: Number(process.env.WA_SCHEDULER_MAX_DELAY_MINUTES || stored.maxDelayMinutes || 60),
    wacliStore: process.env.WACLI_STORE_DIR || join(dir, 'wacli'),
  };
}
