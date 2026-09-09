"""Exchange-data studies on the crawled dataset. No outcome model, no Pinnacle.

1. Order-flow drift (pregame): does signed taker flow over the last 30 min predict the next 30/60 min?
2. Large fills: continuation or reversal after a taker sweep?
3. Maker economics: effective vs realized half-spread per taker fill (pregame and in-play).
4. Liquidity by time-to-start per sport.
All means reported with market-clustered standard errors. Prices are the CLOB 1-min series for token0.
"""
import sqlite3, sys, numpy as np, pandas as pd

DB = sys.argv[1] if len(sys.argv) > 1 else "research/exchange/data/exchange.db"
COST_C = 1.0  # cents round-trip assumed for taker strategies (spread crossing), reported alongside gross
db = sqlite3.connect(DB)

mk = pd.read_sql("SELECT condition_id, sport_tag, market_type, event_time, game_start_time, token0, token1, winner0 FROM markets WHERE status='done'", db)
gs = pd.to_datetime(mk.game_start_time, utc=True, errors="coerce")
gs_epoch = (gs - pd.Timestamp(0, tz="UTC")) // pd.Timedelta(seconds=1)
mk["start"] = gs_epoch.fillna(mk.event_time).astype("int64")
mk = mk[mk.sport_tag.notna()].copy()
start = mk.set_index("condition_id")["start"]
tok0 = mk.set_index("condition_id")["token0"]; tok1 = mk.set_index("condition_id")["token1"]
sport = mk.set_index("condition_id")["sport_tag"]

tr = pd.read_sql("SELECT condition_id, tx, wallet, asset, side, price, size, ts FROM trades", db)
tr = tr[tr.condition_id.isin(start.index)].copy()
tr["usd"] = tr.price * tr["size"]
is0 = tr.asset.values == tok0.reindex(tr.condition_id).values
is1 = tr.asset.values == tok1.reindex(tr.condition_id).values
buy = tr.side.values == "BUY"
tr["sign"] = np.where((buy & is0) | (~buy & is1), 1, np.where((buy & is1) | (~buy & is0), -1, 0))
tr = tr[tr.sign != 0].copy()
tr["p0"] = np.where(tr.asset.values == tok0.reindex(tr.condition_id).values, tr.price, 1 - tr.price)  # fill price in token0 terms
tr["rel"] = tr.ts - start.reindex(tr.condition_id).values  # seconds relative to start
tr["minute"] = tr.ts // 60

pr = pd.read_sql("SELECT condition_id, ts, p FROM prices", db)
pr = pr[pr.condition_id.isin(start.index)].copy()
pr["minute"] = pr.ts // 60
pr = pr.sort_values(["condition_id", "minute"]).drop_duplicates(["condition_id", "minute"], keep="last")
# per-market minute→price lookup with forward fill on a dense grid
price_at = {}
for cid, g in pr.groupby("condition_id", sort=False):
    idx = np.arange(g.minute.iloc[0], g.minute.iloc[-1] + 1)
    s = pd.Series(g.p.values, index=g.minute.values).reindex(idx).ffill()
    price_at[cid] = s

def px(cid, minute):
    s = price_at.get(cid)
    if s is None or minute < s.index[0] or minute > s.index[-1]:
        return np.nan
    return s.iloc[int(minute - s.index[0])]

def cl_mean(df, col, cluster="condition_id"):
    """Mean with cluster-robust SE (clusters = markets)."""
    d = df[[cluster, col]].dropna()
    n = len(d)
    if n < 2: return np.nan, np.nan, n
    m = d[col].mean()
    g = d.groupby(cluster)[col].agg(["sum", "count"])
    resid = (g["sum"] - m * g["count"])
    se = np.sqrt((resid ** 2).sum()) / n
    return m, se, n

def fmt(m, se, n, scale=100, unit="c"):
    if n < 2 or not np.isfinite(se) or se == 0: return f"n={n}"
    return f"{m*scale:+.2f}{unit} (z={m/se:+.1f}, n={n})"

