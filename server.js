/**
 * KUS DevTools MCP Gateway — Endpoint UNICO
 * UN solo SSE con TODAS las herramientas combinadas
 * URL: https://devtools-mcp-kus.fly.dev/sse?token=TOKEN
 */
const express = require('express');
const { spawn } = require('child_process');
const path    = require('path');
const os      = require('os');
const fs      = require('fs');
const ytdlp   = require('yt-dlp-exec');

const PORT      = parseInt(process.env.PORT || '8080');
const API_TOKEN = process.env.MCP_AUTH_TOKEN || '';

if (!API_TOKEN) { console.error('MCP_AUTH_TOKEN requerido'); process.exit(1); }

// ─── Definicion de MCPs stdio ─────────────────────────────────────────────────
const MCP_DEFS = [
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
  {
    name: 'spotify',
    cmd: 'node',
    args: ['/app/spotify-mcp/build/index.js'],
    env: {
      SPOTIFY_CLIENT_ID:     process.env.SPOTIFY_CLIENT_ID     || '',
      SPOTIFY_CLIENT_SECRET: process.env.SPOTIFY_CLIENT_SECRET || '',
      SPOTIFY_REDIRECT_URI:  process.env.SPOTIFY_REDIRECT_URI  || 'http://127.0.0.1:8888/callback',
    },
    enabled: () => !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET),
  },
];

// ─── Bridge stdio→JSON-RPC ────────────────────────────────────────────────────
class McpBridge {
  constructor(def) {
    this.def     = def;
    this.proc    = null;
    this.pending = new Map();
    this.msgId   = 1;
    this.buffer  = '';
    this.ready   = false;
  }

