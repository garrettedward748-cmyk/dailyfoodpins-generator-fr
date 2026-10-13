# Article Platform — single container, no native compilation.
#
# node:sqlite is built into Node 24, so there is no better-sqlite3 build step
# and no C++ toolchain needed. That is what makes this image work identically
# on every VPS without anyone debugging a compiler error.

FROM node:24-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json tailwind.config.js ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app

ENV NODE_ENV=production
RUN apk add --no-cache tini wget ffmpeg fontconfig font-dejavu && \
    mkdir -p /app/data && chown -R node:node /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node prompts ./prompts
COPY --chown=node:node package.json ./

USER node
EXPOSE 8080
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:8080/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
