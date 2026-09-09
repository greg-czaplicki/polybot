# Wallet trade / executable-price collection pilot v1

Locked 2026-09-09, before collection. Owner: Polywhaler. Shadow only; independent
of `wallet-sport-clv.md`, wallet_entries scoring, and live trading rules.

## Question and population

Can bounded public Polymarket polling observe sports wallet buys early enough
to measure the price a follower could have obtained? This is a prospective
measurement feasibility experiment, not a profitability or sharp-wallet claim.
Target competitions: MLB, NFL, NCAAF, EPL, ATP, WTA. Known cached markets only;
unknown series/conditions/outcomes are not guessed from titles.

At first successful enrollment, nominate the two most recently observed wallets
per series from wallet_entries in the preceding seven days (ties: address).
Merge series into sports using the existing series registry snapshot, keep at
most two nominations per sport in descending recency order, and deduplicate
wallets across sports. The cold collector uses the registry fallback plus the
verified pilot-only mapping `12756 -> ncaaf` ([Gamma CFB 2026](https://gamma-api.polymarket.com/series/12756),
checked 2026-09-09); no recurring series-discovery requests or live mapping edits.
Maximum 12 wallets. Freeze addresses, nomination sport,
prior observation count, and last observation time for seven days. Do not use
CLV, profits, or future results for selection. Do not replenish or automatically
renew this cohort. Empty enrollment is a reported failure, not an endless retry.

## Collection contract

One row is one distinguishable Data API trade: wallet, transaction hash, token,
side, trade timestamp, price, size. The API does not supply a fill log index;
identical fills within one transaction may collapse. This is not a complete
on-chain accounting ledger. Both buys and sells are observed; sells are not
short/fade signals.

Every two-minute cron, rotate three wallets, polling the last 15 minutes after
enrollment with `takerOnly=false`, `limit=100`, and a $100 CASH filter. Locally
validate the same constraints. Persist at most ten previously unseen trades per
wallet, newest first (stable trade key breaks ties). A capped API page and local
truncation are counted; neither implies complete coverage. Locally truncated trade keys are tombstoned so
later polls cannot replace their missing first-sighting quotes. A poll interval over
15 minutes is an explicit gap. No historical catch-up or retroactive quote.
Maximum three trade requests and six book requests per run, four-second timeout
per request. No retries within a run. A durable lease and 110-second cooldown
bound concurrent/repeated invocations. Collection stops seven days after enrollment.

Quotes are attempted once for the first six eligible new buys in the deterministic
rotation/order above. Other rows retain a budget-exhausted reason, not a later
replacement quote. Eligibility: known target sport; exact unambiguous cached
outcome label; event at least 15 minutes away at detection and quote receipt;
trade timestamp within the polling window. Snapshot cached schedule and labels
at detection; future schedule revisions must not overwrite these fields.

Validate book condition and token IDs, timestamp (seconds or milliseconds),
finite positive levels, minimum order size, and uncrossed spread. Reject source
timestamps older than 60 seconds or more than five seconds in the future.
Record receipt time and source time separately, top bid/ask and full returned
depth. Walk ascending asks for a hypothetical $8 purchase, requiring enough
depth and the book's minimum share size. This is gross indicative VWAP, **not**
a fill guarantee: fees, race/latency, cancellations and execution are unmodeled.
Pending claims are inserted before fetching. Crashed or failed quote attempts
remain missing; duplicate trade observations never refresh prices.

## Feature / time inventory

| Field | Source and availability | Transform / missing policy | Verdict at T |
| --- | --- | --- | --- |
| Cohort and prior activity | D1 entries observed before enrollment | Seven-day count/recency, frozen; no CLV filter | Legal selection input |
| Wallet trade | Public Data API, first detection timestamp | Stable IDs; validate wallet/time/price/size; malformed count | Known at detection, not at trade time |
| Event/sport/outcome | Existing cache read at detection | Condition ID join; exact distinct label; unknown excluded | Conditional on cached schedule accuracy |
| Follow price and depth | Public CLOB, received at T | $8 ask walk; no imputation or later replacement | Known at quote receipt only |
| Closing price / result | Future source, not collected by this pilot | Missing until separate settlement work | Illegal as an input at T |

T is quote receipt, not the wallet's transaction time. Forecast horizon for a
later CLV experiment would end at scheduled event start. Future observations
cannot change cohort selection or original snapshots. No fitted transforms.

## Evaluation and stopping

Primary pilot metric: usable quote snapshots / new otherwise-eligible buys,
higher is better. Report budget exclusions, API/local caps, malformed trades,
unknown mappings, failures, poll gaps, source age and detection latency alongside
the denominator, per sport. Unknown-wallet activity is outside the denominator;
never claim total wallet coverage. Baseline: current top-holder-delta observations
cannot establish actual wallet fills; naive follow-price baseline is the wallet's
reported price, strong simple comparison is observed best ask versus depth VWAP
on identical quoted rows. There is no profitability null test in this pilot.

After seven days: continue to a separately locked CLV evaluation only if at least
50 otherwise-eligible buys were observed, at least 50% have usable quotes, and
at least 95% of run attempts finish without an error. Report sport-level counts;
insufficient sport samples remain inconclusive. These are instrumentation gates,
not trading promotion gates. Revise limits explicitly if caps/gaps dominate;
never silently optimize selection using favorable quotes or results. Stop on
identity/timing violations, unexpected cost, or expiry. Empty cohort fails.

Future performance work must use chronological post-enrollment observations,
first wallet/condition/side per event, wallet-and-event dependence, paired
baselines, missing-close coverage and net execution costs. No pooled all-sport
promotion, no claims from repeated fills as independent observations. A written
validation/leakage review is required before trusting such results.

Artifacts: this charter, migration 0039, immutable trade snapshots and per-run
diagnostics, parser/order-book/SQLite integration tests. No UI changes, paid
odds dependency, live orders, automatic strategy promotion or wallet copying.

Public contracts: [Data API trades](https://docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets)
and [CLOB order book](https://docs.polymarket.com/api-reference/market-data/get-order-book).
