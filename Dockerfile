FROM node:20-slim AS builder
WORKDIR /app

# Build tools needed for native modules (onnxruntime-node, canvas, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ curl \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# ── Final image ─────────────────────────────────────────────
FROM node:20-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app .
RUN mkdir -p models/.cache models/whisper

EXPOSE 10000

# Health check uses $PORT via shell form so it works on both Render (10000) and local (3002)
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD curl -f http://localhost:${PORT:-10000}/health || exit 1

CMD ["node", "server.js"]
