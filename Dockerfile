FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

RUN apt-get update && apt-get install -y curl git && rm -rf /var/lib/apt/lists/*

# Dependencias principales del gateway
COPY package.json .
RUN npm install

# Instalar Playwright + Chromium
RUN npx playwright install chromium
RUN npx playwright install-deps chromium

# Clonar e instalar mcp-claude-spotify (no está publicado en npm)
# Repo: https://github.com/imprvhub/mcp-claude-spotify
RUN git clone --depth=1 https://github.com/imprvhub/mcp-claude-spotify.git /app/spotify-mcp \
  && cd /app/spotify-mcp \
  && npm install \
  && npm run build

COPY server.js .

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

CMD ["node", "server.js"]
