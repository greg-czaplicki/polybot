# Charter — Per-sport wallet CLV records (`wallet_sport_clv`)

Written 2026-08-27 under the `sports-modeling-doctrine` schema. User-owned
contract for the pre-registered test motivated by the exploratory read in
`docs/audits/2026-08-27-wallet-sport-specialization.md`. **That read peeked
at entries through 2026-08-25; the confirmatory sample is therefore entries
observed AFTER 2026-08-27T00:00Z only.** Changing target, grain, decision
time, thresholds, or metric after confirmatory data exists means a new
charter version; the prior result is then labelled exploratory.

## question
Does a wallet's prior per-sport CLV record predict the CLV of its next entry
(a) at all, and (b) better than its prior global (all-sport) record — enough
to justify sport-aware wallet weighting in holder scoring?

## sport_and_competition
All sports flowing through `wallet_entries` (`sport_series_id` mapped by
`src/lib/sports.ts` + series registry). Pooled across sports by design — the
unit is the wallet, not the sport. New-season sports (NBA, NHL, NCAAF/NCAAB)
enter as they accrue; a wallet's in-sport prior starts empty there, which is
exactly the distinction under test.

## population_and_exclusions
`wallet_entries` rows with:
- `status = 'closed'`, `clv IS NOT NULL`, `sport_series_id` mapped;
- `observed_at > 2026-08-27T00:00Z` (post-peek boundary);
- deduped to the FIRST entry per (wallet, condition_id, side);
- prior-record features computed from entries with
  `settled_at < observed_at`, **excluding the same `condition_id`**;
- a row enters the primary sample only if the wallet's prior in-sport
  record has **n ≥ 5** deduped settled entries at observation time.
Voided entries never count. `kind` (new_top20 / increase) both included.

## grain_and_natural_key
Feature grain: one deduped entry. **Metric grain: the wallet** — every
acceptance statistic is wallet-clustered (per-wallet mean of subsequent
entry CLV, then across-wallet comparison). Entry-level statistics are
diagnostics only, never acceptance: the exploratory read showed entry-level
z ≈ +16 collapsing to z ≈ −0.8 under wallet clustering (slate co-movement).

## analysis_type
Predictive (prospective). No causal claim.

## decision_time_and_horizon
T = `observed_at`. Horizon = market close (hours). Feature legality at T:
- prior in-sport / global CLV means — from entries `settled_at < T`,
  other markets only. Legal.
- `pnl_all` tier, unit size — cached pre-T. Legal (control only).
- The row's own `clv`, `close_price` — post-T. Target only.

## target_or_estimand
Per-entry `clv` (PM close − entry, probability points), aggregated to
per-wallet mean over the wallet's confirmatory-window entries. Estimand:
Δ_w = mean over wallets with prior-in-sport CLV > 0 of their subsequent
mean CLV, minus the same for wallets with prior-in-sport CLV ≤ 0. A wallet
contributes to the bucket its entries qualify for at each entry's T; a
wallet appearing in both buckets contributes its qualifying entries to each.

## base_rate_or_null
Null: prior record carries nothing → Δ_w ≈ 0 (exploratory wallet-clustered
estimate was −0.1pp, consistent with the null).

## naive_and_strong_baselines
- Naive: all qualifying entries, no split.
- Strong: the same split on prior GLOBAL record (n ≥ 5). The in-sport
  feature must beat this control (incremental read: among wallets with
  global-prior sign fixed, does in-sport sign still separate?) before
  "sport-aware" earns anything; a global-only effect is a different,
  simpler feature.

## primary_metric_and_direction
Δ_w (wallet-clustered, in-sport split) with Welch z across wallet means;
higher is better. Thresholds FIXED here: prior n ≥ 5, sign split at 0
(no tuned cutoffs).

## secondary_metrics (diagnostics only)
- Incremental Δ_w holding global-prior sign fixed (the (b) question).
- Continuous version: rank correlation of prior in-sport mean vs subsequent
  wallet mean.
- Specialist (≥90% concentration) vs generalist wallet CLV.
- Per-sport slices; entry-level splits (artifact exhibit, never acceptance).

## validation_design
Chronological 2-week blocks; report Δ_w, z, wallet n per block plus pooled.
Acceptance needs the pooled criterion AND Δ_w > 0 in a majority of blocks
with ≥ 50 qualifying wallets. One read at the data threshold; second read
only at 2× data. No parameter changes after a read.

## data_requirements_and_provenance
Read when **≥ 600 wallets** qualify for the primary in-sport split in the
confirmatory window (exploratory rate suggests ~6–8 weeks → mid/late
October, boosted by NBA/NHL season starts). Provenance: `wallet_entries`
(shares-based diffs, ≥$100, pre-event only; ledger valid from 2026-08-05),
CLV vs PM close from `sharp_money_history` (≤1h staleness). Known caveats:
PM-close CLV only (no Pinnacle reference); top-20 visibility censoring
(exits/reductions unobserved); 7-day void window drops never-closed markets.

## uncertainty_plan
Wallet-clustered Welch z with wallet counts per bucket and per block;
report intervals. The in-sport and global splits are two tests — state both.

## acceptance_rule
- **(a) record predicts:** pooled wallet-clustered Δ_w > 0, z ≥ 2,
  majority of qualifying blocks positive → per-wallet CLV record earns a
  place as a scoring INPUT CANDIDATE (shadow-side first; any picking change
  is an era bump + STRATEGY.md row + tag).
- **(b) sport-specific increment:** additionally incremental Δ_w > 0 with
  z ≥ 2 against the global-record control → the feature is per-sport;
  otherwise global-record only.

## failure_and_stop_conditions
- Δ_w ≤ 0 at 2× the wallet threshold → rejected; record and stop.
- Entry-level significance WITHOUT wallet-clustered significance → null
  result, not a finding (pre-named artifact).
- Any post-T feature in the split → void, repair, rerun.
- Changing prior-n, split point, or the 08-27 boundary after data exists →
  new charter version.

## out_of_scope_and_prohibited_uses
- No scoring or stake change on this signal before acceptance + era bump.
- No fading of poor-record wallets (separate hypothesis, separate charter).
- Not a test of the tennis holder-signal inversion (fade-inversion charter).
- No per-wallet public claims; addresses stay internal.

## required_artifacts
`docs/audits/<date>-wallet-sport-clv-read.md` with wallet counts, block
table, Δ_w/z for (a) and (b), the artifact exhibit (entry vs clustered), and
the decision. Memory + STRATEGY updates only on acceptance.

## Leakage pre-audit (`leakage-audit`, run at charter time)
| item | finding |
|---|---|
| target lineage | `clv` written at settle from `sharp_money_history` close; post-T; target only |
| feature availability | prior record filtered on `settled_at < observed_at` — strictly known-at-T (settle cron lags event end, so this is conservative); same-market exclusion prevents self-contamination |
| temporal transform | prior means are expanding-window over past settled entries only |
| joins | sport via `sport_series_id` stamped at observation (no retro joins); PnL cache fetched pre-T |
| preprocessing / tuning | prior n ≥ 5 and sign-split fixed a priori; exploratory read used n ≥ 3 — disclosed, and its data (≤ 08-25) is excluded from the confirmatory window |
| split | chronological blocks; confirmatory window starts after the peek (08-27) |
| duplicates / groups | dedup to first (wallet, market, side); residual slate co-movement handled by wallet-clustered metric — the pre-audit's central risk, promoted into the acceptance rule itself |
| **verdict** | `CLEAN` conditional on the wallet-clustered metric being the only acceptance statistic |
