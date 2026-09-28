# ——— Frontend: build statica con Vite ———
FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json ./
COPY public public
COPY src src
# Il frontend non ha configurazione: login e Keycloak sono tutti nel server (.env).
RUN npm run build

# ——— Server: API + SQLite, serve anche il frontend ———
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server/src src
COPY --from=web /app/dist /app/dist
RUN mkdir -p /data && chown node:node /data
USER node
ENV PORT=8080 DB_PATH=/data/fig.db STATIC_DIR=/app/dist PUBLIC_URL=https://fig.vlabstudio.net
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/index.ts"]
