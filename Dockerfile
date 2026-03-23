# syntax=docker/dockerfile:1

# ── Stage 1: Build craft3d (Node.js) ─────────────────────────────────────────
FROM node:24.13.0-bookworm-slim AS node-build
WORKDIR /build/services/craft3d

# Copy manifests and install all deps (skip postinstall to avoid downloading Chromium in build stage)
COPY services/craft3d/package*.json ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY services/craft3d/ .
RUN npm run build


# ── Stage 2: Runtime (Python 3.13 + Node.js 24) ──────────────────────────────
FROM python:3.13-slim-bookworm AS runtime

# Install Node.js 24 LTS
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── craft3d (Node.js service on port 3601) ────────────────────────────────────
ENV NODE_ENV=production

WORKDIR /app/services/craft3d
COPY services/craft3d/package*.json ./

# Install prod deps; postinstall runs "playwright install --with-deps chromium"
RUN npm ci --omit=dev

# Copy compiled output from build stage (includes SQL files, browser assets via build:assets)
COPY --from=node-build /build/services/craft3d/dist ./dist

# ── agents (Python/LangGraph service on port 3600) ────────────────────────────
# Install uv and langgraph-cli
RUN pip install --no-cache-dir uv

# Make /app/packages importable so `import agents` resolves to /app/packages/agents/
ENV PYTHONPATH=/app/packages

WORKDIR /app/packages/agents
COPY packages/agents/pyproject.toml packages/agents/uv.lock ./

# Install Python dependencies into the project venv
RUN uv sync --frozen --no-dev

# Install langgraph-cli into the same venv so "uv run langgraph" works
RUN uv pip install "langgraph-cli[inmem]"

# Copy agent source (graphs, instructions, etc.)
COPY packages/agents/ ./

# ── Entrypoint ────────────────────────────────────────────────────────────────
COPY bin/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3600 3601

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