  start() {
    const env = { ...process.env, ...this.def.env };
    this.proc = spawn(this.def.cmd, this.def.args, {
      stdio: ['pipe', 'pipe', 'inherit'], env,
    });
    this.proc.stdout.on('data', chunk => {
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
          }
        } catch (_) {}
      }
    });
    this.proc.on('exit', code => {
      console.warn(`[${this.def.name}] exit(${code}), restart in 3s`);
      this.ready = false;
      setTimeout(() => this.start(), 3000);
    });
    this._init();
  }

  async _init() {
    try {
      await this._rpc('initialize', {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'kus-gateway', version: '1.0.0' },
        capabilities: {},
      });
      this._write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      this.ready = true;
      console.log(`[${this.def.name}] ready`);
    } catch (e) {
      console.error(`[${this.def.name}] init error:`, e.message);
      setTimeout(() => this._init(), 5000);
    }
  }

  _write(obj) { this.proc.stdin.write(JSON.stringify(obj) + '\n'); }

  _rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      const t  = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timeout: ${this.def.name}.${method}`)); }, 60000);
      this.pending.set(id, {
        resolve: v => { clearTimeout(t); resolve(v); },
        reject:  v => { clearTimeout(t); reject(v); },
      });
      this._write({ jsonrpc: '2.0', id, method, params: params || {} });
    });
  }

  async listTools() {
    const r = await this._rpc('tools/list');
    return (r.result?.tools || []).map(t => ({ ...t, _bridge: this.def.name }));
  }

  async callTool(name, args) {
    const r = await this._rpc('tools/call', { name, arguments: args });
    if (r.error) throw new Error(r.error.message);
    return r.result;
  }
}

// ─── Fetch nativo ─────────────────────────────────────────────────────────────
const FETCH_TOOLS = [{
  name: 'fetch',
  _bridge: 'fetch',
  description: 'Fetch a URL and return its text content',
  inputSchema: {
    type: 'object',
    properties: {
      url:     { type: 'string', description: 'URL a obtener' },
      method:  { type: 'string', default: 'GET' },
      headers: { type: 'object' },
      body:    { type: 'string' },
    },
    required: ['url'],
  },
}];

async function callFetch(args) {
  const { url, method = 'GET', headers = {}, body } = args;
  const res = await fetch(url, {
    method,
    headers: { 'User-Agent': 'KUS-MCP-Gateway/1.0', ...headers },
    body: body || undefined,
  });
  const text = await res.text();
  return { content: [{ type: 'text', text: `HTTP ${res.status}\n\n${text.slice(0, 50000)}` }] };
}

// ─── Download Audio Tool (yt-dlp) ────────────────────────────────────────────
const DOWNLOAD_TOOLS = [{
  name: 'download_audio',
  _bridge: 'download',
  description:
    'Descarga el audio de una URL de video/música (YouTube, SoundCloud, TikTok, Vimeo, Twitter/X, Bandcamp, y más de 1000 sitios). ' +
    'Devuelve metadata del track y una URL temporal para descargar el archivo MP3 desde este servidor. ' +
    'La URL temporal expira en 10 minutos.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL del video o canción a descargar (YouTube, SoundCloud, TikTok, etc.)',
      },
      format: {
        type: 'string',
        enum: ['mp3', 'opus', 'm4a', 'flac', 'wav'],
        default: 'mp3',
        description: 'Formato de audio de salida (default: mp3)',
      },
      quality: {
        type: 'string',
        enum: ['0', '2', '5', '9'],
        default: '2',
        description: 'Calidad de audio VBR: 0=máxima, 2=alta (default), 5=media, 9=mínima',
      },
    },
    required: ['url'],
  },
}];

// ─── Download Music Tool (Deezer via ARL) ────────────────────────────────────
// Requiere secret: DEEZER_ARL
// Cómo obtener tu ARL:
//   1. Abre deezer.com en Chrome (cuenta Free o Premium)
//   2. DevTools → Application → Cookies → deezer.com
//   3. Copia el valor de la cookie "arl"
//   4. fly secrets set DEEZER_ARL=<tu_arl>
const DEEZER_TOOLS = [
  {
    name: 'download_music',
    _bridge: 'deezer',
    description:
      'Descarga música directamente desde Deezer en alta calidad (FLAC lossless o MP3 320kbps). ' +
      'Soporta canciones individuales, álbumes completos y playlists mediante URL de Deezer. ' +
      'Requiere que DEEZER_ARL esté configurado como secret en Fly.io. ' +
      'Devuelve una URL temporal de descarga válida por 10 minutos. ' +
      'Ejemplos de URL válidas: https://www.deezer.com/track/123456, https://www.deezer.com/album/789, https://www.deezer.com/playlist/456',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL de Deezer: track, album o playlist (ej: https://www.deezer.com/track/123456)',
        },
        quality: {
          type: 'string',
          enum: ['flac', 'mp3_320', 'mp3_128'],
          default: 'mp3_320',
          description: 'Calidad de descarga: flac=lossless (Premium), mp3_320=alta (Premium), mp3_128=estándar (Free)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'search_deezer',
    _bridge: 'deezer',
    description:
      'Busca canciones, álbumes o artistas en Deezer y devuelve resultados con URLs directas para usar con download_music.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Texto de búsqueda (ej: "Bad Bunny Tití me preguntó", "Taylor Swift Midnights")',
        },
        type: {
          type: 'string',
          enum: ['track', 'album', 'artist', 'playlist'],
          default: 'track',
          description: 'Tipo de búsqueda',
        },
        limit: {
          type: 'number',
          default: 10,
          description: 'Número máximo de resultados (1-25)',
        },
      },
      required: ['query'],
    },
  },
];

// Mapa temporal: token → { filePath, fileName, expires }
const tempFiles = new Map();

// Limpieza automática cada 5 minutos
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tempFiles.entries()) {
    if (now > entry.expires) {
      try { fs.unlinkSync(entry.filePath); } catch (_) {}
      tempFiles.delete(token);
    }
  }
}, 5 * 60 * 1000);

function registerTemp(filePath, fileName) {
  const token   = `dl_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const expires = Date.now() + 10 * 60 * 1000;
  tempFiles.set(token, { filePath, fileName, expires });
  return token;
}

