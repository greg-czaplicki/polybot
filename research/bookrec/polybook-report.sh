#!/bin/bash
# Daily paper market-maker report on the last 24h of recorded pregame books.
set -e
mkdir -p /root/polybook/data/reports
SINCE=$(( $(date +%s) - 86400 ))
OUT=/root/polybook/data/reports/$(date -u +%F).txt
{
  echo "polybook paper-MM report $(date -u) — markets with game_start in the last 24h"
  for Q in 20 50; do
    echo; echo "### QUOTE_USD=$Q INV_CAP_USD=$((Q*3))"
    QUOTE_USD=$Q INV_CAP_USD=$((Q*3)) /root/polyarb/.venv/bin/python /root/polybook/paper_mm.py /root/polybook/data/polybook.db $SINCE
  done
  echo; echo "### ESPORTS dog-bid paper quoter: bid only the underdog (mid < .45), improve when spread allows, BO1/qualifier/academy excluded, cancel T-15m"
  SPORTS=cs2,lol,dota2,val POLICY=DOG QUOTE_USD=20 INV_CAP_USD=40 EXCLUDE_TITLE="\(BO1\)|qualif|academy|challengers|open qualifier" /root/polyarb/.venv/bin/python /root/polybook/paper_mm.py /root/polybook/data/polybook.db $SINCE | grep -vE "^\s+[a-z0-9]+\s+mkts=\s*0 "
  echo; echo "### sharp-follow execution replay (last 24h): $10 bid at the sharp's price, 60s after their fill, cancel T-15m"
  /root/polyarb/.venv/bin/python /root/polybook/follow_sim.py /root/polybook/data/polybook.db $SINCE
  echo; echo "### recorder health (last 24h): rows/min avg, trades/min avg"
  /root/polyarb/.venv/bin/python -c "
import sqlite3,time; db=sqlite3.connect('/root/polybook/data/polybook.db'); s=int(time.time())-86400
print(db.execute('SELECT ROUND(AVG(events_1m)), ROUND(AVG(trades_1m)), MIN(conns), MAX(markets), ROUND(AVG(ws_rtt_ms),1) FROM health WHERE t>=?', (s,)).fetchone())
print('db MB', round(db.execute('SELECT page_count*page_size/1e6 FROM pragma_page_count(), pragma_page_size()').fetchone()[0]))"
} > "$OUT" 2>&1
# prune raw events older than 14 days
/root/polyarb/.venv/bin/python -c "
import sqlite3,time; db=sqlite3.connect('/root/polybook/data/polybook.db'); db.execute('DELETE FROM events WHERE recv_ms < ?', ((int(time.time())-14*86400)*1000,)); db.commit()"
