"""NBA wallet backtest on the 2025-26 full tape (2026-10-07). Charter: docs/charters/nba-wallet-backtest.md

Fixed before the first run: point-in-time wallet records from pregame positions (settled = start+4h before use),
signals S0..S5 triggered by a wallet's first pregame BUY >= $100 (0-24h out), follow at the first fill of the same
token by another wallet >= trigger+60s (sensitivity: +10min), game-clustered z, discovery < 2026-02-01 / holdout >=,
CANDIDATE = disc n>=50 |z|>=2 AND holdout same sign |z|>=1 n>=30.
usage: python3 nba_wallets.py [db]
"""
import sqlite3, math, re, sys, time, bisect
from collections import defaultdict

DB = sys.argv[1] if len(sys.argv) > 1 else "/root/polysharp/data/nba/nba_2025.db"
SEASON_START, SPLIT, SETTLE_LAG = 1761004800, 1769904000, 4 * 3600
TRIG_USD, MIN_STAKE, LAT, LAT2 = 100, 50, 60, 600
TEAMS = {"Hawks", "Celtics", "Nets", "Hornets", "Bulls", "Cavaliers", "Mavericks", "Nuggets", "Pistons", "Warriors",
         "Rockets", "Pacers", "Clippers", "Lakers", "Grizzlies", "Heat", "Bucks", "Timberwolves", "Pelicans", "Knicks",
         "Thunder", "Magic", "76ers", "Suns", "Trail Blazers", "Kings", "Spurs", "Raptors", "Jazz", "Wizards"}
db = sqlite3.connect(DB, timeout=120)
t0 = time.time()
def log(s): print(f"{s}  [{time.time()-t0:.0f}s]", flush=True)

