#!/usr/bin/env bash
# Start `wrangler dev` locally (payments ON, nothing deployed) and probe the routes with curl.
# Verifies that an unpaid POST gets HTTP 402 with a well-formed x402 v2 PAYMENT-REQUIRED header.
# Needs network access to the facilitator (/supported) but no Cloudflare account.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8787}"
BASE="http://127.0.0.1:${PORT}"
LOG="$(mktemp)"
setsid npx wrangler dev --ip 127.0.0.1 --port "$PORT" >"$LOG" 2>&1 &
PID=$!
# kill the whole process group (npx -> wrangler -> workerd)
trap 'kill -- -$PID 2>/dev/null || true; rm -f "$LOG"' EXIT
for _ in $(seq 1 60); do curl -fs "$BASE/health" >/dev/null 2>&1 && break; sleep 1; done

fail=0
for p in / /health /.well-known/x402 /openapi.json /llms.txt; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$p")
  echo "GET $p -> $code"; [ "$code" = 200 ] || fail=1
done

for p in /check/url /check/citation; do
  hdr=$(curl -s -D - -o /dev/null -X POST "$BASE$p" -H 'content-type: application/json' \
        -d '{"url":"https://example.com/","quote":"documentation examples"}')
  code=$(printf '%s' "$hdr" | head -1 | awk '{print $2}')
  pr=$(printf '%s' "$hdr" | tr -d '\r' | awk -F': ' 'tolower($1)=="payment-required"{print $2}')
  echo "POST $p (unpaid) -> $code"
  [ "$code" = 402 ] && [ -n "$pr" ] || { fail=1; continue; }
  PR="$pr" node -e '
    const d = JSON.parse(Buffer.from(process.env.PR, "base64").toString());
    const a = d.accepts[0];
    console.log(JSON.stringify({ x402Version: d.x402Version, resource: d.resource.url, scheme: a.scheme, network: a.network,
      amount: a.amount, asset: a.asset, payTo: a.payTo, bazaar: !!(d.extensions && d.extensions.bazaar) }));
    if (d.x402Version !== 2 || a.scheme !== "exact" || a.network !== "eip155:8453" || !/^0x[0-9a-fA-F]{40}$/.test(a.payTo)) process.exit(1);
  ' || fail=1
done
[ $fail = 0 ] && echo "PROBE OK" || { echo "PROBE FAILED"; tail -40 "$LOG"; exit 1; }
