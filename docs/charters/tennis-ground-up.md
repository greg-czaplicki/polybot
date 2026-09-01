# Charter — Ground-up tennis strategy ("tennis-v2")

**Status: DRAFT — pending owner sign-off. No data acquired, no models fit.**
Written 2026-09-01 under `sports-modeling-doctrine`. This charter must be
approved before Stage 1 begins; per doctrine it is re-chartered, never
quietly amended, if target/grain/decision-time change.

## Motivation

The 2026-08-31 tennis-verdict read established that the MLB-bred holder
signal has no directional skill on ATP (raw 68-68, +3.1%, pin_clv −0.28%)
and inverts on WTA (33-47, −27.4%), and that the vector-gate promotion
checkpoint is structurally unreachable for tennis (clean rate 2.9–5.0%).
Owner decision (2026-09-01): leave the MLB machinery untouched; build a
tennis strategy from the ground up. Infrastructure may be borrowed
(shadow book, pin capture, bot, verdict rule); assumptions may not.

## Charter

**question** — Can a tennis-native pricing stack select Polymarket ATP/WTA
match-winner bets with positive CLV against the Pinnacle de-vigged close
and positive match-clustered ROI?

**analysis_type** — Predictive/decision (betting). All explanatory
findings along the way are diagnostics, never promotion inputs.

**sport_and_competition** — ATP and WTA singles, tour-level main draws
(Slams, 1000/500/250). Excluded: doubles, qualifying, Challenger/ITF,
exhibitions/team events (United Cup et al.), walkovers.

**grain_and_natural_key** — One row = one (match, side) candidate at
decision time. Key: (tournament, round, player_a, player_b); live rows
also carry condition_id. The two sides of a match are one observation:
all inference is match-clustered. ATP and WTA are read separately, never
pooled (pre-registered; the two tours have opposite diagnostic history).

**decision_time_and_horizon** — T = last pre-match evaluation ≥ 30 min
before the scheduled session start (session start is the only start proxy
Polymarket exposes — the same limitation pin capture lives with today).
Every feature must be computable from data timestamped ≤ T. Horizon:
final match outcome.

**target_or_estimand** —
- Stage 1 (offline): P(player A wins), binary. Retirements mid-match
  count as a win for the advancing player (matches Polymarket
  resolution); walkovers excluded (market voided).
- Stage 2 (live shadow): mean pin_clv and ROI of rule-selected shadow
  bets, per rule, per tour.

**base_rate_or_null** — Historical favorite (by closing odds) wins ~65%
of tour-level matches. Null model: market-implied constant.

**naive_and_strong_baselines** (locked before any fitting) —
1. Null: pick the closing favorite at its implied probability.
2. Structural/incumbent: de-vigged closing-odds implied probability
   (tennis-data.co.uk Pinnacle/average columns) scored as a forecaster.
3. Strong simple: surface-aware Elo (Sackmann match data), standard
   parameterization, K tuned on training folds only.

**primary_metric_and_direction** —
- Stage 1: held-out log-loss, lower is better, candidate vs all three
  baselines on identical rows. Honest expectation, stated now: the model
  will NOT beat the closing-odds baseline (nothing public does,
  reliably). Stage 1's real deliverables are (a) a calibrated fair-price
  model for matches where we have no fresh sharp quote (our OddsPapi
  budget covers only a fraction of matches), and (b) the measured gap
  between model and close, which sets the minimum model-vs-PM divergence
  worth acting on in Stage 2.
- Stage 2: mean pin_clv > 0 (match-clustered), per rule per tour.
  Secondary: match-clustered ROI z.

**candidate rules (Stage 2, pre-registered as a family now; numeric
thresholds fixed in a written addendum after Stage 1 and BEFORE the live
shadow read begins)** —
- **R1 (pin edge)**: bet the PM side that Pinnacle's de-vigged price says
  is underpriced, when divergence ≥ θ1. NOTE: this overlaps
  `docs/charters/pin-edge-gate.md` clause (b). The two must not become
  two reads of one hypothesis — resolution recorded below as an owner
  decision.
- **R2 (model edge)**: when no fresh Pinnacle quote exists at T, bet the
  PM side underpriced vs the Stage-1 model by ≥ θ2, restricted to
  calibration slices Stage 1 validated.
- **R3 (tennis-native wallet rule)**: a wallet-transparency rule derived
  for tennis from scratch — NOT the MLB recipe (top-20 × MLB-tuned
  PnL/momentum weights), which the 2026-08-31 read showed has no tennis
  skill. R3 has no thresholds and no shape yet: it may only be
  pre-registered by written addendum from the outputs of Stage 1b
  (below) and/or the wallet-sport specialization confirmatory read
  (~mid-Oct, `docs/charters/wallet-sport-clv.md`). Rationale: wallet
  visibility is Polymarket's structural moat — the only edge here a
  sharp-book arbitrageur cannot copy — and it is the proven mechanism
  behind the live MLB book. It failed on tennis as-implemented, not
  as-a-data-source.
