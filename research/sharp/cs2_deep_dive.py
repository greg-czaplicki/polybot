"""CS2 deep dive (2026-10-02): are there edges on the CS2 exchange beyond the 40-50c match-ML dog lane?

Rules fixed BEFORE the first run:
- unit: one obs per (market, side, cell) = mean ROI of small ($5-100) taker BUY fills at their actual
  (executable) price; pregame fills 0-6h before start unless the cell says in-play; price 0.20-0.95;
  markets resolved 0/1 only. z clustered by event_key (coarse key that lumps simultaneous matches ->
  conservative).
- DISCOVERY = market start < 2026-09-11 (the data the 9/11 cell read saw).
  HOLDOUT   = start >= 2026-09-11 (never used to choose anything).
- CANDIDATE only if discovery n>=50 & |z|>=2 AND holdout same sign with |z|>=1 & n>=30.
  Everything else is noise. The number of cells tested is printed so the false-positive rate is visible.
usage: python3 cs2_deep_dive.py
"""
import sqlite3, math, re, time, bisect
from collections import defaultdict

SPLIT = 1789084800  # 2026-09-11T00:00Z
MINUSD, MAXUSD = 5, 100
db = sqlite3.connect("/root/polysharp/data/sharp.db", timeout=120)
db.execute("ATTACH DATABASE '/root/polybook/data/polybook.db' AS book")
t0 = time.time()

def pband(p): return "20-40c" if p < .40 else "40-50c" if p < .50 else "50-60c" if p < .60 else "60-80c" if p < .80 else "80-95c"
def p5(p): lo = int(p * 20) * 5; return f"{lo}-{lo+5}c"
def tband(m): return "0-15m" if m < 15 else "15-60m" if m < 60 else "60-180m" if m < 180 else "3-6h"

def kind_of(q):
    if q.startswith("Map Handicap:"): return "handicap"
    if q.startswith("Games Total"): return "games_total"
    if re.search(r"Map \d Rounds Handicap", q): return "rounds_hcap"
    if re.search(r"Map \d Total Rounds", q): return "rounds_total"
    if re.search(r"Map \d Winner", q): return "map_winner"
    if re.search(r"\(BO\d\)", q): return "match"
    return "other"

T1 = re.compile(r"IEM|BLAST|Major|PGL|StarLadder|FISSURE|ESL Pro League|Esports World Cup|Perfect World", re.I)
QUAL = re.compile(r"Qualifier|Closed|Open|Play-In", re.I)
def event_of(q):
    m = re.search(r"\(BO\d\) - (.*)$", q); return m.group(1) if m else ""
def tier_of(ev):
    if QUAL.search(ev): return "qualifier"
    return "tier1" if T1.search(ev) else "tier2-3"
def stage_of(ev):
    return "playoffs" if re.search(r"Playoff", ev) else "group" if re.search(r"Group|Stage|Season", ev) else "other"
def teams_of(q):
    m = re.match(r"Counter-Strike: (.*?) vs (.*?) \(BO\d\)", q); return (m.group(1).strip().lower(), m.group(2).strip().lower()) if m else None

mk = {}
for cid, ek, q, st, w0, t0k, t1k in db.execute(
        "SELECT condition_id, COALESCE(event_key,condition_id), question, start, winner0, token0, token1 FROM markets "
        "WHERE sport='cs2' AND status='done' AND winner0 IN (0,1)"):
    k = kind_of(q); ev = event_of(q); fm = re.search(r"\((BO\d)\)", q)
    mk[cid] = dict(ek=ek, q=q, st=st, w0=w0, kind=k, ev=ev, tier=tier_of(ev) if k == "match" else None,
                   stage=stage_of(ev) if k == "match" else None, fmt=fm.group(1) if fm else None,
                   teams=teams_of(q), hold=st >= SPLIT, tok=(t0k, t1k))
labels = {cid: (l0, l1) for cid, l0, l1 in db.execute("SELECT condition_id, label0, label1 FROM book.markets")}
prices = defaultdict(list)
for cid, ts, p in db.execute("SELECT p.condition_id, p.ts, p.p FROM prices p JOIN markets m ON m.condition_id=p.condition_id "
                             "WHERE m.sport='cs2' ORDER BY p.ts"):
    prices[cid].append((ts, p))
