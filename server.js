/**
 * KUS DevTools MCP Gateway
 * Paquetes npm verificados:
 *   - @playwright/mcp
 *   - @modelcontextprotocol/server-memory
 *   - @upstash/context7-mcp
 *   - firecrawl-mcp
 * Fetch: implementado nativo con Node.js fetch (built-in en Node 18+)
 */
const express = require('express');
const { spawn } = require('child_process');
const https   = require('https');
const http    = require('http');
const { URL }  = require('url');

const PORT      = parseInt(process.env.PORT || '8080');
const API_TOKEN = process.env.MCP_AUTH_TOKEN || '';

if (!API_TOKEN) {
  console.error('ERROR: MCP_AUTH_TOKEN no configurado');
  process.exit(1);
}

// ─── Definicion de herramientas ────────────────────────────────────────────
const MCP_TOOLS = [
  {
    name: 'playwright',
    cmd: 'node',
    args: ['./node_modules/@playwright/mcp/cli.js', '--headless'],
    env: {},
    enabled: () => true,
  },
  {
    name: 'memory',
    cmd: 'node',
    args: ['./node_modules/@modelcontextprotocol/server-memory/dist/index.js'],
    env: {},
    enabled: () => true,
  },
  {
    name: 'context7',
    cmd: 'node',
    args: ['./node_modules/@upstash/context7-mcp/dist/index.js'],
    env: {},
    enabled: () => true,
  },
  {
    name: 'firecrawl',
    cmd: 'node',
    args: ['./node_modules/firecrawl-mcp/dist/index.js'],
    env: { FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY || '' },
    enabled: () => !!process.env.FIRECRAWL_API_KEY,
  },
];

// ─── MCP Stdio Bridge ──────────────────────────────────────────────────────
class McpBridge {
  constructor(tool) {
    this.tool     = tool;
    this.proc     = null;
    this.pending  = new Map();
    this.msgId    = 1;
    this.buffer   = '';
    this.ready    = false;
    this.sessions = new Map();
  }

  start() {
    const env = { ...process.env, ...this.tool.env };
    this.proc = spawn(this.tool.cmd, this.tool.args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      env,
    });

    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let nl;
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            resolve(msg);
          } else {
            this._broadcast(msg);
          }
        } catch (_) {}
      }
    });

    this.proc.on('exit', (code) => {
      console.warn(`[${this.tool.name}] exited (${code}), restart in 3s`);
      this.ready = false;
      setTimeout(() => this.start(), 3000);
    });

    this._init();
  }

  async _init() {
    try {
      await this._send({
        jsonrpc: '2.0', id: this.msgId++,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          clientInfo: { name: 'kus-gateway', version: '1.0.0' },
          capabilities: {},
        },
      });
      this._write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      this.ready = true;
      console.log(`[${this.tool.name}] ready`);
    } catch (e) {
      console.error(`[${this.tool.name}] init error:`, e.message);
      setTimeout(() => this._init(), 5000);
    }
  }

  _write(obj) { this.proc.stdin.write(JSON.stringify(obj) + '\n'); }

  _send(obj) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(obj.id);
        reject(new Error(`Timeout: ${this.tool.name}`));
      }, 60000);
      this.pending.set(obj.id, {
        resolve: v => { clearTimeout(t); resolve(v); },
        reject:  v => { clearTimeout(t); reject(v); },
      });
      this._write(obj);
    });
  }

  async listTools() {
    const r = await this._send({ jsonrpc: '2.0', id: this.msgId++, method: 'tools/list', params: {} });
    return r.result?.tools || [];
  }

  async callTool(name, args) {
    const r = await this._send({
      jsonrpc: '2.0', id: this.msgId++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    if (r.error) throw new Error(r.error.message);
    return r.result;
  }

  _broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const [, res] of this.sessions)
      res.write(`event: message\ndata: ${data}\n\n`);
  }

  addSession(id, res)  { this.sessions.set(id, res); }
  removeSession(id)    { this.sessions.delete(id); }
}

