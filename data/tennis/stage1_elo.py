#!/usr/bin/env python3
"""tennis-v2 Stage 1 — baselines + surface-aware Elo, walk-forward.

Boundaries (charter docs/charters/tennis-ground-up.md):
  warmup/train <= 2020, TUNE on 2021 only, VALIDATE 2022-2025.
  2026 is the untouched final test: this script refuses to score it
  (rows are neither evaluated nor rated past 2025-12-31).

Models, locked before running:
  null    — market favorite at a constant p = favorite win rate over all
            years BEFORE the eval year (expanding).
  market  — de-vigged implied prob, PS (Pinnacle) if present else Avg.
  elo     — surface-blended Elo, K = 250/(5+n)^0.4 (FiveThirtyEight
            form), P = 1/(1+10^(-d/400)); blend w tuned on 2021 only.

Rows: walkovers excluded; retirements count as wins for the advancing
player (Polymarket resolution rule) and update ratings. Eval rows need
odds and both players >= 5 prior matches; the rest is the cold-start
slice (reported, never mixed). Tours are processed independently.
"""
import csv, math, os
from collections import defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))
TUNE_YEAR = "2021"
VAL_YEARS = ["2022", "2023", "2024", "2025"]
COLD_MIN_MATCHES = 5
BLEND_GRID = [0.0, 0.25, 0.5, 0.75, 1.0]

def implied(pw, pl):
    try:
        pw, pl = float(pw), float(pl)
        if pw <= 1 or pl <= 1:
            return None
        a, b = 1 / pw, 1 / pl
        return a / (a + b)
    except (TypeError, ValueError):
        return None

def odds_prob(r):
    return implied(r["psw"], r["psl"]) or implied(r["avgw"], r["avgl"]) \
        or implied(r["b365w"], r["b365l"])

def load(tour):
    with open(os.path.join(BASE, f"matches_{tour}.csv")) as f:
        rows = [r for r in csv.DictReader(f)]
    rows = [r for r in rows if r["year_file"] <= "2025"          # 2026 untouched
            and (r["comment"] or "").strip().lower() != "walkover"
            and r["winner"] and r["loser"] and r["date"]]
    rows.sort(key=lambda r: (r["date"], r["tournament"], r["round"]))
    return rows

class Elo:
    def __init__(self, blend):
        self.blend = blend
        self.overall = defaultdict(lambda: 1500.0)
        self.surface = defaultdict(lambda: 1500.0)   # key (player, surface)
        self.n = defaultdict(int)
        self.ns = defaultdict(int)

    def rating(self, p, s):
        return (1 - self.blend) * self.overall[p] + self.blend * self.surface[(p, s)]

    def prob(self, a, b, s):
        return 1 / (1 + 10 ** (-(self.rating(a, s) - self.rating(b, s)) / 400))

    @staticmethod
    def k(n):
        return 250 / (5 + n) ** 0.4

    def update(self, w, l, s):
        po = 1 / (1 + 10 ** (-(self.overall[w] - self.overall[l]) / 400))
        self.overall[w] += self.k(self.n[w]) * (1 - po)
        self.overall[l] -= self.k(self.n[l]) * (1 - po)
        ps = 1 / (1 + 10 ** (-(self.surface[(w, s)] - self.surface[(l, s)]) / 400))
        self.surface[(w, s)] += self.k(self.ns[(w, s)]) * (1 - ps)
        self.surface[(l, s)] -= self.k(self.ns[(l, s)]) * (1 - ps)
        self.n[w] += 1; self.n[l] += 1
        self.ns[(w, s)] += 1; self.ns[(l, s)] += 1

def run(tour, blend, eval_years, collect_gaps=False, shrink=1.0):
    """One chronological pass; score only rows in eval_years.

    shrink: probability shrinkage toward 0.5 applied at SCORING time only
    (p' = 0.5 + shrink*(p-0.5)) — revision recorded in the Stage 1 read:
    raw Elo is overconfident (ECE ~4-5%); tuned on 2021 only."""
    rows = load(tour)
    elo = Elo(blend)
    fav_hist = defaultdict(lambda: [0, 0])          # year -> [fav wins, n]
    per_year = defaultdict(lambda: defaultdict(list))
    cold = defaultdict(int)
    gaps = []
    for r in rows:
        y, s = r["year_file"], r["surface"] or "Hard"
        w, l = r["winner"], r["loser"]
        pm = odds_prob(r)                            # P(actual winner) implied
        if pm is not None:
            fav_hist[y][0] += pm >= 0.5
            fav_hist[y][1] += 1
        if y in eval_years and pm is not None:
            if elo.n[w] < COLD_MIN_MATCHES or elo.n[l] < COLD_MIN_MATCHES:
                cold[y] += 1
            else:
                base_n = base_w = 0
                for yy, (fw, fn) in fav_hist.items():
                    if yy < y:
                        base_w += fw; base_n += fn
                pnull = max(0.5, base_w / base_n) if base_n else 0.65
                pe = 0.5 + shrink * (elo.prob(w, l, s) - 0.5)
                d = per_year[y]
                d["n"].append(1)
                d["ll_null"].append(-math.log(pnull if pm >= 0.5 else 1 - pnull))
                d["ll_mkt"].append(-math.log(pm))
                d["ll_elo"].append(-math.log(pe))
                d["cal"].append((pe, 1.0))           # elo prob assigned to winner
                if collect_gaps:
                    gaps.append(abs(pe - pm))
        elo.update(w, l, s)
    return per_year, cold, gaps

