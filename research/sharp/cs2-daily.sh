#!/bin/bash
# CS2 team-specialist skip forward read (docs/charters/cs2-team-specialist-forward.md): discover + crawl recently
# settled CS2 markets into the backfill DB, fetch their full (maker+taker, >= $50) tapes, then write the daily read.
set -e
cd /root/polysharp
export SPORTS=cs2 MIN_VOL=5000 SHARP_DB=/root/polysharp/data/cs2/cs2_2025.db
/root/polyarb/.venv/bin/python backfill.py "$(date -u -d '-3 days' +%F)" "$(date -u +%F)"
/root/polyarb/.venv/bin/python nba_full_tape.py "$SHARP_DB"
/root/polyarb/.venv/bin/python cs2_forward.py "$SHARP_DB"
