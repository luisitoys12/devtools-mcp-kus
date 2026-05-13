/**
 * KUS DevTools MCP Gateway — Endpoint UNICO v2.5.0
 * UN solo SSE con TODAS las herramientas combinadas
 * URL: https://devtools-mcp-kus.fly.dev/sse?token=TOKEN
 *
 * SPOTIFY OAUTH:
 *   1. Llama a /spotify/login  → redirige al usuario a Spotify
 *   2. Spotify vuelve a       /spotify/callback  → guarda tokens en disco
 *   3. A partir de ahí download_spotify y search_spotify_track funcionan
 *      sin necesidad de credenciales extra.
 */
const express  = require('express');
const { spawn, execFile } = require('child_process');
const path     = require('path');
const os       = require('os');
const fs       = require('fs');
const ytdlp    = require('yt-dlp-exec');

const PORT      = parseInt(process.env.PORT || '8080');
const API_TOKEN = process.env.MCP_AUTH_TOKEN || '';

if (!API_TOKEN) { console.error('MCP_AUTH_TOKEN requerido'); process.exit(1); }

// ─── Spotify OAuth helpers ───────────────────────────────────────────────────
const SPOTIFY_TOKEN_FILE = '/data/spotify_tokens/tokens.json';
const SPOTIFY_SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'user-library-read',
  'user-read-private',
].join(' ');

function getSpotifyRedirectUri() {
  return process.env.SPOTIFY_REDIRECT_URI || 'https://devtools-mcp-kus.fly.dev/spotify/callback';
}

