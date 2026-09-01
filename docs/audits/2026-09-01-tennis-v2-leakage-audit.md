# Leakage audit — tennis-v2 Stage 1 pipeline (2026-09-01)

Sport/question/target/grain: ATP+WTA match winner, P(winner), one row
per match (`data/tennis/stage1_elo.py` over the tennis-data.co.uk
snapshot, README caveats incorporated).
Decision time T: pre-match; features = Elo from strictly earlier matches
+ book quotes (late pre-match per source).
Validation/grouping: chronological single pass, score-then-update;
tune 2021 / validate 2022-25 / test 2026 (unscored to date). One row per
match ⇒ no paired-row group splitting needed. Tours independent.
Automated helper: N/A (online pipeline, no materialized feature matrix);
equivalent bespoke checks run and recorded below.

## Findings

1. **[PASS] Target aliasing.** Source rows are winner/loser-framed, but
   the only model inputs are prior-match ratings and pre-match odds;
   scoring assigns p symmetrically to the actual winner. The null
   baseline's favorite-flag comes from odds, not outcome. `fav_hist`
   base rate sums strictly-prior years only.
2. **[PASS] Update ordering / future perturbation.** Single forward pass
   over rows sorted (date, tournament, round); each row scored before
   `elo.update`. Later outcomes structurally cannot alter earlier
   features.
3. **[PASS] Same-day doubleheaders (509 ATP player-date cases).** Round
   names ('1st Round'…'The Final', 8 values verified) sort
   alphabetically INTO chronological order within (date, tournament);
   Round Robin occurs only in formats without Quarterfinals. Ordering
   correct; residual risk none identified.
4. **[PASS w/ note] year_file vs date bleed (≈49 ATP, similar WTA).**
   A few rows carry dates outside their season file (Dec/Jan spans).
   Chronology is enforced by date sort, so no future information moves;
   effect is fold-labeling fuzz only.
5. **[PASS] Invalid odds values.** ~35 rows/tour across 12 years have
   odds ≤ 1.0 or non-numeric; `implied()` guards them (returns None →
   next book → row dropped from eval if none valid).
6. **[PASS] Odds internal plausibility.** PS vig 2022-25: median
   2.6-2.9%, p95 ≤3.6%, 1 negative row in 20k — consistent with real
   pre-match Pinnacle quotes.
7. **[PASS] Preprocessing/tuning scope.** No fitted scalers/encoders;
   blend + shrinkage tuned on 2021 only. For the 2026 test read all
   parameters are locked before 2026 is first scored.
8. **[REVIEW→accepted assumption] Odds revision policy.** tennis-data
   season files are compiled by the site; we cannot prove quotes were
   never revised post-match. Standard academic source; vig distribution
   shows no settlement artifacts. Accepted as documented provenance risk
   (README), inherent to the no-paid-data constraint.
9. **[REVIEW→accepted assumption] Odds timing.** Quotes are "late
   pre-match", not verified tick closes (`notes.txt` 404 at snapshot).
   Caveat attaches to any CLV-flavored interpretation of the market
   baseline; comparative log-loss claims unaffected.
10. **[CAVEAT, validation years only] Shrinkage decision post-hoc.**
    Disclosed in the Stage 1 read: the choice to add shrinkage followed
    one look at validation folds (parameter tuned on 2021 only).
    Validation margins are mildly optimistic; the 2026 read is clean of
    this (params locked pre-read).

Contaminated fields/artifacts: none identified.
Required repairs: none. Retest condition: any change to sort keys,
label rules, or odds-column precedence reopens findings 2-6.

## Verdict

**Pipeline-internal: CLEAN.** Two source-level assumptions (8, 9) are
accepted and documented rather than proven — they attach as caveats to
interpretation, not blockers to the read. **The one-shot 2026 test read
may proceed**, reported per-tour with: the baseline source-shift note
(2026 market = mostly Avg, not Pinnacle), and finding 10's caveat
confined to validation-year claims.

Auditor: Claude (session 2026-09-01), adversarial pass per
`leakage-audit` skill.
