"""Sharp-money refinements: streaks (trailing settled form), wager sizing (vs wallet's usual), and who is on the other side
(square money on the opposite outcome; with/against the crowd). Sharp = top decile by train outcome-P&L t-stat; square = bottom decile."""
import numpy as np, pandas as pd
exec(open("research/exchange/study_sharp.py").read().split('for key, label in')[0])
g = rank(train, "roi")
sharp = set(g[g.dec == 9].index); square = set(g[g.dec == 0].index)
gc = rank(train, "clv"); sharp_clv = set(gc[gc.dec == 9].index)
t = t.sort_values("ts").copy()
# --- streak: trailing ROI over the wallet's previous 20 fills whose market had started >= 4h before this fill (settled) ---
t["settle_ts"] = t.start + 4 * 3600
streak = np.full(len(t), np.nan)
med_usd = np.full(len(t), np.nan)
for w, idx in t.groupby("wallet").indices.items():
    sub = t.iloc[idx]
    ts = sub.ts.values; st = sub.settle_ts.values; roi = sub.roi.values; usd = sub.usd.values
    order = np.argsort(st); st_sorted = st[order]; roi_sorted = roi[order]
    for j in range(len(sub)):
        k = np.searchsorted(st_sorted, ts[j], side="right")   # settled before this fill
        if k >= 5:
            streak[idx[j]] = roi_sorted[max(0, k - 20):k].mean()
        if j >= 5:
            med_usd[idx[j]] = np.median(usd[:j])
t["streak"] = streak; t["size_ratio"] = t.usd / med_usd
# --- other side: square $ on the OPPOSITE outcome and crowd net flow in the same market before this fill ---
t["is_sq"] = t.wallet.isin(square); t["is_sharp"] = t.wallet.isin(sharp)
sq_opp = np.full(len(t), 0.0); crowd = np.full(len(t), 0.0)
for cid, idx in t.groupby("condition_id").indices.items():
    sub = t.iloc[idx]; ts = sub.ts.values; sg = sub.sign.values; usd = sub.usd.values; sq = sub.is_sq.values
    cs_sq = np.cumsum(np.where(sq, sg * usd, 0.0)); cs_all = np.cumsum(sg * usd)
    for j in range(len(sub)):
        prev_sq = cs_sq[j - 1] if j > 0 else 0.0; prev_all = cs_all[j - 1] if j > 0 else 0.0
        sq_opp[idx[j]] = -sg[j] * prev_sq          # >0: squares have net bought the OTHER side
        crowd[idx[j]] = sg[j] * prev_all           # >0: crowd net flow is on the SAME side as this fill
t["sq_opp"] = sq_opp; t["crowd_same"] = crowd
te = t[(t.start >= split) & t.is_sharp & (t.usd >= 100)].copy()
print(f"sharp (P&L top decile) test fills >= $100: {len(te)} in {te.condition_id.nunique()} markets; baseline follow ROI {fmt(*cl_mean(te,'roi_follow'),scale=100,unit='%')} CLV {fmt(*cl_mean(te,'clv'))}")
def table(name, col, bins, labels):
    te["b"] = pd.cut(te[col], bins, labels=labels)
    print(f"\n{name}:")
    for k, gg in te.groupby("b", observed=True):
        print(f"  {str(k):14s} follow ROI {fmt(*cl_mean(gg,'roi_follow'),scale=100,unit='%'):32s} CLV {fmt(*cl_mean(gg,'clv')):28s} fav {(gg.side_price>=.5).mean()*100:.0f}%")
