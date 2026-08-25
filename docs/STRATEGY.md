# Strategy Versioning

Every pick is stamped with `strategy_version = <era>+<build commit>` at
creation. The **era** changes only when picking behavior changes (gates,
scoring, calibration, grading) — never for UI, infra, or data-quality fixes.
Audits should `GROUP BY` era; the commit SHA identifies the exact code.

Backfilled rows (picks created before stamping existed, assigned by
`picked_at` against deploy timestamps) carry the suffix `+backfill`.

## Eras

| Era | Active from (UTC) | Defined by |
|---|---|---|
| `v1-baseline` | 2026-04-13 (first stored picks) | Initial sharp-side model. ML-only scoring; totals not scored. |
| `v2-totals-scoring` | 2026-04-24 01:14 | Totals scoring split (side-aware OU scorers), signal-saturation fix (noveltyScore), priceEdge in ranking, L2 merge-order fix. Deployed from working tree; committed later in `8630bf8`. |
| `v3-calibration-band-pass` | 2026-05-11 22:28 | Calibration round: scoreDiff ≥ 20, edgeRating band-pass [66,72)∪[80,90), rebucketed Quality/PriceEdge, NBA >90-min timing gate. Commits `5922224`..`607584a` (tag `strategy-v3`). |
| `v4-realized-edge-gates` | 2026-06-25 22:05 | signal_score ≥ 90 hard gate, price_edge ≥ 0.25 floor, grading by realized edge, bot fill reporting. Commits `57696b3`..`cefa752` (tag `strategy-v4`). |
| `v5-nfl-preseason-gate` | 2026-07-30 | NFL preseason hard gate (`nfl_preseason_excluded`, date-derived: before the Thursday after Labor Day). Snapshot max-age guard (45d) on trend consumption — stale prior-season trends now degrade to "no snapshot" instead of scoring as current. Landed alongside non-era infra: dynamic series discovery + MLS (d7d82f9), full-FBS NCAAF seeding, season/week stamping. Tag `strategy-v5`. |
| `v6-prop-gate` | 2026-08-06 | Prop-market hard gate (`prop_market_excluded`: BTTS, NRFI/YRFI, draw-no-bet, etc. per `GAME_PROP_KEYWORDS`). Props scored through ML/totals-calibrated machinery with no policy segment of their own; historical BTTS record 5-1 is n=6 from eras v1-v3. Rejects settle in the shadow book (falsifiability contract, same as preseason gate). Shipped ahead of the EPL restart (~Aug 15), which would have resurfaced BTTS markets. Tag `strategy-v6`. |
| `v7-period-prop-gate` | 2026-08-07 | Prop classification widened to team totals ("Seahawks Team Total: O/U 25.5") and period markets (1H/2H/quarter O/U, moneyline, spread), and checked BEFORE the core-type keywords — these titles contain "o/u"/"total"/"moneyline" and previously classified as pickable full-game markets that would have scored a period line against full-game models. 1H spreads move from the `spread` shadow cohort to `prop`. Player scorer props ("Anytime/First Touchdown") added to the sync-level `isPlayerPropTitle` filter (previously dropped only by accident of title format). Shipped ahead of CFB week 0 (~Aug 22) / NFL week 1; no such market had ever been ingested (football props absent until regular season). Extended same day with the **one-pick-per-market-group rule**: once any line in a group (event × market type, e.g. alternate total lines on one game) is picked, sibling lines reject on later scans (`market_group_already_picked`) instead of stacking correlated exposure — hold, never churn (round-trip spread on thin alt-line books exceeds within-game grade deltas). Same-scan dedup losers, which previously vanished silently, now settle in the shadow book (`alt_line_deduped`), making hold-vs-upgrade empirically measurable. Tag `strategy-v7`. Within-era, non-era addition (2026-08-18): EFL Championship, La Liga, Bundesliga, Serie A, Ligue 1, UCL + ATP/WTA tennis ingested shadow-only behind the `<tag>_league_probation` gate — no live pick population change (see KNOWN-ISSUES). |

