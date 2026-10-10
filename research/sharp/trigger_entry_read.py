# Exploratory read 2026-10-09: one bet per game from wallet-trigger signals, entry at the trigger vs in the bot window.
# Built by prefixing totals_wallets.py records/qualifiers; usage: SPORT=nba SPLIT=1769904000 python3 trigger_entry_read.py <db>
"""Game-totals wallet backtest for any sport on the full tape (generalised from ncaaf_wallets.py, 2026-10-09).
Charters: docs/charters/nfl-wallet-backtest.md (SPORT=nfl), docs/charters/ncaaf-wallet-backtest.md (cfb, frozen script).
Adds the union cells HT (hot S2 or team S3 — the CFB-discovered rule) and GOOD (S1|S2|S3|S4), and $-at-$4 columns.

Fixed before the first run. Runs on the DESKTOP (research backfills never run on the VPS).
A: game cells — T = first fill in [start-180m, start-60m) priced 0.35-0.65 on the game's total lines (line closest to 0.50),
wallet state at T over all the game's total lines; qualifiers S1/S2/S3/S4/S5/S6 on exactly one side -> FOLLOW / FADE.
B: trigger cells (NBA method) on every total line. C: overlay on our own NCAAF totals shadow rows (context only).
Records: pregame positions in every CFB market, settled = start+4h before use. z clustered by game.
DISCOVERY start < 2026-07-01 (2025 season) / HOLDOUT >=. CANDIDATE = disc n>=50 |z|>=2 AND holdout same sign |z|>=1 n>=30.
usage: SPORT=nfl python3 totals_wallets.py <db> [shadow_json]
"""
import sqlite3, math, re, sys, time, bisect, json, os
from collections import defaultdict

DB = sys.argv[1]
SPORT = os.environ.get("SPORT", "cfb")
SHADOW = sys.argv[2] if len(sys.argv) > 2 else None
SPLIT = int(os.environ.get("SPLIT", 1782864000))    # default 2026-07-01T00:00Z (season boundary); NBA uses 2026-02-01
SETTLE_LAG = 4 * 3600
TRIG_USD, ON_USD, MIN_STAKE, LAT = 100, 100, 50, 60
LINE_LO, LINE_HI, WIN_OPEN, WIN_CLOSE = 0.35, 0.65, 180 * 60, 60 * 60
db = sqlite3.connect(DB, timeout=120)
t0 = time.time()
def log(s): print(f"{s}  [{time.time()-t0:.0f}s]", flush=True)

def teams_of(q, mt):
    q = q or ""
    if mt == "spread":
        m = re.match(r"^Spread: (.+?) \(", q)
        return (m.group(1).strip(),) if m else ()
    m = re.match(r"^(.+?) vs\.? (.+?)(?::|$)", q)
    return (m.group(1).strip(), m.group(2).strip()) if m else ()

