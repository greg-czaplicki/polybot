"""EXPLORATORY read (not pre-registered): do the app's live picks do better when the hot-record wallets agree?

Joins the app's settled picks (JSON export of manual_picks: id, condition_id, sharp_side A/B, picked_at (s),
price, status, roi, bet_type, strategy_version, event_time) to the polysharp tape at EACH PICK'S OWN decision
time (picked_at): wallet positions = fills with ts < picked_at, wallet records = settled >= 6h before picked_at,
same hot definitions and side rule as hot_record.py. Side A = token0 (clobTokenIds[0]); the price check below
verifies that mapping on the tape. Outcome = the pick's own settled ROI (what the book actually earned).

  python pick_agreement.py picks.json
"""
import json, math, os, sqlite3, sys, time
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import polysharp, hot_record


def cstats(obs):
    """obs = [(roi, cluster)] -> (mean, se, n) with event-clustered se."""
    n = len(obs)
    if n < 2:
        return (sum(r for r, _ in obs) / n if n else 0.0, float("inf"), n)
    m = sum(r for r, _ in obs) / n
    g = defaultdict(float)
    for r, c in obs:
        g[c] += r - m
    se = math.sqrt(sum(v * v for v in g.values())) / n
    return (m, se, n)


def fmt(name, obs):
    m, se, n = cstats(obs)
    wins = sum(1 for r, _ in obs if r > 0)
    z = m / se if se > 0 and math.isfinite(se) else 0.0
    return f"{name:14s} n={n:4d} wins {wins:3d}/{n:<4d} ROI {m*100:+6.1f}% z={z:+4.1f}"


def diff_line(a, b):
    ma, sa, na = cstats(a); mb, sb, nb = cstats(b)
    if na < 2 or nb < 2:
        return "   agree − disagree: n/a"
    se = math.sqrt(sa * sa + sb * sb)
    return f"   agree − disagree: {100*(ma-mb):+.1f} pts, z={(ma-mb)/se:+.1f}"


