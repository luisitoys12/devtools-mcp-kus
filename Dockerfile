FROM node:20-slim

# Dependencias del sistema: ffmpeg para audio, git para clonar repos, python3/wget para yt-dlp
RUN apt-get update && apt-get install -y \
    chromium \
    ffmpeg \
    git \
    python3 \
    wget \
    ca-certificates \
    --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Instalar dependencias Node
COPY package.json .
RUN npm install --omit=dev

# Clonar y compilar mcp-claude-spotify (no esta en npm)
RUN git clone --depth=1 https://github.com/imprvhub/mcp-claude-spotify.git /app/spotify-mcp \
  && cd /app/spotify-mcp \
  && npm install \
  && npm run build

# Forzar descarga del binario yt-dlp al momento del build
RUN node -e "require('yt-dlp-exec')"

COPY . .

EXPOSE 8080
CMD ["node", "server.js"]
