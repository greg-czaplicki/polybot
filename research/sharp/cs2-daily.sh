#!/bin/bash
# DESKTOP daily (moved off the VPS 2026-10-09): CS2 team-specialist skip forward read
# (docs/charters/cs2-team-specialist-forward.md). Discover recently settled CS2 markets into the desktop
# backfill DB, fetch their full (maker+taker, >= $50) tapes (fast_tape.py), then write the daily read
# to ~/Documents/Projects/polywhaler-data/reports/cs2_forward_<date>.txt.
set -euo pipefail
P=${POLY_DATA:-$HOME/Documents/Projects/polywhaler-data}
cd "$(dirname "$0")"
export SPORTS=cs2 MIN_VOL=5000 SHARP_DB=$P/cs2/cs2_2025.db REPORT_DIR=$P/reports BOOK_DB=/nonexistent DISCOVER_ONLY=1
python3 backfill.py "$(date -u -d '-3 days' +%F)" "$(date -u +%F)" > $P/cs2/daily_backfill.log 2>&1
python3 fast_tape.py "$SHARP_DB" 24 > $P/cs2/daily_tape.log 2>&1
python3 cs2_forward.py "$SHARP_DB"