- The WTA fade is NOT part of tennis-v2; it continues untouched under
  `docs/charters/fade-inversion.md` (read ~mid-Oct).

**Stage 1b — tennis holder-composition study (runs alongside Stage 1;
zero budget, data already owned)** — A DESCRIPTIVE study of the
`top_holders_json` snapshots stored on every tennis shadow row since
2026-08-18: who actually holds tennis markets (recurring wallets vs
one-offs), holder concentration vs MLB markets, whether any recurring
tennis wallet has a meaningful settled track record on tennis (
wallet-clustered, the specialization charter's artifact lesson applies),
and whether top-holder composition looks like bettors or resting
liquidity. Classified descriptive/exploratory under the doctrine: its
outputs are never promotion inputs and never a read — their sole use is
to decide whether an R3 addendum is worth pre-registering, and to
parameterize it if so. If nothing recurs or track records are null, that
is recorded as a valid result and R3 dies before it is born.

**validation_design (Stage 1)** — Season walk-forward: train ≤ 2021,
validate 2022; roll forward through 2025. 2026 YTD is the final test,
read once, after the leakage pre-audit (`leakage-audit` skill) passes.
Slices reported: surface, tour, favorite/dog, cold-start. Known risks the
pre-audit must clear: Sackmann fields computed post-match, ranking-date
as-of alignment, the retirement label rule, odds-column provenance
(closing vs opening).

**data_requirements_and_provenance** (all free; the no-paid-data
constraint is standing owner policy) —
- Historical: Jeff Sackmann `tennis_atp`/`tennis_wta` (results, rankings)
  + tennis-data.co.uk season CSVs (closing odds incl. Pinnacle).
  Snapshot into `data/tennis/` with download date; ≥ 90% closing-odds
  coverage of tour-level matches required or Stage 1 blocks.
- Live: existing OddsPapi tennis fetches within EXISTING caps (the US
  Open boost self-reverts 9/13; tennis-v2 adds zero budget), Polymarket
  books, existing shadow infrastructure.
- Freshness: Elo as-of date recorded per row. A player unseen for > 52
  weeks puts the match in a cold-start slice, reported separately.

**uncertainty_plan** — Match-clustered z everywhere; per-season fold
spread reported; no cross-tour pooling; cold-start slice never silently
mixed.

**acceptance_rule** —
- Stage 1 → Stage 2: candidate beats null AND Elo-vs-implied gap is
  quantified with acceptable calibration (ECE) on validation seasons.
  Beating the closing-odds baseline is NOT required (see honest
  expectation above); if the candidate loses even to the null, R2 is
  dropped and Stage 2 runs R1 only.
- Stage 2 → live probation (per rule, per tour): n ≥ 50 settled,
  match-clustered z ≥ 2, mean pin_clv > 0 — the same universal bar as
  `gate-verdict.ts`. The bar is arithmetic, not an MLB convention, and
  the standing rule from the tennis-verdict charter carries over: it is
  never loosened to make tennis pass.
- Promotion means: live via the existing bot at the fixed $8 stake,
  tennis-v2 stamped as its own strategy lane.

**failure_and_stop_conditions** —
- Stage 1 blockers: odds coverage < 90%; as-of timestamps for rankings/
  Elo inputs cannot be established. Record and stop.
- Stage 2: any rule reaching n ≥ 50 with pin_clv < 0 is killed. If R1
  and R2 both die and the WTA-fade read is also negative, tennis is
  recorded shadow-only indefinitely and this program stops.
- No threshold, slice, or metric changes after the first Stage-2 row is
  recorded, except by written re-charter.

**out_of_scope_and_prohibited_uses** — In-match/live betting; doubles;
Challenger/ITF; set/game derivative markets (props per era v7/v8);
causal claims about why prices diverge; any re-tuning against Stage 1
test folds; reading Stage 2 stats from ad-hoc cuts (gates_json lesson).

**required_artifacts** — This charter, owner-approved; data snapshots
with provenance notes; leakage pre-audit; Stage 1 read in
`docs/audits/`; thresholds addendum; Stage 2 rows in the existing
shadow table under a NEW lane (`reject_reason = 'tennis_v2_paper'`) so
the existing tennis probation population and its scheduled reads are not
contaminated.

## Open owner decisions (block Stage 2, not Stage 1)

1. **Clause-(b) coordination**: fold pin-edge-gate clause (b)'s tennis
   read into tennis-v2 R1 (one hypothesis, one read), or keep them
   separate with clause (b) taking precedence if it reaches n first.
   Recommendation: fold into R1 — two parallel reads of the same
   divergence signal is a multiplicity problem waiting to happen.
2. **Stage 2 duration cap**: recommend one calendar quarter per rule
   before a mandatory continue/stop review, so a thin-volume rule cannot
   linger unread forever the way the vector checkpoint did.
