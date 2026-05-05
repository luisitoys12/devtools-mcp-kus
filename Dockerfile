FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

RUN npm init -y && npm install \
    @playwright/mcp@latest \
    express

RUN npx playwright install chromium
RUN npx playwright install-deps chromium

COPY server.js .

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:8080/ || exit 1

CMD ["node", "server.js"]
