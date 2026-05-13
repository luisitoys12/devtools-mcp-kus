FROM node:20-slim

# Dependencias del sistema para Playwright/Puppeteer + herramientas
RUN apt-get update && apt-get install -y \
    chromium \
    ffmpeg \
    git \
    python3 \
    python3-pip \
    python3-venv \
    wget \
    ca-certificates \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libcairo2 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Crear el directorio que Playwright busca y symlink del browser
RUN mkdir -p /ms-playwright/chromium-1169/chrome-linux \
  && ln -sf /usr/bin/chromium /ms-playwright/chromium-1169/chrome-linux/chrome

# Instalar spotdl en venv aislado para evitar conflictos con pip del sistema
RUN python3 -m venv /opt/spotdl-env \
  && /opt/spotdl-env/bin/pip install --upgrade pip \
  && /opt/spotdl-env/bin/pip install spotdl \
  && /opt/spotdl-env/bin/spotdl --download-ffmpeg || true

# Symlink para llamarlo como "spotdl" desde cualquier path
RUN ln -s /opt/spotdl-env/bin/spotdl /usr/local/bin/spotdl

WORKDIR /app

# Instalar dependencias Node
COPY package.json .
RUN npm install --omit=dev

# Prebuild binario yt-dlp
RUN node -e "require('yt-dlp-exec')"

# Verificar que @playwright/mcp CLI existe
RUN ls ./node_modules/@playwright/mcp/cli.js && echo "playwright/mcp CLI OK"

# Clonar y compilar mcp-claude-spotify
RUN git clone --depth=1 https://github.com/imprvhub/mcp-claude-spotify.git /app/spotify-mcp \
  && cd /app/spotify-mcp \
  && npm install \
  && npm run build

COPY . .

EXPOSE 8080
CMD ["node", "server.js"]
