#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

stop_service() {
  local name="$1"
  local pid_file="$2"

  if [ ! -f "$pid_file" ]; then
    echo -e "${YELLOW}$name:${NC} not running (no PID file at $pid_file)"
    return
  fi

  local pid
  pid=$(cat "$pid_file")

  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    # Give the process up to 5s to exit cleanly
    for i in $(seq 1 5); do
      if ! kill -0 "$pid" 2>/dev/null; then break; fi
      sleep 1
    done
    # Force-kill if still alive
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    echo -e "${GREEN}✓ $name stopped${NC} (PID $pid)"
  else
    echo -e "${YELLOW}$name:${NC} process $pid was already gone"
  fi

  rm -f "$pid_file"
}

stop_service "Frontend" /tmp/docvault-frontend.pid
stop_service "Backend"  /tmp/docvault-backend.pid

echo ""
echo "DocVault stopped."
