import sqlite3, math, collections
db = sqlite3.connect("/root/polysharp/data/sharp.db", timeout=120); bk = sqlite3.connect("/root/polybook/data/polybook.db", timeout=60)
ES = ("cs2", "lol", "dota2", "val", "valorant", "r6siege", "rocketleague")
print("=== tape: settled esports match-winner markets ===")
for s, n, usd, pre in db.execute(f"SELECT m.sport, COUNT(DISTINCT m.condition_id), ROUND(SUM(t.price*t.size)), ROUND(SUM(CASE WHEN t.ts<m.start THEN t.price*t.size END)) FROM markets m JOIN trades t ON t.condition_id=m.condition_id WHERE m.sport IN {ES} AND m.status='done' AND m.market_type='moneyline' GROUP BY 1 ORDER BY 3 DESC"):
    print(f"   {s:9s} markets {n:4d}  ${usd:>12,.0f} total  ${pre:>11,.0f} pregame  (${usd/n:,.0f}/market)")
print("\n=== recorder (since 9/9): pregame spread and depth at the touch, per market avg ===")
for r in bk.execute(f"SELECT m.sport_hint, COUNT(DISTINCT m.condition_id), ROUND(AVG((t.best_ask-t.best_bid)*100),2), ROUND(AVG(t.bid_size*t.best_bid)), ROUND(AVG(t.ask_size*t.best_ask)) FROM tob_minute t JOIN markets m ON t.asset IN (m.token0,m.token1) WHERE m.sport_hint IN {ES} AND t.best_bid IS NOT NULL AND t.best_ask IS NOT NULL GROUP BY 1"):
    print(f"   {r[0]:9s} markets {r[1]:3d}  spread {r[2]}c  $ at best bid {r[3]:,.0f}  ask {r[4]:,.0f}")
print("\n=== favorite-longshot: do esports prices calibrate? (token0 side, T-60m price band → win rate, ROI of backing that band) ===")
rows = db.execute(f"SELECT m.condition_id, m.winner0, p.p FROM markets m JOIN prices p ON p.condition_id=m.condition_id AND p.ts BETWEEN m.start-3900 AND m.start-3300 WHERE m.sport IN {ES} AND m.status='done' AND m.market_type='moneyline' AND m.winner0 IS NOT NULL GROUP BY m.condition_id").fetchall()
bands = [(0.03, 0.15), (0.15, 0.30), (0.30, 0.45), (0.45, 0.55), (0.55, 0.70), (0.70, 0.85), (0.85, 0.97)]
print(f"   {'band':9s} {'n':>5s} {'implied':>8s} {'actual':>7s} {'ROI back':>9s} {'ROI fade':>9s}")
for lo, hi in bands:
    sub = [(w, p) for _, w, p in rows if lo <= p < hi]
    if len(sub) < 20: continue
    n = len(sub); wins = sum(w for w, _ in sub); imp = sum(p for _, p in sub) / n
    roi = sum(((1 / p - 1) if w else -1) for w, p in sub) / n; fade = sum(((1 / (1 - p) - 1) if not w else -1) for w, p in sub) / n
    print(f"   {lo:.2f}-{hi:.2f} {n:5d} {imp*100:7.0f}% {wins/n*100:6.0f}% {roi*100:+8.1f}% {fade*100:+8.1f}%")
print("\n=== opening (T-24h) vs close move, esports vs mlb (median |Δ| cents) ===")
for s in ("cs2", "lol", "dota2", "mlb", "atp"):
    d = db.execute("""SELECT ABS(c.p-o.p)*100 FROM markets m JOIN prices o ON o.condition_id=m.condition_id AND o.ts BETWEEN m.start-21900 AND m.start-21300
                      JOIN prices c ON c.condition_id=m.condition_id AND c.ts BETWEEN m.start-120 AND m.start WHERE m.sport=? AND m.market_type='moneyline' GROUP BY m.condition_id""", (s,)).fetchall()
    if d: v = sorted(x[0] for x in d); print(f"   {s:6s} n={len(v):4d} median {v[len(v)//2]:.1f}c  p90 {v[int(len(v)*.9)]:.1f}c")
