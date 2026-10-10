#!/bin/bash
# DESKTOP daily: refresh a wallet lane's records and ship them to the VPS.  usage: wallet-daily.sh <nhl|soccer>
set -euo pipefail
case "$1" in
  nhl)    SP=nhl;    SPORTS=nhl;                                  DB=nhl_2025.db ;;
  soccer) SP=soccer; SPORTS=epl,lal,bun,sea,fl1,ucl,uel,mls,elc;  DB=soccer_2025.db ;;
  *) echo "unknown $1"; exit 2 ;;
esac
D=$HOME/Documents/Projects/polywhaler-data/$SP
cd "$(dirname "$0")"
export SHARP_DB=$D/$DB REPORT_DIR=$D/reports BOOK_DB=/nonexistent SPORTS MIN_VOL=5000 DISCOVER_ONLY=1
python3 backfill.py "$(date -u -d '-3 days' +%F)" "$(date -u +%F)" > $D/daily_backfill.log 2>&1
python3 fast_tape.py $D/$DB 24 > $D/daily_tape.log 2>&1
SPORT=$SPORTS python3 wallet_records.py $D/$DB $D/${SP}_records.pkl
ssh nl-vps "mkdir -p /root/polysharp/data/$SP"
scp -q $D/${SP}_records.pkl nl-vps:/root/polysharp/data/$SP/${SP}_records.pkl.new
ssh nl-vps "mv /root/polysharp/data/$SP/${SP}_records.pkl.new /root/polysharp/data/$SP/${SP}_records.pkl"
echo "wallet-daily $SP done $(date -u +%FT%TZ)"
