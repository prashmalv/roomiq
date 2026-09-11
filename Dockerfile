# ---------- 1. build the SPA -------------------------------------------------
FROM node:20-alpine AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---------- 2. production dependencies for the API ---------------------------
FROM node:20-alpine AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# ---------- 3. runtime -------------------------------------------------------
FROM node:20-alpine AS run
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY server/package.json ./server/package.json
COPY server/src ./server/src
COPY --from=web /app/web/dist ./web/dist
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/src/index.js"]
