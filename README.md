# 🚀 KUS DevTools MCP Gateway

> Gateway MCP multi-herramienta 100% en la nube para los desarrolladores de **Cush Media**.
> Compatible con Claude Code, Cursor, Windsurf, n8n, VS Code, Perplexity.

## Herramientas disponibles

| Tool | Ruta SSE | Descripcion |
|---|---|---|
| 🎭 Playwright | `/playwright/sse` | Browser automation, scraping, capturas, PDFs, tests E2E |
| 🌐 Fetch | `/fetch/sse` | HTTP requests, leer APIs, descargar paginas |
| 🧠 Memory | `/memory/sse` | Memoria persistente en sesion para el agente |
| 📚 Context7 | `/context7/sse` | Docs actualizadas de cualquier libreria (React, Next.js, Fly.io...) |
| 🔥 Firecrawl | `/firecrawl/sse` | Web scraping avanzado con Markdown limpio (requiere API key) |
| 📦 NPM Docs | `/npmdocs/sse` | Documentacion de paquetes npm en tiempo real |
| ☁️ Oracle OCI | `/oci/sse` | Gestiona instancias, redes y storage en Oracle Cloud (mx-monterrey-1) |

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
    "kus-npmdocs":    { "url": "https://devtools-mcp-kus.fly.dev/npmdocs/sse?token=TU_TOKEN",    "transport": "sse" },
    "kus-oci":        { "url": "https://devtools-mcp-kus.fly.dev/oci/sse?token=TU_TOKEN",        "transport": "sse" }
  }
}
```

### Cursor / Windsurf / VS Code
Mismo JSON, guardar en `.cursor/mcp.json` o `.windsurf/mcp.json`

### Perplexity (Remote MCP)
> Settings → Connectors → Add Connector → Remote MCP

URL: `https://devtools-mcp-kus.fly.dev/oci/sse?token=TU_TOKEN`

### n8n
- Nodo MCP Client → Transport: SSE
- URL: `https://devtools-mcp-kus.fly.dev/playwright/sse?token=TU_TOKEN`

## Activar Firecrawl
```bash
fly secrets set FIRECRAWL_API_KEY=tu_api_key --app devtools-mcp-kus
fly deploy --app devtools-mcp-kus
```
API key gratis en: https://firecrawl.dev

## Activar Oracle OCI
```bash
# 1. Obtener credenciales desde Oracle Cloud Console → Profile → API Keys
fly secrets set OCI_TENANCY_OCID=ocid1.tenancy.oc1..xxx --app devtools-mcp-kus
fly secrets set OCI_USER_OCID=ocid1.user.oc1..xxx --app devtools-mcp-kus
fly secrets set OCI_FINGERPRINT=xx:xx:xx:xx --app devtools-mcp-kus
fly secrets set OCI_REGION=mx-monterrey-1 --app devtools-mcp-kus
# 2. Subir tu llave privada como secret
cat ~/.oci/oci_api_key.pem | fly secrets set OCI_PRIVATE_KEY=- --app devtools-mcp-kus
# 3. Redeploy
fly deploy --app devtools-mcp-kus
```

## Arquitectura

```
Cliente MCP (Claude/Cursor/n8n/Perplexity)
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
    |-- /oci/*        --> @oracle/mcp (OCI)  (:8937)
```


---

## 🔐 Configurar Oracle OCI — Paso a paso

### 1. Crear el API Key en la Consola OCI

1. Entra a [cloud.oracle.com](https://cloud.oracle.com) con tu cuenta
2. Clic en el ícono de **Profile** (arriba derecha) → **User settings**
3. En el menú lateral → **API Keys** → **Add API Key**
4. Deja marcado **"Generate API key pair"**
5. Haz clic en **Download private key** → guarda el archivo `.pem` en un lugar seguro
6. Clic en **Add** — Oracle muestra el **Configuration File Preview**

### 2. Copiar tus credenciales del Configuration File Preview

Oracle te muestra algo así:

```ini
[DEFAULT]
user=ocid1.user.oc1..aaaaaXXXXX
fingerprint=aa:bb:cc:dd:ee:ff:11:22:33:44:55:66:77:88:99:00
tenancy=ocid1.tenancy.oc1..aaaaaXXXXX
region=mx-monterrey-1
key_file=~/.oci/oci_api_key.pem
```

Guarda todos esos valores — los necesitas en el paso siguiente.

### 3. Registrar los secrets en Fly.io

```bash
fly secrets set OCI_TENANCY_OCID="ocid1.tenancy.oc1..xxx" --app devtools-mcp-kus
fly secrets set OCI_USER_OCID="ocid1.user.oc1..xxx"       --app devtools-mcp-kus
fly secrets set OCI_FINGERPRINT="aa:bb:cc:dd:ee:ff:..."  --app devtools-mcp-kus
fly secrets set OCI_REGION="mx-monterrey-1"               --app devtools-mcp-kus

# La llave privada (contenido completo del .pem):
cat ~/Downloads/oci_api_key.pem | fly secrets set OCI_PRIVATE_KEY=- --app devtools-mcp-kus
```

### 4. Verificar que los secrets están activos

```bash
fly secrets list --app devtools-mcp-kus
# Deben aparecer: OCI_TENANCY_OCID, OCI_USER_OCID, OCI_FINGERPRINT, OCI_REGION, OCI_PRIVATE_KEY
```

### 5. Redeploy para que tome los nuevos secrets

```bash
fly deploy --app devtools-mcp-kus
```

Una vez desplegado, el endpoint OCI estará disponible en:
```
https://devtools-mcp-kus.fly.dev/oci/sse
```

> ⚠️ **Importante:** No subas el archivo `.pem` a GitHub. Solo va a Fly.io como secret.

---

## 📻 MCPs Ideales para Radio Online (Runaradio / Estacionkusmedios)

Estos MCP Servers se integran perfectamente con un proyecto de radio online:

| MCP Server | Caso de uso en radio | Endpoint sugerido |
|---|---|---|
| **AzuraCast REST API** | Control total: playlist, now-playing, requests, arrancar/parar estaciones | `/azuracast/*` → `:8938` |
| **ElevenLabs** | Generación de voz para jingles, locución IA, IDs de estación | ya disponible en Composio |
| **Firecrawl** | Scraping de noticias locales Irapuato para leer al aire | `/firecrawl/*` → `:8935` |
| **YouTube MCP** | Publicar grabaciones de programas, clips de entrevistas | ya disponible en Composio |
| **Google Calendar** | Programación de shows, recordatorios de transmisión en vivo | ya disponible en Composio |
| **Notion** | Guiones de programas, bitácora de emisión, directorio de locutores | ya disponible en Composio |
| **n8n / Zapier webhook** | Automatización: cuando termina un bloque → postear en Instagram | custom route |

### AzuraCast MCP — El más valioso para radio

AzuraCast expone una **REST API completa** que puedes proxear como MCP server:

```bash
# Datos en tiempo real de la estación:
GET https://tu-azuracast.com/api/nowplaying/runaradio

# Controlar playlist desde IA:
POST https://tu-azuracast.com/api/station/runaradio/playlist/{id}/toggle

# Historial de canciones:
GET https://tu-azuracast.com/api/station/runaradio/history
```

Se puede envolver en un MCP server ligero con `@modelcontextprotocol/sdk` y agregarlo
al gateway de `devtools-mcp-kus` en el puerto `:8938`.

---
Hecho con ❤️ por **Cush Media** — Irapuato, Guanajuato 🇲🇽