// Guarda tokens en el volumen persistente
function saveSpotifyTokens(tokens) {
  try {
    fs.mkdirSync(path.dirname(SPOTIFY_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(SPOTIFY_TOKEN_FILE, JSON.stringify(tokens, null, 2));
    console.log('[spotify] tokens guardados en', SPOTIFY_TOKEN_FILE);
  } catch (e) {
    console.error('[spotify] error guardando tokens:', e.message);
  }
}

// Lee tokens del volumen
function loadSpotifyTokens() {
  try {
    if (fs.existsSync(SPOTIFY_TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(SPOTIFY_TOKEN_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[spotify] error leyendo tokens:', e.message);
  }
  return null;
}

// Refresca el access_token usando el refresh_token
async function refreshSpotifyToken(tokens) {
  const clientId     = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET no configurados.');

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Error refrescando token: ' + JSON.stringify(data));

  const updated = {
    ...tokens,
    access_token: data.access_token,
    expires_at:   Date.now() + (data.expires_in || 3600) * 1000,
    // refresh_token puede venir renovado o quedarse el mismo
    refresh_token: data.refresh_token || tokens.refresh_token,
  };
  saveSpotifyTokens(updated);
  return updated;
}

// Obtiene un access_token válido (refresca si está por vencer)
async function getValidSpotifyAccessToken() {
  let tokens = loadSpotifyTokens();

  // Sin tokens guardados → pedir al usuario que haga login
  if (!tokens || !tokens.access_token) {
    throw new Error(
      '⚠️  Spotify no está autenticado.\n' +
      'Abre este enlace para conectar tu cuenta:\n' +
      `   https://devtools-mcp-kus.fly.dev/spotify/login\n\n` +
      'Después de autorizar, vuelve a intentar.'
    );
  }

  // Refresca si expira en menos de 5 minutos
  if (Date.now() > (tokens.expires_at || 0) - 5 * 60 * 1000) {
    tokens = await refreshSpotifyToken(tokens);
  }
  return tokens.access_token;
}

// Obtiene access_token de cliente (no requiere login del usuario)
async function getSpotifyClientToken() {
  const clientId     = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET no configurados.');

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('No se pudo obtener token de Spotify: ' + JSON.stringify(data));
  return data.access_token;
}

// ─── MCPs stdio ────────────────────────────────────────────────────────────────
const MCP_DEFS = [
  {
    name: 'playwright',
    cmd: 'node',
    args: [
      './node_modules/@playwright/mcp/cli.js',
      '--headless',
      '--executable-path', '/usr/bin/chromium',
    ],
    env: {
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/usr/bin/chromium',
    },
    enabled: () => true,
  },
  { name: 'memory',   cmd: 'node', args: ['./node_modules/@modelcontextprotocol/server-memory/dist/index.js'], env: {}, enabled: () => true },
  { name: 'context7', cmd: 'node', args: ['./node_modules/@upstash/context7-mcp/dist/index.js'], env: {}, enabled: () => true },
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
      SPOTIFY_REDIRECT_URI:  getSpotifyRedirectUri(),
    },
    enabled: () => !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET),
  },
];

// ─── McpBridge ──────────────────────────────────────────────────────────────────
class McpBridge {
  constructor(def) { this.def=def; this.proc=null; this.pending=new Map(); this.msgId=1; this.buffer=''; this.ready=false; }
  start() {
    const env = { ...process.env, ...this.def.env };
    this.proc = spawn(this.def.cmd, this.def.args, { stdio: ['pipe','pipe','inherit'], env });
    this.proc.stdout.on('data', chunk => {
      this.buffer += chunk.toString();
      let nl;
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nl).trim(); this.buffer = this.buffer.slice(nl+1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve } = this.pending.get(msg.id); this.pending.delete(msg.id); resolve(msg);
          }
        } catch (_) {}
      }
    });
    this.proc.on('exit', code => { console.warn(`[${this.def.name}] exit(${code}), restart in 3s`); this.ready=false; setTimeout(()=>this.start(),3000); });
    this._init();
  }
  async _init() {
    try {
      await this._rpc('initialize', { protocolVersion:'2024-11-05', clientInfo:{name:'kus-gateway',version:'1.0.0'}, capabilities:{} });
      this._write({ jsonrpc:'2.0', method:'notifications/initialized' });
      this.ready=true; console.log(`[${this.def.name}] ready`);
    } catch(e) { console.error(`[${this.def.name}] init error:`,e.message); setTimeout(()=>this._init(),5000); }
  }
  _write(obj) { this.proc.stdin.write(JSON.stringify(obj)+'\n'); }
  _rpc(method,params) {
    return new Promise((resolve,reject) => {
      const id=this.msgId++;
      const t=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Timeout:${this.def.name}.${method}`));},60000);
      this.pending.set(id,{resolve:v=>{clearTimeout(t);resolve(v);},reject:v=>{clearTimeout(t);reject(v);}});
      this._write({jsonrpc:'2.0',id,method,params:params||{}});
    });
  }
  async listTools() { const r=await this._rpc('tools/list'); return (r.result?.tools||[]).map(t=>({...t,_bridge:this.def.name})); }
  async callTool(name,args) { const r=await this._rpc('tools/call',{name,arguments:args}); if(r.error) throw new Error(r.error.message); return r.result; }
}

// ─── Temp file registry ─────────────────────────────────────────────────────────
const tempFiles = new Map();
setInterval(()=>{ const now=Date.now(); for(const [tok,e] of tempFiles.entries()) if(now>e.expires){try{fs.unlinkSync(e.filePath);}catch(_){} tempFiles.delete(tok);} },5*60*1000);
function registerTemp(filePath, fileName) {
  const token=`dl_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  tempFiles.set(token,{filePath,fileName,expires:Date.now()+10*60*1000});
  return token;
}
function makeDownloadUrl(token) { return `https://devtools-mcp-kus.fly.dev/download/${token}`; }

// ─── Tool: fetch ───────────────────────────────────────────────────────────────────
const FETCH_TOOLS = [{
  name:'fetch', _bridge:'fetch',
  description:'Fetch a URL and return its text content',
  inputSchema:{ type:'object', properties:{ url:{type:'string'}, method:{type:'string',default:'GET'}, headers:{type:'object'}, body:{type:'string'} }, required:['url'] },
}];
async function callFetch(args) {
  const {url,method='GET',headers={},body}=args;
  const res=await fetch(url,{method,headers:{'User-Agent':'KUS-MCP-Gateway/1.0',...headers},body:body||undefined});
  const text=await res.text();
  return {content:[{type:'text',text:`HTTP ${res.status}\n\n${text.slice(0,50000)}`}]};
}

// ─── Tool: download_audio (yt-dlp, 1000+ sitios) ─────────────────────────────────
const DOWNLOAD_TOOLS = [{
  name:'download_audio', _bridge:'download',
  description:'Descarga audio de YouTube, SoundCloud, TikTok, Vimeo, Twitter/X, Bandcamp y +1000 sitios. Devuelve URL de descarga temporal (10 min).',
  inputSchema:{ type:'object', properties:{ url:{type:'string'}, format:{type:'string',enum:['mp3','opus','m4a','flac','wav'],default:'mp3'}, quality:{type:'string',enum:['0','2','5','9'],default:'2'} }, required:['url'] },
}];
async function callDownloadAudio(args) {
  const {url,format='mp3',quality='2'}=args;
  let meta;
  try { meta=await ytdlp(url,{dumpSingleJson:true,noWarnings:true,noCheckCertificate:true,preferFreeFormats:true,skipDownload:true}); }
  catch(e) { throw new Error(`No se pudo obtener metadata: ${e.message}`); }
  const title   =meta.title||'audio';
  const artist  =meta.uploader||meta.channel||meta.artist||'Desconocido';
  const duration=meta.duration?`${Math.floor(meta.duration/60)}:${String(meta.duration%60).padStart(2,'0')}`:'N/A';
  const thumb   =meta.thumbnail||'';
  const site    =meta.extractor_key||'Desconocido';
  const safeName=title.replace(/[^a-zA-Z0-9\-_\s]/g,'').trim().replace(/\s+/g,'_').slice(0,80);
  const outFile =path.join(os.tmpdir(),`kus_audio_${Date.now()}_${safeName}.${format}`);
  try { await ytdlp(url,{extractAudio:true,audioFormat:format,audioQuality:quality,output:outFile,noWarnings:true,noCheckCertificate:true,preferFreeFormats:true}); }
  catch(e) { throw new Error(`Error al descargar: ${e.message}`); }
  if(!fs.existsSync(outFile)) throw new Error('El archivo no fue generado. Verifica que ffmpeg esté instalado.');
  const sizeMB=(fs.statSync(outFile).size/1024/1024).toFixed(2);
  const token=registerTemp(outFile,`${safeName}.${format}`);
  return {content:[{type:'text',text:[
    `✅ Audio listo`,``,`🎵 ${title}`,`👤 ${artist}`,`⏱ ${duration}`,`🌐 ${site}`,
    `📁 ${format.toUpperCase()} (q${quality}) — ${sizeMB} MB`,``,
    `🔗 URL de descarga (10 min):`,`   ${makeDownloadUrl(token)}`,
    ``,thumb?`🖼  ${thumb}`:'',
  ].filter(l=>l!==undefined).join('\n')}]};
}

// ─── Tool: search_deezer + download_music (Deezer ARL) ───────────────────────────
const DEEZER_TOOLS = [
  {
    name:'download_music', _bridge:'deezer',
    description:'Descarga música desde Deezer en FLAC o MP3 320kbps usando tu cuenta. Requiere secret DEEZER_ARL en Fly.io. Soporta track, album y playlist.',
    inputSchema:{ type:'object', properties:{ url:{type:'string',description:'URL de Deezer: track, album o playlist'}, quality:{type:'string',enum:['flac','mp3_320','mp3_128'],default:'mp3_320'} }, required:['url'] },
  },
  {
    name:'search_deezer', _bridge:'deezer',
    description:'Busca canciones, álbumes o artistas en Deezer y devuelve URLs para usar con download_music.',
    inputSchema:{ type:'object', properties:{ query:{type:'string'}, type:{type:'string',enum:['track','album','artist','playlist'],default:'track'}, limit:{type:'number',default:10} }, required:['query'] },
  },
];
let deemixLib=null;
function getDeemix() {
  if(deemixLib) return deemixLib;
  if(!process.env.DEEZER_ARL) throw new Error('DEEZER_ARL no configurado. Ejecuta: fly secrets set DEEZER_ARL=<tu_arl>');
  try { deemixLib=require('@karlincoder/deemix'); } catch(e) { throw new Error('Librería @karlincoder/deemix no disponible: '+e.message); }
  return deemixLib;
}
async function callSearchDeezer(args) {
  const {query,type='track',limit=10}=args;
  const res=await fetch(`https://api.deezer.com/search/${type}?q=${encodeURIComponent(query)}&limit=${Math.min(25,limit)}`,{headers:{'User-Agent':'KUS-MCP-Gateway/2.5'}});
  const data=await res.json();
  if(!data.data||data.data.length===0) return {content:[{type:'text',text:`No se encontraron resultados para "${query}" en Deezer.`}]};
  const lines=[`🔍 Resultados en Deezer para "${query}" (${type}):`,``];
  for(const item of data.data) {
    if(type==='track') { const dur=item.duration?`${Math.floor(item.duration/60)}:${String(item.duration%60).padStart(2,'0')}`:''; lines.push(`🎵 ${item.title}`,`   👤 ${item.artist?.name||''} — 💿 ${item.album?.title||''}`,`   ⏱ ${dur}  🔗 ${item.link}`,``); }
    else if(type==='album')   lines.push(`💿 ${item.title}`,`   👤 ${item.artist?.name||''}  🔗 ${item.link}`,``);
    else if(type==='artist')  lines.push(`🎤 ${item.name}`,`   🔗 ${item.link}`,``);
    else if(type==='playlist')lines.push(`📋 ${item.title}`,`   👤 ${item.user?.name||''}  🔗 ${item.link}`,``);
  }
  lines.push(`💡 Usa la URL con download_music para descargar.`);
  return {content:[{type:'text',text:lines.join('\n')}]};
}
async function callDownloadMusic(args) {
  const {url,quality='mp3_320'}=args;
  if(!process.env.DEEZER_ARL) throw new Error('DEEZER_ARL no configurado.\nEjecuta: fly secrets set DEEZER_ARL=<tu_arl>\n\nCómo obtenerlo:\n  1. Abre deezer.com en Chrome\n  2. DevTools → Application → Cookies → deezer.com\n  3. Copia el valor de la cookie "arl"');
  const QUALITY_MAP={flac:9,mp3_320:3,mp3_128:1};
  const deemix=getDeemix();
  let result;
  try { result=await deemix.download({url,arl:process.env.DEEZER_ARL,bitrate:QUALITY_MAP[quality]||3,outputDir:os.tmpdir()}); }
  catch(e) { throw new Error(`Error Deezer: ${e.message}`); }
  const files=Array.isArray(result)?result:[result];
  if(!files||files.length===0) throw new Error('No se descargó ningún archivo.');
  const lines=[`✅ Deezer: ${files.length} archivo(s) listos`,``];
  for(const file of files) {
    const fp=file.path||file; if(!fs.existsSync(fp)) continue;
    const fn=path.basename(fp), sizeMB=(fs.statSync(fp).size/1024/1024).toFixed(2), tok=registerTemp(fp,fn);
    lines.push(`🎵 ${fn}`,`   💾 ${sizeMB} MB`,`   🔗 ${makeDownloadUrl(tok)}`,``);
  }
  lines.push(`⚠️  Los enlaces expiran en 10 minutos.`);
  return {content:[{type:'text',text:lines.join('\n')}]};
}

// ─── Tool: search_spotify + download_spotify (spotdl + OAuth) ────────────────
const SPOTIFY_DL_TOOLS = [
  {
    name:'download_spotify', _bridge:'spotdl',
    description:
      'Descarga música desde Spotify (canciones, álbumes, playlists) usando spotdl. ' +
      'Si Spotify no está autenticado, devuelve una URL para hacer login con un clic. ' +
      'Ejemplos: https://open.spotify.com/track/..., https://open.spotify.com/album/...',
    inputSchema:{
      type:'object',
      properties:{
        url:{ type:'string', description:'URL de Spotify: track, album o playlist' },
        format:{ type:'string', enum:['mp3','opus','flac','ogg','m4a'], default:'mp3' },
        bitrate:{ type:'string', enum:['128k','192k','320k','auto'], default:'320k' },
      },
      required:['url'],
    },
  },
  {
    name:'search_spotify_track', _bridge:'spotdl',
    description:'Busca canciones en Spotify y devuelve URLs para usar con download_spotify. No requiere login.',
    inputSchema:{
      type:'object',
      properties:{
        query:{ type:'string' },
        limit:{ type:'number', default:10 },
      },
      required:['query'],
    },
  },
];

function runSpotdl(args, opts={}) {
  return new Promise((resolve, reject) => {
    const proc = execFile('spotdl', args, { ...opts, maxBuffer: 50*1024*1024 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(stderr||err.message));
      resolve({ stdout, stderr });
    });
  });
}

async function callSearchSpotifyTrack(args) {
  const {query, limit=10}=args;
  // search_spotify_track usa client_credentials (no necesita login del usuario)
  const accessToken = await getSpotifyClientToken();
  const searchRes = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${Math.min(20,limit)}`, {
    headers:{ 'Authorization':'Bearer '+accessToken },
  });
  const searchData = await searchRes.json();
  const items = searchData?.tracks?.items||[];
  if (!items.length) return {content:[{type:'text',text:`No se encontraron resultados para "${query}" en Spotify.`}]};
  const lines=[`🔍 Resultados en Spotify para "${query}":`,``];
  for (const track of items) {
    const dur = track.duration_ms ? `${Math.floor(track.duration_ms/60000)}:${String(Math.floor((track.duration_ms%60000)/1000)).padStart(2,'0')}` : '';
    const artists = track.artists.map(a=>a.name).join(', ');
    lines.push(`🎵 ${track.name}`,`   👤 ${artists} — 💿 ${track.album?.name||''}`,`   ⏱ ${dur}  📅 ${track.album?.release_date||''}`,`   🔗 ${track.external_urls?.spotify||''}`,``);
  }
  lines.push(`💡 Usa la URL con download_spotify para descargar.`);
  return {content:[{type:'text',text:lines.join('\n')}]};
}

async function callDownloadSpotify(args) {
  const {url, format='mp3', bitrate='320k'}=args;
  const clientId     = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId||!clientSecret) throw new Error('SPOTIFY_CLIENT_ID y SPOTIFY_CLIENT_SECRET no configurados en Fly.io.');

  // Verificar que hay sesión OAuth activa (spotdl la necesita para playlists/albums privados)
  // Para tracks públicos no es estrictamente necesario, pero lo pedimos igual para consistencia
  const tokens = loadSpotifyTokens();
  if (!tokens || !tokens.access_token) {
    return {content:[{type:'text',text:[
      '⚠️  Spotify no está autenticado todavía.',
      '',
      '👉 Abre este enlace para conectar tu cuenta de Spotify:',
      '   https://devtools-mcp-kus.fly.dev/spotify/login',
      '',
      'Solo necesitas hacerlo una vez — los tokens se guardan de forma persistente.',
      'Después de autorizar, vuelve a llamar a download_spotify.',
    ].join('\n')}]};
  }

  const outDir = path.join(os.tmpdir(), `spotdl_${Date.now()}`);
  fs.mkdirSync(outDir, {recursive:true});
  const spotdlArgs = [
    'download', url,
    '--output', path.join(outDir, '{artist} - {title}.{output-ext}'),
    '--format', format,
    '--bitrate', bitrate,
    '--client-id',     clientId,
    '--client-secret', clientSecret,
    '--no-cache',
    '--print-errors',
  ];
  let stdout;
  try {
    const result = await runSpotdl(spotdlArgs, { timeout: 5*60*1000, cwd: outDir,
      env: { ...process.env, SPOTIPY_CLIENT_ID: clientId, SPOTIPY_CLIENT_SECRET: clientSecret } });
    stdout = result.stdout;
  } catch(e) {
    try { fs.rmSync(outDir, {recursive:true,force:true}); } catch(_) {}
    throw new Error(`Error spotdl: ${e.message}`);
  }
  let files = [];
  try {
    files = fs.readdirSync(outDir)
      .filter(f => ['.mp3','.opus','.flac','.ogg','.m4a'].includes(path.extname(f).toLowerCase()))
      .map(f => path.join(outDir, f));
  } catch(_) {}
  if (!files.length) {
    try { fs.rmSync(outDir, {recursive:true,force:true}); } catch(_) {}
    throw new Error(`spotdl no descargó archivos. Salida:\n${stdout.slice(0,2000)}`);
  }
  const lines=[`✅ Spotify: ${files.length} archivo(s) listos`,``];
  for (const fp of files) {
    const fn=path.basename(fp), sizeMB=(fs.statSync(fp).size/1024/1024).toFixed(2), tok=registerTemp(fp,fn);
    lines.push(`🎵 ${fn}`,`   💾 ${sizeMB} MB`,`   🔗 ${makeDownloadUrl(tok)}`,``);
  }
  lines.push(`⚠️  Los enlaces expiran en 10 minutos.`);
  return {content:[{type:'text',text:lines.join('\n')}]};
}

// ─── Iniciar bridges ─────────────────────────────────────────────────────────
const bridges = {};
for (const def of MCP_DEFS) { if(def.enabled()){bridges[def.name]=new McpBridge(def);bridges[def.name].start();} }

// Cache de tools
let toolsCache=null, toolsMap={};
async function getTools() {
  if(toolsCache) return toolsCache;
  const all=[...FETCH_TOOLS,...DOWNLOAD_TOOLS,...DEEZER_TOOLS,...SPOTIFY_DL_TOOLS];
  for(const[,b] of Object.entries(bridges)) { if(!b.ready) continue; try{all.push(...(await b.listTools()));}catch(_){} }
  toolsMap={};
  for(const t of all){toolsMap[t.name]=t._bridge||null;delete t._bridge;}
  toolsCache=all;
  setTimeout(()=>{toolsCache=null;},60000);
  return all;
}

async function callAnyTool(name,args) {
  const bridge=toolsMap[name];
  if(bridge==='fetch')   return callFetch(args);
  if(bridge==='download')return callDownloadAudio(args);
  if(bridge==='deezer'){
    if(name==='search_deezer')  return callSearchDeezer(args);
    if(name==='download_music') return callDownloadMusic(args);
  }
  if(bridge==='spotdl'){
    if(name==='search_spotify_track') return callSearchSpotifyTrack(args);
    if(name==='download_spotify')     return callDownloadSpotify(args);
  }
  if(bridges[bridge]) return bridges[bridge].callTool(name,args);
  for(const[,b] of Object.entries(bridges)){try{return await b.callTool(name,args);}catch(_){}}
  throw new Error(`Tool not found: ${name}`);
}

// ─── Express app ─────────────────────────────────────────────────────────────────
const app=express();
app.use(express.json());
function getToken(req){const b=(req.headers['authorization']||'').replace(/^Bearer\s+/i,'').trim();if(b)return b;try{return new URL(req.url,'http://x').searchParams.get('token')||'';}catch{return '';}}
function auth(req,res,next){if(getToken(req)===API_TOKEN)return next();res.status(401).json({error:'Unauthorized'});}

// ─── Rutas Spotify OAuth ─────────────────────────────────────────────────────
// GET /spotify/login  → redirige a Spotify para autorizar
app.get('/spotify/login', (req, res) => {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) return res.status(500).send('SPOTIFY_CLIENT_ID no configurado.');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     clientId,
    scope:         SPOTIFY_SCOPES,
    redirect_uri:  getSpotifyRedirectUri(),
    state:         'kus_' + Date.now(),
  });
  res.redirect('https://accounts.spotify.com/authorize?' + params.toString());
});

// GET /spotify/callback  → Spotify llama aquí con el code
app.get('/spotify/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`Error de autorización Spotify: ${error}`);
  if (!code)  return res.status(400).send('No se recibió code de Spotify.');

  const clientId     = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return res.status(500).send('Secrets de Spotify no configurados.');

  try {
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: getSpotifyRedirectUri(),
      }),
    });
    const data = await tokenRes.json();
    if (!data.access_token) return res.status(500).send('Error obteniendo tokens: ' + JSON.stringify(data));

    saveSpotifyTokens({
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    Date.now() + (data.expires_in || 3600) * 1000,
      scope:         data.scope,
    });

    res.send(`
      <!DOCTYPE html><html><head><meta charset="utf-8"><title>Spotify conectado</title>
      <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1DB954;color:#fff;}
      .card{background:rgba(0,0,0,.3);padding:2rem 3rem;border-radius:1rem;text-align:center;}
      h1{font-size:2rem;margin-bottom:.5rem;}p{opacity:.85;}</style></head>
      <body><div class="card">
        <h1>✅ Spotify conectado</h1>
        <p>Tu cuenta ha sido autorizada correctamente.<br>Ya puedes usar <strong>download_spotify</strong> en el MCP.</p>
        <p style="margin-top:1.5rem;font-size:.85rem;opacity:.6">Puedes cerrar esta ventana.</p>
      </div></body></html>
    `);
  } catch (e) {
    console.error('[spotify/callback]', e.message);
    res.status(500).send('Error interno: ' + e.message);
  }
});

// GET /spotify/status  → indica si hay sesión activa
app.get('/spotify/status', (req, res) => {
  const tokens = loadSpotifyTokens();
  if (!tokens) return res.json({ authenticated: false, message: 'No hay sesión. Ve a /spotify/login' });
  const expiresIn = Math.round(((tokens.expires_at || 0) - Date.now()) / 1000);
  res.json({
    authenticated: true,
    expires_in_seconds: expiresIn,
    scopes: tokens.scope || 'desconocido',
    login_url: 'https://devtools-mcp-kus.fly.dev/spotify/login',
  });
});

// ─── Ruta de descarga temporal ───────────────────────────────────────────────
app.get('/download/:token',(req,res)=>{
  const entry=tempFiles.get(req.params.token);
  if(!entry) return res.status(404).send('Archivo no encontrado o enlace expirado.');
  if(Date.now()>entry.expires){try{fs.unlinkSync(entry.filePath);}catch(_){}tempFiles.delete(req.params.token);return res.status(410).send('Enlace expirado.');}
  res.download(entry.filePath,entry.fileName,err=>{if(!err){try{fs.unlinkSync(entry.filePath);}catch(_){}tempFiles.delete(req.params.token);}});
});

// SSE
const sessions=new Map();
app.get('/sse',auth,(req,res)=>{
  const sid=`kus_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive');res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();sessions.set(sid,res);res.write(`event: endpoint\ndata: /message?sessionId=${sid}\n\n`);
  const ping=setInterval(()=>res.write(': ping\n\n'),15000);
  req.on('close',()=>{clearInterval(ping);sessions.delete(sid);});
});

