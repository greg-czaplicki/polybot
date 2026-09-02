# Charter — Player props, record-only shadow cohort (`player_prop`)

Written 2026-09-02 under the `sports-modeling-doctrine` schema. Owner
decision the same day: "let's at least track it … track everything so we
can find areas that couldn't possibly make us money that we thought might."
This is the contract for a NEW shadow population; nothing here feeds the
bot. Changing target, grain, decision time, or metric after data exists
means a new charter version; the prior result is then exploratory.

## question
Does the holder-composition signal (top-20 holder snapshots × wallet
PnL/momentum — the same machinery that grades game markets) carry
information in Polymarket **player-prop** markets, per sport and per prop
subtype? Secondary, descriptive: how much volume do player props actually
carry on Polymarket (the owner's prior: "more than you think; NFL is a
major market")?

## why it was never tracked
Discovery (`sharp-money.ts` `isMainMarketTitle`) dropped any title matching
a player-stat pattern from the first commit; the era-v7 prop gate only ever
saw team totals, period markets and soccer derivatives. Lifted 2026-09-02:
player-prop titles now pass discovery (the $10k volume floor still
applies), classify as `prop` (`isPlayerPropTitle` in `line-ingestion.ts`),
reject on the era-v7 gate, and settle in the shadow book under subtype
`player_prop` (`PROP_SUBTYPE_SQL`). Live picking behaviour is unchanged —
NOT an era bump.

## sport_and_competition
Every sport the scanner covers. Read per sport AND per subtype (passing
yards ≠ anytime TD ≠ strikeouts). NFL is the expected first cohort (week 1
kicks off 2026-09-10; Polymarket lists "<A> vs. <B> - Player Props" events
under the NFL series, ~10 markets each, alt-line ladders per player).

## population_and_exclusions
`shadow_candidates` rows with `market_type = 'prop'`, subtype
`player_prop`, `created_at ≥ 2026-09-02T13:00Z`, `status ∈ {win, loss}`;
pushes reported as a count. Exclude `price < 0.25` (era v9 floor — the
phantom-edge mechanism applies with extra force on ladder tails) and
`price > 0.75`. Alt-line ladders: all lines are recorded; the read uses ONE
line per (event, player, stat) — the first sighted with the largest volume
— and treats the ladder as one cluster.

## grain_and_natural_key
One row = first sighting of one (market, side): `condition_id +
sharp_side`. Later sightings are dependent and dropped.

## analysis_type
Predictive (prospective), record-only. No causal claim.

## decision_time_and_horizon
T = sighting. Horizon = market settlement (game end). Features at T are the
standard signal components (`signal_components_json`, `top_holders_json`)
and the price; all stamped at T by the same code path as game markets.

## baselines
1. Coin flip at the sighting price (ROI 0 by construction after vig).
2. The game-prop cohorts (`btts`, `first_inning`, `team_total`, `period`)
   read on the same rule — props already tracked for a month.
3. No sharp-book benchmark exists: neither Pinnacle (OddsPapi catalog has
   zero player markets) nor the DK ESPN anchor carries player props, so
   `pin_clv` is NULL for this cohort BY CONSTRUCTION. The verdict rule's
   CLV criterion therefore falls back to the Polymarket self-close `clv`
   (`gate-verdict.ts`, `PIN_CLV_MIN_N` never reached) — a weaker proxy,
   disclosed here.

## primary_metrics
Per sport × subtype, clean cohort (prop gate sole blocker = `PROP_CLEAN_SQL`):
ROI at 1u/first-sighting price, event-clustered z (ladder = one cluster),
mean `clv` (PM self-close), n. Descriptive: markets seen / above floor /
total and max volume per tag per scan (`playerPropStats` in the runtime
market stats).

## pre_registered_hypothesis (pessimistic, written before any row exists)
H0: holder composition in player-prop books is dominated by the same
omnipresent liquidity wallets that made the tennis signal a coin flip
(2026-09-01 holder-composition study: top wallet on 39% of tennis markets,
66-71 record). Expected read: clean ROI ≈ 0, no subtype clears the bar.
The owner's counter-prior is on VOLUME, not signal — that is answered by
the descriptive metric regardless of the ROI read.

## acceptance_criteria
Standard bar, per sport × subtype, never pooled: n ≥ 50 clean settled
rows, clustered z ≥ 2, clv > 0 — AND, because `pin_clv` is unavailable,
a second independent block (the next n ≥ 50) that replicates z ≥ 1.5. Only
then may a `player_prop` policy segment be designed, shadow-run n ≥ 50,
and go live as its own strategy lane (era bump). Below the bar: stays
record-only; a subtype with n ≥ 100 and z ≤ 0 is recorded as "cannot
make money" in `docs/STRATEGY.md` and dropped from further reads.

## stop_conditions
- Subrequest budget: if player props push a scan past its market budget
  (visible as pagination-cap hits or `analyzeSharpMoney` budget warnings),
  restrict discovery to football before any other fix — never lower the
  volume floor.
- Zero player-prop rows by 2026-09-15 → discovery or classification bug,
  not "no volume": `playerPropStats.seen` must be > 0 on NFL weekends.

## data_requirements
n ≥ 50 clean settled rows in a subtype. Expected pace unknown; the
descriptive metric after week 1 sets it.

## leakage_pre_audit
Same pipeline as game markets (audited 2026-08-05/08-07; trend-snapshot
lookahead closed). Player props carry no trend context (`game_id` NULL —
titles have no matchup), so the trend tier is inert. Settlement via
condition resolution, as for all shadow rows. No new leakage path.
