#!/bin/bash
# DESKTOP daily (era v22): keep NFL wallet records current for the nfl_wallet_follow lane and ship them to the VPS.
set -euo pipefail
D=${NFL_DATA:-$HOME/Documents/Projects/polywhaler-data/nfl}
cd "$(dirname "$0")"
export SHARP_DB=$D/nfl_2025.db REPORT_DIR=$D/reports BOOK_DB=/nonexistent SPORTS=nfl MIN_VOL=5000 DISCOVER_ONLY=1
python3 backfill.py "$(date -u -d '-4 days' +%F)" "$(date -u +%F)" > $D/daily_backfill.log 2>&1
python3 fast_tape.py $D/nfl_2025.db 24 > $D/daily_tape.log 2>&1
SPORT=nfl python3 wallet_records.py $D/nfl_2025.db $D/nfl_records.pkl
scp -q $D/nfl_records.pkl nl-vps:/root/polysharp/data/nfl/nfl_records.pkl.new
ssh nl-vps 'mv /root/polysharp/data/nfl/nfl_records.pkl.new /root/polysharp/data/nfl/nfl_records.pkl'
echo "nfl-daily done $(date -u +%FT%TZ)"
