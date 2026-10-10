"""Build wallet records for a wallet-signal lane from a desktop backfill DB (generalised from cfb_records.py, 2026-10-09).
SPORT env = the backfill DB's sport label (cfb, nfl, nba, …). Adds `all` (S1/S6 records) to the CFB file's hot/team.

Same definitions as research/sharp/ncaaf_wallets.py (charter docs/charters/ncaaf-wallet-backtest.md):
position = pregame fills per wallet per market (net shares / net cash), stake = pregame BUY cash >= $50,
settles at start + 4h. Output pickle (shipped to the VPS by cfb-daily.sh):
  hot[wallet]         = (settle_ts list, cumulative wins)        -> S2: last 12 settled >= 9 wins
  team[(wallet,team)] = (settle_ts list, cum pnl, cum stake)     -> S3: >= 10 settled, ROI >= +15%
  all[wallet]         = (settle_ts list, cum pnl, cum stake)     -> S1 sharp (>= 30, ROI >= +10%) / S6 square (>= 30, ROI <= -15%)
Only wallets/keys that can ever qualify are kept (>= 12 positions for hot, >= 10 per team).
usage: SPORT=nfl python3 wallet_records.py <db> <out.pkl>
"""
import sqlite3, sys, re, pickle, os, time
from collections import defaultdict

DB, OUT = sys.argv[1], sys.argv[2]
SPORT = os.environ.get("SPORT", "cfb")
SETTLE_LAG, MIN_STAKE = 4 * 3600, 50

def teams_of(q, mt):
    q = q or ""
    if mt == "spread":
        m = re.match(r"^Spread: (.+?) \(", q)
        return (m.group(1).strip(),) if m else ()
    m = re.match(r"^(.+?) vs\.? (.+?)(?::|$)", q)
    return (m.group(1).strip(), m.group(2).strip()) if m else ()

db = sqlite3.connect(DB, timeout=120)
mk = {cid: dict(mt=mt, st=st, w0=w0, teams=teams_of(q, mt)) for cid, mt, q, st, w0 in db.execute(
    "SELECT condition_id, market_type, question, start, winner0 FROM markets "
    "WHERE status='done' AND winner0 IN (0,1) AND sport IN (" + ",".join("?" * len(SPORT.split(","))) + ") AND condition_id IN (SELECT condition_id FROM fills_done)", tuple(SPORT.split(",")))}
pos = defaultdict(lambda: [0.0, 0.0])
for cid, w, is0, sh, cash, buy in db.execute("""SELECT f.condition_id, f.wallet, f.asset = m.token0,
        SUM(CASE WHEN f.side='BUY' THEN f.size ELSE -f.size END), SUM(CASE WHEN f.side='BUY' THEN f.price*f.size ELSE -f.price*f.size END),
        SUM(CASE WHEN f.side='BUY' THEN f.price*f.size ELSE 0 END)
    FROM fills_all f JOIN markets m ON m.condition_id = f.condition_id WHERE f.ts < m.start GROUP BY 1, 2, 3"""):
    m = mk.get(cid)
    if not m: continue
    won = m["w0"] if is0 else 1 - m["w0"]
    p = pos[(cid, w)]; p[0] += sh * won - cash; p[1] += buy
allr, teamr = defaultdict(list), defaultdict(list)
for (cid, w), (pnl, stake) in pos.items():
    if stake < MIN_STAKE: continue
    m = mk[cid]; e = (m["st"] + SETTLE_LAG, pnl, stake)
    allr[w].append(e)
    for tm in m["teams"]: teamr[(w, tm)].append(e)
hot, team, allrec = {}, {}, {}
for w, lst in allr.items():
    if len(lst) < 12: continue
    lst.sort(); ts, cw = [], [0]
    for s, p, _ in lst: ts.append(s); cw.append(cw[-1] + (1 if p > 0 else 0))
    hot[w] = (ts, cw)
    if len(lst) >= 30:
        cp, cs = [0.0], [0.0]
        for _, p, st in lst: cp.append(cp[-1] + p); cs.append(cs[-1] + st)
        allrec[w] = (ts, cp, cs)
for k, lst in teamr.items():
    if len(lst) < 10: continue
    lst.sort(); ts, cp, cs = [], [0.0], [0.0]
    for s, p, st in lst: ts.append(s); cp.append(cp[-1] + p); cs.append(cs[-1] + st)
    team[k] = (ts, cp, cs)
latest = max((m["st"] for m in mk.values()), default=0)
with open(OUT + ".tmp", "wb") as f:
    pickle.dump({"built_at": int(time.time()), "latest_start": latest, "markets": len(mk), "sport": SPORT, "hot": hot, "team": team, "all": allrec}, f)
os.replace(OUT + ".tmp", OUT)
print(f"records [{SPORT}]: {len(mk)} markets, {len(hot)} hot-eligible, {len(allrec)} with >=30 positions, {len(team)} team keys, latest start {latest}")
