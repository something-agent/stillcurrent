#!/usr/bin/env bash
# Show the unpaid 402 challenge of a running instance, decoded. Usage: scripts/probe_402.sh [base_url]
set -euo pipefail
BASE="${1:-http://127.0.0.1:8402}"
for path in /check/url /check/citation; do
  echo "=== POST $BASE$path (no payment) ==="
  hdrs=$(mktemp)
  body=$(curl -s -D "$hdrs" -X POST "$BASE$path" -H 'content-type: application/json' -d '{"url":"https://example.com","quote":"Example Domain"}')
  head -1 "$hdrs"
  echo "--- body"; echo "$body"
  echo "--- PAYMENT-REQUIRED header (decoded)"
  grep -i '^payment-required:' "$hdrs" | cut -d' ' -f2 | tr -d '\r' | base64 -d | python3 -m json.tool
  rm -f "$hdrs"
done