def px(cid, t, tol=1800):
    arr = prices.get(cid)
    if not arr: return None
    i = bisect.bisect_right(arr, (t, 9)) - 1
    return arr[i][1] if i >= 0 and t - arr[i][0] < tol else None

fills = db.execute("""SELECT m.condition_id, t.asset=m.token0, t.price, t.size, t.ts FROM markets m
    CROSS JOIN trades t INDEXED BY trades_cond ON t.condition_id=m.condition_id
    WHERE m.sport='cs2' AND m.status='done' AND m.winner0 IN (0,1) AND t.side='BUY'
      AND t.ts BETWEEN m.start-21600 AND m.start+10800 ORDER BY m.condition_id, t.ts""").fetchall()
print(f"cs2: {len(fills)} taker BUY fills (pregame 6h + in-play 3h), {len(mk)} resolved markets "
      f"(discovery {sum(not v['hold'] for v in mk.values())}, holdout {sum(v['hold'] for v in mk.values())})  [{time.time()-t0:.0f}s]")

cell = defaultdict(lambda: defaultdict(list))
drift_obs = defaultdict(lambda: defaultdict(list))   # cents the side's price moves fill -> start
for cid, is0, p, sz, ts in fills:
    m = mk.get(cid)
    if not m or not (0.20 <= p < 0.95): continue
    usd = p * sz; win = m["w0"] if is0 else 1 - m["w0"]; roi = win / p - 1; mins = (m["st"] - ts) / 60
    k, side = m["kind"], (is0, cid)
    if usd > 500 and mins >= 0 and k == "match":
        cell[("m.big($500+) taker", pband(p))][side].append(roi)
    if not (MINUSD <= usd <= MAXUSD): continue
    if mins < 0:
        if k == "match": cell[("m.in-play", pband(p))][side].append(roi)
        continue
    keys = [("kind", k), ("kind×price", k, pband(p))]
    if k == "match":
        b = pband(p)
        keys += [("m.price5c", p5(p)), ("m.price×time", b, tband(mins)), ("m.fmt", m["fmt"]), ("m.fmt×price", m["fmt"], b),
                 ("m.tier", m["tier"]), ("m.tier×price", m["tier"], b), ("m.stage", m["stage"]), ("m.stage×price", m["stage"], b)]
        hr = time.gmtime(m["st"]).tm_hour
        hb = "00-08Z" if hr < 8 else "08-14Z" if hr < 14 else "14-20Z" if hr < 20 else "20-24Z"
        keys += [("m.startUTC", hb), ("m.startUTC×price", hb, b)]
        p2h = px(cid, ts - 7200)
        if p2h is not None:
            sp = p2h if is0 else 1 - p2h; mv = p - sp
            dbk = "shortening>3c" if mv > .03 else "drifting>3c" if mv < -.03 else "flat±3c"
            keys += [("m.2h-move", dbk), ("m.2h-move×price", dbk, b)]
        pc = px(cid, m["st"] - 60, 900)
        if pc is not None:
            drift_obs[("m.drift-to-start", b, tband(mins))][side].append(((pc if is0 else 1 - pc) - p) * 100)
    elif k in ("handicap", "games_total"):
        lab = labels.get(cid, ("?", "?"))[0 if is0 else 1] or "?"
        if k == "handicap": sl = "-1.5 (fav 2-0)" if is0 else "+1.5 (dog)"
        else: sl = "Over" if lab.lower().startswith("o") else "Under" if lab.lower().startswith("u") else "?"
        keys += [(k + ".side", sl), (k + ".side×price", sl, pband(p))]
    elif k == "map_winner":
        n = re.search(r"Map (\d) Winner", m["q"]).group(1)
        keys += [("map_winner.map", "Map " + n)]
    for kk in keys: cell[kk][side].append(roi)

def clz(obs):
    n = len(obs)
    if n < 2: return (0.0, 0.0, n)
    mu = sum(r for r, _ in obs) / n; g = defaultdict(float)
    for r, c in obs: g[c] += r - mu
    se = math.sqrt(sum(v * v for v in g.values())) / n
    return (mu, mu / se if se > 0 else 0.0, n)
def obs_of(store, k, hold):
    return [(sum(rs) / len(rs), mk[cid]["ek"]) for (is0, cid), rs in store[k].items() if mk[cid]["hold"] == hold]

