# 🚀 KUS DevTools MCP Server

> Servidor MCP remoto 100% en la nube para los desarrolladores de **Cush Media**.
> Compatible con Claude Code, Cursor, Windsurf, n8n, VS Code.

## Herramientas disponibles

| Tool | Descripcion |
|---|---|
| 🎭 Playwright | Browser automation, scraping, capturas, PDFs, tests E2E |
| 📸 Screenshots | Capturas de paginas completas |
| 🔍 Network | Inspeccionar peticiones de red |
| ⚡ JavaScript | Ejecutar JS en el navegador |

## Setup para devs (2 minutos)

### 1. Claude Code
```bash
cp configs/claude-code.json ~/.claude/claude_desktop_config.json
# Editar y poner token real
```

### 2. Cursor / Windsurf
```bash
cp configs/cursor-windsurf.json .cursor/mcp.json
```

### 3. VS Code + Copilot
```bash
cp configs/vscode.json .vscode/mcp.json
```

### 4. n8n
- Nodo MCP Client → Transport: SSE
- URL: `https://devtools-mcp-kus.fly.dev/sse?token=TU_TOKEN`

## Deploy propio

```bash
git clone https://github.com/luisitoys12/devtools-mcp-kus.git
cd devtools-mcp-kus
fly launch --name mi-devtools-mcp
fly secrets set MCP_AUTH_TOKEN=mi_token_secreto
fly deploy
```

## Arquitectura

```
Cliente MCP
    |
    | HTTPS + Bearer Token
    v
Express Auth Layer (:8080)
    |
    | HTTP interno sin Origin header
    v
@playwright/mcp (localhost:8931)
    |
    v
Chromium headless en Fly.io
```

---
Hecho con ❤️ por **Cush Media** — Irapuato, Guanajuato 🇲🇽
