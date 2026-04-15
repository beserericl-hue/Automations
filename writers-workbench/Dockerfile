# ---- Stage 1: Install all deps + build everything ----
FROM node:20-alpine AS build
WORKDIR /app

# Copy workspace root package files (lock file lives here)
COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/

RUN npm ci

# Copy source code
COPY client/ ./client/
COPY server/ ./server/

# Build client — VITE_ vars must be ARG + ENV so Vite sees them at build time
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_N8N_WEBHOOK_URL
ARG VITE_ELEVENLABS_AGENT_ID
ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL}
ENV VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY}
ENV VITE_N8N_WEBHOOK_URL=${VITE_N8N_WEBHOOK_URL}
ENV VITE_ELEVENLABS_AGENT_ID=${VITE_ELEVENLABS_AGENT_ID}

WORKDIR /app/client
RUN echo "=== DEBUG: pwd ===" && pwd && \
    echo "=== DEBUG: ls -la ===" && ls -la && \
    echo "=== DEBUG: cat vite.config.ts ===" && cat vite.config.ts && \
    echo "=== DEBUG: index.html exists? ===" && ls -la index.html && \
    echo "=== DEBUG: starting build ===" && npm run build

# Build server
WORKDIR /app/server
RUN npm run build

WORKDIR /app

# ---- Stage 2: Production deps only ----
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/

RUN npm ci --omit=dev

# ---- Stage 3: Production image ----
FROM node:20-alpine
WORKDIR /app

# Production node_modules (hoisted at root)
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./

# Server compiled output
COPY --from=build /app/server/dist ./dist

# Client build (served as static files by Express)
COPY --from=build /app/client/dist ./public

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