print("=" * 100)
print("STUDY 4 — where is the liquidity? USD by time-to-start, per sport (share of market total)")
b = pd.cut(-tr.rel / 3600, bins=[-1e9, 0, 1, 6, 24, 1e9], labels=["in-play", "<1h", "1-6h", "6-24h", ">24h"])
liq = tr.assign(bucket=b, sport=sport.reindex(tr.condition_id).values).groupby(["sport", "bucket"], observed=True).usd.sum().unstack(fill_value=0)
liq = liq[["in-play", "<1h", "1-6h", "6-24h", ">24h"]]
tot = liq.sum(axis=1)
out = (liq.div(tot, axis=0) * 100).round(0).astype(int)
out["total_$M"] = (tot / 1e6).round(1)
out["per_mkt_$k"] = (tot / mk.groupby("sport_tag").size().reindex(out.index) / 1e3).round(0)
print(out.sort_values("total_$M", ascending=False).to_string())

print("\n" + "=" * 100)
print("STUDY 1 — order-flow drift, pregame. Feature: signed taker USD flow on token0 over prior 30 min; target: p(t+h)-p(t)")
sf = tr[tr.rel < 0].assign(susd=tr.sign * tr.usd).groupby(["condition_id", "minute"]).susd.sum()
rows = []
for cid, st in start.items():
    s = sf.loc[cid] if cid in sf.index.get_level_values(0) else None
    m0 = st // 60
    for t in range(m0 - 360, m0 - 29, 30):  # samples every 30 min, last one exits at start
        p_t = px(cid, t)
        if not np.isfinite(p_t): continue
        f30 = float(s.loc[(s.index > t - 30) & (s.index <= t)].sum()) if s is not None else 0.0
        mom = p_t - px(cid, t - 30)
        rows.append((cid, sport[cid], st, t, p_t, f30, mom, px(cid, t + 30) - p_t, px(cid, min(t + 60, m0)) - p_t))
fd = pd.DataFrame(rows, columns=["condition_id", "sport", "start", "t", "p", "flow", "mom", "fwd30", "fwd60"])
fd = fd[(fd.p > 0.1) & (fd.p < 0.9)]
fd["oos"] = fd.start >= pd.Timestamp("2026-08-20", tz="UTC").timestamp()
print(f"samples {len(fd)} across {fd.condition_id.nunique()} markets; |flow|>0 in {(fd.flow!=0).mean()*100:.0f}% of samples")
for name, g in [("ALL", fd)] + [(s, fd[fd.sport == s]) for s in ["mlb", "atp", "wta", "nfl", "ncaaf", "epl", "laliga"]]:
    if len(g) < 200: continue
    c30 = g[["flow", "fwd30"]].corr().iloc[0, 1]; c60 = g[["flow", "fwd60"]].corr().iloc[0, 1]; cm = g[["mom", "fwd30"]].corr().iloc[0, 1]
    big = g[g.flow.abs() >= 500].copy()
    big["ret30"] = np.sign(big.flow) * big.fwd30; big["ret60"] = np.sign(big.flow) * big.fwd60
    m30, se30, n30 = cl_mean(big, "ret30"); m60, se60, n60 = cl_mean(big, "ret60")
    bo = big[big.oos]; mo, seo, no = cl_mean(bo, "ret30")
    print(f"{name:7s} n={len(g):6d} corr(flow,fwd30)={c30:+.3f} corr(flow,fwd60)={c60:+.3f} corr(mom,fwd30)={cm:+.3f} | follow-flow |flow|>=$500: 30m {fmt(m30,se30,n30)} 60m {fmt(m60,se60,n60)} | OOS(>=8/20) 30m {fmt(mo,seo,no)}")
# decile table on ALL
fd["dec"] = pd.qcut(fd.flow.rank(method="first"), 10, labels=False)
print("flow decile → mean fwd30 (cents):", (fd.groupby("dec").fwd30.mean() * 100).round(2).tolist())
print(f"(taker round-trip cost assumed ≈ {COST_C:.1f}c; a rule needs gross > that to be worth anything)")

