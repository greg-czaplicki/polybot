#!/bin/bash
set -euo pipefail
URL_FILE="$HOME/.cloudflared/latest-tunnel-url.txt"
if [ ! -s "$URL_FILE" ]; then
  echo "Tunnel URL file is missing or empty." >&2
  exit 1
fi
URL="$(cat "$URL_FILE")"
echo "$URL" | npx wrangler secret put BOT_CONTROL_URL --name tanstack-start-app --env=""
pnpm run deploy
