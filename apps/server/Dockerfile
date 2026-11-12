FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN npm ci
COPY apps/server apps/server
COPY apps/web apps/web
COPY wordpress-plugin wordpress-plugin
RUN npm run build -w @botwa/server && npm run build -w @botwa/web

FROM node:22-slim
ENV NODE_ENV=production
# pg_dump (must match the server major version: postgres:16) for in-app encrypted backups. NOT built/tested in CI here.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-16 ffmpeg \
 && apt-get purge -y curl gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN npm ci --omit=dev -w @botwa/server && npm cache clean --force
# Optional "meaning" search runtime (~0.5 GB with the model runtime). Build with WITH_SEMANTIC=1 and set SEMANTIC_SEARCH=local.
ARG WITH_SEMANTIC=0
RUN if [ "$WITH_SEMANTIC" = "1" ]; then npm i --no-save --omit=dev @huggingface/transformers@4.3.2 -w @botwa/server && npm cache clean --force; fi
# Optional headless browser (~0.4 GB) for pages built by JavaScript. Used by the separate "browser" service (docker compose --profile browser),
# or in-process with BROWSER=local. Build with WITH_BROWSER=1.
ARG WITH_BROWSER=0
RUN if [ "$WITH_BROWSER" = "1" ]; then apt-get update && apt-get install -y --no-install-recommends chromium fonts-freefont-ttf && rm -rf /var/lib/apt/lists/*; fi
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
RUN mkdir -p /data/media /data/backups /data/models && chown -R node:node /data
USER node
WORKDIR /app/apps/server
EXPOSE 3000
CMD ["node", "dist/server.js"]
