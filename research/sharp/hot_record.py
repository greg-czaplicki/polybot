"""Pre-registered forward lane: HOT-RECORD WALLETS per market, per sport
(charter: docs/charters/hot-record-lane.md; mirrored at /root/polysharp/hot_record.py).

Owner's hypothesis (2026-09-15): "hot" is a per-event, per-day property — the wallets that are
hot tonight on Mets/Orioles need not be hot tomorrow — and hot means a RECORD, not a PnL sign:
"the top wallets are 10-2 in their last 12". The app's live signal uses the sign of Polymarket's
day/week PnL across all markets; this lane is the record version, in THIS sport only.

Rule (frozen; changing any constant = new charter version):
  T        = market start − 3600 s
  record   a wallet's pregame positions (one per market, usd-weighted net side) in the SAME sport on
           markets whose start + SETTLE_LAG <= T (settled before T — point-in-time); the last WINDOW
           of them; needs >= MIN_SETTLED
  hot      variant "record": wins >= ceil(HOT_WIN_RATE * len(window))            (the owner's rule)
           variant "units":  sum of ROI over the window > 0 (price-aware secondary)
  side     at T, net pregame position of every wallet on the market (fills with ts < T);
           the side with >= MIN_HOT hot wallets AND hot USD >= DOMINANCE × the other side's hot USD
  entry    FIRST taker-BUY fill of that side's token in [T, start] with $5 <= notional <= $100
  outcome  held to settlement, ROI = win / entry − 1
  grain    one row per market; z clustered by event_key; read PER SPORT, never pooled for a decision
Nothing here places, recommends or scores a bet.
"""
import bisect, math, os, sqlite3, sys, time
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import polysharp                      # load_fills / per_market / SETTLE_LAG — the same labelled fills the daily uses
from cell_lanes import clustered

LANE_START = 1789516800               # 2026-09-16 00:00:00Z — markets starting before this are reference only
DB = polysharp.DB
T_BEFORE = 3600
WINDOW = 12
MIN_SETTLED = 8
HOT_WIN_RATE = 0.75
MIN_HOT = 3
DOMINANCE = 2.0
ENTRY_MIN_USD, ENTRY_MAX_USD = 5.0, 100.0
VARIANTS = ("record", "units")


def build_histories(fills):
    """(wallet, sport) -> (sorted settled_ts list, wins list, roi list), one observation per market."""
    acc = defaultdict(list)
    for f in polysharp.per_market(fills):
        acc[(f["wallet"], f["sport"])].append((f["start"] + polysharp.SETTLE_LAG, 1 if f["roi"] > 0 else 0, f["roi"]))
    hist = {}
    for k, v in acc.items():
        v.sort()
        hist[k] = ([a for a, _, _ in v], [b for _, b, _ in v], [c for _, _, c in v])
    return hist


def window_at(hist, wallet, sport, t):
    """The wallet's last WINDOW settled-before-t observations in the sport, or None if < MIN_SETTLED."""
    h = hist.get((wallet, sport))
    if not h:
        return None
    ts, wins, rois = h
    i = bisect.bisect_right(ts, t)
    if i < MIN_SETTLED:
        return None
    lo = max(0, i - WINDOW)
    return wins[lo:i], rois[lo:i]


def is_hot(win_roi, variant):
    if win_roi is None:
        return False
    wins, rois = win_roi
    if variant == "record":
        return sum(wins) >= math.ceil(HOT_WIN_RATE * len(wins))
    return sum(rois) > 0