| `v8-soccer-derivative-gate` | 2026-08-23 | Prop classification widened to soccer derivative markets: corners ("O/U 10.5 Total Corners" — contains "o/u"/"total", classified as the pickable game total until now), cards ("Total Cards", "Yellow/Red Card", "Booking Points"), and "Shots on Target". Card keywords are listed explicitly rather than as bare "card", which would match Cardinals moneylines. Surfaced by the EPL 2026-27 restart (first slate Aug 21): 4 corners rows ingested 8/21-8/23, one A-grade all-vector-pass corners candidate stopped only by the timing gate — same leak class era v7 closed for team totals/period markets. Zero live corners picks were ever made, so the live pick population is unchanged retroactively; the bump is prospective. Digest prop subtypes gain `corners`/`cards` cohorts. Tag `strategy-v8`. |
| `v9-entry-price-floor` | 2026-08-24 | Minimum sharp-side entry price 0.25 (`entry_price_below_floor`, `MIN_ENTRY_PRICE` in sharp-grade.ts). Root cause: `fairPrice` is the ratio of the two sides' holder-quality scores, not a probability — on lopsided-price markets sharp capital structurally avoids the expensive side, so the cheap side's score share → ~1 and fair/priceEdge/scoreDiff/grade inflate together (e.g. "fair 0.97" on Under 0.5 goals at 9¢, graded A+ — able to outrank the sane line in its market group under the v7 one-pick-per-group rule). Surfaced by EPL-restart alt lines (O/U 0.5 / O/U 5.5 / −1.5 spreads); until now only timing/microstructure gates incidentally blocked them. Shadow evidence (all settled rows): price <0.15 → 2-58 (model claimed avg pe 0.63); 0.15–0.25 → 4-32 (−50% ROI); pe>0.60 → 3-33 (−73%); all profitable segments live in [0.25, 0.75]. The expensive side cannot generate phantom positive pe, so a floor alone closes the mechanism. Zero historical live picks priced <0.25 — purely prospective. Deliberately NOT added to the `gates_json` vector (a new key would NULL-fail sole-blocker reads on every pre-v9 shadow row); its promotion cohort reads like the timing/microstructure gates. Tag `strategy-v9`. Within-era, non-era addition (2026-08-25): NHL moved from the hard `nhl_sport_excluded` reject (2026-03-19, evidence predates the picks table) to `nhl_league_probation` — shadow-only, no live pick population change; promotion via the same sole-blocker checkpoint as the other probation leagues. |

Era boundaries are **deploy** timestamps, not commit timestamps — early work
was sometimes deployed before being committed. The one pick created between
the two Jun 25 deploys (ss=94.3 straggler, 20:31 UTC) is classified `v3`
because it predates the gate going live.

## Pre-registered tests (open)

Hypotheses written down BEFORE their data exists, so the read is mechanical
when n arrives. Each names its cohort, its criterion, and its n. Reading a
test early, or on a different cut, does not count.

| test | registered | cohort | criterion | read at |
|---|---|---|---|---|
| **Pinnacle price edge as a gate** (`pin_edge = pin_fair_prob − price` on shadow anchors, migration 0035). Second, holder-independent signal: "the Polymarket price beats Pinnacle's devigged number at sighting". | 2026-08-25 | Per sport: settled shadow rows with `pin_fair_prob` non-null, `price ≥ 0.25`, non-timing reject, deduped by market+side. Two sub-cuts: (a) alone — `pin_edge ≥ 0.03` vs `< 0.03`; (b) combined — probation/all-vector-pass rows split the same way. | (a) ROI(pin_edge≥3¢) − ROI(<3¢) > 0 with z ≥ 2 AND `pin_clv` of the ≥3¢ bucket > 0. Passing (a) in a sport earns `pin_edge` a place in that sport's gate vector (era bump); passing (b) in a probation sport is grounds to promote that sport on the combined rule. | n ≥ 100 anchored settled rows in the sport (MLB ~2 weeks; tennis/soccer TBD by coverage) |
| **WTA fade** — the holder signal inverts in WTA (2026-08-25 read: every vector gate's pass side ≤ fail side, all-pass rows −17..−60%). Hypothesis: betting the OPPOSITE side of the sharp signal in WTA is +EV. | 2026-08-25 | WTA shadow rows that pass all five vector gates (would-have-bet cohort), deduped, `price ≥ 0.25`; ROI recomputed as if the other side were bet at `1 − price`. | Fade ROI > 0 with z ≥ 2 AND fade `pin_clv` > 0 (computed against the fade side's Pinnacle prob). If met, a `wta_fade` policy is designed and shadow-run for a further n ≥ 50 before any live bet. | n ≥ 100 would-have-bet WTA rows (≈ mid-Oct at current volume) |
| **Tennis sharp-signal verdict** (from 2026-08-23 diagnosis). | 2026-08-23 | ATP and WTA separately: all-vector-pass probation rows. | The standard promotion rule (n ≥ 50 sole-blocker, z ≥ 2, pin_clv > 0) via the /shadow verdict. | n ≈ 200 total tennis rows (~mid-Sept) |

## Bumping

1. Update `STRATEGY_VERSION` in `src/lib/strategy-version.ts`.
2. Add a row to the table above with the deploy time and what changed.
3. Tag the commit: `git tag strategy-vN <sha>`.
