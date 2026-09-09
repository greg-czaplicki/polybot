"""Follow-ups: (2b) follow-the-sweep from the sweep's own last fill price; (3b) maker realized spread by horizon, hours-to-start, price band."""
import sqlite3, sys, numpy as np, pandas as pd
exec(open("research/exchange/studies.py").read().split('print("=" * 100)')[0])  # reuse loading + helpers

print("=" * 100)
print("STUDY 2b — follow the sweep: enter at the sweep's LAST fill price (worst price the sweeper paid), signed; pregame, >=61 min before start")
tr_pre = tr[tr.rel < 0].sort_values("ts")
sw = tr_pre.groupby(["condition_id", "tx", "wallet"]).agg(usd=("usd", "sum"), sgn=("sign", "first"), ts=("ts", "max"), p_last=("p0", "last"), p_first=("p0", "first"), n=("usd", "size")).reset_index()
sw["sport"] = sport.reindex(sw.condition_id).values; sw["minute"] = sw.ts // 60; sw["start"] = start.reindex(sw.condition_id).values
sw = sw[(sw.start // 60 - sw.minute) >= 61]
sw["walk"] = sw.sgn * (sw.p_last - sw.p_first)  # how far the sweep walked the book
for h in [5, 15, 60]:
    sw[f"f{h}"] = [s_.sgn * (px(c, m + h) - s_.p_last) for s_, c, m in zip(sw.itertuples(), sw.condition_id, sw.minute)]
sw["fstart"] = [s_.sgn * (px(c, st // 60) - s_.p_last) for s_, c, st in zip(sw.itertuples(), sw.condition_id, sw.start)]
for thr in [1000, 5000]:
    g = sw[sw.usd >= thr]
    print(f"\nsweeps >= ${thr}: n={len(g)}, mean book walk {g.walk.mean()*100:+.2f}c, multi-level sweeps {(g.n>1).mean()*100:.0f}%")
    for name, gg in [("ALL", g)] + [(s, g[g.sport == s]) for s in ["mlb", "atp", "nfl", "epl"]]:
        if len(gg) < 40: continue
        print(f"  {name:5s} vs last fill: +5m {fmt(*cl_mean(gg,'f5'))}  +15m {fmt(*cl_mean(gg,'f15'))}  +60m {fmt(*cl_mean(gg,'f60'))}  to-start {fmt(*cl_mean(gg,'fstart'))}")
print("(a follower also pays ~0.5c half-spread on entry and exit; net = these minus ~1c)")

print("\n" + "=" * 100)
print("STUDY 3b — maker realized half-spread (cents, maker's side), pregame, by horizon / hours-to-start / price band")
t3 = tr[(tr.rel < -900)].copy()
t3["sport"] = sport.reindex(t3.condition_id).values
t3["m_before"] = [px(c, m - 1) for c, m in zip(t3.condition_id, t3.minute)]
for h in [5, 15, 60]:
    t3[f"r{h}"] = t3.sign * (t3.p0 - np.array([px(c, m + h) for c, m in zip(t3.condition_id, t3.minute)]))
t3["rstart"] = t3.sign * (t3.p0 - np.array([px(c, s // 60) for c, s in zip(t3.condition_id, start.reindex(t3.condition_id).values)]))
t3["eff"] = t3.sign * (t3.p0 - t3.m_before)
t3 = t3[(t3.p0 > 0.05) & (t3.p0 < 0.95)]
t3["hrs"] = pd.cut(-t3.rel / 3600, [0.25, 1, 3, 6, 24, 1e9], labels=["15m-1h", "1-3h", "3-6h", "6-24h", ">24h"])
t3["band"] = pd.cut(t3.p0, [0.05, 0.25, 0.45, 0.55, 0.75, 0.95], labels=["5-25", "25-45", "45-55", "55-75", "75-95"])
def line(name, gg):
    if len(gg) < 500: return
    e = cl_mean(gg, "eff"); r5 = cl_mean(gg, "r5"); r15 = cl_mean(gg, "r15"); r60 = cl_mean(gg, "r60"); rs = cl_mean(gg, "rstart")
    usd = gg.usd.sum() / 1e6
    print(f"  {name:8s} ${usd:6.1f}M eff {e[0]*100:+.2f}c | realized +5m {fmt(*r5)} +15m {fmt(*r15)} +60m {fmt(*r60)} held-to-start {fmt(*rs)}")
print("by hours-to-start (ALL sports):")
for k, gg in t3.groupby("hrs", observed=True): line(str(k), gg)
print("by hours-to-start (MLB):")
for k, gg in t3[t3.sport == "mlb"].groupby("hrs", observed=True): line(str(k), gg)
print("by price band (ALL, pregame):")
for k, gg in t3.groupby("band", observed=True): line(str(k), gg)
print("by sport, OOS only (start >= 8/20):")
oos = t3[start.reindex(t3.condition_id).values >= pd.Timestamp("2026-08-20", tz="UTC").timestamp()]
for s in ["mlb", "atp", "wta", "nfl", "ncaaf", "epl", "laliga"]: line(s, oos[oos.sport == s])
print("\ntaker-side mirror: takers' mean 15m mark-to-market per $1 = negative of maker realized; takers as a group LOSE the realized spread pregame.")
