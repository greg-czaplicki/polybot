"""Pre-registered forward cell lanes (charter: docs/charters/cell-lanes.md).

The polysharp crawl stores every settled market's full pre-start tape and 1-min
price series, so a forward lane needs no live recorder: the rule is frozen here,
the start date is git-committed, and the read is computed from the crawl.

Rule (identical for every lane):
  trigger  T60 = market start − 3600 s
  price    the side's last prices-history value at or before T60 (token1 = 1 − token0)
  member   sport / market_type / price band as defined in LANES
  entry    the FIRST taker-BUY fill of that side's token in [T60, start] with
           $5 ≤ notional ≤ $100 (a small taker's executable price); no fill → no row
  outcome  held to settlement, ROI = win / entry − 1
  grain    one row per (market, side); z clustered by event_key
Nothing here places, recommends or scores a bet.
"""
import math, sqlite3, sys, time, os
from collections import defaultdict

LANE_START = 1789171200            # 2026-09-12 00:00:00Z — markets starting before this are reference only
DB = os.environ.get("SHARP_DB", "/root/polysharp/data/sharp.db")

LANES = {
    # name                    sport   market_type  lo    hi    expectation (pre-registered)
    "atp_dog_cell":          ("atp",  "moneyline", 0.20, 0.40, "positive; pass = ROI>0 & clustered z>=2 at n>=150"),
    "mlb_runline_dog_cell":  ("mlb",  "spread",    0.20, 0.40, "positive; likely a 2027 read (n<100 expected this season)"),
    "guard_atp_fav_60_80":   ("atp",  "moneyline", 0.60, 0.80, "negative guard; <= -4% recent-half -> price-band gate"),
    "guard_cs2_fav_50_95":   ("cs2",  "moneyline", 0.50, 0.95, "negative guard; <= -4% recent-half -> price-band gate"),
    "guard_mlb_total_60_80": ("mlb",  "total",     0.60, 0.80, "negative guard; <= -4% recent-half -> price-band gate"),
    # Replication lanes (charter v1.1, 2026-09-11): the ATP/CS2 structure applied to sports whose own tape was too
    # thin to read (< 250 markets). Bands are copied, NOT fitted to these sports. Same pass rule as atp_dog_cell.
    "repl_nfl_dog_cell":     ("nfl",   "moneyline", 0.20, 0.40, "replication of the dog cell; read at n>=150"),
    "repl_nfl_fav_60_80":    ("nfl",   "moneyline", 0.60, 0.80, "replication of the favourite guard"),
    "repl_ncaaf_dog_cell":   ("ncaaf", "moneyline", 0.20, 0.40, "replication of the dog cell; read at n>=150"),
    "repl_ncaaf_fav_60_80":  ("ncaaf", "moneyline", 0.60, 0.80, "replication of the favourite guard"),
    "repl_epl_dog_cell":     ("epl",   "moneyline", 0.20, 0.40, "replication of the dog cell (3-way market: draw side included); read at n>=150"),
    "repl_epl_fav_60_80":    ("epl",   "moneyline", 0.60, 0.80, "replication of the favourite guard"),
}


def clustered(obs):
    """obs = [(roi, cluster)] -> (mean, z, n)"""
    n = len(obs)
    if n < 2:
        return (0.0, 0.0, n)
    m = sum(r for r, _ in obs) / n
    g = defaultdict(float)
    for r, c in obs:
        g[c] += r - m
    se = math.sqrt(sum(v * v for v in g.values())) / n
    return (m, m / se if se > 0 else 0.0, n)


def lane_rows(db, name, start_from=None, start_to=None):
    sport, mtype, lo, hi, _ = LANES[name]
    q = """SELECT m.condition_id, COALESCE(m.event_key, m.condition_id), m.start, m.winner0, m.token0, m.token1,
                  (SELECT p FROM prices q WHERE q.condition_id=m.condition_id AND q.ts<=m.start-3600 ORDER BY q.ts DESC LIMIT 1)
           FROM markets m
           WHERE m.sport=? AND m.market_type=? AND m.status='done' AND m.winner0 IN (0,1) AND m.token1 IS NOT NULL"""
    args = [sport, mtype]
    if start_from is not None:
        q += " AND m.start>=?"; args.append(start_from)
    if start_to is not None:
        q += " AND m.start<?"; args.append(start_to)
    rows = []
    for cid, ek, st, w0, t0, t1, p0 in db.execute(q, args):
        if p0 is None:
            continue
        for side, tok, sp, win in ((0, t0, p0, w0), (1, t1, 1 - p0, 1 - w0)):
            if not (lo <= sp < hi):
                continue
            r = db.execute("""SELECT price FROM trades WHERE condition_id=? AND asset=? AND side='BUY'
                              AND ts BETWEEN ? AND ? AND price*size BETWEEN 5 AND 100 ORDER BY ts LIMIT 1""",
                           (cid, tok, st - 3600, st)).fetchone()
            if not r or not (0.05 <= r[0] <= 0.95):
                continue
            rows.append((cid, side, ek, st, sp, r[0], win, win / r[0] - 1))
    return rows


def report_lines(db, now=None):
    now = now or int(time.time())
    out = ["", f"FORWARD CELL LANES (pre-registered, markets starting >= {time.strftime('%Y-%m-%d', time.gmtime(LANE_START))}; "
               "entry = first small taker-BUY fill after T-60m; one row per market-side; z clustered by event)"]
    for name, (sport, mtype, lo, hi, expect) in LANES.items():
        fwd = lane_rows(db, name, start_from=LANE_START)
        m, z, n = clustered([(r[7], r[2]) for r in fwd])
        wins = sum(r[6] for r in fwd)
        ref = lane_rows(db, name, start_to=LANE_START)
        rm, rz, rn = clustered([(r[7], r[2]) for r in ref])
        out.append(f"  {name:24s} {sport:4s} {mtype:9s} {lo:.2f}-{hi:.2f}  FORWARD ROI {m*100:+6.1f}% z={z:+4.1f} n={n:4d} wins {wins}/{n}"
                   f"   | reference (in-sample, pre-{time.strftime('%Y-%m-%d', time.gmtime(LANE_START))}) {rm*100:+6.1f}% z={rz:+4.1f} n={rn}")
        out.append(f"      expectation: {expect}")
    return out


if __name__ == "__main__":
    db = sqlite3.connect(DB)
    print("\n".join(report_lines(db)))
