# 🚀 KUS DevTools MCP Gateway

> Gateway MCP multi-herramienta 100% en la nube para los desarrolladores de **Cush Media**.
> Compatible con Claude Code, Cursor, Windsurf, n8n, VS Code.

## Herramientas disponibles

| Tool | Ruta SSE | Descripcion |
|---|---|---|
| 🎭 Playwright | `/playwright/sse` | Browser automation, scraping, capturas, PDFs, tests E2E |
| 🌐 Fetch | `/fetch/sse` | HTTP requests, leer APIs, descargar paginas |
| 🧠 Memory | `/memory/sse` | Memoria persistente en sesion para el agente |
| 📚 Context7 | `/context7/sse` | Docs actualizadas de cualquier libreria (React, Next.js, Fly.io...) |
| 🔥 Firecrawl | `/firecrawl/sse` | Web scraping avanzado con Markdown limpio (requiere API key) |
| 📦 NPM Docs | `/npmdocs/sse` | Documentacion de paquetes npm en tiempo real |

## Config para devs (2 minutos)

### Claude Code / Desktop
```json
{
  "mcpServers": {
    "kus-playwright": { "url": "https://devtools-mcp-kus.fly.dev/playwright/sse?token=TU_TOKEN", "transport": "sse" },
    "kus-fetch":      { "url": "https://devtools-mcp-kus.fly.dev/fetch/sse?token=TU_TOKEN",      "transport": "sse" },
    "kus-memory":     { "url": "https://devtools-mcp-kus.fly.dev/memory/sse?token=TU_TOKEN",     "transport": "sse" },
    "kus-context7":   { "url": "https://devtools-mcp-kus.fly.dev/context7/sse?token=TU_TOKEN",   "transport": "sse" },
    "kus-firecrawl":  { "url": "https://devtools-mcp-kus.fly.dev/firecrawl/sse?token=TU_TOKEN",  "transport": "sse" },
    "kus-npmdocs":    { "url": "https://devtools-mcp-kus.fly.dev/npmdocs/sse?token=TU_TOKEN",    "transport": "sse" }
  }
}
```

### Cursor / Windsurf / VS Code
Mismo JSON, guardar en `.cursor/mcp.json` o `.windsurf/mcp.json`

### n8n
- Nodo MCP Client → Transport: SSE
- URL: `https://devtools-mcp-kus.fly.dev/playwright/sse?token=TU_TOKEN`

## Activar Firecrawl
```bash
fly secrets set FIRECRAWL_API_KEY=tu_api_key --app devtools-mcp-kus
fly deploy --app devtools-mcp-kus
```
API key gratis en: https://firecrawl.dev

## Arquitectura

```
Cliente MCP (Claude/Cursor/n8n)
    |
    | HTTPS + Bearer Token
    v
Express Gateway (:8080)
    |
    |-- /playwright/* --> @playwright/mcp    (:8931)
    |-- /fetch/*      --> server-fetch       (:8932)
    |-- /memory/*     --> server-memory      (:8933)
    |-- /context7/*   --> context7-mcp       (:8934)
    |-- /firecrawl/*  --> firecrawl-mcp      (:8935)
    |-- /npmdocs/*    --> npm-package-docs   (:8936)
```

---
Hecho con ❤️ por **Cush Media** — Irapuato, Guanajuato 🇲🇽
