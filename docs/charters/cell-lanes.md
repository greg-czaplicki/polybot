# Charter — Forward counterparty cell lanes (`cell_lanes`)

Written 2026-09-11 under the `sports-modeling-doctrine` schema. Pre-registers
the forward test of the cells found in
`docs/audits/2026-09-11-counterparty-cells.md`. The rule is code
(`research/sharp/cell_lanes.py`, mirrored at `/root/polysharp/cell_lanes.py`
on the VPS) and the start date is a constant in that file. Changing sport,
market type, price band, trigger time, entry definition or metric after
2026-09-12 means a NEW charter version; the prior result is then labelled
exploratory.

## question
Do the price × market-type cells in which random small takers crossed the
spread at a profit (or a loss) on the 2026-04…09 tape keep doing so on
markets that start after the rule was frozen?

## sport_and_competition
Five lanes, each read on its own, never pooled:

| lane | sport | market | side price at T-60 | pre-registered expectation |
|---|---|---|---|---|
| `atp_dog_cell` | ATP | moneyline | 0.20 ≤ p < 0.40 | positive |
| `mlb_runline_dog_cell` | MLB | spread (run line) | 0.20 ≤ p < 0.40 | positive; expected n < 100 before 2027 |
| `guard_atp_fav_60_80` | ATP | moneyline | 0.60 ≤ p < 0.80 | negative |
| `guard_cs2_fav_50_95` | CS2 | moneyline | 0.50 ≤ p < 0.95 | negative |
| `guard_mlb_total_60_80` | MLB | total | 0.60 ≤ p < 0.80 | negative |

## population_and_exclusions
Markets in the polysharp crawl (`markets.status = 'done'`, `winner0 ∈ {0,1}`,
both tokens known) with `start ≥ 2026-09-12T00:00Z`. A market-side enters a
lane when its last `prices` value at or before T-60 min falls in the band
(token1 price = 1 − token0). It is dropped, not imputed, when no qualifying
entry fill exists. Pushes are outside the population by construction.

Reference numbers for markets starting before 2026-09-12 are printed beside
the forward numbers and are IN-SAMPLE; they are the sanity check that the
mechanics reproduce the audit, never evidence.

## grain_and_natural_key
One row = one (`condition_id`, side). z clustered by `event_key` (a game's
moneyline, run line and total settle together).

## analysis_type
Predictive, prospective. No causal claim about who the counterparty is.

## decision_time_and_horizon
T = start − 60 min. Entry = the first taker-BUY fill of the side's token in
[T, start] with $5 ≤ notional ≤ $100 — an executable price a small account
could actually have paid, not the `prices-history` series (which the
2026-09-11 audit showed is a bid/ask artifact). Horizon = settlement.
Legal at T: the side price (pre-T by construction). The entry fill is after T
and is the price, not a feature.

## baselines
- Zero: ROI = 0 (the cell is efficient).
- The lane's own in-sample reference (printed), which the forward read must
  not be compared against for significance — only for sign.

## primary_metric_and_others
Primary: mean ROI per row, event-clustered z. Secondary: wins/n, n per week.
No CLV term: the 2026-09-11 audit established the close is a fair yardstick
only for MLB moneylines and this test is about executable fills.

## validation_and_acceptance
- `atp_dog_cell`: read at n ≥ 150 rows. Pass = ROI > 0 and z ≥ 2. Pass →
  write a shadow lane in the app (record-only) for one more n ≥ 150 before
  any live proposal. Fail → drop; no re-cut of the same data.
- `mlb_runline_dog_cell`: read whatever accrues through the 2026 postseason;
  a decision needs n ≥ 150, which is a 2027 read.
- Guards: first re-cut 2026-10-01 with `cell_read.py`; a guard that shows
  ≤ −4% in the recent half there AND ROI < 0 in its forward lane at n ≥ 100
  becomes an era-gated price-band gate (strategy era bump required).
- Every read is quoted from the polysharp daily report section
  `FORWARD CELL LANES`, never from an ad-hoc cut.

## data_requirements
Polysharp daily crawl running (`polysharp-daily.timer`, 11:45Z) so that
settled ATP/MLB/CS2 tapes keep arriving; `prices` coverage at T-60 for the
market (markets without a T-60 price are excluded, count reported if it
exceeds 10 % of candidates).

## known_leakage_risks
- `start` is the scheduled start from polybook/Gamma; a market whose real
  start was earlier than recorded would have an in-play "T-60" price. The
  audit found the T-60 and T-1 reads agree, so the effect is small, but tennis
  session-start times are the weak point (see tennis-ground-up charter).
- Dog cells are tail-heavy: a handful of 4× wins carry the mean. That is why
  n ≥ 150 and a clustered z are required, and why no promotion happens from
  another cut of the historical tape.

## Amendment v1.1 (2026-09-11, before any forward data exists)
Replication lanes added for NFL, NCAAF and EPL, whose own tapes were too thin
to read (137 / 106 / 219 markets; their cells flip sign between halves, and
the NCAAF slice even points the other way). The bands are COPIED from the
ATP/CS2 structure — moneyline dogs 0.20–0.40 expected positive, moneyline
favourites 0.60–0.80 expected negative — not fitted to these sports. That
makes them an out-of-sport replication, the strongest form of forward test
this data allows. Same rule, grain, entry and pass criteria as `atp_dog_cell`
(n ≥ 150, ROI > 0, clustered z ≥ 2); the favourite lanes are read as guards.
EPL is a three-way market: a draw token whose price falls in the band is a
row like any other. Label drift fixed the same day: polybook's slug-prefix
hints are normalised in `polysharp.py` (`cfb→ncaaf`, `lal→laliga`,
`bun→bundesliga`, `fl1→ligue1`, `elc→championship`) so each sport is one label.
