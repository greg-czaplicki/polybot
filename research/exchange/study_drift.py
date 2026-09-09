"""Side-selection features testable on the tape without shadows: favorite-longshot drift, pregame momentum, opening-vs-close."""
import numpy as np, pandas as pd
exec(open("research/exchange/studies.py").read().split('print("=" * 100)')[0])
rows = []
for cid, st in start.items():
    m0 = st // 60
    p6, p1, p0_ = px(cid, m0 - 360), px(cid, m0 - 60), px(cid, m0)
    p24 = px(cid, m0 - 1440)
    if np.isfinite(p6) and np.isfinite(p1) and np.isfinite(p0_):
        rows.append((cid, sport[cid], st, p24, p6, p1, p0_))
d = pd.DataFrame(rows, columns=["condition_id", "sport", "start", "p24", "p6", "p1", "p0"])
d["drift6"] = d.p0 - d.p6; d["drift1"] = d.p0 - d.p1; d["mom"] = d.p1 - d.p6
print(f"markets with prices at T-6h, T-1h, start: {len(d)}")
print("\nFavorite-longshot drift: mean (p_start - p_6h) by p_6h band, cents (token0). Positive = favorites (high p) drift up.")
d["band"] = pd.cut(d.p6, [0, .2, .35, .45, .55, .65, .8, 1], labels=["<20", "20-35", "35-45", "45-55", "55-65", "65-80", ">80"])
for k, g in d.groupby("band", observed=True):
    m, se, n = cl_mean(g, "drift6"); print(f"  p6 {k:6s} n={n:4d} drift6 {m*100:+.2f}c (z={m/se:+.1f})  drift1 {cl_mean(g,'drift1')[0]*100:+.2f}c")
print("\nMomentum: does the T-6h→T-1h move continue into the last hour? corr(mom, drift1) overall and by sport:")
print(f"  ALL corr={d[['mom','drift1']].corr().iloc[0,1]:+.3f}; mean drift1 when mom>=+2c: {cl_mean(d[d.mom>=.02],'drift1')[0]*100:+.2f}c (n={(d.mom>=.02).sum()}), when mom<=-2c: {cl_mean(d[d.mom<=-.02],'drift1')[0]*100:+.2f}c (n={(d.mom<=-.02).sum()})")
for s in ["mlb", "atp", "wta", "epl", "nfl", "ncaaf"]:
    g = d[d.sport == s]
    if len(g) < 40: continue
    print(f"  {s:5s} n={len(g):4d} corr={g[['mom','drift1']].corr().iloc[0,1]:+.3f}  mom>=+2c→drift1 {cl_mean(g[g.mom>=.02],'drift1')[0]*100:+.2f}c  mom<=-2c→ {cl_mean(g[g.mom<=-.02],'drift1')[0]*100:+.2f}c")
print("\nOpening (T-24h) vs close: |p_start - p_24h| median by sport (how much the pregame price actually moves):")
e = d.dropna(subset=["p24"])
print((e.assign(a=(e.p0 - e.p24).abs() * 100).groupby("sport").a.median().round(1).sort_values(ascending=False).head(8)).to_dict())
