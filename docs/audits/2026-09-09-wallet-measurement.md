# Wallet settlement and qualification — 2026-09-09

Owner authorized the next implementation priority: unblock wallet settlement and
qualify wallets on distinct markets. No UI, live scoring, stake, or gate changes.

## Baseline and fix

Production baseline: 79,915 ledger entries, 5,682 open, 5,034 past the one-hour
settlement delay. Oldest open event September 2. There were 171 wallets with
three or more closed entries but fewer than three distinct closed markets.

Settlement now selects entries with an available valid pre-event close OR an
expired seven-day void deadline. Missing-close entries remain open without
occupying the batch. Prices still come from the latest positive side-specific
history observation at/before event time, at most one hour old. A valid close
still wins over voiding even after seven days. Database failures propagate to
the existing cron error handler; they do not become missing-close voids. Writes
require open status and count actual changes, making replay safe. No migration
is needed and historical closed/void entries are not rewritten.

Leaderboard and specialist CLV are aggregated per wallet/condition, including
both sides in one market observation. For measured closed increments:

- observed shares = delta_usd / entry_price;
- closing gain = sum(observed shares * clv);
- market CLV = closing gain / sum(observed shares);
- market relative CLV = closing gain / sum(delta_usd).

Shares here are implied by ledger dollars and observed prices, not exchange
fills. Top-20 visibility and observation-price limitations remain.

Markets have equal weight in wallet averages. A market qualifies only after all
entries are terminal and at least one has valid measured CLV. Voids contribute
no measured CLV. Three distinct measured markets are required for leaderboard
qualification; specialist CLV qualification uses the same market counts. Raw
entry counts, volume totals and the overall ledger summary remain entry-level
descriptive counts. `closed` and `beatCloseCount` in ranked wallet rows are now
market counts; `entries` remains the number of ledger observations.

The specialist designation still means sport concentration, not proven skill.
Different markets of the same game are still separate conditions. Opposite-side
holdings are pooled for measurement, not reinterpreted as directional conviction.

## Timing and leakage checks

This is a descriptive record as of query time, not a historical prediction or a
new model. Entry grain and observed prices remain unchanged. Close prices are
post-observation evaluation labels, constrained to pre-event history; no close
or ranking is introduced into live inputs. `settled_at` remains actual processing
time, including newly processed backlog. No historical availability is backdated.
The prospective wallet-sport charter (first-entry dedup, settled-before-observed
priors, wallet-clustered acceptance) is unchanged; these rankings do not replace
that confirmatory analysis. Prediction-skill verdict remains REVIEW REQUIRED.

## Verification

SQLite integration tests execute the production queries and settlement function,
covering 50 missing closes before a newer valid entry, replay, correct side,
stale/post-start/null quotes, void expiry, database failure, distinct-market and
hedge qualification, partial settlement, cash/share weighting and invariance to
splitting a position into more increments.

Read-only production checks found 50 available closes in the first new batch
(query ~1.3 ms), and a minimum of three measured markets in the returned top 25.
Both ranking queries executed successfully (~0.8–0.9 seconds each on this data).
The rankings are descriptive and more expensive than raw increment averages.

Full suite: 322 tests passed across 18 files. Biome passed on the four changed
TypeScript files and the production build passed. The earlier repository-wide
TypeScript failures remain outside this change; no claim of a clean typecheck.

Deployed version `695c6250-b819-4c7c-8477-8cdcce63fb5f`. Production health returned
HTTP 200 with no alert. At 12:18:56 UTC, the cron closed 50 wallet entries after
deployment, confirming the backlog is being processed. Source changes remain
in the working tree.

Owner constraint added during verification: no paid odds API subscriptions or
upgrades. Future planning should center on Polymarket wallet/price data and use
existing free external allowances only as optional benchmarks. This constraint
does not itself alter existing registered promotion criteria or activate lanes.
