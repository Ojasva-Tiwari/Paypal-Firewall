# syntax=docker/dockerfile:1

# ==============================================================================
# Stage 1: Production dependencies (compiled with build tools if native fallback needed)
# ==============================================================================
FROM node:24-bookworm-slim AS prod-deps

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ==============================================================================
# Stage 2: Full build stage (compiles backend TS + frontend Vite bundle)
# ==============================================================================
FROM node:24-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force

COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY demo ./demo
COPY web ./web

RUN npm run build

# ==============================================================================
# Stage 3: Minimal non-root production runtime
# ==============================================================================
FROM node:24-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/payguard.db

# Dedicated non-root runtime user and SQLite persistence directory
RUN groupadd --system --gid 1001 payguard \
  && useradd --system --uid 1001 --gid payguard --home-dir /app --shell /usr/sbin/nologin payguard \
  && mkdir -p /app/data \
  && chown -R payguard:payguard /app

# Runtime package manifest (required for "type": "module"), prod deps, and compiled outputs only
COPY --chown=payguard:payguard package.json ./
COPY --chown=payguard:payguard --from=prod-deps /app/node_modules ./node_modules
COPY --chown=payguard:payguard --from=builder /app/dist/src ./dist/src
COPY --chown=payguard:payguard --from=builder /app/dist/demo ./dist/demo
COPY --chown=payguard:payguard --from=builder /app/dist/web ./dist/web

VOLUME ["/app/data"]

EXPOSE 3000

USER payguard

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const p=process.env.PORT||3000;fetch('http://127.0.0.1:'+p+'/healthz').then((r)=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/src/server.js"]