// Message
app.post('/message',auth,async(req,res)=>{
  const{sessionId}=req.query,msg=req.body,session=sessions.get(sessionId);
  const emit=r=>{const p=JSON.stringify({jsonrpc:'2.0',id:msg.id,result:r});if(session)session.write(`event: message\ndata: ${p}\n\n`);res.json({ok:true});};
  const emitErr=(c,m)=>{const p=JSON.stringify({jsonrpc:'2.0',id:msg.id,error:{code:c,message:m}});if(session)session.write(`event: message\ndata: ${p}\n\n`);res.json({ok:true});};
  try{
    if(msg.method==='initialize') return emit({protocolVersion:'2024-11-05',serverInfo:{name:'kus-devtools',version:'2.5.0'},capabilities:{tools:{}}});
    if(msg.method==='notifications/initialized') return res.json({ok:true});
    if(msg.method==='tools/list'){const tools=await getTools();return emit({tools});}
    if(msg.method==='tools/call'){const result=await callAnyTool(msg.params.name,msg.params.arguments||{});return emit(result);}
    return emitErr(-32601,'Method not found: '+msg.method);
  }catch(e){console.error('[message]',e.message);return emitErr(-32603,e.message);}
});

// Compatibilidad
app.get('/:tool/sse',auth,(req,res)=>res.redirect(`/sse?token=${getToken(req)}`));

