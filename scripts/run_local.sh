#!/usr/bin/env bash
# Usage: scripts/run_local.sh [paid|test] [port]
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${1:-paid}"; PORT="${2:-8402}"
[ -d .venv ] || { python3 -m venv .venv && .venv/bin/pip install -r requirements.lock; }
if [ "$MODE" = test ]; then export X402_DISABLED=1; echo "TEST MODE: payment gate OFF (bind 127.0.0.1 only)"; fi
exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port "$PORT"