print("\n" + "=" * 100)
print("STUDY 2 — large taker sweeps (one tx, one wallet), pregame: signed price change after the sweep")
sw = tr[tr.rel < 0].groupby(["condition_id", "tx", "wallet"]).agg(usd=("usd", "sum"), sgn=("sign", "first"), ts=("ts", "max"), n=("usd", "size")).reset_index()
sw["sport"] = sport.reindex(sw.condition_id).values
sw["minute"] = sw.ts // 60
sw["start"] = start.reindex(sw.condition_id).values
sw = sw[(sw.start // 60 - sw.minute) >= 61]  # room for +60 pregame
for h in [5, 15, 60]:
    sw[f"d{h}"] = [sw_.sgn * (px(c, m + h) - px(c, m)) for sw_, c, m in zip(sw.itertuples(), sw.condition_id, sw.minute)]
sw["pre"] = [s_.sgn * (px(c, m) - px(c, m - 1)) for s_, c, m in zip(sw.itertuples(), sw.condition_id, sw.minute)]
for thr in [250, 1000, 5000]:
    g = sw[sw.usd >= thr]
    print(f"\nsweeps >= ${thr}: n={len(g)} in {g.condition_id.nunique()} markets; impact at fill minute {fmt(*cl_mean(g,'pre'))}")
    for name, gg in [("ALL", g)] + [(s, g[g.sport == s]) for s in ["mlb", "atp", "wta", "nfl", "ncaaf", "epl"]]:
        if len(gg) < 30: continue
        print(f"  {name:7s} +5m {fmt(*cl_mean(gg,'d5'))}  +15m {fmt(*cl_mean(gg,'d15'))}  +60m {fmt(*cl_mean(gg,'d60'))}")

print("\n" + "=" * 100)
print("STUDY 3 — maker economics per taker fill: effective half-spread (fill vs mid 1 min before) and realized (fill vs mid 15 min after), in cents, from the MAKER's side")
t3 = tr.copy()
t3["m_before"] = [px(c, m - 1) for c, m in zip(t3.condition_id, t3.minute)]
t3["m_after"] = [px(c, m + 15) for c, m in zip(t3.condition_id, t3.minute)]
# taker buys token0-equivalent at p0 (sign=+1) → maker sold at p0: eff = p0 - m_before, real = p0 - m_after
# taker sells token0-equivalent (sign=-1) → maker bought at p0: eff = m_before - p0, real = m_after - p0
t3["eff"] = t3.sign * (t3.p0 - t3.m_before)
t3["real"] = t3.sign * (t3.p0 - t3.m_after)
t3["sport"] = sport.reindex(t3.condition_id).values
t3 = t3[(t3.p0 > 0.05) & (t3.p0 < 0.95)]
for phase, g in [("pregame (>15m before start)", t3[t3.rel < -900]), ("in-play", t3[t3.rel > 0])]:
    print(f"\n{phase}: fills={len(g)}")
    for name, gg in [("ALL", g)] + [(s, g[g.sport == s]) for s in ["mlb", "atp", "wta", "nfl", "ncaaf", "epl", "laliga"]]:
        if len(gg) < 500: continue
        e, es, n = cl_mean(gg, "eff"); r, rs, _ = cl_mean(gg, "real")
        # usd-weighted realized
        w = gg.dropna(subset=["real"]); rw = np.average(w.real, weights=w.usd) if len(w) else np.nan
        print(f"  {name:7s} effective {fmt(e,es,n)}  realized(15m) {fmt(r,rs,n)}  usd-weighted realized {rw*100:+.2f}c  adverse selection {(e-r)*100:+.2f}c")
print("\nInterpretation: realized > 0 means makers keep part of the spread after the price reacts; realized < 0 means takers are informed and run makers over.")