async function callDownloadAudio(args) {
  const { url, format = 'mp3', quality = '2' } = args;
  let meta;
  try {
    meta = await ytdlp(url, {
      dumpSingleJson: true, noWarnings: true, noCheckCertificate: true,
      preferFreeFormats: true, skipDownload: true,
    });
  } catch (e) {
    throw new Error(`No se pudo obtener metadata de la URL: ${e.message}`);
  }
  const title    = meta.title    || 'audio';
  const artist   = meta.uploader || meta.channel || meta.artist || 'Desconocido';
  const duration = meta.duration ? `${Math.floor(meta.duration / 60)}:${String(meta.duration % 60).padStart(2, '0')}` : 'N/A';
  const thumb    = meta.thumbnail || '';
  const site     = meta.extractor_key || 'Desconocido';
  const safeName = title.replace(/[^a-zA-Z0-9\-_\s]/g, '').trim().replace(/\s+/g, '_').slice(0, 80);
  const outFile  = path.join(os.tmpdir(), `kus_audio_${Date.now()}_${safeName}.${format}`);
  try {
    await ytdlp(url, {
      extractAudio: true, audioFormat: format, audioQuality: quality,
      output: outFile, noWarnings: true, noCheckCertificate: true, preferFreeFormats: true,
    });
  } catch (e) { throw new Error(`Error al descargar audio: ${e.message}`); }
  if (!fs.existsSync(outFile)) throw new Error('El archivo de audio no fue generado. Verifica que ffmpeg esté instalado.');
  const sizeMB = (fs.statSync(outFile).size / 1024 / 1024).toFixed(2);
  const token  = registerTemp(outFile, `${safeName}.${format}`);
  const summary = [
    `✅ Audio listo para descargar`,
    ``,
    `🎵 Título:    ${title}`,
    `👤 Artista:   ${artist}`,
    `⏱  Duración:  ${duration}`,
    `🌐 Fuente:    ${site}`,
    `📁 Formato:   ${format.toUpperCase()} (calidad ${quality})`,
    `💾 Tamaño:    ${sizeMB} MB`,
    ``,
    `🔗 URL de descarga (válida 10 min):`,
    `   https://devtools-mcp-kus.fly.dev/download/${token}`,
    ``,
    thumb ? `🖼  Thumbnail: ${thumb}` : '',
  ].filter(l => l !== undefined).join('\n');
  return { content: [{ type: 'text', text: summary }] };
}

