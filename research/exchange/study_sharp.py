"""Sharp-money follow test, held to RESOLUTION. Wallets ranked in TRAIN (starts < 8/24) by (a) CLV t-stat and (b) outcome P&L t-stat;
TEST (starts >= 8/24): copy each ranked wallet's pregame fill >= MIN_USD at (fill price + ENTRY_COST), hold to resolution.
Also an aggregate per-market signal: net sharp $ flow (top decile minus bottom decile) at first sighting → one bet per market."""
import numpy as np, pandas as pd
exec(open("research/exchange/studies.py").read().split('print("=" * 100)')[0])
ENTRY_COST = 0.005   # half-spread at entry; fee observed 0
MIN_USD = 200
w0 = mk.set_index("condition_id")["winner0"]
t = tr[tr.rel < -900].copy()
t["sport"] = sport.reindex(t.condition_id).values
t["start"] = start.reindex(t.condition_id).values
t["win0"] = w0.reindex(t.condition_id).values
t = t.dropna(subset=["win0"])
t["p_start"] = [px(c, s // 60) for c, s in zip(t.condition_id, t.start)]
t["clv"] = t.sign * (t.p_start - t.p0)
# outcome of the side bought: sign +1 = bought token0-equivalent at p0; wins if win0==1. sign -1 = bought token1 at (1-p0); wins if win0==0
t["side_price"] = np.where(t.sign > 0, t.p0, 1 - t.p0)
t["side_win"] = np.where(t.sign > 0, t.win0 == 1, t.win0 == 0)
t["roi"] = np.where(t.side_win, 1 / t.side_price - 1, -1.0)                      # the wallet's own ROI per $1
fp = t.side_price + ENTRY_COST
t["roi_follow"] = np.where(t.side_win, 1 / fp - 1, -1.0)                          # ours, entering at their price + cost
t = t[(t.side_price > 0.05) & (t.side_price < 0.95)]
split = pd.Timestamp("2026-08-24", tz="UTC").timestamp()
train, test = t[t.start < split], t[t.start >= split]
print(f"train fills {len(train)} ({train.condition_id.nunique()} mkts) test fills {len(test)} ({test.condition_id.nunique()} mkts)")
print(f"ALL takers, test: own ROI {fmt(*cl_mean(test,'roi'))}   CLV {fmt(*cl_mean(test,'clv'))}")

def rank(train, key, min_n=20):
    g = train.groupby("wallet").agg(n=(key, "size"), m=(key, "mean"), sd=(key, "std"), usd=("usd", "sum"))
    g = g[g.n >= min_n].copy()
    g["t"] = g.m / (g.sd.replace(0, np.nan) / np.sqrt(g.n))
    g["dec"] = pd.qcut(g.t.rank(method="first"), 10, labels=False)
    return g

for key, label in [("clv", "CLV"), ("roi", "outcome P&L")]:
    g = rank(train, key)
    print(f"\n=== wallets ranked by train {label} t-stat (n>=20 train fills, {len(g)} wallets) ===")
    print("  decile | TEST own ROI | TEST follow ROI (+0.5c) | TEST CLV | fills | $")
    for d in [0, 5, 8, 9]:
        te = test[test.wallet.isin(g[g.dec == d].index)]
        print(f"  {d:6d} | {fmt(*cl_mean(te,'roi'),scale=100,unit='%')} | {fmt(*cl_mean(te,'roi_follow'),scale=100,unit='%')} | {fmt(*cl_mean(te,'clv'))} | {len(te)} | ${te.usd.sum():,.0f}")
    top = test[test.wallet.isin(g[g.dec == 9].index) & (test.usd >= MIN_USD)]
    print(f"  TOP decile, fills >= ${MIN_USD}: follow ROI {fmt(*cl_mean(top,'roi_follow'),scale=100,unit='%')}  CLV {fmt(*cl_mean(top,'clv'))}  n={len(top)} mkts={top.condition_id.nunique()}")
    for s in ["mlb", "atp", "wta", "epl", "laliga", "nfl", "ncaaf"]:
        g2 = top[top.sport == s]
        if len(g2) >= 25:
            print(f"     {s:6s} follow ROI {fmt(*cl_mean(g2,'roi_follow'),scale=100,unit='%')}  CLV {fmt(*cl_mean(g2,'clv'))}  n={len(g2)}  fav share {(g2.side_price>=.5).mean()*100:.0f}%")
    # one bet per market: first top-decile fill >= MIN_USD in each test market
    first = top.sort_values("ts").groupby("condition_id").head(1)
    print(f"  ONE BET PER MARKET (first top-decile fill): follow ROI {fmt(*cl_mean(first,'roi_follow'),scale=100,unit='%')}  n={len(first)}  wins {int(first.side_win.sum())}")
    # aggregate: net sharp-minus-square flow per market at T-60m, bet the sign
    sharp = set(g[g.dec == 9].index); square = set(g[g.dec == 0].index)
    tt = test[test.wallet.isin(sharp | square)].copy()
    tt["w"] = np.where(tt.wallet.isin(sharp), 1, -1) * tt.sign * tt.usd
    net = tt.groupby("condition_id").w.sum()
    rows = []
    for cid, v in net.items():
        if abs(v) < 500: continue
        st = start[cid]; p = px(cid, st // 60 - 60)
        if not np.isfinite(p): continue
        side0 = v > 0
        price = (p if side0 else 1 - p) + ENTRY_COST
        win = (w0[cid] == 1) if side0 else (w0[cid] == 0)
        rows.append((cid, sport[cid], price, (1 / price - 1) if win else -1.0, win))
    agg = pd.DataFrame(rows, columns=["condition_id", "sport", "price", "roi", "win"])
    if len(agg):
        print(f"  NET SHARP FLOW >= $500 per market, bet at T-60m: ROI {fmt(*cl_mean(agg,'roi'),scale=100,unit='%')}  n={len(agg)}  wins {int(agg.win.sum())}  by sport: " +
              ", ".join(f"{s}:{cl_mean(agg[agg.sport==s],'roi')[0]*100:+.0f}%(n={(agg.sport==s).sum()})" for s in ["mlb","atp","wta","epl","nfl"] if (agg.sport==s).sum() >= 10))
