"""Are there informed wallets? Rank wallets on pregame fill CLV in a TRAIN period, measure them OOS in TEST.
CLV per fill = sign * (price at scheduled start - fill price), token0 terms. Follow cost ≈ 0.5c half-spread + up to 1.25c fee."""
import sys, numpy as np, pandas as pd
exec(open("research/exchange/studies.py").read().split('print("=" * 100)')[0])

t = tr[tr.rel < -900].copy()  # pregame, >15 min before start
t["sport"] = sport.reindex(t.condition_id).values
t["start"] = start.reindex(t.condition_id).values
t["p_start"] = [px(c, s // 60) for c, s in zip(t.condition_id, t.start)]
t["p_15"] = [px(c, m + 15) for c, m in zip(t.condition_id, t.minute)]
t["clv"] = t.sign * (t.p_start - t.p0)
t["m15"] = t.sign * (t.p_15 - t.p0)
t = t.dropna(subset=["clv"])
t = t[(t.p0 > 0.05) & (t.p0 < 0.95)]
split = pd.Timestamp("2026-08-24", tz="UTC").timestamp()
train, test = t[t.start < split], t[t.start >= split]
print(f"pregame fills: train {len(train)} ({train.wallet.nunique()} wallets), test {len(test)} ({test.wallet.nunique()} wallets)")
print(f"ALL fills CLV to start: train {fmt(*cl_mean(train,'clv'))}  test {fmt(*cl_mean(test,'clv'))}   (takers as a group vs the close)")
usd_w = lambda g: np.average(g.clv, weights=g.usd) * 100 if len(g) else np.nan
print(f"usd-weighted: train {usd_w(train):+.2f}c test {usd_w(test):+.2f}c")

# rank wallets in train
g = train.groupby("wallet").agg(n=("clv", "size"), clv=("clv", "mean"), usd=("usd", "sum"), sd=("clv", "std"))
g["t"] = g.clv / (g.sd / np.sqrt(g.n))
for min_n in [20, 50]:
    gg = g[g.n >= min_n].copy()
    gg["dec"] = pd.qcut(gg.t.rank(method="first"), 10, labels=False)
    print(f"\nwallets with >= {min_n} train fills: {len(gg)}; ranked by train t-stat of CLV")
    print("  decile | train clv | TEST clv (z, n fills, wallets active) | TEST 15m mark | test $")
    for d in [0, 4, 8, 9]:
        ws = gg[gg.dec == d].index
        te = test[test.wallet.isin(ws)]
        m, se, n = cl_mean(te, "clv"); m15, se15, _ = cl_mean(te, "m15")
        print(f"  {d:6d} | {gg[gg.dec==d].clv.mean()*100:+.2f}c   | {fmt(m,se,n)} wallets={te.wallet.nunique()} | {fmt(m15,se15,n)} | ${te.usd.sum():,.0f}")
    top = gg[gg.dec == 9].index
    te = test[test.wallet.isin(top)]
    big = te[te.usd >= 200]
    print(f"  top decile, TEST fills >= $200: {fmt(*cl_mean(big,'clv'))}  by sport: " +
          ", ".join(f"{s}:{fmt(*cl_mean(big[big.sport==s],'clv'))}" for s in ["mlb","atp","wta","epl","nfl"] if (big.sport==s).sum() >= 30))
    # top by raw mean instead of t
    gg["dec_m"] = pd.qcut(gg.clv.rank(method="first"), 10, labels=False)
    te2 = test[test.wallet.isin(gg[gg.dec_m == 9].index)]
    print(f"  (top decile by raw mean CLV instead: TEST {fmt(*cl_mean(te2,'clv'))})")

# persistence of the very best: top 20 wallets by train t with n>=50
best = g[g.n >= 50].sort_values("t", ascending=False).head(20)
te = test[test.wallet.isin(best.index)]
print(f"\ntop-20 wallets by train t (n>=50): train mean {best.clv.mean()*100:+.2f}c, TEST {fmt(*cl_mean(te,'clv'))}, test fills {len(te)}, active {te.wallet.nunique()}/20")
print("per-wallet test CLV (c) for those active:", (te.groupby("wallet").clv.mean()*100).round(2).sort_values(ascending=False).tolist())
print("\nfollow cost ≈ 0.5c half-spread + fee 0.05*p*(1-p)*100c (≈1.25c at p=.5) ⇒ ~1.75c/share needed to break even as a taker.")