table("STREAK (trailing settled ROI, last ≤20 bets)", "streak", [-2, -0.1, 0, 0.1, 5], ["cold <-10%", "-10..0%", "0..+10%", "hot >+10%"])
table("WAGER SIZE vs wallet's own median", "size_ratio", [0, 0.5, 1, 2, 5, 1e9], ["<0.5x", "0.5-1x", "1-2x", "2-5x", ">5x"])
table("SQUARE $ on the OPPOSITE side before the fill", "sq_opp", [-1e12, -500, 0, 500, 5000, 1e12], ["squares SAME side >$500", "same <$500", "opp <$500", "opp $500-5k", "opp >$5k"])
table("CROWD net flow same side before the fill", "crowd_same", [-1e12, -5000, -500, 500, 5000, 1e12], ["against >$5k", "against $500-5k", "neutral", "with $500-5k", "with >$5k"])
table("TIMING minutes to start", "rel", [-1e9, -720, -240, -60, -15], [">12h", "4-12h", "1-4h", "15-60m"])
# combined: hot + big + squares opposite
c = te[(te.streak > 0) & (te.size_ratio >= 1) & (te.sq_opp > 0)]
print(f"\nCOMBINED hot & >=median size & squares on the other side: follow ROI {fmt(*cl_mean(c,'roi_follow'),scale=100,unit='%')} CLV {fmt(*cl_mean(c,'clv'))} mkts={c.condition_id.nunique()}")
c1 = c.sort_values("ts").groupby("condition_id").head(1)
print(f"  one bet per market: follow ROI {fmt(*cl_mean(c1,'roi_follow'),scale=100,unit='%')} n={len(c1)} wins={int(c1.side_win.sum())} by sport: " +
      ", ".join(f"{s}:{cl_mean(c1[c1.sport==s],'roi_follow')[0]*100:+.0f}%(n={(c1.sport==s).sum()})" for s in ["mlb","atp","wta","epl","laliga","nfl","ncaaf"] if (c1.sport==s).sum() >= 8))
# same for CLV-ranked sharps
te2 = t[(t.start >= split) & t.wallet.isin(sharp_clv) & (t.usd >= 100)]
c2 = te2[(te2.streak > 0) & (te2.size_ratio >= 1) & (te2.sq_opp > 0)].sort_values("ts").groupby("condition_id").head(1)
print(f"  (CLV-ranked sharps, same combo, one/market): {fmt(*cl_mean(c2,'roi_follow'),scale=100,unit='%')} n={len(c2)}")

print("\n" + "=" * 90)
print("ROBUSTNESS — single features, ONE BET PER MARKET (first qualifying sharp fill), test split into halves")
h2 = pd.Timestamp("2026-09-01", tz="UTC").timestamp()
def one_per_market(df):
    return df.sort_values("ts").groupby("condition_id").head(1)
def report(name, df):
    a = one_per_market(df); a1 = a[a.start < h2]; a2 = a[a.start >= h2]
    print(f"  {name:44s} all {fmt(*cl_mean(a,'roi_follow'),scale=100,unit='%'):30s} CLV {fmt(*cl_mean(a,'clv')):24s} | 8/24-9/1 {cl_mean(a1,'roi_follow')[0]*100:+.0f}% (n={len(a1)}) | 9/1-9/9 {cl_mean(a2,'roi_follow')[0]*100:+.0f}% (n={len(a2)})")
report("baseline: any sharp fill >= $100", te)
report("squares on OPPOSITE side >= $500", te[te.sq_opp >= 500])
report("squares on OPPOSITE side $500-5k", te[(te.sq_opp >= 500) & (te.sq_opp < 5000)])
report("squares on SAME side >= $500 (should be bad)", te[te.sq_opp <= -500])
report("hot streak > +10%", te[te.streak > 0.10])
report("hot streak AND squares opposite >= $500", te[(te.streak > 0.10) & (te.sq_opp >= 500)])
report("sharp AGAINST crowd > $5k", te[te.crowd_same <= -5000])
te["mins"] = -te.rel / 60
report("timing 15-60m before start", te[te.mins <= 60])
report("timing 1-4h", te[(te.mins > 60) & (te.mins <= 240)])
report("timing > 4h", te[te.mins > 240])
sq = one_per_market(te[te.sq_opp >= 500])
print("\n  squares-opposite by sport (one/market): " + ", ".join(f"{s}:{cl_mean(sq[sq.sport==s],'roi_follow')[0]*100:+.0f}% (n={(sq.sport==s).sum()}, CLV {cl_mean(sq[sq.sport==s],'clv')[0]*100:+.2f}c)" for s in ["mlb","atp","wta","epl","laliga","nfl","ncaaf"] if (sq.sport==s).sum() >= 8))
print(f"  squares-opposite: how many markets/week does it fire? {len(sq)} markets over {((te.start.max()-te.start.min())/86400):.0f} days")
