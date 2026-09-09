# Wallet trade identity and CLV measurement v2

Scope: complete the shadow measurement loop, not enable live following. No UI,
paid provider, wallet reselection, strategy version bump, or historical quote
repair. Contract: [wallet-trade-measurement-v2.md](../charters/wallet-trade-measurement-v2.md).

## Delivered

- Future-only Gamma enrichment, two condition-ID requests per run. Exact token
  IDs resolve display-label differences and missing cached sports markets.
  Unknown series remain unclassified/unsupported; no title-based sport guessing.
- Up to two CLOB close requests per run in the final ten scheduled minutes.
  Valid midpoint snapshots survive later request failures. Late responses and
  stale, crossed or mismatched books never become closes.
- Insert-once settlement, up to 50 rows per run. Primary midpoint and secondary
  history ask-proxy sources are explicitly separate. Missing labels expire after
  seven days; newer measurable rows do not starve behind missing history.
- `/api/wallet-trade-digest`: read-only aggregates, frozen first-signal counts,
  equal-event metrics and chronological daily blocks by version/sport/source.
  No addresses, rankings, p-values or live-ready verdict.
- Dedicated run-version column preserves interrupted-run attribution; operator
  pause is `wallet_trade_pilot.enabled=0`. Expiry keeps recorded-close maintenance
  active but stops new polling and metadata requests.

## Timing / leakage review

Target: source-specific scheduled-close price minus captured follow VWAP.
Decision time: original quote receipt; raw grain: wallet transaction/token fill;
evaluation grain: first observed wallet/token buy, then known event grouping.

PASS (code and SQLite fixtures):

- Original observation rows, selection and first quotes do not change after
  enrichment or later API responses. Metadata must already be available at
  detection; resolving this run's misses happens after its trade processing.
- Close receipt/source windows are pre-start, entry receipt is at least 15
  minutes pre-start, and target snapshots must follow entry receipt.
- History fallbacks require matching condition, schedule and both labels;
  stale, post-start, zero/one and wrong-side values are excluded.
- Replays cannot replace finalized targets. Failed database reads cannot turn
  missing data into zero CLV or a successful settlement.
- First-buy selection happens before filtering for quote success. Prior local
  truncation blocks later replacement signals. Repeated fills do not inflate
  sample counts; unknown event IDs are not converted into independent games.
- Collector versions, midpoint/proxy sources and sports remain separate.
  There is no fitted preprocessing, tuning, random split or promotion code.

REVIEW REQUIRED for predictive/trading claims:

- Frozen Polymarket times are not independently verified actual starts; tennis
  can carry session times, not match times. Postponements and revisions remain
  target-validity limitations. The report explicitly labels its timing basis.
- Quote snapshots are gross indications, not fills or executable exits. Fees,
  latency, adverse selection and net profitability are not validated.
- v1 rows lack frozen Gamma event IDs and cannot be retroactively promoted into
  the known-event cohort. Public Data API page limits and identical-fill keys
  mean this is not a complete on-chain ledger.
- Only two nominated wallets per sport; no broad wallet-population significance
  or untouched predictive holdout exists. September 16 is an instrumentation
  checkpoint, not an automatic strategy unlock.

Verdict: tested timing/identity mechanics pass; predictive usefulness remains
REVIEW REQUIRED. Automated matrix-correlation heuristics are inapplicable here:
there is no fitted prediction matrix. Adversarial SQLite fixtures exercise the
actual acquisition, target joins, deduplication and aggregation instead.

## Verification and operations

21 new tests plus the existing 23 wallet-pilot tests cover token matching,
future/stale metadata, enrichment bounds/backoff, immutable observations,
close boundaries/failures, expiry/pause behavior, missing-history starvation,
settlement replay, first-signal censorship, event weighting and privacy.

Migration 0040 is additive and was applied through the D1 migration ledger to
polywhaler-db at 12:59:09 UTC on September 9 (ledger row present, none pending).
Source commit `9c05864`; Worker version `83fcf535-3248-4bab-aa5a-6d350e17194b`
deployed at 12:59:59 UTC.

Post-deploy check at 13:09 UTC: `/api/wallet-trade-digest` returned HTTP 200,
stage `collecting`, 12 wallets enrolled, five v2 polls with zero errors and zero
eligible buys yet (minutes after deploy, expected). `/api/shadow-digest` returned
HTTP 200, `health.alert=false`, 239/240 runs successful in 24h, no chronic
errors. A successful heartbeat is not evidence of trading edge.

Emergency pause (preserves observations and does not affect live betting):
`UPDATE wallet_trade_pilot SET enabled=0 WHERE id=1;`
An already-running sweep may finish. Resume with enabled=1 without deleting the
cohort; expiry remains enforced. Never restart the pilot by clearing its tables.
