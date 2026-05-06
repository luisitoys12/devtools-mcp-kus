FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

# Instalar dependencias del sistema
RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Instalar todos los MCP servers y dependencias
RUN npm init -y && npm install \
    @playwright/mcp@latest \
    @modelcontextprotocol/server-fetch@latest \
    @modelcontextprotocol/server-memory@latest \
    @upstash/context7-mcp@latest \
    firecrawl-mcp@latest \
    npm-package-docs-mcp@latest \
    express \
    node-fetch

# Instalar Chromium para Playwright
RUN npx playwright install chromium
RUN npx playwright install-deps chromium

COPY server.js .

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:8080/ || exit 1

CMD ["node", "server.js"]
