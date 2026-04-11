# ---- Stage 1: Build React client ----
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_N8N_WEBHOOK_URL
ARG VITE_ELEVENLABS_AGENT_ID
RUN npm run build

# ---- Stage 2: Build Node server ----
FROM node:20-alpine AS server-build
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

# ---- Stage 3: Production image ----
FROM node:20-alpine
WORKDIR /app

# Copy server build + production deps only
COPY server/package*.json ./
RUN npm ci --omit=dev

COPY --from=server-build /app/server/dist ./dist

# Copy client build into public directory (served by Express)
COPY --from=client-build /app/client/dist ./public

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
