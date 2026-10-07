#!/bin/bash
# Keep NBA wallet records current for the fade lane: discover + crawl recently settled NBA markets into the
# backfill DB, then fetch their full (maker+taker, >= $50) tapes. Idempotent.
set -e
cd /root/polysharp
export SPORTS=nba SHARP_DB=/root/polysharp/data/nba/nba_2025.db
/root/polyarb/.venv/bin/python backfill.py "$(date -u -d '-3 days' +%F)" "$(date -u +%F)"
/root/polyarb/.venv/bin/python nba_full_tape.py
