"""NCAAB wallet backtest on the 2025-26 full tape (2026-10-30). Charter: docs/charters/ncaab-wallet-backtest.md

= nba_wallets.py with the charter's three changes: PRIMARY entry in the bot window (first other-wallet fill of the token
in [max(trigger+60s, start-180m), start-60m), signal before start-60m; immediate entry = info), games from 2025-12-01
scored (November builds records, reported as info), DISCOVERY 2025-12-01..2026-02-01 / HOLDOUT >= 2026-02-01.
Teams parsed from "A vs. B" titles (no fixed list). Candidates are re-read one bet per game.
usage: python3 ncaab_wallets.py <db>
"""
import sqlite3, math, re, sys, time, bisect
from collections import defaultdict

DB = sys.argv[1]
SEASON_START, SCORE_START, SPLIT, SETTLE_LAG = 1761955200, 1764547200, 1769904000, 4 * 3600
TRIG_USD, MIN_STAKE, LAT, LAT2 = 100, 50, 60, 600
db = sqlite3.connect(DB, timeout=120)
t0 = time.time()
def log(s): print(f"{s}  [{time.time()-t0:.0f}s]", flush=True)

# ---- markets -> games
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
        if not m: continue
        mk[cid] = dict(mt=mt, st=st, w0=w0, tok0=tok0, g=game_key(st, m.group(1), m.group(2)), teams=(m.group(1), m.group(2)))
    elif mt == "spread":
        m = re.match(r"^Spread: (.+?) \(([-+][\d.]+)\)", q)
        if m: spreads.append((cid, st, w0, tok0, m.group(1)))
by_team = defaultdict(list)
for k, (gst, tm) in games.items():
    for t in tm: by_team[t].append((gst, k))
for cid, st, w0, tok0, team in spreads:
    g = [k for gst, k in by_team.get(team, []) if abs(gst - st) < 3 * 3600]
    if len(g) == 1: mk[cid] = dict(mt="spread", st=st, w0=w0, tok0=tok0, g=g[0], teams=games[g[0]][1])
for m in mk.values(): m["per"] = "nov" if m["st"] < SCORE_START else ("hold" if m["st"] >= SPLIT else "disc")
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
    if n >= 30 and roi >= 0.10: out.append("S1_sharp")
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

SIGS = ["S0_any", "S1_sharp", "S2_hot", "S3_team_specialist", "S4_type_specialist", "S5_consensus"]
obs = defaultdict(list)    # (sig, type) -> [(roi, roi_10m, game, hold)]
for i, (cid, tl) in enumerate(trig.items()):
    m = mk[cid]; tl.sort()
    first = {}                                   # (sig, is0) -> (ts, wallet)
    s1_seen = {0: [], 1: []}
    for ts, w, is0 in tl:
        qs = quals(w, cid, ts)
        for s in qs: first.setdefault((s, is0), (ts, w))
        if "S1_sharp" in qs and w not in s1_seen[is0]:
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
            p1 = entry(is0, tw[0] + LAT, tw[1])
            pbw = None
            if tw[0] < m["st"] - 3600:
                tb = max(tw[0] + LAT, m["st"] - 3 * 3600)
                for j in range(bisect.bisect_left(fts, tb), len(fl)):
                    f = fl[j]
                    if f[0] >= m["st"] - 3600: break
                    if f[1] == is0 and f[3] != tw[1] and 0.05 <= f[2] <= 0.95: pbw = f[2]; break
            if p1 is None and pbw is None: continue
            won = m["w0"] if is0 else 1 - m["w0"]
            row = dict(bw=(won / pbw - 1) if pbw is not None else None, imm=(won / p1 - 1) if p1 is not None else None,
                       g=m["g"], per=m["per"], tt=tw[0])
            for ty in ("all", m["mt"]): obs[(s, ty)].append(row)
    if i % 1000 == 0: log(f"  {i}/{len(trig)} markets")

def clz(o):
    n = len(o)
    if n < 2: return (0.0, 0.0, n, 0)
    mu = sum(r for r, _ in o) / n; g = defaultdict(float)
    for r, c in o: g[c] += r - mu
    se = math.sqrt(sum(v * v for v in g.values())) / n
    return (mu, mu / se if se > 0 else 0.0, n, len(g))
def cut(o, per, key="bw"): return clz([(d[key], d["g"]) for d in o if d["per"] == per and d[key] is not None])
def per_game(o, per, key="bw"):
    by = defaultdict(list)
    for d in o:
        if d["per"] == per and d[key] is not None: by[d["g"]].append(d)
    out = []
    for g, lst in by.items():
        t = min(d["tt"] for d in lst); tied = [d for d in lst if d["tt"] == t]
        out.append((sum(d[key] for d in tied) / len(tied), g))
    return out
cands, tested = [], 0
print(f"\n{'cell (BOT-WINDOW entry)':34s} discovery Dec-Jan                    | holdout Feb+                        | holdout immediate (info) | November (info)")
for s in SIGS:
    for ty in ("all", "moneyline", "total", "spread"):
        o = obs.get((s, ty), [])
        d, h, hi, nv = cut(o, "disc"), cut(o, "hold"), cut(o, "hold", "imm"), cut(o, "nov")
        tested += 1; flag = ""
        if d[2] >= 50 and abs(d[1]) >= 2 and h[2] >= 30 and d[0] * h[0] > 0 and abs(h[1]) >= 1:
            flag = "  <== CANDIDATE" + (" (FADE)" if d[0] < 0 else ""); cands.append((s, ty))
        elif d[2] >= 50 and abs(d[1]) >= 2: flag = "  (disc only, holdout fails)"
        print(f"{s+' / '+ty:34s} {d[0]*100:+6.1f}% z{d[1]:+5.1f} n{d[2]:5d} g{d[3]:4d} | {h[0]*100:+6.1f}% z{h[1]:+5.1f} n{h[2]:5d} g{h[3]:4d} "
              f"| {hi[0]*100:+6.1f}% z{hi[1]:+5.1f} n{hi[2]:5d} | {nv[0]*100:+6.1f}% n{nv[2]:4d}{flag}")
print(f"\ncells tested: {tested}; expected chance discovery hits at |z|>=2 ~{tested*0.046:.1f}")
print(f"CANDIDATES: {len(cands)}")
for s, ty in cands:
    o = obs[(s, ty)]
    for per in ("disc", "hold"):
        pg = per_game(o, per); mu, z, n, _ = clz(pg); w = sum(1 for r, _ in pg if r > 0)
        print(f"   {s} / {ty} ONE BET PER GAME {per}: {w}-{n-w} {mu*100:+.1f}% z{z:+.1f}")
import pickle
pickle.dump(dict(obs), open(DB.replace(".db", "_obs.pkl"), "wb"))
log("done")
