# ---- Stage 1: Install all deps + build everything ----
FROM node:20-alpine AS build
WORKDIR /app

# Copy workspace root package files (lock file is here)
COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/

RUN npm ci

# Copy source code
COPY client/ ./client/
COPY server/ ./server/

# Build client (needs VITE_ env vars at build time)
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_N8N_WEBHOOK_URL
ARG VITE_ELEVENLABS_AGENT_ID
RUN npm -w client run build

# Build server
RUN npm -w server run build

# ---- Stage 2: Production image ----
FROM node:20-alpine
WORKDIR /app

# Copy workspace root package files for production install
COPY package.json package-lock.json ./
COPY server/package.json ./server/

# Install production deps only (workspace-aware)
RUN npm ci --omit=dev --workspace=server

# Copy server build output
COPY --from=build /app/server/dist ./dist

# Copy client build into public directory (served by Express)
COPY --from=build /app/client/dist ./public

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
