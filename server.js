/**
 * KUS DevTools MCP Gateway — Endpoint UNICO v2.4.0
 * UN solo SSE con TODAS las herramientas combinadas
 * URL: https://devtools-mcp-kus.fly.dev/sse?token=TOKEN
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

// ─── MCPs stdio ────────────────────────────────────────────────────────────────
const MCP_DEFS = [
  { name: 'playwright', cmd: 'node', args: ['./node_modules/@playwright/mcp/cli.js', '--headless'], env: {}, enabled: () => true },
  { name: 'memory',     cmd: 'node', args: ['./node_modules/@modelcontextprotocol/server-memory/dist/index.js'], env: {}, enabled: () => true },
  { name: 'context7',   cmd: 'node', args: ['./node_modules/@upstash/context7-mcp/dist/index.js'], env: {}, enabled: () => true },
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
  const res=await fetch(`https://api.deezer.com/search/${type}?q=${encodeURIComponent(query)}&limit=${Math.min(25,limit)}`,{headers:{'User-Agent':'KUS-MCP-Gateway/2.4'}});
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

// ─── Tool: search_spotify + download_spotify (spotdl) ───────────────────────────
// spotdl usa la API oficial de Spotify para metadata y YouTube para el audio.
// Requiere: SPOTIFY_CLIENT_ID y SPOTIFY_CLIENT_SECRET (ya configurados en Fly).
const SPOTIFY_DL_TOOLS = [
  {
    name:'download_spotify', _bridge:'spotdl',
    description:
      'Descarga música desde Spotify (canciones, álbumes, playlists) usando spotdl. ' +
      'Obtiene metadata oficial de Spotify (portada, letra, artista, álbum) y descarga el audio desde YouTube en MP3 320kbps. ' +
      'Requiere SPOTIFY_CLIENT_ID y SPOTIFY_CLIENT_SECRET configurados (ya activos). ' +
      'Ejemplos de URL: https://open.spotify.com/track/..., https://open.spotify.com/album/..., https://open.spotify.com/playlist/...',
    inputSchema:{
      type:'object',
      properties:{
        url:{ type:'string', description:'URL de Spotify: track, album o playlist' },
        format:{ type:'string', enum:['mp3','opus','flac','ogg','m4a'], default:'mp3', description:'Formato de audio (default: mp3)' },
        bitrate:{ type:'string', enum:['128k','192k','320k','auto'], default:'320k', description:'Bitrate de salida (default: 320k)' },
      },
      required:['url'],
    },
  },
  {
    name:'search_spotify_track', _bridge:'spotdl',
    description:'Busca canciones en Spotify usando la API oficial y devuelve URLs directas para usar con download_spotify.',
    inputSchema:{
      type:'object',
      properties:{
        query:{ type:'string', description:'Texto de búsqueda (ej: "Bad Bunny Tití me preguntó", "Taylor Swift Shake It Off")' },
        limit:{ type:'number', default:10, description:'Cantidad de resultados (1-20)' },
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
  const clientId     = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId||!clientSecret) throw new Error('SPOTIFY_CLIENT_ID y SPOTIFY_CLIENT_SECRET no configurados.');

  // Obtener token de la API pública de Spotify
  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method:'POST',
    headers:{ 'Content-Type':'application/x-www-form-urlencoded', 'Authorization':'Basic '+Buffer.from(`${clientId}:${clientSecret}`).toString('base64') },
    body:'grant_type=client_credentials',
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('No se pudo obtener token de Spotify: '+JSON.stringify(tokenData));

  const searchRes = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${Math.min(20,limit)}`, {
    headers:{ 'Authorization':'Bearer '+tokenData.access_token },
  });
  const searchData = await searchRes.json();
  const items = searchData?.tracks?.items||[];
  if (!items.length) return {content:[{type:'text',text:`No se encontraron resultados para "${query}" en Spotify.`}]};

  const lines=[`🔍 Resultados en Spotify para "${query}":`,``];
  for (const track of items) {
    const dur = track.duration_ms ? `${Math.floor(track.duration_ms/60000)}:${String(Math.floor((track.duration_ms%60000)/1000)).padStart(2,'0')}` : '';
    const artists = track.artists.map(a=>a.name).join(', ');
    lines.push(
      `🎵 ${track.name}`,
      `   👤 ${artists} — 💿 ${track.album?.name||''}`,
      `   ⏱ ${dur}  📅 ${track.album?.release_date||''}`,
      `   🔗 ${track.external_urls?.spotify||''}`,
      ``,
    );
  }
  lines.push(`💡 Usa la URL con download_spotify para descargar.`);
  return {content:[{type:'text',text:lines.join('\n')}]};
}

async function callDownloadSpotify(args) {
  const {url, format='mp3', bitrate='320k'}=args;
  const clientId     = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId||!clientSecret) throw new Error('SPOTIFY_CLIENT_ID y SPOTIFY_CLIENT_SECRET no configurados en Fly.io.');

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
    // Limpiar dir temp en error
    try { fs.rmSync(outDir, {recursive:true,force:true}); } catch(_) {}
    throw new Error(`Error spotdl: ${e.message}`);
  }

  // Recopilar archivos descargados
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
    const fn     = path.basename(fp);
    const sizeMB = (fs.statSync(fp).size/1024/1024).toFixed(2);
    const tok    = registerTemp(fp, fn);
    lines.push(`🎵 ${fn}`, `   💾 ${sizeMB} MB`, `   🔗 ${makeDownloadUrl(tok)}`, ``);
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

// Ruta de descarga temporal (sin auth, el token es el secreto)
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
    if(msg.method==='initialize') return emit({protocolVersion:'2024-11-05',serverInfo:{name:'kus-devtools',version:'2.4.0'},capabilities:{tools:{}}});
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
  const active=['fetch','download_audio','download_music','search_deezer','download_spotify','search_spotify_track',...Object.keys(bridges)];
  res.type('text').send(`KUS DevTools MCP Gateway v2.4.0\n${'='.repeat(50)}\n\nSSE:  /sse?token=TOKEN\nPOST: /message?sessionId=ID\n\nHerramientas: ${active.join(', ')}\n`);
});
app.get('/health',async(_req,res)=>{
  const tools={};
  for(const[k,b] of Object.entries(bridges)) tools[k]=b.ready?'ready':'starting';
  tools['fetch']='ready';
  tools['download_audio']='ready';
  tools['download_music']=process.env.DEEZER_ARL?'ready':'needs DEEZER_ARL';
  tools['download_spotify']=(process.env.SPOTIFY_CLIENT_ID&&process.env.SPOTIFY_CLIENT_SECRET)?'ready':'needs SPOTIFY secrets';
  tools['search_spotify_track']='ready';
  tools['search_deezer']='ready';
  res.json({status:'ok',tools});
});

app.listen(PORT,'0.0.0.0',()=>{
  console.log(`KUS MCP Gateway v2.4.0 en puerto ${PORT}`);
  console.log('Tools:',['fetch','download_audio','download_music','search_deezer','download_spotify','search_spotify_track',...Object.keys(bridges)].join(', '));
});
