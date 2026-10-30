"""NCAAB price-rule backtest (2026-10-30). Charter: docs/charters/ncaab-price-backtest.md
Entry per (market, side) = first BUY fill of the token in [start-180m, start-60m), 0.05-0.95; ROI = won/price - 1;
game-clustered z; DISCOVERY < 2026-02-01 / HOLDOUT >=. 24 fixed cells. usage: python3 ncaab_prices.py <db>"""
import sqlite3, math, re, sys, time, bisect
from collections import defaultdict
db = sqlite3.connect(sys.argv[1]); SPLIT = 1769904000
games, mk = {}, {}
def game_key(st, a, b):
    k = (st // 600, tuple(sorted((a, b)))); games.setdefault(k, (st, (a, b))); return k
rows = db.execute("SELECT condition_id, market_type, question, start, winner0, token0 FROM markets WHERE status='done' AND winner0 IN (0,1)").fetchall()
spreads = []
for cid, mt, q, st, w0, tok0 in rows:
    if mt in ("moneyline", "total"):
        m = re.match(r"^(.+?) vs\.? (.+?)(?:: O/U ([\d.]+))?$", q)
        if m: mk[cid] = dict(mt=mt, st=st, w0=w0, tok0=tok0, g=game_key(st, m.group(1), m.group(2)))
    elif mt == "spread":
        m = re.match(r"^Spread: (.+?) \(([-+][\d.]+)\)", q)
        if m: spreads.append((cid, st, w0, tok0, m.group(1)))
by_team = defaultdict(list)
for k, (gst, tm) in games.items():
    for t in tm: by_team[t].append((gst, k))
for cid, st, w0, tok0, team in spreads:
    g = [k for gst, k in by_team.get(team, []) if abs(gst - st) < 3 * 3600]
    if len(g) == 1: mk[cid] = dict(mt="spread", st=st, w0=w0, tok0=tok0, g=g[0])
size = defaultdict(float)
for cid, n in db.execute("SELECT f.condition_id, SUM(f.price*f.size) FROM fills_all f JOIN markets m USING(condition_id) WHERE f.ts < m.start GROUP BY 1"):
    if cid in mk: size[mk[cid]["g"]] += n
R = []   # observations
for cid, m in mk.items():
    st = m["st"]
    fl = db.execute("SELECT ts, asset = ?, price FROM fills_all WHERE condition_id = ? AND side='BUY' AND ts >= ? AND ts < ? ORDER BY ts",
                    (m["tok0"], cid, st - 6 * 3600, st - 3600)).fetchall()
    for is0 in (1, 0):
        early = next((p for ts, a, p in fl if a == is0 and 0.05 <= p <= 0.95), None)
        ent = next((p for ts, a, p in fl if a == is0 and ts >= st - 3 * 3600 and 0.05 <= p <= 0.95), None)
        if ent is None: continue
        won = m["w0"] if is0 else 1 - m["w0"]
        mon = time.gmtime(st).tm_mon
        R.append(dict(mt=m["mt"], is0=is0, p=ent, early=early, roi=won / ent - 1, g=m["g"], hold=st >= SPLIT,
                      phase="novdec" if mon in (11, 12) else "jan+", big=size[m["g"]] >= 50000))
print(f"{len(mk)} markets, {len(games)} games, {len(R)} market-side observations")
ML = lambda d: d["mt"] == "moneyline"
band = lambda lo, hi: (lambda d: ML(d) and lo <= d["p"] < hi)
dog, fav = band(0.20, 0.40), band(0.60, 0.80)
mv = lambda d: d["early"] is not None and d["p"] - d["early"]
CELLS = [
 ("A ML 05-20", band(0.05, 0.20)), ("A ML 20-40", dog), ("A ML 40-50", band(0.40, 0.50)),
 ("A ML 50-60", band(0.50, 0.60)), ("A ML 60-80", fav), ("A ML 80-95", band(0.80, 0.951)),
 ("B total Over", lambda d: d["mt"] == "total" and d["is0"] == 1), ("B total Under", lambda d: d["mt"] == "total" and d["is0"] == 0),
 ("C spread fav", lambda d: d["mt"] == "spread" and d["is0"] == 1), ("C spread dog", lambda d: d["mt"] == "spread" and d["is0"] == 0),
 ("D ML steam >=3c", lambda d: ML(d) and d["early"] is not None and d["p"] - d["early"] >= 0.03),
 ("D ML drift >=3c", lambda d: ML(d) and d["early"] is not None and d["early"] - d["p"] >= 0.03),
 ("D total steam >=3c", lambda d: d["mt"] == "total" and d["early"] is not None and d["p"] - d["early"] >= 0.03),
 ("D total drift >=3c", lambda d: d["mt"] == "total" and d["early"] is not None and d["early"] - d["p"] >= 0.03),
 ("E dogs 20-40 Nov-Dec", lambda d: dog(d) and d["phase"] == "novdec"), ("E dogs 20-40 Jan+", lambda d: dog(d) and d["phase"] == "jan+"),
 ("E favs 60-80 Nov-Dec", lambda d: fav(d) and d["phase"] == "novdec"), ("E favs 60-80 Jan+", lambda d: fav(d) and d["phase"] == "jan+"),
 ("F big dogs 20-40", lambda d: dog(d) and d["big"]), ("F small dogs 20-40", lambda d: dog(d) and not d["big"]),
 ("F big favs 60-80", lambda d: fav(d) and d["big"]), ("F small favs 60-80", lambda d: fav(d) and not d["big"]),
 ("F big Overs", lambda d: d["mt"] == "total" and d["is0"] == 1 and d["big"]), ("F small Overs", lambda d: d["mt"] == "total" and d["is0"] == 1 and not d["big"]),
]
def clz(o):
    n = len(o)
    if n < 2: return 0.0, 0.0, n
    mu = sum(r for r, _ in o) / n; g = defaultdict(float)
    for r, c in o: g[c] += r - mu
    se = math.sqrt(sum(v * v for v in g.values())) / n
    return mu, (mu / se if se else 0.0), n
cands = []
print(f"\n{'cell':24s} discovery (<2/1)            | holdout (>=2/1)")
for name, f in CELLS:
    d = clz([(x["roi"], x["g"]) for x in R if not x["hold"] and f(x)]); h = clz([(x["roi"], x["g"]) for x in R if x["hold"] and f(x)])
    flag = ""
    if d[2] >= 50 and abs(d[1]) >= 2 and h[2] >= 30 and d[0] * h[0] > 0 and abs(h[1]) >= 1:
        flag = "  <== CANDIDATE" + (" (FADE/GUARD)" if d[0] < 0 else ""); cands.append(name)
    elif d[2] >= 50 and abs(d[1]) >= 2: flag = "  (disc only)"
    print(f"{name:24s} {d[0]*100:+6.1f}% z{d[1]:+5.1f} n{d[2]:5d} | {h[0]*100:+6.1f}% z{h[1]:+5.1f} n{h[2]:5d}{flag}")
print(f"\ncells: {len(CELLS)}; chance passes ~{len(CELLS)*0.046:.1f}; CANDIDATES: {cands}")
import pickle; pickle.dump(R, open(sys.argv[1].replace(".db", "_price_obs.pkl"), "wb"))
