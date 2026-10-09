"""CS2 team-specialist skip — forward paper read (2026-10-09). Charter: docs/charters/cs2-team-specialist-forward.md

Lane rows and wallet records are the cs2_wallets.py rule verbatim, restricted to matches starting >= 2026-10-10T00:00Z.
Primary: S3_on_fav (team specialist on the favourite, none on the dog) — READ at n >= 100, PASS = ROI < 0 and z <= -2.
Writes a dated report to REPORT_DIR and prints it. Runs daily after cs2-daily.sh.
usage: python3 cs2_forward.py [db]
"""
import os, sqlite3, math, re, sys, time, bisect
from collections import defaultdict
from datetime import datetime, timezone

DB = sys.argv[1] if len(sys.argv) > 1 else "/root/polysharp/data/cs2/cs2_2025.db"
REPORT_DIR = os.environ.get("REPORT_DIR", "/root/polysharp/data/reports")
FORWARD_FROM, READ_N, STAKE = 1791590400, 100, 4.0          # 2026-10-10T00:00Z
SETTLE_LAG, ON_USD, MIN_STAKE = 4 * 3600, 100, 50
LANE_LO, LANE_HI, WIN_OPEN, WIN_CLOSE = 0.40, 0.50, 180 * 60, 60 * 60
db = sqlite3.connect(DB, timeout=120)

mk, bet = {}, set()
TEAMS_RE = re.compile(r"^Counter-Strike: (.+?) vs\.? (.+?)(?: \(BO\d\))?(?: - |$)")
for cid, mt, q, st, w0, tok0 in db.execute(
        "SELECT condition_id, market_type, question, start, winner0, token0 FROM markets "
        "WHERE status='done' AND winner0 IN (0,1) AND sport='cs2' AND condition_id IN (SELECT condition_id FROM fills_done)"):
    m = TEAMS_RE.match(q or "")
    teams = (m.group(1).strip(), m.group(2).strip()) if m else ()
    mk[cid] = dict(mt=mt, st=st, w0=w0, tok0=tok0, teams=teams, q=q,
                   g=(st // 600, tuple(sorted(teams))) if teams else (st // 600, cid))
    if mt == "moneyline" and teams and re.search(r"\(BO\d\)", q) and st >= FORWARD_FROM: bet.add(cid)

pos = defaultdict(lambda: [0.0, 0.0])
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
    m = mk[cid]; e = (m["st"] + SETTLE_LAG, pnl, stake)
    rec_all[w].append(e)
    for tm in m["teams"]: rec_team[(w, tm)].append(e)
del pos
def prefix(d):
    out = {}
    for k, lst in d.items():
        lst.sort(); ts, cp, cs = [], [0.0], [0.0]
        for s, p, st in lst: ts.append(s); cp.append(cp[-1] + p); cs.append(cs[-1] + st)
        out[k] = (ts, cp, cs)
    return out
R_all, R_team = prefix(rec_all), prefix(rec_team)
def stat(R, k, t):
    r = R.get(k)
    if not r: return 0, 0.0
    n = bisect.bisect_left(r[0], t)
    return n, (r[1][n] / r[2][n] if r[2][n] > 0 else 0.0)
def quals(w, cid, t):
    out = set()
    n, roi = stat(R_all, w, t)
    if n >= 30 and roi >= 0.10: out.add("S1")
    if any((lambda s: s[0] >= 10 and s[1] >= 0.15)(stat(R_team, (w, tm), t)) for tm in mk[cid]["teams"]): out.add("S3")
    return out

obs = defaultdict(list)   # cell -> [(roi, match, start, question)]
for cid in sorted(bet, key=lambda c: mk[c]["st"]):
    m = mk[cid]; st = m["st"]
    fl = db.execute("SELECT ts, asset = ?, price, wallet, side, price*size FROM fills_all WHERE condition_id = ? AND ts < ? ORDER BY ts",
                    (m["tok0"], cid, st)).fetchall()
    lane = next(((f[0], f[1], f[2]) for f in fl if st - WIN_OPEN <= f[0] < st - WIN_CLOSE and LANE_LO <= f[2] < LANE_HI), None)
    if not lane: continue
    T, dog, price = lane
    buys = defaultdict(lambda: [0.0, 0.0])
    for ts, is0, p, w, side, cash in fl:
        if ts >= T: break
        if side == "BUY": buys[w][is0] += cash
    on = {dog: defaultdict(set), 1 - dog: defaultdict(set)}
    for w, b in buys.items():
        for tok in (0, 1):
            if b[tok] >= ON_USD and b[tok] > b[1 - tok]:
                for q in quals(w, cid, T): on[tok][q].add(w)
    won = m["w0"] if dog else 1 - m["w0"]
    row = (won / price - 1, m["g"], st, m["q"])
    D, F = on[dog], on[1 - dog]
    obs["L0_lane"].append(row)
    s3fav = bool(F["S3"]) and not D["S3"]
    if s3fav: obs["S3_on_fav"].append(row)
    else: obs["lane_minus_S3_on_fav"].append(row)
    if D["S3"] and not F["S3"]: obs["S3_on_dog"].append(row)
    if F["S1"] and not D["S1"]: obs["S1_on_fav"].append(row)

def clz(o):
    n = len(o)
    if n < 2: return (sum(r for r, *_ in o) / n if n else 0.0, 0.0, n)
    mu = sum(r for r, *_ in o) / n; g = defaultdict(float)
    for r, c, *_ in o: g[c] += r - mu
    se = math.sqrt(sum(v * v for v in g.values())) / n
    return (mu, mu / se if se > 0 else 0.0, n)
now = datetime.now(timezone.utc)
out = [f"CS2 TEAM-SPECIALIST SKIP — forward paper read, {now:%Y-%m-%d %H:%MZ} (charter docs/charters/cs2-team-specialist-forward.md)",
       f"forward matches from 2026-10-10: {len(bet)} settled match winners crawled, {len(obs['L0_lane'])} lane rows"]
for c, tag in (("S3_on_fav", "PRIMARY (hypothesis: negative)"), ("L0_lane", "context"), ("lane_minus_S3_on_fav", "context: filtered lane"),
               ("S3_on_dog", "context"), ("S1_on_fav", "context")):
    mu, z, n = clz(obs[c])
    wins = sum(1 for r, *_ in obs[c] if r > 0)
    out.append(f"  {c:22s} {wins:3d}-{n-wins:<3d} {mu*100:+6.1f}% z{z:+5.1f} n{n:4d}  ${mu*n*STAKE:+8.2f} at ${STAKE:.0f}  [{tag}]")
mu, z, n = clz(obs["S3_on_fav"])
if n < READ_N: out.append(f"VERDICT: not read yet (n {n}/{READ_N}); no decision before n >= {READ_N}")
else: out.append("VERDICT: " + ("PASS — propose skip filter to owner (era bump, owner's go)" if mu < 0 and z <= -2 else "FAIL — no filter, do not re-cut"))
out.append("recent S3_on_fav rows:")
for r, g, st, q in obs["S3_on_fav"][-5:]:
    out.append(f"    {datetime.fromtimestamp(st, timezone.utc):%m-%d %H:%M}  {'WIN ' if r > 0 else 'LOSS'}  {q}")
txt = "\n".join(out)
print(txt)
os.makedirs(REPORT_DIR, exist_ok=True)
with open(os.path.join(REPORT_DIR, f"cs2_forward_{now:%Y-%m-%d}.txt"), "w") as f: f.write(txt + "\n")
