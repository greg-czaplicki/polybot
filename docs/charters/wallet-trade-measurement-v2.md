# Wallet trade measurement v2 — locked 2026-09-09

Addendum to wallet-trade-pilot.md, not a rewrite of its recorded observations.
At design time the pilot had five clean runs, 17 trades, one usable MLB quote,
14 unknown markets and no evaluated closes. Diagnostics identified a missing
MLB market and a tournament-prefixed tennis outcome. Changes below are motivated
by coverage, not observed CLV. No live picking changes or paid data sources.

## Question, population and time

Descriptive prospective feasibility: after detecting a selected wallet buy,
does the captured $8 gross ask-depth price beat the same token's pregame close?
Same 12 frozen wallets, six sports and September 16 expiry as v1; no replacement,
extension, new selection model or retroactive quote. New observations carry
collection_version=2. Report versions separately; v1 is not silently comparable.

T is quote receipt, not transaction time. Raw grain is a distinguishable trade;
evaluation grain is the FIRST observed buy per wallet/token in the original
cohort, ordered by detection time, trade time and trade key, before filtering
for successful quotes. Tokens identify condition/outcome globally. Earlier
missing quotes, pending claims, and locally truncated buys block later fills
from becoming replacement first signals. Sells remain descriptive only.

## Identity inventory / availability

At most two public Gamma condition-ID lookups per run, four-second timeout,
performed AFTER collecting trades. Resolve existing observed conditions, oldest
unattempted first. Cache successes for six hours and failures for 15 minutes;
no retry within the run. Read this metadata only on future first sightings,
with fetched_at <= detection and age <= six hours. Preserve the original
snapshot, status, cohort and trade price on every existing row.

Require exactly one matching condition, one event, two distinct outcome strings,
two distinct numeric token IDs and a single series ID. Known series outside the
target six sports are unsupported_sport; sportsMarketType with an unknown series
is unsupported_series; absence of recognized sports metadata is unclassified,
NOT evidence that a market is non-sports. Never guess sport/team/token from title.
Use gameStartTime only for missing cached schedules, not listing startDate or
resolution endDate. Snapshot the Gamma event ID for contest grouping. Explicit
closed/archived/not-accepting-orders flags exclude future quotes. If Gamma and
the existing cache disagree on sport or scheduled start, exclude with a metadata
conflict rather than silently changing timing. Token IDs may safely resolve
display-label differences; subsequent CLOB response must still match both IDs.
Without usable metadata, retain v1's conservative cached-label path and report
its identity source. Unknown availability is never treated as known at T.

## Close capture and settlement contract

Add at most TWO CLOB close requests per cron, round-robin by last attempt for
quoted condition/token/scheduled-start groups. Capture only during [start-600,
start), validate IDs, fresh source timestamp (<=60 seconds old, <=5 seconds
future, and strictly before start), positive uncrossed bid/ask and a valid book.
Store the latest valid snapshot within this window; a later failed attempt does
not erase it. Request and receipt must both be pre-start. Primary close is the
bid/ask midpoint, a mark-to-market benchmark, NOT an executable exit or ROI.
All time windows refer to the frozen Polymarket schedule, not independently
verified actual kickoff. Known tennis limitation: a stamped session time may
precede the real match by hours. Tennis marks remain session-time proxies and
cannot support true match-close or trading-readiness claims without validation.

Settle at least 60 seconds after the frozen start, up to 50 rows per cron.
Prefer the captured CLOB midpoint. If unavailable, permit the latest valid
sharp_money_history side price in [start-600,start), strictly AFTER quote receipt,
only when schedule and both labels match the frozen snapshot. This is an
ask-based close PROXY: label source history_ask_proxy and never pool it with
CLOB midpoint results. No current/postgame prices, binary resolution prices,
retroactive quotes, or later schedule/outcome-label repairs. No valid close
within seven days of start becomes missing_close, not a win/loss/zero CLV.
Available newer closes must not starve behind older rows missing closes.

Close labels are future TARGETS, never inputs at T. Immutable entry snapshot and
separate settlement table record source time, settlement time, close, follow
CLV and wallet-price/best-ask baselines. Finalized measurements are insert-once;
replays and future history cannot change them. Settlement and bounded closing
capture continue for already-recorded quotes after cohort expiry; new wallet
polls and identity lookups stop. Missing closes eventually terminate settlement.
Operator pause: `wallet_trade_pilot.enabled=0` stops all new runs, including
close capture and settlement, while preserving data (an in-flight run may finish).

## Locked metrics and validation

Primary descriptive metric: mean(close_midpoint - follow_VWAP), probability
points, higher is better. Baselines on IDENTICAL paired rows: zero price movement,
close minus original wallet fill (unavailable follower-price diagnostic), and
close minus observed best ask (simple depth-free follower baseline). Secondary:
relative CLV, quote and close coverage, buy/sell/mapping exclusions, detection
delay, poll gaps, page/local caps, distinct wallets, conditions and known events.
Net returns and fees remain unknown; never label gross CLV as expected profit.

First-signal rows are grouped by frozen Gamma event ID before averaging, with
equal weights to known events; report versions, sports and close sources
separately. Missing event IDs are a separate descriptive coverage count and
do not become independent games by substituting condition IDs. Multiple wallets,
sides and markets on one game remain dependent; report unique wallet count.
With only two nominated wallets per sport, broad wallet-population inference
and significance claims are prohibited. No leaderboard, p-values, or automated
promotion. Per-sport daily UTC-start blocks provide chronological diagnostics;
the same contest stays in one block. No fitting, preprocessing, tuning or random
split. Seven-day sample remains exploratory instrumentation, not final holdout.

Success/failure: original >=50 eligible buys, >=50% quote coverage, >=95% clean
polls remain instrumentation checks only, reported separately by version. Any
timing/identity violation invalidates measurement. Sparse/missing-close groups
are inconclusive. September 16 review may justify a NEW prospective charter;
live eligibility also requires separately validated net execution costs, broader
wallet/event coverage and an untouched chronological holdout. No live-ready
status can be emitted by this report. Do not tune gates after seeing results.

Artifacts: migration 0040, bounded identity/close services, read-only aggregate
digest without wallet addresses, SQLite timing/idempotence/aggregation tests,
deployment audit. Public contracts: [Gamma markets](https://docs.polymarket.com/api-reference/markets/list-markets)
and [CLOB book](https://docs.polymarket.com/api-reference/market-data/get-order-book).
