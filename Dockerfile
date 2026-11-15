# OrderQR — production image for Dokploy (or any Docker host)
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    TRUST_PROXY=1

WORKDIR /app

# Install deps first for layer caching. `qrcode` is an optionalDependency but
# npm installs it by default, so table QR images work in the image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js ./
COPY public ./public
COPY api ./api

# Persistent store lives on a volume mounted at /app/data (see compose file).
RUN mkdir -p /app/data && chown -R node:node /app

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
