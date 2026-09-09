# Wallet trade collection deployment

Scope: separate seven-day shadow pilot; no UI, order placement, stake/gate edits,
paid feeds, or changes to existing wallet experiment definitions. Contract:
[wallet-trade-pilot.md](../charters/wallet-trade-pilot.md).

Implementation: public Data API buys/sells, frozen activity-selected watchlist,
three wallets per cron, up to six first-sighting order-book snapshots, $8 gross
ask-depth VWAP, persisted missing/exclusion reasons and truncated-trade tombstones.
A separate ENAM-pinned instance of the existing Durable Object isolates requests
from the live pipeline. D1 lease/cooldown prevents concurrent/repeated collection.
The cohort expires after seven days; there is no automatic renewal or promotion.

Validation: 23 new tests exercise parsing, identity, timing, depth, stale/crossed
books, minimum size, real SQLite migration/queries, frozen selection, duplicate
replay, truncation, failures, expiry, lease exclusion, and crash-pending snapshots.
Public endpoint smoke test returned numeric trade timestamp/price/size, matching
book condition/token IDs, millisecond book timestamp and string minimum size.
CFB 2026 ID 12756 was verified directly with Gamma; it is a pilot-only supplement
to the existing fallback map, not a global live policy change.

## Operational queries

Use the existing `pnpm run d1:exec:remote --command "SQL" --json` helper against
polywhaler-db. Inspect counts, not individual addresses, in routine reports.

```sql
SELECT datetime(enrolled_at,'unixepoch') enrolled_utc,
       datetime(expires_at,'unixepoch') expires_utc,
       json_array_length(cohort_json) wallets, cursor,
       datetime(last_run_at,'unixepoch') last_run_utc
FROM wallet_trade_pilot;

SELECT datetime(started_at,'unixepoch') started_utc, finished_at,
       json_extract(report_json,'$.errors') errors,
       json_extract(report_json,'$.gaps') gaps,
       json_extract(report_json,'$.cappedPages') capped_pages,
       json_extract(report_json,'$.truncated') truncated, error
FROM wallet_trade_polls ORDER BY started_at DESC LIMIT 10;

SELECT sport, quote_status, COUNT(*) n,
       AVG(detected_at-trade_at) mean_detection_delay_seconds
FROM wallet_trade_observations GROUP BY sport, quote_status;
```

Pending rows are missing measurements, not successful quotes; do not repair them
with current prices. API/page caps and unknown markets mean this is a bounded
sample, never a complete wallet ledger. A usable snapshot is not an actual fill
and is gross of fees. No future CLV/ROI labels or strategy promotion are implemented
in this collection phase. Keep existing experiments and live betting unchanged.

Emergency stop (pilot only, preserves all observations): set `expires_at` to
the current Unix second for `wallet_trade_pilot.id=1`. A current in-flight run may
finish; subsequent runs make no trade/book requests. Do not delete the cohort to
restart it: write a new charter/cohort version instead.