def summarize(tour, per_year, cold):
    print(f"\n[{tour.upper()}] year   n  cold  ll_null ll_market ll_elo")
    tot = defaultdict(list)
    for y in sorted(per_year):
        d = per_year[y]
        n = len(d["n"])
        print(f"  {y}  {n:5d} {cold.get(y,0):4d}   "
              f"{sum(d['ll_null'])/n:.4f}  {sum(d['ll_mkt'])/n:.4f}  {sum(d['ll_elo'])/n:.4f}")
        for k in ("ll_null", "ll_mkt", "ll_elo"):
            tot[k] += d[k]
    n = len(tot["ll_null"])
    if n:
        print(f"  ALL  {n:5d}        "
              f"{sum(tot['ll_null'])/n:.4f}  {sum(tot['ll_mkt'])/n:.4f}  {sum(tot['ll_elo'])/n:.4f}")

if __name__ == "__main__":
    for tour in ("atp", "wta"):
        # --- tune blend on 2021 only ---
        best, best_ll = None, None
        for wgt in BLEND_GRID:
            py, _, _ = run(tour, wgt, [TUNE_YEAR])
            d = py[TUNE_YEAR]
            ll = sum(d["ll_elo"]) / len(d["ll_elo"])
            print(f"[{tour}] tune w={wgt:.2f}  2021 ll_elo={ll:.4f}  (n={len(d['ll_elo'])})")
            if best_ll is None or ll < best_ll:
                best, best_ll = wgt, ll
        print(f"[{tour}] LOCKED blend w={best}")
        # --- tune shrinkage on 2021 with locked blend ---
        bshr, bll = None, None
        for a in (0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 1.0):
            py, _, _ = run(tour, best, [TUNE_YEAR], shrink=a)
            d = py[TUNE_YEAR]
            ll = sum(d["ll_elo"]) / len(d["ll_elo"])
            if bll is None or ll < bll:
                bshr, bll = a, ll
        print(f"[{tour}] LOCKED shrink a={bshr} (2021 ll={bll:.4f})")
        # --- validate 2022-2025 with locked blend+shrink ---
        per_year, cold, gaps = run(tour, best, VAL_YEARS, collect_gaps=True, shrink=bshr)
        summarize(tour, per_year, cold)
        # calibration of elo (10 bins) + model-market gap quantiles
        allc = [c for y in VAL_YEARS for c in per_year[y]["cal"]]
        bins = defaultdict(lambda: [0.0, 0])
        for pe, won in allc:
            b = min(9, int(pe * 10))
            bins[b][0] += pe; bins[b][1] += 1
        # winner-assigned probs: observed freq in bin b = fraction of rows (always winner=1);
        # proper calibration needs both sides — mirror each row as (1-pe, loss).
        bins2 = defaultdict(lambda: [0, 0, 0.0])
        for pe, _ in allc:
            for p, o in ((pe, 1), (1 - pe, 0)):
                b = min(9, int(p * 10))
                bins2[b][0] += o; bins2[b][1] += 1; bins2[b][2] += p
        print(f"  [{tour}] elo calibration (bin: pred vs obs, n)")
        ece = 0.0; N = sum(v[1] for v in bins2.values())
        for b in sorted(bins2):
            o, n, ps = bins2[b]
            print(f"    {b/10:.1f}-{(b+1)/10:.1f}: pred {ps/n:.3f} obs {o/n:.3f}  n={n}")
            ece += n / N * abs(ps / n - o / n)
        print(f"  [{tour}] ECE={ece:.4f}")
        gaps.sort()
        q = lambda x: gaps[int(x * (len(gaps) - 1))]
        print(f"  [{tour}] |elo-market| gap: median {q(.5):.3f}  p75 {q(.75):.3f}  "
              f"p90 {q(.9):.3f}  p95 {q(.95):.3f}  n={len(gaps)}")