# ---- markets -> games (same parsing as nba_backtest.py)
games, mk = {}, {}
def game_key(st, a, b):
    k = (st // 600, tuple(sorted((a, b))))
    games.setdefault(k, (st, (a, b)))
    return k
rows = db.execute("SELECT condition_id, market_type, question, start, winner0, token0 FROM markets "
                  "WHERE status='done' AND winner0 IN (0,1) AND start >= ? AND condition_id IN (SELECT condition_id FROM fills_done)",
                  (SEASON_START,)).fetchall()
spreads = []
for cid, mt, q, st, w0, tok0 in rows:
    if mt in ("moneyline", "total"):
        m = re.match(r"^(.+?) vs\.? (.+?)(?:: O/U ([\d.]+))?$", q)
        if not m or m.group(1) not in TEAMS or m.group(2) not in TEAMS: continue
        mk[cid] = dict(mt=mt, st=st, w0=w0, tok0=tok0, g=game_key(st, m.group(1), m.group(2)), teams=(m.group(1), m.group(2)))
    elif mt == "spread":
        m = re.match(r"^Spread: (.+?) \(([-+][\d.]+)\)", q)
        if m and m.group(1) in TEAMS: spreads.append((cid, st, w0, tok0, m.group(1)))
for cid, st, w0, tok0, team in spreads:
    g = [k for k, (gst, tm) in games.items() if team in tm and abs(gst - st) < 3 * 3600]
    if len(g) == 1: mk[cid] = dict(mt="spread", st=st, w0=w0, tok0=tok0, g=g[0], teams=games[g[0]][1])
for m in mk.values(): m["hold"] = m["st"] >= SPLIT
log(f"{len(mk)} markets, {len(games)} games, fills_all rows {db.execute('SELECT count(*) FROM fills_all').fetchone()[0]}")

# ---- pregame positions -> point-in-time records
pos = defaultdict(lambda: [0.0, 0.0, 0.0, 0.0])   # (cid, wallet) -> [pnl, stake, buy0, buy1]
q = db.execute("""SELECT f.condition_id, f.wallet, f.asset = m.token0,
        SUM(CASE WHEN f.side='BUY' THEN f.size ELSE -f.size END), SUM(CASE WHEN f.side='BUY' THEN f.price*f.size ELSE -f.price*f.size END),
        SUM(CASE WHEN f.side='BUY' THEN f.price*f.size ELSE 0 END)
    FROM fills_all f JOIN markets m ON m.condition_id = f.condition_id WHERE f.ts < m.start GROUP BY 1, 2, 3""")
for cid, w, is0, sh, cash, buy in q:
    m = mk.get(cid)
    if not m: continue
    won = m["w0"] if is0 else 1 - m["w0"]
    p = pos[(cid, w)]; p[0] += sh * won - cash; p[1] += buy; p[2 if is0 else 3] += buy
log(f"{len(pos)} wallet-market positions")
rec_all = defaultdict(list); rec_team = defaultdict(list); rec_type = defaultdict(list)
for (cid, w), (pnl, stake, b0, b1) in pos.items():
    if stake < MIN_STAKE: continue
    m = mk[cid]; e = (m["st"] + SETTLE_LAG, pnl, stake, 1 if pnl > 0 else 0)
    rec_all[w].append(e); rec_type[(w, m["mt"])].append(e)
    for tm in m["teams"]: rec_team[(w, tm)].append(e)
del pos
def prefix(d):
    out = {}
    for k, lst in d.items():
        lst.sort(); ts, cp, cs, cw = [], [0.0], [0.0], [0]
        for s, p, st, wn in lst:
            ts.append(s); cp.append(cp[-1] + p); cs.append(cs[-1] + st); cw.append(cw[-1] + wn)
        out[k] = (ts, cp, cs, cw)
    return out
R_all, R_team, R_type = prefix(rec_all), prefix(rec_team), prefix(rec_type)
del rec_all, rec_team, rec_type
log(f"records: {len(R_all)} wallets")
def stat(R, k, t):
    r = R.get(k)
    if not r: return 0, 0.0, 0
    n = bisect.bisect_left(r[0], t)
    return n, (r[1][n] / r[2][n] if r[2][n] > 0 else 0.0), r[3][n]
def last12(w, t):
    r = R_all.get(w)
    if not r: return 0
    n = bisect.bisect_left(r[0], t)
    return r[3][n] - r[3][n - 12] if n >= 12 else -1

def quals(w, cid, t):
    m = mk[cid]; out = ["S0_any"]
    n, roi, _ = stat(R_all, w, t)
    if n >= 30 and roi >= 0.10: out.append("S1_nba_sharp")
    if last12(w, t) >= 9: out.append("S2_hot")
    if any((lambda s: s[0] >= 10 and s[1] >= 0.15)(stat(R_team, (w, tm), t)) for tm in m["teams"]): out.append("S3_team_specialist")
    n, roi, _ = stat(R_type, (w, m["mt"]), t)
    if n >= 20 and roi >= 0.10: out.append("S4_type_specialist")
    return out

trig = defaultdict(list)   # cid -> [(ts, wallet, is0)]
for cid, w, is0, ts in db.execute("""SELECT f.condition_id, f.wallet, f.asset = m.token0, MIN(f.ts) FROM fills_all f
        JOIN markets m ON m.condition_id = f.condition_id
        WHERE f.side='BUY' AND f.price*f.size >= ? AND f.ts >= m.start - 86400 AND f.ts < m.start GROUP BY 1, 2, 3""", (TRIG_USD,)):
    if cid in mk: trig[cid].append((ts, w, is0))
log(f"triggers in {len(trig)} markets")

SIGS = ["S5_consensus"]
DIAG = []
obs = defaultdict(list)    # (sig, type) -> [(roi, roi_10m, game, hold)]
for i, (cid, tl) in enumerate(trig.items()):
    m = mk[cid]; tl.sort()
    first = {}                                   # (sig, is0) -> (ts, wallet)
    s1_seen = {0: [], 1: []}
    for ts, w, is0 in tl:
        qs = quals(w, cid, ts)
        for s in qs: first.setdefault((s, is0), (ts, w))
        if "S1_nba_sharp" in qs and w not in s1_seen[is0]:
            s1_seen[is0].append(w)
            if len(s1_seen[is0]) == 2 and not s1_seen[1 - is0]: first.setdefault(("S5_consensus", is0), (ts, w))
    if not first: continue
    fl = db.execute("SELECT ts, asset = ?, price, wallet FROM fills_all WHERE condition_id = ? AND ts < ? ORDER BY ts",
                    (m["tok0"], cid, m["st"])).fetchall()
    fts = [f[0] for f in fl]
    def entry(is0, t, w):
        for j in range(bisect.bisect_left(fts, t), len(fl)):
            f = fl[j]
            if f[1] == is0 and f[3] != w and 0.05 <= f[2] <= 0.95: return f[2]
        return None
    for s in SIGS:
        a, b = first.get((s, 1)), first.get((s, 0))
        if a and b: continue                      # signal on both sides -> no bet
        for is0, tw in ((1, a), (0, b)):
            if not tw: continue
            p1, p2 = entry(is0, tw[0] + LAT, tw[1]), entry(is0, tw[0] + LAT2, tw[1])
            if p1 is None: continue
            if m["mt"] == "total":
                pf = entry(1 - is0, tw[0] + LAT, None); pf2 = entry(1 - is0, tw[0] + LAT2, None)
                wonf = 1 - (m["w0"] if is0 else 1 - m["w0"])
                DIAG.append(dict(side="Over" if is0 else "Under", p=p1, pf=pf, pf2=pf2, wonf=wonf, g=m["g"], hold=m["hold"],
                                 mon=time.strftime("%Y-%m", time.gmtime(m["st"])), mins=(m["st"] - tw[0]) / 60, tt=tw[0]))
            won = m["w0"] if is0 else 1 - m["w0"]
            r2 = (won / p2 - 1) if p2 is not None else None
            for ty in ("all", m["mt"]): obs[(s, ty)].append((won / p1 - 1, r2, m["g"], m["hold"]))
    if i % 1000 == 0: log(f"  {i}/{len(trig)} markets")


def clz(o):
    n = len(o)
    if n < 2: return (0.0, 0.0, n)
    mu = sum(r for r, _ in o) / n; g = defaultdict(float)
    for r, c in o: g[c] += r - mu
    se = math.sqrt(sum(v * v for v in g.values())) / n
    return (mu, mu / se if se > 0 else 0.0, n)
def show(lab, rows, key="pf"):
    o = [((d["wonf"] / d[key] - 1), d["g"]) for d in rows if d[key] is not None]
    mu, z, n = clz(o); stake = 4 * n; print(f"  {lab:34s} FADE ROI {mu*100:+6.1f}% z{z:+5.1f} n{n:4d}   ($4/bet: {mu*stake:+8.2f})")

def per_game(rows, key="pf"):
    by = defaultdict(list)
    for d in rows:
        if d[key] is not None: by[d["g"]].append(d)
    out = []
    for g, lst in by.items():
        t = min(d["tt"] for d in lst); tied = [d for d in lst if d["tt"] == t]      # earliest trigger; average tied lines
        out.append((sum(d["wonf"] / d[key] - 1 for d in tied) / len(tied), g, tied[0]))
    return out
def show(lab, o):
    mu, z, n = clz([(r, g) for r, g, _ in o]); w = sum(1 for r, _, _ in o if r > 0)
    print(f"  {lab:30s} {w}-{n-w}  FADE ROI {mu*100:+6.1f}% z{z:+5.1f}  ($4/game: {mu*4*n:+7.2f})")
print("\nONE BET PER GAME (earliest consensus trigger, tied alt lines averaged), fade at next executable fill")
for lab, sel in (("discovery", lambda d: not d["hold"]), ("holdout", lambda d: d["hold"]), ("all", lambda d: True)):
    show(lab, per_game([d for d in DIAG if sel(d)]))
show("holdout +10min", per_game([d for d in DIAG if d["hold"]], "pf2"))
blk = defaultdict(list)
for r, g, d in per_game(DIAG): blk[d["mon"]].append((r, g, d))
for mo in sorted(blk): show(mo, blk[mo])
import statistics
print("fade entry price, per game: median", statistics.median(d["pf"] for _, _, d in per_game(DIAG)),
      " share 0.40-0.60:", sum(1 for _, _, d in per_game(DIAG) if .4 <= d["pf"] <= .6) / len(per_game(DIAG)))
show("entry 0.40-0.60 only (info)", [x for x in per_game(DIAG) if .4 <= x[2]["pf"] <= .6])
