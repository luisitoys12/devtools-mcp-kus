/**
 * KUS DevTools MCP Gateway
 * Arquitectura: cada MCP corre en stdio, este server los envuelve en SSE/HTTP
 * Compatible con Claude Code, Cursor, Windsurf, n8n
 */
const express = require('express');
const { spawn } = require('child_process');

const PORT      = parseInt(process.env.PORT      || '8080');
const API_TOKEN = process.env.MCP_AUTH_TOKEN     || '';

if (!API_TOKEN) {
  console.error('ERROR: MCP_AUTH_TOKEN no configurado');
  process.exit(1);
}

// ─── Definicion de herramientas ─────────────────────────────────────────────────────
const MCP_TOOLS = [
  {
    name: 'playwright',
    label: 'Browser Automation',
    cmd: 'npx',
    args: ['@playwright/mcp@latest', '--headless'],
    env: {},
    enabled: () => true,
  },
  {
    name: 'fetch',
    label: 'HTTP Fetch',
    cmd: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    env: {},
    enabled: () => true,
  },
  {
    name: 'memory',
    label: 'Persistent Memory',
    cmd: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: {},
    enabled: () => true,
  },
  {
    name: 'context7',
    label: 'Library Docs (Context7)',
    cmd: 'npx',
    args: ['-y', '@upstash/context7-mcp@latest'],
    env: {},
    enabled: () => true,
  },
  {
    name: 'firecrawl',
    label: 'Web Scraping (Firecrawl)',
    cmd: 'npx',
    args: ['-y', 'firecrawl-mcp'],
    env: { FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY || '' },
    enabled: () => !!process.env.FIRECRAWL_API_KEY,
  },
];

// ─── MCP Stdio Bridge ───────────────────────────────────────────────────────────────
class McpBridge {
  constructor(tool) {
    this.tool    = tool;
    this.proc    = null;
    this.pending = new Map();
    this.msgId   = 1;
    this.buffer  = '';
    this.ready   = false;
    this.sessions = new Map(); // sessionId -> res
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
            // Notificacion -> broadcast a todas las sesiones
            this._broadcast(msg);
          }
        } catch (e) { /* linea no-JSON, ignorar */ }
      }
    });

    this.proc.on('exit', (code) => {
      console.warn(`[${this.tool.name}] proceso termino (${code}), reiniciando en 3s...`);
      this.ready = false;
      setTimeout(() => this.start(), 3000);
    });

    // Inicializar el proceso MCP
    this._init();
  }

  async _init() {
    try {
      await this._send({ jsonrpc: '2.0', id: this.msgId++, method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          clientInfo: { name: 'kus-gateway', version: '1.0.0' },
          capabilities: {},
        },
      });
      this._write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      this.ready = true;
      console.log(`[${this.tool.name}] listo`);
    } catch (e) {
      console.error(`[${this.tool.name}] error init:`, e.message);
    }
  }

  _write(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  _send(obj) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(obj.id);
        reject(new Error(`Timeout esperando respuesta de ${this.tool.name}`));
      }, 60000);
      this.pending.set(obj.id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject:  (v) => { clearTimeout(timeout); reject(v); },
      });
      this._write(obj);
    });
  }

  async listTools() {
    const res = await this._send({ jsonrpc: '2.0', id: this.msgId++, method: 'tools/list', params: {} });
    return res.result?.tools || [];
  }

  async callTool(name, args) {
    const res = await this._send({
      jsonrpc: '2.0', id: this.msgId++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    if (res.error) throw new Error(res.error.message);
    return res.result;
  }

  _broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const [, res] of this.sessions) {
      res.write(`event: message\ndata: ${data}\n\n`);
    }
  }

  addSession(sessionId, res) { this.sessions.set(sessionId, res); }
  removeSession(sessionId)    { this.sessions.delete(sessionId); }
}

// Iniciar bridges
const bridges = {};
for (const tool of MCP_TOOLS) {
  if (tool.enabled()) {
    bridges[tool.name] = new McpBridge(tool);
    bridges[tool.name].start();
  }
}

// ─── Express Gateway ─────────────────────────────────────────────────────────────
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

// SSE: GET /:tool/sse
app.get('/:tool/sse', auth, (req, res) => {
  const bridge = bridges[req.params.tool];
  if (!bridge) return res.status(404).json({ error: `Tool ${req.params.tool} no existe` });

  const sessionId = `${req.params.tool}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  bridge.addSession(sessionId, res);
  res.write(`event: endpoint\ndata: /${req.params.tool}/message?sessionId=${sessionId}\n\n`);

  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); bridge.removeSession(sessionId); });
});

// MCP Messages: POST /:tool/message
app.post('/:tool/message', auth, async (req, res) => {
  const bridge = bridges[req.params.tool];
  if (!bridge) return res.status(404).json({ error: 'Tool no encontrada' });
  if (!bridge.ready) return res.status(503).json({ error: 'MCP iniciando, reintenta en segundos' });

  const { sessionId } = req.query;
  const msg = req.body;

  const send = (result) => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
    const session = bridge.sessions.get(sessionId);
    if (session) session.write(`event: message\ndata: ${payload}\n\n`);
    res.json({ ok: true });
  };

  const sendErr = (code, message) => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    const session = bridge.sessions.get(sessionId);
    if (session) session.write(`event: message\ndata: ${payload}\n\n`);
    res.json({ ok: true });
  };

  try {
    if (msg.method === 'initialize') {
      return send({
        protocolVersion: '2024-11-05',
        serverInfo: { name: `kus-${req.params.tool}`, version: '1.0.0' },
        capabilities: { tools: {} },
      });
    }
    if (msg.method === 'notifications/initialized') return res.json({ ok: true });
    if (msg.method === 'tools/list') {
      const tools = await bridge.listTools();
      return send({ tools });
    }
    if (msg.method === 'tools/call') {
      const result = await bridge.callTool(msg.params.name, msg.params.arguments || {});
      return send(result);
    }
    return sendErr(-32601, `Method not found: ${msg.method}`);
  } catch (e) {
    console.error(`[${req.params.tool}]`, e.message);
    return sendErr(-32603, e.message);
  }
});

// Root info
app.get('/', (_req, res) => {
  const active = Object.keys(bridges);
  res.send(
    'KUS DevTools MCP Gateway - ONLINE\n' +
    '================================\n\n' +
    'Herramientas activas:\n' +
    active.map(t => `  ${t.padEnd(12)}: /${t}/sse?token=TOKEN`).join('\n') + '\n\n' +
    'Auth: ?token=TOKEN  o  Authorization: Bearer TOKEN\n'
  );
});

app.get('/health', (_req, res) => {
  const status = {};
  for (const [k, b] of Object.entries(bridges)) status[k] = b.ready ? 'ready' : 'starting';
  res.json({ status: 'ok', tools: status });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`KUS MCP Gateway en 0.0.0.0:${PORT}`);
  console.log('Herramientas:', Object.keys(bridges).join(', '));
});