// Info y health
app.get('/',(_req,res)=>{
  const spotifyAuth = loadSpotifyTokens() ? '✅ autenticado' : '⚠️  pendiente → /spotify/login';
  const active=['fetch','download_audio','download_music','search_deezer','download_spotify','search_spotify_track',...Object.keys(bridges)];
  res.type('text').send([
    `KUS DevTools MCP Gateway v2.5.0`,
    '='.repeat(50),
    '',
    `SSE:  /sse?token=TOKEN`,
    `POST: /message?sessionId=ID`,
    '',
    `Spotify: ${spotifyAuth}`,
    `Herramientas: ${active.join(', ')}`,
  ].join('\n'));
});
app.get('/health',async(_req,res)=>{
  const tools={};
  for(const[k,b] of Object.entries(bridges)) tools[k]=b.ready?'ready':'starting';
  tools['fetch']='ready';
  tools['download_audio']='ready';
  tools['download_music']=process.env.DEEZER_ARL?'ready':'needs DEEZER_ARL';
  const spotTokens = loadSpotifyTokens();
  tools['download_spotify']=(process.env.SPOTIFY_CLIENT_ID&&process.env.SPOTIFY_CLIENT_SECRET)
    ? (spotTokens ? 'ready' : 'needs login → /spotify/login')
    : 'needs SPOTIFY secrets';
  tools['search_spotify_track']=(process.env.SPOTIFY_CLIENT_ID&&process.env.SPOTIFY_CLIENT_SECRET)?'ready':'needs SPOTIFY secrets';
  tools['search_deezer']='ready';
  res.json({status:'ok',version:'2.5.0',tools,spotify_login:'https://devtools-mcp-kus.fly.dev/spotify/login'});
});

app.listen(PORT,'0.0.0.0',()=>{
  console.log(`KUS MCP Gateway v2.5.0 en puerto ${PORT}`);
  console.log(`Spotify login: https://devtools-mcp-kus.fly.dev/spotify/login`);
  const spotTokens = loadSpotifyTokens();
  console.log(`Spotify tokens: ${spotTokens ? 'cargados ✅' : 'no configurados — visita /spotify/login'}`);
  console.log('Tools:',['fetch','download_audio','download_music','search_deezer','download_spotify','search_spotify_track',...Object.keys(bridges)].join(', '));
});
