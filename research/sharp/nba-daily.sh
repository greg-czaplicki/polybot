#!/bin/bash
# DESKTOP daily (moved off the VPS 2026-10-09): keep NBA wallet records current for the nba_totals_fade lane.
# Discover recently settled NBA markets into the desktop backfill DB, fetch their full tapes (fast_tape.py),
# rebuild the records pickle and ship it to the VPS, where nba_fade_live.py loads it.
set -euo pipefail
D=${NBA_DATA:-$HOME/Documents/Projects/polywhaler-data/nba}
cd "$(dirname "$0")"
export SPORTS=nba SHARP_DB=$D/nba_2025.db REPORT_DIR=$D BOOK_DB=/nonexistent DISCOVER_ONLY=1
python3 backfill.py "$(date -u -d '-3 days' +%F)" "$(date -u +%F)" > $D/daily_backfill.log 2>&1
python3 fast_tape.py $D/nba_2025.db 24 > $D/daily_tape.log 2>&1
python3 nba_fade_live.py --build-records $D/nba_2025.db $D/records.pkl
scp -q $D/records.pkl nl-vps:/root/polysharp/data/nba/records.pkl.new
ssh nl-vps 'mv /root/polysharp/data/nba/records.pkl.new /root/polysharp/data/nba/records.pkl'
echo "nba-daily done $(date -u +%FT%TZ)"