// ─── Deezer: search (API pública, sin ARL) ────────────────────────────────────
async function callSearchDeezer(args) {
  const { query, type = 'track', limit = 10 } = args;
  const safeLimit = Math.min(Math.max(1, limit), 25);
  const apiUrl = `https://api.deezer.com/search/${type}?q=${encodeURIComponent(query)}&limit=${safeLimit}`;
  const res  = await fetch(apiUrl, { headers: { 'User-Agent': 'KUS-MCP-Gateway/2.3' } });
  const data = await res.json();
  if (!data.data || data.data.length === 0) {
    return { content: [{ type: 'text', text: `No se encontraron resultados para "${query}" en Deezer.` }] };
  }
  const lines = [`🔍 Resultados de Deezer para "${query}" (${type}):`, ''];
  for (const item of data.data) {
    if (type === 'track') {
      const dur = item.duration ? `${Math.floor(item.duration/60)}:${String(item.duration%60).padStart(2,'0')}` : '';
      lines.push(`🎵 ${item.title}`);
      lines.push(`   👤 ${item.artist?.name || ''} — 💿 ${item.album?.title || ''}`);
      lines.push(`   ⏱ ${dur}  🔗 ${item.link}`);
    } else if (type === 'album') {
      lines.push(`💿 ${item.title}`);
      lines.push(`   👤 ${item.artist?.name || ''}  🔗 ${item.link}`);
    } else if (type === 'artist') {
      lines.push(`🎤 ${item.name}`);
      lines.push(`   🔗 ${item.link}`);
    } else if (type === 'playlist') {
      lines.push(`📋 ${item.title}`);
      lines.push(`   👤 ${item.user?.name || ''}  🔗 ${item.link}`);
    }
    lines.push('');
  }
  lines.push(`💡 Usa la URL con la herramienta download_music para descargar.`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ─── Deezer: download_music via @karlincoder/deemix ──────────────────────────
let deemixLib = null;
function getDeemix() {
  if (deemixLib) return deemixLib;
  if (!process.env.DEEZER_ARL) throw new Error('DEEZER_ARL no configurado. Ejecuta: fly secrets set DEEZER_ARL=<tu_arl>');
  try {
    deemixLib = require('@karlincoder/deemix');
  } catch (e) {
    throw new Error('Librería @karlincoder/deemix no disponible: ' + e.message);
  }
  return deemixLib;
}

async function callDownloadMusic(args) {
  const { url, quality = 'mp3_320' } = args;
  if (!process.env.DEEZER_ARL) {
    throw new Error(
      'DEEZER_ARL no configurado.\n' +
      'Para habilitarlo ejecuta en tu terminal:\n' +
      '  fly secrets set DEEZER_ARL=<tu_arl>\n\n' +
      'Cómo obtener tu ARL:\n' +
      '  1. Abre deezer.com en Chrome (cuenta Free o Premium)\n' +
      '  2. DevTools → Application → Cookies → deezer.com\n' +
      '  3. Copia el valor de la cookie "arl"'
    );
  }

  // Map quality string to Deezer bitrate constant
  const QUALITY_MAP = {
    'flac':    9,   // FLAC lossless (requiere Premium)
    'mp3_320': 3,   // MP3 320kbps  (requiere Premium)
    'mp3_128': 1,   // MP3 128kbps  (cuenta Free)
  };
  const bitrateId = QUALITY_MAP[quality] || 3;
  const outDir    = os.tmpdir();

  const deemix = getDeemix();

  let result;
  try {
    result = await deemix.download({
      url,
      arl:      process.env.DEEZER_ARL,
      bitrate:  bitrateId,
      outputDir: outDir,
    });
  } catch (e) {
    throw new Error(`Error al descargar desde Deezer: ${e.message}`);
  }

  // @karlincoder/deemix devuelve array de archivos descargados
  const files = Array.isArray(result) ? result : [result];
  if (!files || files.length === 0) throw new Error('No se descargó ningún archivo.');

  const lines = [`✅ Descarga desde Deezer completada (${files.length} archivo${files.length > 1 ? 's' : ''})`, ''];

  for (const file of files) {
    const filePath = file.path || file;
    if (!fs.existsSync(filePath)) continue;
    const fileName = path.basename(filePath);
    const sizeMB   = (fs.statSync(filePath).size / 1024 / 1024).toFixed(2);
    const token    = registerTemp(filePath, fileName);
    lines.push(`🎵 ${fileName}`);
    lines.push(`   💾 ${sizeMB} MB`);
    lines.push(`   🔗 https://devtools-mcp-kus.fly.dev/download/${token}`);
    if (file.title)  lines.push(`   📌 ${file.title}`);
    if (file.artist) lines.push(`   👤 ${file.artist}`);
    if (file.album)  lines.push(`   💿 ${file.album}`);
    lines.push('');
  }

  lines.push(`⚠️  Los enlaces expiran en 10 minutos.`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ─── Iniciar bridges ──────────────────────────────────────────────────────────
const bridges = {};
for (const def of MCP_DEFS) {
  if (def.enabled()) {
    bridges[def.name] = new McpBridge(def);
    bridges[def.name].start();
  }
}

// Cache de tools (se refresca cada 60s)
let toolsCache = null;
let toolsMap   = {};
async function getTools() {
  if (toolsCache) return toolsCache;
  const all = [...FETCH_TOOLS, ...DOWNLOAD_TOOLS, ...DEEZER_TOOLS];
  for (const [, b] of Object.entries(bridges)) {
    if (!b.ready) continue;
    try { all.push(...(await b.listTools())); } catch (_) {}
  }
  toolsMap = {};
  for (const t of all) { toolsMap[t.name] = t._bridge || null; delete t._bridge; }
  toolsCache = all;
  setTimeout(() => { toolsCache = null; }, 60000);
  return all;
}

async function callAnyTool(name, args) {
  const bridge = toolsMap[name];
  if (bridge === 'fetch')    return callFetch(args);
  if (bridge === 'download') return callDownloadAudio(args);
  if (bridge === 'deezer') {
    if (name === 'search_deezer')  return callSearchDeezer(args);
    if (name === 'download_music') return callDownloadMusic(args);
  }
  if (bridges[bridge]) return bridges[bridge].callTool(name, args);
  for (const [, b] of Object.entries(bridges)) {
    try { return await b.callTool(name, args); } catch (_) {}
  }
  throw new Error(`Tool not found: ${name}`);
}

// ─── Express ──────────────────────────────────────────────────────────────────
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

// ─── Ruta de descarga temporal ────────────────────────────────────────────────
app.get('/download/:token', (req, res) => {
  const entry = tempFiles.get(req.params.token);
  if (!entry) return res.status(404).send('Archivo no encontrado o enlace expirado.');
  if (Date.now() > entry.expires) {
    try { fs.unlinkSync(entry.filePath); } catch (_) {}
    tempFiles.delete(req.params.token);
    return res.status(410).send('Enlace expirado. Vuelve a ejecutar la herramienta de descarga.');
  }
  res.download(entry.filePath, entry.fileName, err => {
    if (!err) {
      try { fs.unlinkSync(entry.filePath); } catch (_) {}
      tempFiles.delete(req.params.token);
    }
  });
});

// ─── SSE UNICO ────────────────────────────────────────────────────────────────
const sessions = new Map();

app.get('/sse', auth, (req, res) => {
  const sid = `kus_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  sessions.set(sid, res);
  res.write(`event: endpoint\ndata: /message?sessionId=${sid}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); sessions.delete(sid); });
});

// ─── MESSAGE UNICO ────────────────────────────────────────────────────────────
app.post('/message', auth, async (req, res) => {
  const { sessionId } = req.query;
  const msg = req.body;
  const session = sessions.get(sessionId);
  const emit = (result) => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
    if (session) session.write(`event: message\ndata: ${payload}\n\n`);
    res.json({ ok: true });
  };
  const emitErr = (code, message) => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    if (session) session.write(`event: message\ndata: ${payload}\n\n`);
    res.json({ ok: true });
  };
  try {
    if (msg.method === 'initialize') {
      return emit({
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'kus-devtools', version: '2.3.0' },
        capabilities: { tools: {} },
      });
    }
    if (msg.method === 'notifications/initialized') return res.json({ ok: true });
    if (msg.method === 'tools/list') {
      const tools = await getTools();
      return emit({ tools });
    }
    if (msg.method === 'tools/call') {
      const result = await callAnyTool(msg.params.name, msg.params.arguments || {});
      return emit(result);
    }
    return emitErr(-32601, 'Method not found: ' + msg.method);
  } catch (e) {
    console.error('[message]', e.message);
    return emitErr(-32603, e.message);
  }
});

