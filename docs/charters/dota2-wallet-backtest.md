# Charter — Dota 2 wallet backtest (`dota2_wallet_backtest`)

Written 2026-10-21 before any wallet-level Dota 2 result was computed (the
backfill was still discovering markets). Rule is code:
`research/sharp/dota2_wallets.py`, run on the DESKTOP against
`~/Documents/Projects/polywhaler-data/dota2/dota2_2025.db` table `fills_all`
(full maker + taker tape, fills ≥ $50, fetched by
`research/sharp/fast_tape.py`).

Why this exists: owner, 2026-10-21, "Did we look at esports Dota?" → "Sure".
The price-cell read on Dota (2026-10-02, `cell_read.py`) found nothing; the
untested axis is WHO is on each side. This is the CS2 wallet backtest
(`cs2-wallet-backtest.md`, 0/15 passed) copied VERBATIM — same qualifiers,
same 15 cells, same acceptance rule — with only the population and the split
date changed. No Dota-specific cells are added.

## population
Dota 2 match-winner markets (`markets.market_type = 'moneyline'`, question
`Dota 2: A vs B (BOn) - …`), resolved 0/1, discovered by `backfill.py` with
`SPORTS=dota2 MIN_VOL=5000` over 2025-10-01 … 2026-10-20. Game winners,
handicaps and games totals are NOT bet cells, but every Dota 2 market in the
DB contributes positions to wallet records.

## wallet records, qualifiers, A lane-filter cells, B follow cells
Identical to `cs2-wallet-backtest.md` (S1 sharp ≥ 30 positions ROI ≥ +10%;
S2 hot ≥ 9 of last 12; S3 team specialist ≥ 10 positions ROI ≥ +15%; S5
consensus; lane row = first fill in [start − 180 min, start − 60 min) priced
[0.40, 0.50); 10 A cells + 5 B cells). There is no live Dota lane: the A
cells describe a hypothetical Dota pick'em-dog lane.

## split and acceptance
z clustered by match. SPLIT = the median `start` of the bet population
(match-winner markets with a full tape), computed from start times only,
before any outcome is read; DISCOVERY < SPLIT, HOLDOUT ≥ SPLIT. The script
prints the split date. CANDIDATE = discovery n ≥ 50 and |z| ≥ 2 AND holdout
same sign, |z| ≥ 1, n ≥ 30. 15 cells → ~0.7 chance discovery hits expected.

Candidate → proposed to the owner as a $4 live pilot lane (new era, owner's
go). Nothing passing → recorded as no edge; not re-cut, no new thresholds.

## known_leakage_risks
Same as the CS2 charter: point-in-time records (start + 4 h settle lag),
state strictly before T, $50 fill floor, slippage not modelled. Early
months are record warm-up, so discovery cells are thinner than holdout.
