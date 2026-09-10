"""Esports edge tests on the tape. (A) underdog bias by game, train/test by date, at MID and at MID+3c (taker), plus CLV of dogs (does the price drift toward them?).
(B) pregame MAKER realized spread per fill for esports (fill vs mid 1 min before / 15 min after). (C) esports-specialist wallets, train/test."""
import sqlite3, math, collections, datetime, bisect
db = sqlite3.connect("/root/polysharp/data/sharp.db", timeout=120)
ES = ("cs2", "dota2", "val", "lol")
SPLIT = datetime.datetime(2026, 8, 1, tzinfo=datetime.timezone.utc).timestamp()
mk = {r[0]: r for r in db.execute(f"SELECT condition_id, sport, start, token0, winner0, question FROM markets WHERE sport IN {ES} AND status='done' AND market_type='moneyline' AND winner0 IS NOT NULL")}
prices = collections.defaultdict(list)
for cid, ts, p in db.execute(f"SELECT p.condition_id, p.ts, p.p FROM prices p JOIN markets m ON m.condition_id=p.condition_id WHERE m.sport IN {ES} AND m.market_type='moneyline' ORDER BY p.ts"): prices[cid].append((ts, p))
def px(cid, t):
    arr = prices.get(cid)
    if not arr: return None
    i = bisect.bisect_right(arr, (t, 9)) - 1
    return arr[i][1] if i >= 0 and t - arr[i][0] < 900 else None
def cl(xs):
    n = len(xs)
    if n < 2: return (0, 0, n)
    m = sum(v for v, _ in xs) / n; g = collections.defaultdict(lambda: [0.0, 0])
    for v, c in xs: g[c][0] += v; g[c][1] += 1
    se = math.sqrt(sum((s - m * k) ** 2 for s, k in g.values())) / n
    return (m, se, n)
f = lambda m, se, n, sc=100, u="%": f"{m*sc:+6.1f}{u} (z{m/se if se else 0:+5.1f}, n={n})"
print("=== (A) BACK THE UNDERDOG at T-60m: dog = side priced < 0.45; ROI at mid, at mid+3c (taker in a 6c-spread book), CLV to start ===")
rows = []
for cid, (_, sport, st, tok0, w0, q) in mk.items():
    p0 = px(cid, st - 3600); c = px(cid, st - 60)
    if p0 is None: continue
    dog0 = p0 < 0.45; dog1 = (1 - p0) < 0.45
    if not (dog0 or dog1): continue
    dp = p0 if dog0 else 1 - p0; win = (w0 == 1) if dog0 else (w0 == 0)
    clv = ((c - p0) if dog0 else (p0 - c)) if c is not None else None
    rows.append(dict(cid=cid, sport=sport, test=st >= SPLIT, dp=dp, roi=(1 / dp - 1) if win else -1.0, roi3=(1 / (dp + 0.03) - 1) if win else -1.0, clv=clv))
def block(name, rs):
    tr = [r for r in rs if not r["test"]]; te = [r for r in rs if r["test"]]
    for lab, g in (("train", tr), ("test ", te)):
        a = cl([(r["roi"], r["cid"]) for r in g]); b = cl([(r["roi3"], r["cid"]) for r in g]); c = cl([(r["clv"], r["cid"]) for r in g if r["clv"] is not None])
        print(f"  {name:26s} {lab}: mid {f(*a)}  taker+3c {f(*b)}  CLV {f(c[0],c[1],c[2],100,'c')}")
block("ALL dogs <0.45", rows)
for s in ES: 
    rs = [r for r in rows if r["sport"] == s]
    if len(rs) >= 40: block(s, rs)
block("dogs 0.30-0.45", [r for r in rows if 0.30 <= r["dp"] < 0.45]); block("dogs 0.15-0.30", [r for r in rows if 0.15 <= r["dp"] < 0.30]); block("dogs <0.15", [r for r in rows if r["dp"] < 0.15])
print("\n=== (B) PREGAME MAKER economics in esports: per taker fill, maker's effective half-spread (fill vs mid 1m before) and realized (fill vs mid 15m after), cents ===")
eff = collections.defaultdict(list); real = collections.defaultdict(list)
for cid, asset, side, price, size, ts in db.execute(f"SELECT t.condition_id, t.asset, t.side, t.price, t.size, t.ts FROM trades t JOIN markets m ON m.condition_id=t.condition_id WHERE m.sport IN {ES} AND m.market_type='moneyline' AND m.status='done' AND t.ts < m.start-900"):
    m = mk.get(cid)
    if not m: continue
    is0 = asset == m[3]; sign = 1 if ((side == "BUY") == is0) else -1; p0 = price if is0 else 1 - price
    if not (0.05 < p0 < 0.95): continue
    b = px(cid, ts - 60); a = px(cid, ts + 900)
    if b is None or a is None: continue
    eff[m[1]].append((sign * (p0 - b), cid)); real[m[1]].append((sign * (p0 - a), cid))
for s in ES:
    if len(eff[s]) < 200: continue
    e = cl(eff[s]); r = cl(real[s])
    print(f"  {s:6s} fills {e[2]:6d}  effective {e[0]*100:+.2f}c  realized(15m) {f(r[0],r[1],r[2],100,'c')}  adverse selection {(e[0]-r[0])*100:+.2f}c")
print("\n=== (C) esports-specialist wallets (ranked on esports-only pregame markets, >=15 train markets), top decile followed one-per-event in test ===")
per = collections.defaultdict(lambda: collections.defaultdict(lambda: [0.0, 0.0, None]))
for cid, w, asset, side, price, size, ts in db.execute(f"SELECT t.condition_id, t.wallet, t.asset, t.side, t.price, t.size, t.ts FROM trades t JOIN markets m ON m.condition_id=t.condition_id WHERE m.sport IN {ES} AND m.market_type='moneyline' AND m.status='done' AND t.ts < m.start-900"):
    m = mk.get(cid)
    if not m: continue
    is0 = asset == m[3]; sign = 1 if ((side == "BUY") == is0) else -1; p0 = price if is0 else 1 - price; sp = p0 if sign > 0 else 1 - p0
    if not (0.05 < sp < 0.95): continue
    win = (m[4] == 1) if sign > 0 else (m[4] == 0); a = per[w][cid]; usd = price * size; a[0] += usd; a[1] += ((1 / sp - 1) if win else -1) * usd; a[2] = ts if a[2] is None else min(a[2], ts)
stats = {}
for w, ms in per.items():
    tr = [v for cid, v in ms.items() if mk[cid][2] < SPLIT]
    if len(tr) < 15: continue
    r = [v[1] / v[0] for v in tr]; mm = sum(r) / len(r); sd = math.sqrt(sum((x - mm) ** 2 for x in r) / (len(r) - 1))
    stats[w] = mm / (sd / math.sqrt(len(r))) if sd > 1e-6 else 0
rk = sorted(stats, key=stats.get); k = max(1, len(rk) // 10); sharp = set(rk[-k:])
cands = sorted((v[2], cid, v) for w in sharp for cid, v in per[w].items() if mk[cid][2] >= SPLIT and v[0] >= 50)
seen = set(); bets = []
for ts, cid, v in cands:
    if cid in seen: continue
    seen.add(cid); bets.append((v[1] / v[0], cid))
print(f"  wallets ranked {len(rk)}, specialists {len(sharp)}; TEST follow (their price) {f(*cl(bets))}")