// ─── Fetch nativo (Node 18+) como herramienta MCP virtual ─────────────────
class FetchBridge {
  constructor() { this.ready = true; this.sessions = new Map(); }
  start() { console.log('[fetch] ready (native Node fetch)'); }
  addSession(id, res)  { this.sessions.set(id, res); }
  removeSession(id)    { this.sessions.delete(id); }

  async listTools() {
    return [{
      name: 'fetch',
      description: 'Fetch a URL and return its content',
      inputSchema: {
        type: 'object',
        properties: {
          url:     { type: 'string', description: 'URL to fetch' },
          method:  { type: 'string', default: 'GET' },
          headers: { type: 'object' },
          body:    { type: 'string' },
        },
        required: ['url'],
      },
    }];
  }

  async callTool(name, args) {
    if (name !== 'fetch') throw new Error('Unknown tool: ' + name);
    const { url, method = 'GET', headers = {}, body } = args;
    const res = await fetch(url, {
      method,
      headers: { 'User-Agent': 'KUS-MCP-Gateway/1.0', ...headers },
      body: body || undefined,
    });
    const text = await res.text();
    return { content: [{ type: 'text', text: `Status: ${res.status}\n\n${text.slice(0, 50000)}` }] };
  }
}

// Iniciar bridges
const bridges = {};
bridges['fetch'] = new FetchBridge();
bridges['fetch'].start();

for (const tool of MCP_TOOLS) {
  if (tool.enabled()) {
    bridges[tool.name] = new McpBridge(tool);
    bridges[tool.name].start();
  }
}

// ─── Express ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

function getToken(req) {
  const b = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (b) return b;
  try { return new URL(req.url, 'http://x').searchParams.get('token') || ''; } catch { return ''; }
}
function auth(req, res, next) {
  if (getToken(req) === API_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.get('/:tool/sse', auth, (req, res) => {
  const bridge = bridges[req.params.tool];
  if (!bridge) return res.status(404).json({ error: 'Tool not found' });

  const sid = `${req.params.tool}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  bridge.addSession(sid, res);
  res.write(`event: endpoint\ndata: /${req.params.tool}/message?sessionId=${sid}\n\n`);

  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); bridge.removeSession(sid); });
});

app.post('/:tool/message', auth, async (req, res) => {
  const bridge = bridges[req.params.tool];
  if (!bridge) return res.status(404).json({ error: 'Tool not found' });
  if (!bridge.ready) return res.status(503).json({ error: 'Starting...' });

  const { sessionId } = req.query;
  const msg = req.body;

  const emit = (payload) => {
    const session = bridge.sessions?.get(sessionId);
    if (session) session.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    res.json({ ok: true });
  };

  const emitErr = (code, message) => emit({ jsonrpc: '2.0', id: msg.id, error: { code, message } });

  try {
    if (msg.method === 'initialize')
      return emit({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: `kus-${req.params.tool}`, version: '1.0.0' },
        capabilities: { tools: {} },
      }});
    if (msg.method === 'notifications/initialized') return res.json({ ok: true });
    if (msg.method === 'tools/list') {
      const tools = await bridge.listTools();
      return emit({ jsonrpc: '2.0', id: msg.id, result: { tools } });
    }
    if (msg.method === 'tools/call') {
      const result = await bridge.callTool(msg.params.name, msg.params.arguments || {});
      return emit({ jsonrpc: '2.0', id: msg.id, result });
    }
    return emitErr(-32601, 'Method not found: ' + msg.method);
  } catch (e) {
    console.error(`[${req.params.tool}]`, e.message);
    return emitErr(-32603, e.message);
  }
});

app.get('/', (_req, res) => {
  const active = Object.keys(bridges);
  res.type('text').send(
    'KUS DevTools MCP Gateway\n' +
    '========================\n\n' +
    active.map(t => `  ${t.padEnd(12)}: /${t}/sse?token=TOKEN`).join('\n') + '\n'
  );
});

app.get('/health', (_req, res) => {
  const tools = {};
  for (const [k, b] of Object.entries(bridges))
    tools[k] = b.ready ? 'ready' : 'starting';
  res.json({ status: 'ok', tools });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`KUS MCP Gateway on port ${PORT}`);
  console.log('Tools:', Object.keys(bridges).join(', '));
});