def lane_rows(db, fills, hist, variant, start_from=None, start_to=None):
    mk = {}
    q = "SELECT condition_id, COALESCE(event_key, condition_id), start, winner0, token0, token1, sport, market_type FROM markets WHERE status='done' AND winner0 IN (0,1) AND token1 IS NOT NULL"
    args = []
    if start_from is not None:
        q += " AND start>=?"; args.append(start_from)
    if start_to is not None:
        q += " AND start<?"; args.append(start_to)
    for r in db.execute(q, args):
        mk[r[0]] = r[1:]
    by_cid = defaultdict(list)
    for f in fills:                                   # load_fills output is sorted by ts
        if f["cid"] in mk:
            by_cid[f["cid"]].append(f)
    rows = []
    for cid, fs in by_cid.items():
        ek, st, w0, t0, t1, sport, mtype = mk[cid]
        T = st - T_BEFORE
        pos = defaultdict(float)                      # wallet -> net usd toward token0
        for f in fs:
            if f["ts"] >= T:
                break
            pos[f["wallet"]] += f["sign"] * f["usd"]
        hot_usd = [0.0, 0.0]; hot_n = [0, 0]
        for w, net in pos.items():
            if abs(net) < 1.0:
                continue
            if not is_hot(window_at(hist, w, sport, T), variant):
                continue
            side = 0 if net > 0 else 1
            hot_usd[side] += abs(net); hot_n[side] += 1
        sig = None
        for side in (0, 1):
            if hot_n[side] >= MIN_HOT and hot_usd[side] >= DOMINANCE * hot_usd[1 - side]:
                sig = side
        if sig is None:
            continue
        tok = t0 if sig == 0 else t1
        win = w0 if sig == 0 else 1 - w0
        r = db.execute("""SELECT price FROM trades WHERE condition_id=? AND asset=? AND side='BUY'
                          AND ts BETWEEN ? AND ? AND price*size BETWEEN ? AND ? ORDER BY ts LIMIT 1""",
                       (cid, tok, T, st, ENTRY_MIN_USD, ENTRY_MAX_USD)).fetchone()
        if not r or not (0.05 <= r[0] <= 0.95):
            continue
        rows.append(dict(cid=cid, ek=ek, sport=sport, mtype=mtype, start=st, side=sig, entry=r[0], win=win,
                         roi=win / r[0] - 1, hot_n=hot_n[sig], hot_n_opp=hot_n[1 - sig], hot_usd=hot_usd[sig],
                         hot_usd_opp=hot_usd[1 - sig], wallets=len(pos)))
    rows.sort(key=lambda r: r["start"])
    return rows


def _line(name, rows):
    m, z, n = clustered([(r["roi"], r["ek"]) for r in rows])
    wins = sum(r["win"] for r in rows)
    return f"{name:22s} ROI {m*100:+6.1f}% z={z:+4.1f} n={n:4d} wins {wins}/{n}"


def report_lines(db, now=None, fills=None):
    now = now or int(time.time())
    if fills is None:
        fills = polysharp.load_fills(db)
    hist = build_histories(fills)
    day = time.strftime("%Y-%m-%d", time.gmtime(LANE_START))
    out = ["", f"HOT-RECORD LANE (pre-registered, markets starting >= {day}; hot = wallet's record in THIS sport over its last "
               f"{WINDOW} settled pregame positions (min {MIN_SETTLED}, settled before T-60m): 'record' = >= {int(HOT_WIN_RATE*100)}% wins, "
               f"'units' = ROI sum > 0; side = >= {MIN_HOT} hot wallets and >= {DOMINANCE:g}x the other side's hot USD; "
               "entry = first small taker-BUY fill after T-60m; one row per market; z clustered by event; read per sport)"]
    for variant in VARIANTS:
        fwd = lane_rows(db, fills, hist, variant, start_from=LANE_START)
        ref = lane_rows(db, fills, hist, variant, start_to=LANE_START)
        out.append(f"  variant {variant}: FORWARD {_line('all sports (info only)', fwd)}   | reference (in-sample, pre-{day}) {_line('', ref)}")
        sports = sorted({r["sport"] for r in fwd + ref}, key=lambda s: -sum(1 for r in ref if r["sport"] == s))
        for s in sports:
            fs_ = [r for r in fwd if r["sport"] == s]; rs_ = [r for r in ref if r["sport"] == s]
            if len(fs_) + len(rs_) < 10:
                continue
            out.append(f"    {_line(s or 'unlabelled', fs_)}   | reference {_line('', rs_)}")
        out.append(f"      expectation: positive per sport; pass = n >= 100 rows in the sport, ROI > 0, clustered z >= 2 "
                   f"(then a record-only shadow lane in the app for one more n >= 100). ~{len(ref)} in-sample rows total.")
    return out


if __name__ == "__main__":
    db = sqlite3.connect(DB)
    print("\n".join(report_lines(db)))
