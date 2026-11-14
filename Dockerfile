FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV WRANGLER_SEND_METRICS=false CLOUDFLARE_CF_FETCH_ENABLED=false
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
# Trial-reel generator: its own small package (canvas with prebuilt Linux binaries).
COPY reels/package.json reels/package-lock.json ./reels/
RUN cd reels && npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production WRANGLER_SEND_METRICS=false CLOUDFLARE_CF_FETCH_ENABLED=false
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /data /internal && chown node:node /data /internal
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --chown=node:node docker ./docker
COPY --from=build --chown=node:node /app/reels ./reels
USER node
EXPOSE 3100 3102
CMD ["node", "docker/start.mjs"]
