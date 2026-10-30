#!/bin/bash
set -e
cd /home/greg-czaplicki/Documents/Projects/polywhaler/research/sharp
D=/home/greg-czaplicki/Documents/Projects/polywhaler-data/ncaab
export SPORTS=cbb MIN_VOL=5000 SHARP_DB=$D/ncaab_2025.db REPORT_DIR=/home/greg-czaplicki/Documents/Projects/polywhaler-data/reports BOOK_DB=/nonexistent DISCOVER_ONLY=1
python3 backfill.py 2025-11-01 2026-04-10 > $D/backfill.log 2>&1
python3 fast_tape.py $D/ncaab_2025.db 24 > $D/full_tape.log 2>&1
echo FETCH DONE >> $D/full_tape.log