def main(path):
    picks = json.load(open(path))
    db = sqlite3.connect(polysharp.DB)
    t0 = time.time()
    fills = polysharp.load_fills(db)
    hist = hot_record.build_histories(fills)
    cids = {p["condition_id"] for p in picks}
    mk = {}
    for r in db.execute("SELECT condition_id, COALESCE(event_key, condition_id), start, winner0, token0, token1, sport, status FROM markets"):
        if r[0] in cids:
            mk[r[0]] = r[1:]
    by_cid = defaultdict(list)
    for f in fills:
        if f["cid"] in cids:
            by_cid[f["cid"]].append(f)
    print(f"picks {len(picks)}; in tape {sum(1 for p in picks if p['condition_id'] in mk)}; "
          f"done in tape {sum(1 for p in picks if p['condition_id'] in mk and mk[p['condition_id']][6]=='done')}; "
          f"fills loaded {len(fills)} in {time.time()-t0:.0f}s")
    rows = []
    price_diffs = []
    unmatched = 0
    for p in picks:
        m = mk.get(p["condition_id"])
        if not m or m[6] != "done" or m[2] not in (0, 1):
            unmatched += 1
            continue
        ek, st, w0, t0_, t1, sport, _ = m
        T = int(p["picked_at"])
        side = 0 if p["sharp_side"] == "A" else 1
        # mapping check: token0 price at/before T vs the pick's entry price
        r = db.execute("SELECT p FROM prices WHERE condition_id=? AND ts<=? ORDER BY ts DESC LIMIT 1", (p["condition_id"], T)).fetchone()
        if r and p.get("price") is not None:
            exp = r[0] if side == 0 else 1 - r[0]
            price_diffs.append(abs(exp - p["price"]))
        pos = defaultdict(float)
        for f in by_cid.get(p["condition_id"], []):
            if f["ts"] >= T:
                break
            pos[f["wallet"]] += f["sign"] * f["usd"]
        rec = dict(cid=p["condition_id"], ek=ek, roi=p["roi"], win=1 if p["status"] == "win" else 0, side=side,
                   oos=T >= 1784592000, bet_type=p.get("bet_type"), wallets=len(pos))   # oos = picked after 2026-07-20 (post-gate)
        for variant in hot_record.VARIANTS:
            hot_usd = [0.0, 0.0]; hot_n = [0, 0]
            for w, net in pos.items():
                if abs(net) < 1.0:
                    continue
                if not hot_record.is_hot(hot_record.window_at(hist, w, sport, T), variant):
                    continue
                s = 0 if net > 0 else 1
                hot_usd[s] += abs(net); hot_n[s] += 1
            strict = None
            for s in (0, 1):
                if hot_n[s] >= hot_record.MIN_HOT and hot_usd[s] >= hot_record.DOMINANCE * hot_usd[1 - s]:
                    strict = s
            soft = None
            if hot_usd[0] + hot_usd[1] > 0 and hot_usd[0] != hot_usd[1]:
                soft = 0 if hot_usd[0] > hot_usd[1] else 1
            rec[variant] = dict(hot_n=hot_n, hot_usd=hot_usd, strict=strict, soft=soft)
        rows.append(rec)
    print(f"matched settled picks {len(rows)}, unmatched/unsettled-in-tape {unmatched}")
    if price_diffs:
        price_diffs.sort()
        print(f"side-A=token0 mapping check: median |tape price − pick price| = {price_diffs[len(price_diffs)//2]:.3f}, "
              f"90th pct {price_diffs[int(len(price_diffs)*0.9)]:.3f} (small = mapping right)")
    print(f"picks with any wallet positions before pick time: {sum(1 for r in rows if r['wallets']>0)}/{len(rows)}; "
          f"median wallets {sorted(r['wallets'] for r in rows)[len(rows)//2] if rows else 0}")

    def cut(rs, variant, rule):
        agree = [(r["roi"], r["ek"]) for r in rs if r[variant][rule] == r["side"]]
        dis = [(r["roi"], r["ek"]) for r in rs if r[variant][rule] is not None and r[variant][rule] != r["side"]]
        none = [(r["roi"], r["ek"]) for r in rs if r[variant][rule] is None]
        return agree, dis, none

    for label, rs in (("ALL settled MLB picks", rows),
                      ("post-2026-07-20 (out-of-sample era)", [r for r in rows if r["oos"]]),
                      ("totals only", [r for r in rows if r["bet_type"] == "total"]),
                      ("moneylines only", [r for r in rows if r["bet_type"] == "moneyline"])):
        print(f"\n== {label}: {fmt('baseline', [(r['roi'], r['ek']) for r in rs])}")
        for variant in hot_record.VARIANTS:
            for rule, desc in (("strict", ">=3 hot & 2x USD (lane rule)"), ("soft", "hot-USD majority, any count")):
                agree, dis, none = cut(rs, variant, rule)
                print(f"  hot={variant:6s} {desc}")
                print(f"    {fmt('agree', agree)}")
                print(f"    {fmt('disagree', dis)}")
                print(f"    {fmt('no hot side', none)}")
                print(diff_line(agree, dis))
    # hot-count ladder on the pick side (record variant): does MORE hot wallets on our side help?
    print("\n== hot-record wallets ON the pick side (record variant), all picks:")
    for lo, hi in ((0, 1), (1, 3), (3, 6), (6, 999)):
        obs = [(r["roi"], r["ek"]) for r in rows if lo <= r["record"]["hot_n"][r["side"]] < hi]
        label = f"{lo}-{hi-1} hot" if hi < 999 else f"{lo}+ hot"
        print(f"    {fmt(label, obs)}")
    print("\n== hot-record wallets AGAINST the pick side (record variant), all picks:")
    for lo, hi in ((0, 1), (1, 3), (3, 6), (6, 999)):
        obs = [(r["roi"], r["ek"]) for r in rows if lo <= r["record"]["hot_n"][1 - r["side"]] < hi]
        label = f"{lo}-{hi-1} hot" if hi < 999 else f"{lo}+ hot"
        print(f"    {fmt(label, obs)}")


if __name__ == "__main__":
    main(sys.argv[1])