// ─── Rutas individuales (compatibilidad) ──────────────────────────────────────
app.get('/:tool/sse', auth, (req, res) => {
  res.redirect(`/sse?token=${getToken(req)}`);
});

// ─── Info y health ────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  const active = ['fetch', 'download_audio', 'download_music', 'search_deezer', ...Object.keys(bridges)];
  res.type('text').send(
    'KUS DevTools MCP Gateway v2.3.0 — Endpoint Unico\n' +
    '=================================================\n\n' +
    'UN SOLO LINK para todas las herramientas:\n' +
    '  SSE:  /sse?token=TOKEN\n' +
    '  POST: /message?sessionId=ID\n\n' +
    'Herramientas activas: ' + active.join(', ') + '\n'
  );
});

app.get('/health', async (_req, res) => {
  const tools = {};
  for (const [k, b] of Object.entries(bridges))
    tools[k] = b.ready ? 'ready' : 'starting';
  tools['fetch']          = 'ready';
  tools['download_audio'] = 'ready';
  tools['download_music'] = process.env.DEEZER_ARL ? 'ready' : 'needs DEEZER_ARL secret';
  tools['search_deezer']  = 'ready';
  res.json({ status: 'ok', tools });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`KUS MCP Gateway v2.3.0 (endpoint unico) en puerto ${PORT}`);
  console.log('Tools:', ['fetch', 'download_audio', 'download_music', 'search_deezer', ...Object.keys(bridges)].join(', '));
});
