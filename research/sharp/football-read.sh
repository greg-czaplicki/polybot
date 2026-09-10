#!/bin/bash
# Weekly per-sport read (Mondays 12:00 UTC on the VPS): fetch the app's per-sport read for every tracked sport and file it.
set -e
mkdir -p /root/polysharp/data/reports
OUT=/root/polysharp/data/reports/football-$(date -u +%F).txt
BASE=$(grep -oE "^BOT_BASE_URL=.*" /root/polybot/.env | cut -d= -f2-)
{
  echo "football weekly read $(date -u)"
  for S in nfl ncaaf epl laliga seriea bundesliga ligue1 mls ucl atp wta mlb; do
    echo; curl -s "$BASE/api/sport-edge?sport=$S&format=text"; echo
  done
  echo; echo "### polysharp per-sport event signals (rule A / B), from today's daily report"
  grep -E "^\s+(A|B) (nfl|ncaaf)|A_first_primary|B_max_money" /root/polysharp/data/reports/$(date -u +%F).txt 2>/dev/null || echo "(daily report not yet written today)"
} > "$OUT" 2>&1
cat "$OUT"
