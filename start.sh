#!/usr/bin/env bash
set -euo pipefail

BOLD=$'\033[1m'
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[0;33m'
NC=$'\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Kill any stale docvault processes (uvicorn or next-server) we left from a
# previous run. Skips unrelated processes sharing the port (e.g. Chrome).
kill_stale_docvault() {
  local port=$1
  local pids
  pids=$(lsof -ti :"$port" 2>/dev/null || true)
  for pid in $pids; do
    local args
    args=$(ps -p "$pid" -o args= 2>/dev/null || true)
    if echo "$args" | grep -qE "(uvicorn|next-server|next dev)"; then
      kill "$pid" 2>/dev/null || true
      echo -e "  ${YELLOW}Killed stale process on :$port (PID $pid)${NC}"
    fi
  done
}

# ── 1. Storage path check ────────────────────────────────────────────────────
# Read DOCVAULT_STORAGE_PATH from backend/.env if present (skip commented lines)
ENV_FILE="$SCRIPT_DIR/backend/.env"
if [ -f "$ENV_FILE" ]; then
  DOCVAULT_STORAGE_PATH=$(grep -E '^DOCVAULT_STORAGE_PATH=' "$ENV_FILE" | cut -d'=' -f2- | tr -d ' ' || true)
fi
DOCVAULT_STORAGE_PATH="${DOCVAULT_STORAGE_PATH:-$HOME/Documents/DocVault}"

if [ ! -d "$DOCVAULT_STORAGE_PATH" ]; then
  echo -e "${RED}${BOLD}Error:${NC} ${RED}Storage directory not found: $DOCVAULT_STORAGE_PATH${NC}"
  echo ""
  echo "Either create the directory:"
  echo "  mkdir -p \"$DOCVAULT_STORAGE_PATH\""
  echo ""
  echo "Or set a different path in backend/.env:"
  echo "  DOCVAULT_STORAGE_PATH=/path/to/your/storage"
  exit 1
fi
if [ ! -w "$DOCVAULT_STORAGE_PATH" ]; then
  echo -e "${RED}${BOLD}Error:${NC} ${RED}Storage directory is not writable: $DOCVAULT_STORAGE_PATH${NC}"
  echo "Fix permissions or set a different path in backend/.env:"
  echo "  DOCVAULT_STORAGE_PATH=/path/to/your/storage"
  exit 1
fi
echo -e "${GREEN}✓ Storage path OK${NC} ($DOCVAULT_STORAGE_PATH)"

# ── 2. Ollama ─────────────────────────────────────────────────────────────────
if ! command -v ollama &>/dev/null; then
  echo -e "${YELLOW}Warning: ollama not found in PATH — skipping (health check will show red)${NC}"
else
  if ! pgrep -x ollama &>/dev/null; then
    echo "Starting Ollama..."
    ollama serve >/tmp/docvault-ollama.log 2>&1 &
    sleep 2
  fi
  echo -e "${GREEN}✓ Ollama running${NC}"

  # Wait for the Ollama HTTP API to be ready before checking models.
  # pgrep only confirms the process exists — the HTTP server may still be starting.
  echo -n "  Waiting for Ollama API"
  OLLAMA_API_READY=false
  for i in $(seq 1 20); do
    if curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
      OLLAMA_API_READY=true
      echo -e " ${GREEN}ready${NC}"
      break
    fi
    echo -n "."
    sleep 1
    if [ "$i" -eq 20 ]; then
      echo -e " ${YELLOW}timed out${NC}"
    fi
  done

  if $OLLAMA_API_READY; then
    OLLAMA_TAGS=$(curl -s http://localhost:11434/api/tags 2>/dev/null)
    if ! echo "$OLLAMA_TAGS" | grep -q '"nomic-embed-text'; then
      echo -e "${YELLOW}  Warning: nomic-embed-text not found. Run: ollama pull nomic-embed-text${NC}"
    fi
    if ! echo "$OLLAMA_TAGS" | grep -q '"llama3.1:8b'; then
      echo -e "${YELLOW}  Warning: llama3.1:8b not found. Run: ollama pull llama3.1:8b${NC}"
    fi
  fi
fi

# ── 3. Backend (FastAPI on :8777) ─────────────────────────────────────────────
kill_stale_docvault 8777
echo "Starting backend..."
cd "$SCRIPT_DIR/backend"
source .venv/bin/activate

# Bind to the Mac's Tailscale IP so the backend is reachable only over the
# tailnet — not on the local LAN or the open internet.
uvicorn main:app --host 100.82.222.43 --port 8777 --log-level debug \
  >/tmp/docvault-backend.log 2>&1 &
BACKEND_PID=$!
echo "$BACKEND_PID" >/tmp/docvault-backend.pid
echo -e "${GREEN}✓ Backend started${NC} (PID $BACKEND_PID — logs: /tmp/docvault-backend.log)"

echo -n "  Waiting for backend"
for i in $(seq 1 15); do
  if curl -s http://127.0.0.1:8777/health >/dev/null 2>&1; then
    echo -e " ${GREEN}ready${NC}"
    break
  fi
  echo -n "."
  sleep 1
  if [ "$i" -eq 15 ]; then
    echo -e " ${RED}timed out${NC}"
    echo "Check /tmp/docvault-backend.log for errors."
  fi
done

# ── 4. Frontend (Next.js) ─────────────────────────────────────────────────────
kill_stale_docvault 3000
echo "Starting frontend..."
cd "$SCRIPT_DIR/frontend"

: >/tmp/docvault-frontend.log   # truncate so we read fresh output below
npm run dev >/tmp/docvault-frontend.log 2>&1 &
FRONTEND_PID=$!
echo "$FRONTEND_PID" >/tmp/docvault-frontend.pid
echo -e "${GREEN}✓ Frontend started${NC} (PID $FRONTEND_PID — logs: /tmp/docvault-frontend.log)"

# Wait for Next.js to log "Ready" (handles port bumping automatically)
echo -n "  Waiting for frontend"
FRONTEND_URL=""
for i in $(seq 1 30); do
  if grep -q "Ready in" /tmp/docvault-frontend.log 2>/dev/null; then
    # Extract the URL Next.js actually chose (handles port bumps like :3001)
    FRONTEND_URL=$(grep -oE 'http://localhost:[0-9]+' /tmp/docvault-frontend.log | head -1)
    echo -e " ${GREEN}ready${NC}"
    break
  fi
  echo -n "."
  sleep 1
  if [ "$i" -eq 30 ]; then
    echo -e " ${YELLOW}timed out — check /tmp/docvault-frontend.log${NC}"
    FRONTEND_URL="http://localhost:3777"
  fi
done

FRONTEND_URL="${FRONTEND_URL:-http://localhost:3777}"

echo ""
echo -e "${BOLD}DocVault is running${NC}"
echo -e "  Frontend  →  $FRONTEND_URL"
echo -e "  Backend   →  http://localhost:8777"
echo -e "  Logs      →  /tmp/docvault-*.log"
echo ""
echo -e "Run ${BOLD}./stop.sh${NC} to shut down."
