"""NBA exchange backtest on the 2025-26 season (2026-10-07). Charter: docs/charters/nba-exchange-backtest.md

Rules fixed BEFORE the first run (same method as cs2_deep_dive.py):
- unit: one obs per (market, side, cell) = mean ROI of small ($5-100) taker BUY fills at their executable price,
  0-6h before start, price 0.20-0.95, markets resolved 0/1 only. z clustered by GAME (teams + start).
- DISCOVERY = start < 2026-02-01, HOLDOUT = start >= 2026-02-01 (play-in + playoffs included).
- CANDIDATE only if discovery n>=50 & |z|>=2 AND holdout same sign with |z|>=1 & n>=30.
usage: python3 nba_backtest.py [db]   (default /root/polysharp/data/nba/nba_2025.db)
"""
import sqlite3, math, re, sys, time, bisect
from collections import defaultdict

DB = sys.argv[1] if len(sys.argv) > 1 else "/root/polysharp/data/nba/nba_2025.db"
SEASON_START = 1761004800  # 2025-10-21T00:00Z (preseason excluded)
SPLIT = 1769904000         # 2026-02-01T00:00Z
PLAYOFFS = 1776211200      # 2026-04-15T00:00Z (play-in onward; info-only cut of the holdout)
MINUSD, MAXUSD, BIGUSD = 5, 100, 500
TEAMS = {"Hawks", "Celtics", "Nets", "Hornets", "Bulls", "Cavaliers", "Mavericks", "Nuggets", "Pistons", "Warriors",
         "Rockets", "Pacers", "Clippers", "Lakers", "Grizzlies", "Heat", "Bucks", "Timberwolves", "Pelicans", "Knicks",
         "Thunder", "Magic", "76ers", "Suns", "Trail Blazers", "Kings", "Spurs", "Raptors", "Jazz", "Wizards"}
db = sqlite3.connect(DB, timeout=120)
t0 = time.time()

def pband(p): return "20-40c" if p < .40 else "40-50c" if p < .50 else "50-60c" if p < .60 else "60-80c" if p < .80 else "80-95c"
def tband(m): return "0-15m" if m < 15 else "15-60m" if m < 60 else "60-180m" if m < 180 else "3-6h"

# ---- markets -> games
raw = db.execute("SELECT condition_id, market_type, question, start, winner0 FROM markets "
                 "WHERE status='done' AND winner0 IN (0,1) AND start >= ?", (SEASON_START,)).fetchall()
