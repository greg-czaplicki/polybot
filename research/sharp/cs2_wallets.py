"""CS2 wallet backtest on the full tape (2026-10-09). Charter: docs/charters/cs2-wallet-backtest.md

Fixed before the first run. A: lane-filter cells — lane row = first fill in [start-180m, start-60m) priced 0.40-0.50
(dog token, T, entry), wallet state at T from fills < T, qualifiers S1/S2/S3/S5 on dog vs favourite.
B: follow cells (NBA method) — first pregame BUY >= $100 0-24h out, follow at the first other-wallet fill >= trigger+60s.
Records: pregame positions in every CS2 market, settled = start+4h before use. z clustered by match.
DISCOVERY start < 2026-06-01 / HOLDOUT >=. CANDIDATE = disc n>=50 |z|>=2 AND holdout same sign |z|>=1 n>=30.
usage: python3 cs2_wallets.py [db]
"""
import sqlite3, math, re, sys, time, bisect
from collections import defaultdict

DB = sys.argv[1] if len(sys.argv) > 1 else "/root/polysharp/data/cs2/cs2_2025.db"
SPLIT, SETTLE_LAG = 1780272000, 4 * 3600          # 2026-06-01T00:00Z
TRIG_USD, ON_USD, MIN_STAKE, LAT = 100, 100, 50, 60
LANE_LO, LANE_HI, WIN_OPEN, WIN_CLOSE = 0.40, 0.50, 180 * 60, 60 * 60
db = sqlite3.connect(DB, timeout=120)
t0 = time.time()
def log(s): print(f"{s}  [{time.time()-t0:.0f}s]", flush=True)

