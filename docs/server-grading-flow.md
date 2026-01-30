# Server-Side Grading Flow (Draft)

Owner: TBD
Date: 2026-01-30
Status: Draft

## Purpose
Define the server-side grading flow used by the bulk grading endpoint so manual UI and bots consume a single source of truth.

## Inputs
- `conditionIds: string[]`
- Optional `historyWindowMinutes` (default 60)
- Optional `staleThresholdMinutes` (default 15)

## Data Sources
- `sharp_money_cache` for current edge rating, readiness, and warnings
- `sharp_money_history` for recent signal score computation

## Flow
1) Validate input
   - Reject empty list.
   - Cap max items per request (suggest 100–250).

2) Fetch cache entries
   - Query `sharp_money_cache` by `conditionIds`.
   - Missing entries return `error: "not_found"`.

3) Fetch recent history
   - Query `sharp_money_history` for all `conditionIds` within `historyWindowMinutes`.
   - Group history by `conditionId`.
   - If history length < 2, treat as insufficient history.

4) Compute signal score
   - Use shared grading module.
   - If history is insufficient, fallback to edge/diff blend.

5) Compute grade
   - Use `signalScoreToGradeLabel` with configured floors.

6) Compute freshness
   - `historyUpdatedAt = max(recordedAt)` for each condition.
   - `computedAt = now`.
   - `stale` if `now - historyUpdatedAt > staleThresholdMinutes`.

7) Assemble result
   - `grade`, `signalScore`, `edgeRating`, `scoreDifferential`, `isReady`, `warnings`, `computedAt`, `historyUpdatedAt`.

## Warnings
- `stale_data` if history is stale.
- `not_ready` if `isReady === false`.
- `no_edge` if `sharpSide === "EVEN"`.
- `low_conviction` / `high_concentration` if present in cached analysis.

## Determinism
- Make `historyWindowMinutes` and thresholds explicit to avoid hidden defaults.
- Ensure server and UI use the same shared grading module.

## Performance
- Batch DB reads: one query for cache, one query for history.
- Group history in memory by `conditionId`.