games = {}            # gkey -> (start, (teamA, teamB))
by_team = defaultdict(list)
def game_key(st, a, b):
    k = (st // 600, tuple(sorted((a, b))))
    if k not in games:
        games[k] = (st, (a, b)); by_team[a].append(st); by_team[b].append(st)
    return k
mk, dropped = {}, defaultdict(int)
for cid, mt, q, st, w0 in raw:
    if mt in ("moneyline", "total"):
        m = re.match(r"^(.+?) vs\.? (.+?)(?:: O/U ([\d.]+))?$", q)
        if not m or m.group(1) not in TEAMS or m.group(2) not in TEAMS: dropped["non-NBA teams"] += 1; continue
        mk[cid] = dict(mt=mt, st=st, w0=w0, g=game_key(st, m.group(1), m.group(2)), teams=(m.group(1), m.group(2)))
    elif mt == "spread":
        m = re.match(r"^Spread: (.+?) \(([-+][\d.]+)\)", q)
        if not m or m.group(1) not in TEAMS: dropped["spread unparsed"] += 1; continue
        mk[cid] = dict(mt=mt, st=st, w0=w0, team=m.group(1), fav0=float(m.group(2)) < 0)
    else:
        dropped[mt] += 1
for cid, m in list(mk.items()):          # attach spreads to their game
    if m["mt"] != "spread": continue
    g = [k for k, (st, tm) in games.items() if m["team"] in tm and abs(st - m["st"]) < 3 * 3600]
    if len(g) != 1: dropped["spread no game"] += 1; del mk[cid]; continue
    m["g"] = g[0]
for t in by_team: by_team[t].sort()
def b2b(team, st):
    arr = by_team[team]; i = bisect.bisect_left(arr, st) - 1
    return i >= 0 and st - arr[i] < 30 * 3600
for m in mk.values():
    m["hold"] = m["st"] >= SPLIT; m["po"] = m["st"] >= PLAYOFFS

prices = defaultdict(list)
for cid, ts, p in db.execute("SELECT condition_id, ts, p FROM prices ORDER BY ts"):
    if cid in mk: prices[cid].append((ts, p))
def px(cid, t, tol=1800):
    arr = prices.get(cid)
    if not arr: return None
    i = bisect.bisect_right(arr, (t, 9)) - 1
    return arr[i][1] if i >= 0 and t - arr[i][0] < tol else None

fills = db.execute("""SELECT m.condition_id, t.asset=m.token0, t.price, t.size, t.ts FROM markets m
    CROSS JOIN trades t INDEXED BY trades_cond ON t.condition_id=m.condition_id
    WHERE m.status='done' AND m.winner0 IN (0,1) AND t.side='BUY'
      AND t.ts BETWEEN m.start-21600 AND m.start+3600 ORDER BY m.condition_id, t.ts""").fetchall()

# ---- coverage
bym = defaultdict(lambda: defaultdict(int))
for m in mk.values(): bym[time.strftime("%Y-%m", time.gmtime(m["st"]))][m["mt"]] += 1
print(f"NBA 2025-26: {len(mk)} markets in {len(games)} games, dropped {dict(dropped)}; {len(fills)} taker BUY fills  [{time.time()-t0:.0f}s]")
print("markets/month: " + "  ".join(f"{k} ml{v['moneyline']}/tot{v['total']}/spr{v['spread']}" for k, v in sorted(bym.items())))
print(f"with prices: {sum(1 for c in mk if prices.get(c))}/{len(mk)};  "
      f"discovery games {sum(1 for st, _ in games.values() if st < SPLIT)}, holdout games {sum(1 for st, _ in games.values() if st >= SPLIT)}")

cell = defaultdict(lambda: defaultdict(list))
drift_obs = defaultdict(lambda: defaultdict(list))
after_start = 0
for cid, is0, p, sz, ts in fills:
    m = mk.get(cid)
    if not m or not (0.20 <= p < 0.95): continue
    mins = (m["st"] - ts) / 60
    if mins < 0: after_start += 1; continue
    usd = p * sz; win = m["w0"] if is0 else 1 - m["w0"]; roi = win / p - 1
    mt, b, side = m["mt"], pband(p), (is0, cid)
    if usd > BIGUSD: cell[("big taker>$500", mt, b)][side].append(roi)
    if not (MINUSD <= usd <= MAXUSD): continue
    keys = [("type", mt), ("type×price", mt, b), ("type×price×time", mt, b, tband(mins))]
    if mt == "total":
        sl = "Over" if is0 else "Under"
        keys += [("total.side", sl), ("total.side×time", sl, tband(mins))]
        if b2b(m["teams"][0], m["st"]) or b2b(m["teams"][1], m["st"]): keys.append(("rest: total, a team on B2B", sl))
    elif mt == "spread":
        sl = "fav" if is0 == m["fav0"] else "dog"
        keys += [("spread.side", sl), ("spread.side×price", sl, b)]
    else:
        team, opp = (m["teams"][0], m["teams"][1]) if is0 else (m["teams"][1], m["teams"][0])
        tb, ob = b2b(team, m["st"]), b2b(opp, m["st"])
        if tb != ob: keys.append(("rest: ML side", "side on B2B, opp rested" if tb else "side rested, opp on B2B"))
        p2h = px(cid, ts - 7200)
        if p2h is not None:
            mv = p - (p2h if is0 else 1 - p2h)
            dbk = "shortening>3c" if mv > .03 else "drifting>3c" if mv < -.03 else "flat±3c"
            keys += [("ml.2h-move", dbk), ("ml.2h-move×price", dbk, b)]
        pc = px(cid, m["st"] - 60, 900)
        if pc is not None:
            drift_obs[("ml.drift-to-start", b, tband(mins))][side].append(((pc if is0 else 1 - pc) - p) * 100)
    for kk in keys: cell[kk][side].append(roi)

def clz(obs):
    n = len(obs)
    if n < 2: return (0.0, 0.0, n, 0)
    mu = sum(r for r, _ in obs) / n; g = defaultdict(float)
    for r, c in obs: g[c] += r - mu
    se = math.sqrt(sum(v * v for v in g.values())) / n
    return (mu, mu / se if se > 0 else 0.0, n, len(g))
def obs_of(store, k, sel):
    return [(sum(rs) / len(rs), mk[cid]["g"]) for (is0, cid), rs in store[k].items() if sel(mk[cid])]
DISC, HOLD, HOLD_RS = (lambda m: not m["hold"]), (lambda m: m["hold"]), (lambda m: m["hold"] and not m["po"])

print(f"fills after scheduled start (excluded): {after_start}")
tested, cands = 0, []
order = ["type", "type×price", "type×price×time", "total.side", "total.side×time", "spread.side", "spread.side×price",
         "ml.2h-move", "ml.2h-move×price", "rest: ML side", "rest: total, a team on B2B", "big taker>$500"]
for pre in order:
    ks = sorted([k for k in cell if k[0] == pre], key=lambda k: k[1:])
    if not ks: continue
    print(f"\n== {pre}      discovery (<2/1)                       | holdout (>=2/1)                      | holdout reg-season (info)")
    for k in ks:
        md, zd, nd, gd = clz(obs_of(cell, k, DISC)); mh, zh, nh, gh = clz(obs_of(cell, k, HOLD)); mr, zr, nr, _ = clz(obs_of(cell, k, HOLD_RS))
        if nd + nh < 40: continue
        tested += 1
        flag = ""
        if nd >= 50 and abs(zd) >= 2 and nh >= 30 and mh * md > 0 and abs(zh) >= 1:
            flag = "  <== CANDIDATE"; cands.append((k, md, zd, nd, gd, mh, zh, nh, gh))
        elif nd >= 50 and abs(zd) >= 2: flag = "  (disc only, holdout fails)"
        print(f"  {str(k[1:]):40s} {md*100:+6.1f}% z{zd:+5.1f} n{nd:5d} g{gd:4d} | {mh*100:+6.1f}% z{zh:+5.1f} n{nh:5d} g{gh:4d} "
              f"| {mr*100:+6.1f}% z{zr:+5.1f} n{nr:5d}{flag}")

print("\n== moneyline price drift fill -> start (cents toward the side bought; diagnostic only)")
for k in sorted(drift_obs, key=lambda k: k[1:]):
    dd = clz(obs_of(drift_obs, k, DISC)); dh = clz(obs_of(drift_obs, k, HOLD))
    if dd[2] + dh[2] < 40: continue
    print(f"  {str(k[1:]):30s} disc {dd[0]:+5.2f}c z{dd[1]:+5.1f} n{dd[2]:5d}  | hold {dh[0]:+5.2f}c z{dh[1]:+5.1f} n{dh[2]:5d}")

print(f"\ncells tested: {tested}  -> at |z|>=2 expect ~{tested*0.046:.0f} false discovery hits by chance; "
      f"P(chance hit also passes holdout same-sign |z|>=1) ~16%")
print(f"CANDIDATES: {len(cands)}")
for c in cands:
    print("  ", c[0], f"disc {c[1]*100:+.1f}% z{c[2]:+.1f} n{c[3]} g{c[4]} | hold {c[5]*100:+.1f}% z{c[6]:+.1f} n{c[7]} g{c[8]}")
print(f"done {time.time()-t0:.0f}s")
