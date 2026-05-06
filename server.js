const express = require('express');
const { spawn } = require('child_process');
const http    = require('http');

const PORT      = parseInt(process.env.PORT      || '8080');
const API_TOKEN = process.env.MCP_AUTH_TOKEN     || '';

// Puertos internos para cada MCP
const PORTS = {
  playwright : parseInt(process.env.PORT_PLAYWRIGHT || '8931'),
  fetch      : parseInt(process.env.PORT_FETCH      || '8932'),
  memory     : parseInt(process.env.PORT_MEMORY     || '8933'),
  context7   : parseInt(process.env.PORT_CONTEXT7   || '8934'),
  firecrawl  : parseInt(process.env.PORT_FIRECRAWL  || '8935'),
  npmdocs    : parseInt(process.env.PORT_NPMDOCS    || '8936'),
};

if (!API_TOKEN) {
  console.error('ERROR: MCP_AUTH_TOKEN no configurado.');
  process.exit(1);
}

// ─── Lanzar cada MCP server ──────────────────────────────────────────────────
function launchMCP(name, cmd, args, env = {}) {
  const proc = spawn(cmd, args, {
    stdio : ['ignore', 'inherit', 'inherit'],
    env   : { ...process.env, ...env },
  });
  proc.on('error', e  => console.error(`[${name}] error:`, e.message));
  proc.on('exit',  c  => console.warn(`[${name}] exit code: ${c}`));
  console.log(`[${name}] iniciado en puerto ${PORTS[name]}`);
  return proc;
}

launchMCP('playwright', 'npx', [
  '@playwright/mcp@latest', '--headless',
  '--port', String(PORTS.playwright), '--host', 'localhost',
]);

launchMCP('fetch', 'npx', [
  '@modelcontextprotocol/server-fetch',
  '--port', String(PORTS.fetch), '--transport', 'sse',
]);

launchMCP('memory', 'npx', [
  '@modelcontextprotocol/server-memory',
  '--port', String(PORTS.memory), '--transport', 'sse',
]);

launchMCP('context7', 'npx', [
  '@upstash/context7-mcp@latest',
  '--port', String(PORTS.context7), '--transport', 'sse',
]);

// Firecrawl solo si tiene API key
if (process.env.FIRECRAWL_API_KEY) {
  launchMCP('firecrawl', 'npx', [
    'firecrawl-mcp',
    '--port', String(PORTS.firecrawl), '--transport', 'sse',
  ], { FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY });
} else {
  console.warn('[firecrawl] sin API key - deshabilitado');
}

launchMCP('npmdocs', 'npx', [
  'npm-package-docs-mcp',
  '--port', String(PORTS.npmdocs), '--transport', 'sse',
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function extractToken(req) {
  const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;
  try {
    const url = new URL(req.url, 'http://x');
    const t = url.searchParams.get('token');
    if (t) return t;
  } catch (_) {}
  const m = req.url.match(/^\/(sse|mcp|message)\/[^/]+\/([^/?#]+)/);
  return m ? m[2] : '';
}

function proxyTo(targetPort, targetPath) {
  return (req, res) => {
    let cleanPath = targetPath;
    try {
      const url = new URL(req.url, 'http://x');
      url.searchParams.delete('token');
      // Preservar sessionId y otros params
      cleanPath = targetPath + (url.search || '');
    } catch (_) {}

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (['origin', 'host', 'authorization'].includes(k.toLowerCase())) continue;
      headers[k] = v;
    }

    const proxy = http.request(
      { hostname: 'localhost', port: targetPort, path: cleanPath, method: req.method, headers },
      mcpRes => { res.writeHead(mcpRes.statusCode, mcpRes.headers); mcpRes.pipe(res, { end: true }); }
    );
    proxy.on('error', err => {
      console.error(`[proxy:${targetPort}]`, err.message);
      if (!res.headersSent)
        res.status(502).json({ error: `MCP en puerto ${targetPort} no disponible aun, reintenta.` });
    });
    req.pipe(proxy, { end: true });
  };
}

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();

function auth(req, res, next) {
  if (extractToken(req) === API_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized - Bearer token requerido.' });
}

// Rutas por tool: /playwright/sse  /fetch/sse  /memory/sse  etc.
const tools = [
  { name: 'playwright', port: PORTS.playwright },
  { name: 'fetch',      port: PORTS.fetch      },
  { name: 'memory',     port: PORTS.memory     },
  { name: 'context7',   port: PORTS.context7   },
  { name: 'firecrawl',  port: PORTS.firecrawl  },
  { name: 'npmdocs',    port: PORTS.npmdocs    },
];

for (const t of tools) {
  app.all(`/${t.name}/sse`,     auth, proxyTo(t.port, '/sse'));
  app.all(`/${t.name}/mcp`,     auth, proxyTo(t.port, '/mcp'));
  app.all(`/${t.name}/message`, auth, proxyTo(t.port, '/message'));
}

// Ruta raiz: info
app.get('/', (_req, res) => {
  const available = tools
    .filter(t => t.name !== 'firecrawl' || !!process.env.FIRECRAWL_API_KEY)
    .map(t => `  ${t.name.padEnd(12)}: /sse?token=TOKEN o /${t.name}/sse?token=TOKEN`)
    .join('\n');
  res.send(
    'KUS DevTools MCP Gateway - ONLINE\n' +
    '================================\n\n' +
    'Herramientas disponibles:\n' +
    available + '\n\n' +
    'Auth: ?token=TOKEN  o  Authorization: Bearer TOKEN\n'
  );
});

// Health
app.get('/health', (_req, res) => res.json({ status: 'ok', tools: tools.map(t => t.name) }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`KUS DevTools MCP Gateway corriendo en 0.0.0.0:${PORT}`);
  console.log('Herramientas:', tools.map(t => t.name).join(', '));
});
