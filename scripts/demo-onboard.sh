#!/usr/bin/env bash
# Drive the Merchant Factory end to end: POST /merchants, then poll the job
# and stream its progress events until it finishes. Requires curl + jq.
#
# Usage:
#   ONBOARD_ADMIN_KEY=... scripts/demo-onboard.sh https://some-store.example [nickname]
#
# Env:
#   BASE_URL           API base (default http://localhost:3000)
#   ONBOARD_ADMIN_KEY  must match the server's ONBOARD_ADMIN_KEY (required)
set -euo pipefail

BASE="${BASE_URL:-http://localhost:3000}"
KEY="${ONBOARD_ADMIN_KEY:?set ONBOARD_ADMIN_KEY to the server admin key}"
URL="${1:?usage: demo-onboard.sh <https-store-url> [nickname]}"
NICK="${2:-}"

body=$(jq -n --arg url "$URL" --arg nick "$NICK" \
  '{url: $url} + (if $nick != "" then {nickname: $nick} else {} end)')

echo "==> POST $BASE/admin/merchants (admin bypass)"
job=$(curl -sS -X POST "$BASE/admin/merchants" \
  -H 'content-type: application/json' \
  -H "x-admin-key: $KEY" \
  -d "$body")
echo "$job" | jq .

job_id=$(echo "$job" | jq -r '.job_id // empty')
if [ -z "$job_id" ]; then
  echo "!! onboarding request was rejected" >&2
  exit 1
fi

echo "==> Polling $BASE/merchants/jobs/$job_id"
since=0
while :; do
  resp=$(curl -sS "$BASE/merchants/jobs/$job_id?since=$since")
  echo "$resp" | jq -r '.events[] | "  \(.t) [\(.stage)] \(.message)"'
  since=$(echo "$resp" | jq -r '.next_since')
  if [ "$(echo "$resp" | jq -r '.final')" = "true" ]; then
    break
  fi
  sleep 2
done

echo "==> Job finished:"
echo "$resp" | jq '{status, outcome, result}'

echo "==> Onboarded merchants:"
curl -sS "$BASE/merchants" | jq .

echo "==> Live catalog now serves:"
curl -sS "$BASE/products" | jq '[.products[] | {id, price_usd, merchant}]'
