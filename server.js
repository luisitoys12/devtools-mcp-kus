const express = require('express');
const { spawn } = require('child_process');
const http    = require('http');

const PORT      = parseInt(process.env.PORT     || '8080');
const MCP_PORT  = parseInt(process.env.MCP_PORT || '8931');
const API_TOKEN = process.env.MCP_AUTH_TOKEN    || '';

if (!API_TOKEN) {
  console.error('ERROR: MCP_AUTH_TOKEN no configurado.');
  console.error('Ejecuta: fly secrets set MCP_AUTH_TOKEN=tu_token');
  process.exit(1);
}

const mcp = spawn('npx', [
  '@playwright/mcp@latest',
  '--headless',
  '--port', String(MCP_PORT),
  '--host', 'localhost',
], { stdio: ['ignore', 'inherit', 'inherit'] });

mcp.on('error', e => console.error('[MCP] error:', e.message));
mcp.on('exit',  c => { console.error('[MCP] termino con codigo:', c); process.exit(1); });

function extractToken(req) {
  const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;
  try {
    const url = new URL(req.url, 'http://x');
    const t = url.searchParams.get('token');
    if (t) return t;
  } catch (_) {}
  const m = req.url.match(/^\/(sse|mcp|message)\/([^/?#]+)/);
  return m ? m[2] : '';
}

function proxyTo(targetPath) {
  return (req, res) => {
    let cleanPath = targetPath;
    try {
      const url = new URL(req.url, 'http://x');
      url.searchParams.delete('token');
      cleanPath = targetPath + (url.search || '');
    } catch (_) {}

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (['origin', 'host', 'authorization'].includes(k.toLowerCase())) continue;
      headers[k] = v;
    }

    const opts = {
      hostname : 'localhost',
      port     : MCP_PORT,
      path     : cleanPath,
      method   : req.method,
      headers,
    };

    const proxy = http.request(opts, mcpRes => {
      res.writeHead(mcpRes.statusCode, mcpRes.headers);
      mcpRes.pipe(res, { end: true });
    });
    proxy.on('error', err => {
      console.error('[proxy] error:', err.message);
      if (!res.headersSent)
        res.status(502).json({ error: 'MCP iniciando, reintenta en segundos.' });
    });
    req.pipe(proxy, { end: true });
  };
}

const app = express();

function auth(req, res, next) {
  if (extractToken(req) === API_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized - Bearer token requerido.' });
}

app.all('/mcp',            auth, proxyTo('/mcp'));
app.all('/mcp/:token',     auth, proxyTo('/mcp'));
app.all('/sse',            auth, proxyTo('/sse'));
app.all('/sse/:token',     auth, proxyTo('/sse'));
app.all('/message',        auth, proxyTo('/message'));
app.all('/message/:token', auth, proxyTo('/message'));

app.get('/', (_req, res) => res.send(
  'KUS DevTools MCP Server - ONLINE\n' +
  'SSE : /sse?token=TOKEN\n' +
  'MCP : /mcp  (Authorization: Bearer TOKEN)\n'
));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`KUS DevTools MCP en 0.0.0.0:${PORT} | MCP interno localhost:${MCP_PORT}`);
});
