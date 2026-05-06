FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Solo instalar los paquetes MCP que existen en npm
RUN npm init -y && npm install \
    @playwright/mcp@latest \
    @modelcontextprotocol/sdk@latest \
    @modelcontextprotocol/server-fetch@latest \
    @modelcontextprotocol/server-memory@latest \
    @upstash/context7-mcp@latest \
    firecrawl-mcp@latest \
    express \
    eventsource

RUN npx playwright install chromium
RUN npx playwright install-deps chromium

COPY server.js .

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

CMD ["node", "server.js"]