# ---- markets: every resolved CS2 market feeds records; match winners are the bet population
mk, bet = {}, set()
TEAMS_RE = re.compile(r"^Counter-Strike: (.+?) vs\.? (.+?)(?: \(BO\d\))?(?: - |$)")
for cid, mt, q, st, w0, tok0 in db.execute(
        "SELECT condition_id, market_type, question, start, winner0, token0 FROM markets "
        "WHERE status='done' AND winner0 IN (0,1) AND sport='cs2' AND condition_id IN (SELECT condition_id FROM fills_done)"):
    m = TEAMS_RE.match(q or "")
    teams = (m.group(1).strip(), m.group(2).strip()) if m else ()
    mk[cid] = dict(mt=mt, st=st, w0=w0, tok0=tok0, teams=teams, hold=st >= SPLIT,
                   g=(st // 600, tuple(sorted(teams))) if teams else (st // 600, cid))
    if mt == "moneyline" and teams and re.search(r"\(BO\d\)", q): bet.add(cid)
log(f"{len(mk)} markets, {len(bet)} match winners, fills_all rows {db.execute('SELECT count(*) FROM fills_all').fetchone()[0]}")

# ---- pregame positions -> point-in-time records
pos = defaultdict(lambda: [0.0, 0.0])   # (cid, wallet) -> [pnl, stake]
for cid, w, is0, sh, cash, buy in db.execute("""SELECT f.condition_id, f.wallet, f.asset = m.token0,
        SUM(CASE WHEN f.side='BUY' THEN f.size ELSE -f.size END), SUM(CASE WHEN f.side='BUY' THEN f.price*f.size ELSE -f.price*f.size END),
        SUM(CASE WHEN f.side='BUY' THEN f.price*f.size ELSE 0 END)
    FROM fills_all f JOIN markets m ON m.condition_id = f.condition_id WHERE f.ts < m.start GROUP BY 1, 2, 3"""):
    m = mk.get(cid)
    if not m: continue
    won = m["w0"] if is0 else 1 - m["w0"]
    p = pos[(cid, w)]; p[0] += sh * won - cash; p[1] += buy
rec_all = defaultdict(list); rec_team = defaultdict(list)
for (cid, w), (pnl, stake) in pos.items():
    if stake < MIN_STAKE: continue
    m = mk[cid]; e = (m["st"] + SETTLE_LAG, pnl, stake, 1 if pnl > 0 else 0)
    rec_all[w].append(e)
    for tm in m["teams"]: rec_team[(w, tm)].append(e)
log(f"{len(pos)} wallet-market positions")
del pos
def prefix(d):
    out = {}
    for k, lst in d.items():
        lst.sort(); ts, cp, cs, cw = [], [0.0], [0.0], [0]
        for s, p, st, wn in lst:
            ts.append(s); cp.append(cp[-1] + p); cs.append(cs[-1] + st); cw.append(cw[-1] + wn)
        out[k] = (ts, cp, cs, cw)
    return out
R_all, R_team = prefix(rec_all), prefix(rec_team)
del rec_all, rec_team
log(f"records: {len(R_all)} wallets")
def stat(R, k, t):
    r = R.get(k)
    if not r: return 0, 0.0
    n = bisect.bisect_left(r[0], t)
    return n, (r[1][n] / r[2][n] if r[2][n] > 0 else 0.0)
def last12(w, t):
    r = R_all.get(w)
    if not r: return -1
    n = bisect.bisect_left(r[0], t)
    return r[3][n] - r[3][n - 12] if n >= 12 else -1
def quals(w, cid, t):
    out = {"S0"}
    n, roi = stat(R_all, w, t)
    if n >= 30 and roi >= 0.10: out.add("S1")
    if last12(w, t) >= 9: out.add("S2")
    if any((lambda s: s[0] >= 10 and s[1] >= 0.15)(stat(R_team, (w, tm), t)) for tm in mk[cid]["teams"]): out.add("S3")
    return out

obs = defaultdict(list)   # cell -> [(roi, match, hold)]
for i, cid in enumerate(sorted(bet)):
    m = mk[cid]; st = m["st"]
    fl = db.execute("SELECT ts, asset = ?, price, wallet, side, price*size FROM fills_all WHERE condition_id = ? AND ts < ? ORDER BY ts",
                    (m["tok0"], cid, st)).fetchall()
    def add(cell, is0, price):
        won = m["w0"] if is0 else 1 - m["w0"]
        obs[cell].append((won / price - 1, m["g"], m["hold"]))

    # ---- A. lane rows
    lane = next(((f[0], f[1], f[2]) for f in fl if st - WIN_OPEN <= f[0] < st - WIN_CLOSE and LANE_LO <= f[2] < LANE_HI), None)
    if lane:
        T, dog, price = lane
        buys = defaultdict(lambda: [0.0, 0.0])            # wallet -> [buy cash token1, buy cash token0]
        for ts, is0, p, w, side, cash in fl:
            if ts >= T: break
            if side == "BUY": buys[w][is0] += cash
        on = {dog: defaultdict(set), 1 - dog: defaultdict(set)}   # token -> qualifier -> wallets
        for w, b in buys.items():
            for tok in (0, 1):
                if b[tok] >= ON_USD and b[tok] > b[1 - tok]:
                    for q in quals(w, cid, T): on[tok][q].add(w)
        add("A L0_lane", dog, price)
        D, F = on[dog], on[1 - dog]
        for q in ("S1", "S2", "S3"):
            if D[q] and not F[q]: add(f"A {q}_on_dog", dog, price)
            if F[q] and not D[q]: add(f"A {q}_on_fav", dog, price)
        if len(D["S1"]) >= 2 and not F["S1"]: add("A S5_on_dog", dog, price)
        if len(F["S1"]) >= 2 and not D["S1"]: add("A S5_on_fav", dog, price)
        if not F["S1"]: add("A L_skip_S1_fav", dog, price)

    # ---- B. follow cells
    first, s1_seen = {}, {0: [], 1: []}
    seen = set()
    for ts, is0, p, w, side, cash in fl:
        if side != "BUY" or cash < TRIG_USD or ts < st - 86400 or (w, is0) in seen: continue
        seen.add((w, is0))
        qs = quals(w, cid, ts)
        for s in qs: first.setdefault((s, is0), (ts, w))
        if "S1" in qs and w not in s1_seen[is0]:
            s1_seen[is0].append(w)
            if len(s1_seen[is0]) == 2 and not s1_seen[1 - is0]: first.setdefault(("S5", is0), (ts, w))
    fts = [f[0] for f in fl]
    for s in ("S0", "S1", "S2", "S3", "S5"):
        a, b = first.get((s, 1)), first.get((s, 0))
        if a and b: continue
        for is0, tw in ((1, a), (0, b)):
            if not tw: continue
            for j in range(bisect.bisect_left(fts, tw[0] + LAT), len(fl)):
                f = fl[j]
                if f[1] == is0 and f[3] != tw[1] and 0.05 <= f[2] <= 0.95:
                    add(f"B {s}_follow", is0, f[2]); break
    if i % 500 == 0: log(f"  {i}/{len(bet)} markets")

def clz(o):
    n = len(o)
    if n < 2: return (0.0, 0.0, n, 0)
    mu = sum(r for r, _ in o) / n; g = defaultdict(float)
    for r, c in o: g[c] += r - mu
    se = math.sqrt(sum(v * v for v in g.values())) / n
    return (mu, mu / se if se > 0 else 0.0, n, len(g))
CELLS = ["A L0_lane", "A S1_on_dog", "A S1_on_fav", "A S2_on_dog", "A S2_on_fav", "A S3_on_dog", "A S3_on_fav",
         "A S5_on_dog", "A S5_on_fav", "A L_skip_S1_fav", "B S0_follow", "B S1_follow", "B S2_follow", "B S3_follow", "B S5_follow"]
cands = []
print(f"\n{'cell':22s} discovery (<6/1)                     | holdout (>=6/1)                      | all")
for c in CELLS:
    o = obs.get(c, [])
    d = clz([(r, g) for r, g, h in o if not h]); h = clz([(r, g) for r, g, hh in o if hh]); a = clz([(r, g) for r, g, _ in o])
    flag = ""
    if d[2] >= 50 and abs(d[1]) >= 2 and h[2] >= 30 and d[0] * h[0] > 0 and abs(h[1]) >= 1:
        flag = "  <== CANDIDATE" + (" (negative)" if d[0] < 0 else ""); cands.append((c, d, h))
    elif d[2] >= 50 and abs(d[1]) >= 2: flag = "  (disc only, holdout fails)"
    print(f"{c:22s} {d[0]*100:+6.1f}% z{d[1]:+5.1f} n{d[2]:5d} g{d[3]:4d} | {h[0]*100:+6.1f}% z{h[1]:+5.1f} n{h[2]:5d} g{h[3]:4d} "
          f"| {a[0]*100:+6.1f}% z{a[1]:+5.1f} n{a[2]:5d}{flag}")
print(f"\ncells tested: {len(CELLS)}; expected chance discovery hits at |z|>=2 ~{len(CELLS)*0.046:.1f}")
print(f"CANDIDATES: {len(cands)}")
for c, d, h in cands: print(f"   {c}: disc {d[0]*100:+.1f}% z{d[1]:+.1f} n{d[2]} | hold {h[0]*100:+.1f}% z{h[1]:+.1f} n{h[2]}")
log("done")
