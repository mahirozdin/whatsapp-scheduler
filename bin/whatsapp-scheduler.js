#!/usr/bin/env node
import { join } from 'node:path';
import { Avatars } from '../src/avatars.js';
import { loadConfig } from '../src/config.js';
import { startServer } from '../src/server.js';
import { Service } from '../src/service.js';
import { Settings } from '../src/settings.js';
import { MessageStore } from '../src/store.js';
import { resolveWacli, wacliVersion, WhatsApp } from '../src/wacli.js';

const HELP = `whatsapp-scheduler - schedule WhatsApp messages from your own account

Usage:
  whatsapp-scheduler            Start the web UI, the scheduler and the MCP endpoint
  whatsapp-scheduler mcp        Run the MCP server over stdio (talks to the running server)
  whatsapp-scheduler password   Print the web UI password
  whatsapp-scheduler token      Print the API/MCP token and the remote MCP URL path

Environment:
  PORT, HOST                         Listen address (default 127.0.0.1:3737)
  WA_SCHEDULER_PASSWORD              Web UI password (default: generated, see \`password\`)
  WA_SCHEDULER_TOKEN                 API/MCP token (default: generated, see \`token\`)
  WA_SCHEDULER_DATA                  Data directory
  WA_SCHEDULER_MAX_DELAY_MINUTES     Skip messages that are overdue by more than this (default 60)
  WACLI_BIN                          Path to a wacli binary (default: PATH or auto-download)
`;

async function start(config) {
  const log = (line) => console.log(`[${new Date().toISOString()}] ${line}`);
  const bin = await resolveWacli(config.dir, log);
  log(`using ${wacliVersion(bin) || 'wacli'} at ${bin}`);

  const whatsapp = new WhatsApp({ bin, store: config.wacliStore, log });
  const store = new MessageStore(join(config.dir, 'messages.json'));
  const settings = new Settings(join(config.dir, 'settings.json'));
  // Profile picture lookups briefly stop the WhatsApp connection, so never
  // while pairing, sending, or with a message due in the next 2 minutes.
  const avatars = new Avatars({
    dir: join(config.dir, 'avatars'),
    whatsapp,
    log,
    canPause: () => whatsapp.linked && !whatsapp.unlinking && !whatsapp.authProc && !whatsapp.sending && !service.busy(),
  });
  const service = new Service({ store, whatsapp, settings, avatars, maxDelayMinutes: config.maxDelayMinutes, log });
  whatsapp.beforeSync = () => avatars.prefetch();

  await whatsapp.start();
  service.start();
  avatars.start();
  await startServer({ config, service, whatsapp, avatars, log });

  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  console.log(`
  WhatsApp Scheduler is running: ${url}
  Password: run \`whatsapp-scheduler password\` (stored in ${config.file})
  WhatsApp: ${whatsapp.linked ? 'linked' : 'not linked yet - open the web UI to link it'}
`);

  const shutdown = () => {
    service.stop();
    avatars.stop();
    whatsapp.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const command = process.argv[2] || 'start';
const config = loadConfig();

if (command === 'start') {
  await start(config);
} else if (command === 'mcp') {
  const { runStdio } = await import('../src/mcp-stdio.js');
  await runStdio(config);
} else if (command === 'password') {
  console.log(config.password);
} else if (command === 'token') {
  console.log(`Token:          ${config.token}`);
  console.log(`MCP (header):   POST /mcp with "Authorization: Bearer ${config.token}"`);
  console.log(`MCP (URL only): /mcp/${config.token}`);
} else if (command === 'help' || command === '--help' || command === '-h') {
  console.log(HELP);
} else {
  console.error(`Unknown command: ${command}\n\n${HELP}`);
  process.exit(1);
}
