#!/bin/bash
# DESKTOP daily (era v21): keep CFB wallet records current for the cfb_hot_follow lane and ship them to the VPS.
# Discover recently settled CFB markets, fetch their full tapes (fast_tape.py), rebuild records, scp the pickle.
set -euo pipefail
D=${CFB_DATA:-$HOME/Documents/Projects/polywhaler-data/ncaaf}
cd "$(dirname "$0")"
export SHARP_DB=$D/ncaaf_2025.db REPORT_DIR=$D/reports BOOK_DB=/nonexistent SPORTS=cfb MIN_VOL=5000 DISCOVER_ONLY=1
python3 backfill.py "$(date -u -d '-4 days' +%F)" "$(date -u +%F)" > $D/daily_backfill.log 2>&1
python3 fast_tape.py $D/ncaaf_2025.db 24 > $D/daily_tape.log 2>&1
python3 cfb_records.py $D/ncaaf_2025.db $D/cfb_records.pkl
scp -q $D/cfb_records.pkl nl-vps:/root/polysharp/data/cfb/cfb_records.pkl.new
ssh nl-vps 'mv /root/polysharp/data/cfb/cfb_records.pkl.new /root/polysharp/data/cfb/cfb_records.pkl'
echo "cfb-daily done $(date -u +%FT%TZ)"
