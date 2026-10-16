import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import QRCode from 'qrcode';
import { createMcpServer } from './mcp.js';
import { ValidationError } from './service.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};
const COOKIE = 'wa_scheduler_session';
const SESSION_DAYS = 30;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string';
  res.writeHead(status, {
    'Content-Type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(json ? JSON.stringify(body) : body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

export function startServer({ config, service, whatsapp, log = console.log }) {
  const sign = (value) => createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
  const failedLogins = new Map(); // ip -> { count, since }

  function sessionCookie(req) {
    const expires = Date.now() + SESSION_DAYS * 86_400_000;
    const value = `${expires}.${sign(String(expires))}`;
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86_400}${secure}`;
  }

  function hasSession(req) {
    const match = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    if (!match) return false;
    const [expires, signature] = match[1].split('.');
    return Number(expires) > Date.now() && safeEqual(signature || '', sign(expires));
  }

  function hasToken(req) {
    const header = req.headers.authorization || '';
    return header.startsWith('Bearer ') && safeEqual(header.slice(7), config.token);
  }

  function requireAuth(req) {
    if (hasToken(req)) return;
    if (!hasSession(req)) throw new HttpError(401, 'login required');
    // Cookie-authenticated writes must be same-origin JSON requests (CSRF guard on top of SameSite=Strict).
    if (req.method !== 'GET' && !(req.headers['content-type'] || '').startsWith('application/json')) {
      throw new HttpError(415, 'expected application/json');
    }
  }

  async function login(req, res) {
    const ip = req.socket.remoteAddress;
    const entry = failedLogins.get(ip);
    if (entry && entry.count >= 10 && Date.now() - entry.since < 15 * 60_000) {
      throw new HttpError(429, 'too many failed logins, try again in 15 minutes');
    }
    const { password } = await readJson(req);
    if (!safeEqual(password || '', config.password)) {
      const next = entry && Date.now() - entry.since < 15 * 60_000 ? entry : { count: 0, since: Date.now() };
      next.count += 1;
      failedLogins.set(ip, next);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      throw new HttpError(401, 'wrong password');
    }
    failedLogins.delete(ip);
    send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req) });
  }

  async function handleMcp(req, res) {
    const mcp = createMcpServer(service);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      mcp.close();
    });
    await mcp.connect(transport);
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    await transport.handleRequest(req, res, body);
  }

  async function status() {
    const data = service.status();
    const qr = data.whatsapp.pairing?.qr;
    if (qr) data.whatsapp.pairing = { ...data.whatsapp.pairing, qrSvg: await QRCode.toString(qr, { type: 'svg', margin: 1 }) };
    return data;
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && STATIC[path]) {
      const [file, type] = STATIC[path];
      const body = await readFile(join(PUBLIC_DIR, file));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Frame-Options': 'DENY' });
      return res.end(body);
    }

    // MCP over HTTP: `Authorization: Bearer <token>` or the token in the path
    // (for clients such as the Claude mobile app that only take a URL).
    if (path === '/mcp' || path.startsWith('/mcp/')) {
      const pathToken = path.slice('/mcp/'.length);
      if (!(hasToken(req) || (pathToken && safeEqual(pathToken, config.token)))) throw new HttpError(401, 'invalid MCP token');
      return handleMcp(req, res);
    }

    if (path === '/api/login' && req.method === 'POST') return login(req, res);
    if (path === '/api/logout' && req.method === 'POST') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }
    if (path === '/api/session') return send(res, 200, { authenticated: hasSession(req) || hasToken(req) });

    if (!path.startsWith('/api/')) throw new HttpError(404, 'not found');
    requireAuth(req);

    if (path === '/api/status' && req.method === 'GET') return send(res, 200, await status());
    if (path === '/api/whatsapp/link' && req.method === 'POST') {
      const { phone } = await readJson(req);
      whatsapp.link({ phone: phone ? String(phone) : undefined });
      return send(res, 200, { ok: true });
    }
    if (path === '/api/whatsapp/cancel-link' && req.method === 'POST') {
      whatsapp.cancelLink();
      return send(res, 200, { ok: true });
    }
    if (path === '/api/whatsapp/unlink' && req.method === 'POST') {
      await whatsapp.unlink();
      return send(res, 200, { ok: true });
    }
    if (path === '/api/recipients' && req.method === 'GET') {
      return send(res, 200, await service.searchRecipients(url.searchParams.get('q') || ''));
    }
    if (path === '/api/messages' && req.method === 'GET') {
      return send(res, 200, service.list({ status: url.searchParams.get('status') || undefined }));
    }
    if (path === '/api/messages' && req.method === 'POST') {
      const body = await readJson(req);
      return send(res, 201, service.schedule({ ...body, source: hasToken(req) ? 'api' : 'web' }));
    }
    const match = path.match(/^\/api\/messages\/([\w-]+)$/);
    if (match && req.method === 'DELETE') return send(res, 200, service.cancel(match[1]));

    throw new HttpError(404, 'not found');
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      if (err instanceof ValidationError) return send(res, 400, { error: err.message });
      log(`error: ${err.stack || err}`);
      send(res, 500, { error: 'internal error' });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve(server));
  });
}