# ---- markets: every resolved CFB market feeds records; game totals are the bet population
mk, games = {}, defaultdict(list)
for cid, mt, q, st, w0, tok0 in db.execute(
        "SELECT condition_id, market_type, question, start, winner0, token0 FROM markets "
        "WHERE status='done' AND winner0 IN (0,1) AND sport=? AND condition_id IN (SELECT condition_id FROM fills_done)", (SPORT,)):
    teams = teams_of(q, mt)
    gk = (tuple(sorted(teams)), (st - 6 * 3600) // 86400) if len(teams) == 2 else None
    mk[cid] = dict(mt=mt, st=st, w0=w0, tok0=tok0, teams=teams, hold=st >= SPLIT, g=gk or cid)
    if mt == "total" and gk: games[gk].append(cid)
log(f"{len(mk)} markets, {len(games)} games with totals, fills_all rows {db.execute('SELECT count(*) FROM fills_all').fetchone()[0]}")

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
rec_all, rec_tot, rec_team = defaultdict(list), defaultdict(list), defaultdict(list)
for (cid, w), (pnl, stake) in pos.items():
    if stake < MIN_STAKE: continue
    m = mk[cid]; e = (m["st"] + SETTLE_LAG, pnl, stake, 1 if pnl > 0 else 0)
    rec_all[w].append(e)
    if m["mt"] == "total": rec_tot[w].append(e)
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
R_all, R_tot, R_team = prefix(rec_all), prefix(rec_tot), prefix(rec_team)
del rec_all, rec_tot, rec_team
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
def quals(w, teams, t):
    out = {"S0"}
    n, roi = stat(R_all, w, t)
    if n >= 30 and roi >= 0.10: out.add("S1")
    if n >= 30 and roi <= -0.15: out.add("S6")
    if last12(w, t) >= 9: out.add("S2")
    if any((lambda s: s[0] >= 10 and s[1] >= 0.15)(stat(R_team, (w, tm), t)) for tm in teams): out.add("S3")
    n4, roi4 = stat(R_tot, w, t)
    if n4 >= 20 and roi4 >= 0.10: out.add("S4")
    return out

def game_fills(gk, before):
    """All fills on the game's total lines before `before`, Over-mapped: (ts, is_over, price, wallet, side, cash, cid)."""
    out = []
    for cid in games[gk]:
        m = mk[cid]
        for ts, is0, p, w, side, cash in db.execute(
                "SELECT ts, asset = ?, price, wallet, side, price*size FROM fills_all WHERE condition_id = ? AND ts < ? ORDER BY ts",
                (m["tok0"], cid, min(before, m["st"]))):
            out.append((ts, is0, p, w, side, cash, cid))
    out.sort()
    return out

def on_sides(fl, T, teams):
    """qualifier -> {side: set(wallets)} for wallets on Over (1) / Under (0) from fills < T."""
    buys = defaultdict(lambda: [0.0, 0.0])
    for ts, is0, p, w, side, cash, _ in fl:
        if ts >= T: break
        if side == "BUY": buys[w][is0] += cash
    on = defaultdict(lambda: {0: set(), 1: set()})
    for w, b in buys.items():
        for s in (0, 1):
            if b[s] >= ON_USD and b[s] > b[1 - s]:
                for q in quals(w, teams, T): on[q][s].add(w)
    for s in (0, 1):
        on["S5"][s] = on["S1"][s] | on["S4"][s]
        on["HT"][s] = on["S2"][s] | on["S3"][s]
        on["GOOD"][s] = on["S1"][s] | on["S2"][s] | on["S3"][s] | on["S4"][s]
    return on


from collections import defaultdict as dd
rows = dd(list)   # rule -> [(roi, gk, hold, month)]
RULES = {"S6": {"S6"}, "S3": {"S3"}, "S3|S6": {"S3", "S6"}, "S1fade": {"S1"}}
for i, (gk, cids) in enumerate(sorted(games.items(), key=lambda kv: mk[kv[1][0]]["st"])):
    st = min(mk[c]["st"] for c in cids); teams = mk[cids[0]]["teams"]; hold = st >= SPLIT
    fl = game_fills(gk, st)
    seen = set(); trig = []          # (ts, is_over, quals)
    for ts, is0, p, w, side, cash, cid in fl:
        if side != "BUY" or cash < TRIG_USD or ts < st - 86400 or (w, is0) in seen: continue
        seen.add((w, is0)); trig.append((ts, is0, quals(w, teams, ts), w))
    for rule, Q in RULES.items():
        fade = rule == "S1fade"
        sup = {0: None, 1: None}
        for ts, is0, qs, w in trig:
            if qs & Q:
                s_ = (1 - is0) if fade else is0
                if sup[s_] is None: sup[s_] = ts
        if (sup[0] is None) == (sup[1] is None): continue      # none or conflict (as of all pregame triggers)
        side_ = 1 if sup[1] is not None else 0; tt = sup[side_]
        # entry A: first fill on that side by anyone >= trigger+60s (trigger entry)
        # entry B: first fill in [st-180m, st-60m) priced 0.35-0.65 on that side, after the trigger (bot-window entry)
        eA = eB = None
        for ts, is0, p, w, side, cash, cid in fl:
            px = p if is0 == side_ else None
            if px is None: continue
            mm = mk[cid]
            if eA is None and ts >= tt + LAT and 0.05 <= px <= 0.95: eA = (px, cid)
            if eB is None and ts > tt and mm["st"] - WIN_OPEN <= ts < mm["st"] - WIN_CLOSE and 0.35 <= px <= 0.65: eB = (px, cid)
        mon = time.strftime("%Y-%m", time.gmtime(st))
        for lab, e in (("trigger", eA), ("window", eB)):
            if not e: continue
            mm = mk[e[1]]; won = mm["w0"] if side_ == 1 else 1 - mm["w0"]
            rows[(rule, lab)].append((won / e[0] - 1, gk, hold, mon))
def zz(o):
    n=len(o)
    if n<2: return 0,0
    mu=sum(o)/n; sd=(sum((x-mu)**2 for x in o)/(n-1))**.5
    return mu, (mu/(sd/n**.5) if sd else 0)
print(f"\nONE BET PER GAME — conflict-free signal over all pregame triggers 0-24h  (split {SPLIT})")
for k in sorted(rows):
    o=rows[k]; a=[r for r,_,_,_ in o]; d=[r for r,_,h,_ in o if not h]; h=[r for r,_,hh,_ in o if hh]
    w=sum(1 for x in a if x>0); ma,za=zz(a); md,zd=zz(d); mh,zh=zz(h)
    mons=dd(float)
    for r,_,_,m in o: mons[m]+=4*r
    print(f"{k[0]:7s} {k[1]:8s} {w}-{len(a)-w} all {ma*100:+.1f}% z{za:.1f} ${ma*len(a)*4:+.0f} | disc {md*100:+.1f}% z{zd:.1f} n{len(d)} | hold {mh*100:+.1f}% z{zh:.1f} n{len(h)} | " + " ".join(f"{m[2:]}:{v:+.0f}" for m,v in sorted(mons.items())))
