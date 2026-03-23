#!/bin/bash
set -euo pipefail

# ── Security: refuse to start if secret-like files are present ───────────────
if find /app -maxdepth 4 -type f \( -name ".env*" -o -name "*.key" \) -print -quit 2>/dev/null | grep -q .; then
  echo "[entrypoint] ERROR: Detected secret-like file(s). Remove them before running:" >&2
  find /app -maxdepth 4 -type f \( -name ".env*" -o -name "*.key" \) -print >&2
  exit 1
fi

# ── Validate craft3d build ────────────────────────────────────────────────────
if [ ! -d /app/services/craft3d/node_modules ]; then
  echo "[entrypoint] ERROR: node_modules not found in /app/services/craft3d" >&2
  exit 1
fi

if [ ! -d /app/services/craft3d/dist ]; then
  echo "[entrypoint] ERROR: dist not found in /app/services/craft3d. Did you run the build step?" >&2
  exit 1
fi

# ── Start services ────────────────────────────────────────────────────────────

# 1. LangGraph agents on port 3600 (mandatory)
echo "[entrypoint] Starting LangGraph agents on port 3600..."
cd /app/packages/agents_server
uv run langgraph dev --host 0.0.0.0 --port 3600 --no-browser &
AGENTS_PID=$!

# 2. craft3d on port 3601 (mandatory)
echo "[entrypoint] Starting craft3d on port 3601..."
PORT=3601 node /app/services/craft3d/dist/index.js &
CRAFT3D_PID=$!

echo "[entrypoint] Both services started (agents PID=$AGENTS_PID, craft3d PID=$CRAFT3D_PID)"

# ── Supervise: exit the container if either service goes down ─────────────────
wait -n $AGENTS_PID $CRAFT3D_PID
echo "[entrypoint] A service exited unexpectedly. Shutting down container." >&2
kill $AGENTS_PID $CRAFT3D_PID 2>/dev/null || true
exit 1
