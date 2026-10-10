# Charter — NFL wallet backtest (`nfl_wallet_backtest`)

Written 2026-10-09 while the NFL tape backfill was still discovering markets,
before any NFL wallet result was computed. Rule is code:
`research/sharp/totals_wallets.py` with `SPORT=nfl` (generalisation of the
frozen `ncaaf_wallets.py`: same records, qualifiers, cells, split and
acceptance, plus the union cells HT and GOOD), run on the DESKTOP against
`~/Documents/Projects/polywhaler-data/nfl/nfl_2025.db` (`fills_all`, full
maker+taker tape ≥ $50, `fast_tape.py`).

Why: owner 2026-10-09 — find wallet edges sport by sport and go live; NFL
first (Sunday). The NFL totals pilot (era v18) bets the holder pipeline's
plain sighted side; this asks whether WHO is on a side adds edge.

## population
NFL markets (slug prefix `nfl`), `backfill.py SPORTS=nfl MIN_VOL=5000`
over 2025-09-03 … 2026-02-10 (2025 regular season + playoffs) and
2026-09-08 … 2026-10-08 (2026 regular season to date; preseason excluded by
the date ranges). Bet cells = game totals (token0 = Over); moneylines and
spreads feed wallet records.

## qualifiers, cells, split, acceptance
Identical to `ncaaf-wallet-backtest.md` with "CFB" read as "NFL" (S1 sharp,
S2 hot, S3 team, S4 totals specialist, S5 consensus, S6 square; A game cells
at the first in-window fill 60–180 min out, priced 0.35–0.65; B trigger
cells; FOLLOW and FADE), plus A-cells:
- `HT` — S2 or S3 wallets on exactly one side;
- `GOOD` — S1|S2|S3|S4 wallets on exactly one side.
Discovery = 2025 season (start < 2026-07-01), holdout = 2026 to date.
CANDIDATE = discovery n ≥ 50, |z| ≥ 2 AND holdout same sign, |z| ≥ 1,
n ≥ 30 (15 cells × 2 directions = 30 tests, ~1.4 chance hits).

## PRIMARY: replication of the CFB rule
`A HT FOLLOW` is the CFB-discovered lane rule (`cfb-hot-follow-pilot.md`),
tested here out of sport. REPLICATES if its ROI is > 0 in BOTH seasons and
the pooled game-clustered z ≥ 1.5. Replicates → propose an NFL HT follow $4
lane (owner's go + era bump). Fails → no NFL HT lane; recorded.

## C. overlay (context)
Our NFL totals shadow rows (D1 export 2026-10-09,
`shadow_nfl_totals_2026-10-09.json`), one per game, matched to the tape:
wallet types agree / oppose / neither with the sighted side. Descriptive.

## after the read
A constructive combination pass is expected (owner rule): anything found
there is labelled exploratory and can only go live as a $4 pilot lane on
the owner's go, never as a promotion.

## known_leakage_risks
As in `ncaaf-wallet-backtest.md`. NFL has ~16 games a week, so the 2026
holdout is small (≈ 75 games); the primary replication rule is pooled for
that reason.