tested, cands = 0, []
order = ["kind", "kind×price", "m.price5c", "m.price×time", "m.fmt", "m.fmt×price", "m.tier", "m.tier×price", "m.stage",
         "m.stage×price", "m.startUTC", "m.startUTC×price", "m.2h-move", "m.2h-move×price", "map_winner.map",
         "handicap.side", "handicap.side×price", "games_total.side", "games_total.side×price", "m.in-play", "m.big($500+) taker"]
for pre in order:
    ks = sorted([k for k in cell if k[0] == pre], key=lambda k: k[1:])
    if not ks: continue
    print(f"\n== {pre}      discovery (start<9/11)            | holdout (9/11-9/30)")
    for k in ks:
        md, zd, nd = clz(obs_of(cell, k, False)); mh, zh, nh = clz(obs_of(cell, k, True))
        if nd + nh < 40: continue
        tested += 1
        flag = ""
        if nd >= 50 and abs(zd) >= 2 and nh >= 30 and mh * md > 0 and abs(zh) >= 1: flag = "  <== CANDIDATE"; cands.append((k, md, zd, nd, mh, zh, nh))
        elif nd >= 50 and abs(zd) >= 2: flag = "  (disc only, holdout fails)"
        print(f"  {str(k[1:]):34s} {md*100:+6.1f}% z{zd:+5.1f} n{nd:5d}  | {mh*100:+6.1f}% z{zh:+5.1f} n{nh:5d}{flag}")

print("\n== price drift fill -> start (cents toward the side you bought; + = market moved your way)")
for k in sorted(drift_obs, key=lambda k: k[1:]):
    dd = clz(obs_of(drift_obs, k, False)); dh = clz(obs_of(drift_obs, k, True))
    if dd[2] + dh[2] < 40: continue
    print(f"  {str(k[1:]):30s} disc {dd[0]:+5.2f}c z{dd[1]:+5.1f} n{dd[2]:5d}  | hold {dh[0]:+5.2f}c z{dh[1]:+5.1f} n{dh[2]:5d}")

# ---- team persistence: does a team's discovery residual (win - T-60m price) predict its holdout residual?
res = defaultdict(lambda: {False: [], True: []})
for cid, m in mk.items():
    if m["kind"] != "match" or not m["teams"]: continue
    p = px(cid, m["st"] - 3600)
    if p is None or not (0.05 < p < 0.95): continue
    for team, pt, w in ((m["teams"][0], p, m["w0"]), (m["teams"][1], 1 - p, 1 - m["w0"])):
        res[team][m["hold"]].append((w - pt, pt, w, m["ek"]))
pairs = [(sum(r[0] for r in v[False]) / len(v[False]), v) for t, v in res.items() if len(v[False]) >= 5 and len(v[True]) >= 3]
xs = [a for a, _ in pairs]; ys = [sum(r[0] for r in v[True]) / len(v[True]) for _, v in pairs]
if len(xs) > 5:
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys)); vx = sum((x - mx) ** 2 for x in xs); vy = sum((y - my) ** 2 for y in ys)
    print(f"\n== team persistence: {len(pairs)} teams with >=5 discovery + >=3 holdout matches; "
          f"corr(discovery residual, holdout residual) = {cov/math.sqrt(vx*vy):+.3f}")
    for lab, sel in (("teams that OVERperformed price in discovery (resid>+.10)", lambda a: a > .10),
                     ("teams that UNDERperformed in discovery (resid<-.10)", lambda a: a < -.10)):
        obs = [((w / pt - 1), ek) for a, v in pairs if sel(a) for _, pt, w, ek in v[True] if pt >= .20]
        mu, z, n = clz(obs); print(f"  backing {lab}: holdout ROI {mu*100:+.1f}% z{z:+.1f} n={n}")

print(f"\ncells tested: {tested}  -> at |z|>=2 expect ~{tested*0.046:.0f} false discovery hits by chance; "
      f"P(chance hit also passes holdout same-sign |z|>=1) ~16%")
print(f"CANDIDATES: {len(cands)}")
for c in cands: print("  ", c[0], f"disc {c[1]*100:+.1f}% z{c[2]:+.1f} n{c[3]} | hold {c[4]*100:+.1f}% z{c[5]:+.1f} n{c[6]}")
print(f"done {time.time()-t0:.0f}s")
