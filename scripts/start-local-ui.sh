#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

HOST="${HERMES_UI_HOST:-127.0.0.1}"
PORT="${HERMES_UI_PORT:-8787}"
URL="http://${HOST}:${PORT}"

echo "Building Approved Mind Mirror local UI..."
npm run build

echo "Starting Approved Mind Mirror Local Web Chat at ${URL}"
echo "Local-only. Press Control-C in this terminal to stop the server."

if command -v open >/dev/null 2>&1; then
  (sleep 1 && open "$URL" >/dev/null 2>&1 || true) &
fi

node dist/ui.js
