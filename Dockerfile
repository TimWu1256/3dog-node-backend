# syntax=docker/dockerfile:1

# ── Stage 1: Build craft3d ────────────────────────────────────────────────────
FROM node:24.13.0-bookworm-slim AS node-build
WORKDIR /build

COPY services/craft3d/package*.json ./
RUN npm ci --ignore-scripts

COPY services/craft3d/ .
RUN npm run build


# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:24.13.0-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY services/craft3d/package*.json ./

# postinstall runs "playwright install --with-deps chromium"
RUN npm ci --omit=dev

COPY --from=node-build /build/dist ./dist

EXPOSE 3601

CMD ["node", "dist/index.js"]
