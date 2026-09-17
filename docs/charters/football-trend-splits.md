# Charter — Football situational trend splits (NFL / NCAAF)

Written 2026-09-17 under the `sports-modeling-doctrine` schema, BEFORE any
row carrying the new fields exists. The rule is code
(`research/trends/football_trend_read.py`); the forward start, the lanes and
every threshold are constants in that file. Changing a lane, a threshold,
the dedup, the cluster key or the metric after 2026-09-18 means a NEW
charter version; the prior result is then labelled exploratory.

## question
Do the situational trend splits the canonical pipeline already computes for
football teams — ATS record in the pick's venue/role split ("home dog",
"away favorite", …) and the over/under rate in the venue split ("overs at
home") — carry information about the sharp-side outcome that the scorer is
not using, or that the market has already priced?

## origin (why this is a hypothesis, not a result)
Owner question on 2026-09-17: "for NFL, CFB, are we doing anything like
O/U at home?". Audit that day: the canonical pipeline computes nine rolling
splits per team (overall, home, away, favorite, dog and the four combos)
with SU / ATS / OU records over a 10-game window, from ESPN finals and
DraftKings closing lines, for `nfl` and `ncaaf`. The scorer
(`src/server/domain/opportunity-scoring.ts`) reads the split only for ATS;
every OU factor reads the overall snapshot. `canonicalScore` is the fourth
tiebreaker in bot ranking and gates nothing, and football is shadow-only,
so no bet has ever depended on any of it. No outcome study of football
trends exists. Nothing has been looked at; there is no block 1.

Doctrine prior: team trend splits are public information (every sportsbook
site shows them) and are expected to be priced. The pre-registered
expectation is therefore ROI ≈ 0 for every lane. The owner's counter-prior
is that situational form (in particular OU lean at the venue) is
under-weighted by Polymarket's thin football books.

## sport_and_competition
`nfl` and `ncaaf`, read separately, never pooled. 2026 regular seasons
(NFL weeks 1–18, NCAAF through conference championships). Football is
shadow-only under era v13; nothing here changes picking.

## population_and_exclusions
`shadow_candidates` rows with `sport_tag ∈ {nfl, ncaaf}`,
`trend_context_json` non-null, `status ∈ {win, loss}`,
`created_at ≥ 2026-09-18T00:00Z` (first rows whose blob carries
`ouSplitPct`, `overallGames`, `splitGames`; shipped 2026-09-17). Rows are
deduped to one per (`condition_id`, `sharp_side`) keeping the FIRST sighting
(the blob is written with `INSERT OR IGNORE`, so later sightings never
overwrite it). Pushes are outside the population by construction.

Coverage caveat (pre-registered, not a leak): only rows that reached the
bot's candidate scan carry a blob — rows rejected `outside_window` never do.
The cohort is therefore "markets a live pick could have come from", which
is the population that matters. The share of football rows without a blob
is printed by the sweep and expected around 40 %.

A split with fewer than `MIN_SPLIT_GAMES = 4` graded games is NOT a trend;
such rows fall outside every lane (they stay in the baseline and the
complement). With the 45-day freshness guard resetting at season start,
NFL venue splits reach 4 games around week 8 and the combo splits later;
NCAAF a week or two earlier. This is why the read is a November read.

## grain_and_natural_key
One row = one (`condition_id`, `sharp_side`). z clustered by event
(matchup prefix of `market_title` + event date): a game's moneyline,
spread and total settle together.

## analysis_type
Predictive, prospective. No causal claim.

## decision_time_and_horizon
T = first sighting of the market-side inside the bot window (60–180 min
pre-start; the `too_close_to_start` rows are later, still pre-start). Every
feature in the blob is the LATEST snapshot at T, which by construction
contains only games that were final before T (snapshot `as_of_time` is the
prior game; the 45-day guard blanks last season). Horizon = settlement.

## lanes (all read per sport)
| lane | market family | rule at T | expectation |
|---|---|---|---|
| `ats_split_hot` | moneyline + spread | sharp-side team's `atsSplitPct ≥ 0.60`, `splitGames ≥ 4` | ≈ 0 (priced) |
| `ats_split_cold` | moneyline + spread | `atsSplitPct ≤ 0.40`, `splitGames ≥ 4` | ≈ 0 |
| `ou_split_aligned` | total | every team with a venue-split lean (`ouSplitPct ≥ 0.60` over / `≤ 0.40` under, `splitGames ≥ 4`) leans WITH the pick direction | owner: > 0; doctrine: ≈ 0 |
| `ou_split_opposed` | total | every leaning team leans AGAINST the pick | owner: < 0; doctrine: ≈ 0 |
| `ref_ou_overall_*` | total | same rule on the overall window (`ouOverPct`, `overallGames ≥ 4`) — the feature the scorer already uses | reference only, no verdict |

"Mixed" totals (one team leans with, the other against) are in neither OU
lane. The sharp-side team for side markets is `team` in the blob; for
totals `team` is the home team (home split) and `opponent` the away team
(away split), as the bot has always built it.

## baselines
- Zero: ROI = 0 (the split is priced).
- The lane's complement: all rows of the same market family in the sport
  that are not in the lane. A lane must beat its complement, not just zero,
  because football shadow baselines are themselves non-zero
  (NFL sides −7.4 % on 150 in-sample rows at the time of writing).

## primary_metric_and_others
Primary: mean ROI per row at the sighted price, event-clustered z (mean of
per-event means over its SE — the estimator in
`src/lib/grade-floor-test.ts`). Secondary: wins/n, lane − complement in
points, event count. No CLV term (owner stance 2026-09-15; and football
`pin_*` coverage is budget-limited).

## validation_and_acceptance
Per sport and per lane: read at n ≥ 50 rows in the lane. PASS = ROI > 0,
clustered z ≥ 2, and lane − complement > 0 (for `ou_split_opposed` and
`ats_split_cold` the mirror: ROI < 0, z ≤ −2, complement − lane > 0).

- A PASS earns the split feature a place in the scorer for that sport
  (OU factors reading the venue split, or an ATS-split gate) — a strategy
  era bump, applied only after one further n ≥ 50 forward block at z ≥ 1.5
  with the feature recorded but still not scored.
- n ≥ 100 in a lane with |z| < 1 → recorded "priced", the lane is dropped
  for that sport; no re-cut of the same rows with different thresholds.
- The `ref_ou_overall_*` lanes never trigger anything; they exist so a
  venue-split pass can be compared with what the scorer already had.
- Every read is quoted from `football_trend_read.py`, never from an ad-hoc
  cut, and is filed as `docs/audits/<date>-football-trend-splits.md`.

## read schedule
First look 2026-11-16 (after NFL week 10 / NCAAF week 12), sign and n only
unless a lane has n ≥ 50. Verdict read after the regular seasons
(NFL 2027-01-11; NCAAF after conference championships, 2026-12-07). Lanes
still short of n ≥ 50 then are recorded as "insufficient" and the charter
carries unchanged into the 2027 season (the split fields keep accruing on
every football shadow row).

## data_requirements
ESPN finals + DraftKings close ingestion (`espn-schedule-ingestion`,
`line-ingestion`) running so facts and snapshots keep up (2026-09-17: NFL
week 1 facts 32/32, NCAAF weeks 0–2 facts 204, all with spread and total);
the canonical sync (`canonical_sync_runs`) healthy; the bot candidate scan
reaching football markets so the blob is written. The
`docs/KNOWN-ISSUES.md` ESPN-403 entry is the failure mode to watch: a
silent finals freeze makes every split stale without erroring.

## leakage pre-audit (2026-09-17)
- Target leakage: none — blob is written at first sighting, pre-start;
  `INSERT OR IGNORE` prevents post-result rewrites.
- Temporal: snapshots are as-of the prior final game; the pipeline's
  late-game repair (`repairSnapshotsAfterLateGame`) rewrites SNAPSHOTS but
  never the blob, so a row keeps what was actually known at T.
- Join: team resolution is by alias at T; a failed resolution yields a null
  blob or `teamSnapshotFound=false`, which is outside every lane, not a
  wrong lane.
- Selection: the in-window coverage caveat above. REVIEW at the first read:
  share of blob-less rows by reject reason, to confirm it is the window and
  not a resolver failure (NFL nickname-only titles resolve via
  `short_name`, verified 2026-09-17 on "Chiefs").
