import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp.js';

/**
 * Talks to the running scheduler over its HTTP API, so the stdio MCP server
 * never touches WhatsApp or the message store directly.
 */
class HttpBackend {
  constructor(config) {
    const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
    this.base = process.env.WA_SCHEDULER_URL || `http://${host.includes(':') ? `[${host}]` : host}:${config.port}`;
    this.token = config.token;
  }

  async call(method, path, body) {
    let res;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error(`The whatsapp-scheduler server is not reachable at ${this.base}. Start it with \`npx whatsapp-scheduler\`.`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  status() {
    return this.call('GET', '/api/status').then((data) => {
      if (data.whatsapp?.pairing) data.whatsapp.pairing = { active: true };
      return data;
    });
  }

  searchRecipients(query) {
    return this.call('GET', `/api/recipients?q=${encodeURIComponent(query)}`);
  }

  schedule(message) {
    return this.call('POST', '/api/messages', message);
  }

  list({ status } = {}) {
    return this.call('GET', `/api/messages${status ? `?status=${status}` : ''}`);
  }

  cancel(id) {
    return this.call('DELETE', `/api/messages/${encodeURIComponent(id)}`);
  }
}

export async function runStdio(config) {
  const server = createMcpServer(new HttpBackend(config));
  await server.connect(new StdioServerTransport());
}
