# Auto Trading Design (Polymarket)

Status: Draft
Owner: TBD
Date: 2026-01-30

## Background
We want an auto-trading bot for Polymarket that places moneyline bets in the final 5 minutes before event start. The bot should prioritize high-quality "A" bets (and optionally "B" bets) and integrate with existing sharp analysis in this repo.

This design aligns with the manual-first hardening roadmap in `docs/roadmap-bot.md`.

## Current Bet Grading (Audit Summary)
Source: `src/server/api/sharp-money.ts`, `src/routes/sharp.tsx`.

### Edge rating computation
- Sharp side is "A" or "B" if its sharp score exceeds the other by more than 5; otherwise "EVEN".
- `calculateEdgeRatingBreakdown` uses:
  - Score differential (log curve) up to 70 points.
  - Volume bonus up to 5 points (log curve).
  - Holder quality bonus from -15 to +20 points (weighted PnL).
- Edge penalties apply for low PnL coverage, low holder count, low conviction, and high concentration.
- Final edge rating is `baseEdgeRating * edgePenalty`, clamped to 0-100.

### Grade mapping and filtering (UI)
- Grades are derived from `signalScore` (0-100), not raw edge rating.
- `signalScore` is computed from:
  - `edgeRating` (70%)
  - normalized score differential (20%)
  - trend/volume/stability deltas from recent history
  - fallback to `edgeRating * 0.75 + diffScore * 0.25` if insufficient history
- Grade thresholds and floors (current UI logic):
  - A+ if `signalScore >= 92` AND `edgeRating >= 80` AND `scoreDifferential >= 30`
  - A if `signalScore >= 85` AND `edgeRating >= 72` AND `scoreDifferential >= 20`
  - B if `signalScore >= 75`
  - C if `signalScore >= 65`
  - D otherwise
- `MIN_EDGE_RATING = 66` is used for stability scoring and filtering.

## Assumptions
- Personal-use only; no multi-user access or external exposure required.
- Configuration is local and managed by the owner.

## Goals
- Auto-execute Polymarket moneyline bets within a 5-minute window before event start.
- Default to "A" bets; allow configurable inclusion of "B" bets.
- Base trading decisions on server-side `signalScore` + grade (not client-only).
- Maintain risk limits and a kill switch.
- Provide auditability for decisions and executed orders.

## Non-goals
- No spreads or O/U until Polymarket adds those markets.
- No high-frequency market making or arbitrage.

## Requirements
- Moneyline only (current Polymarket market types).
- Trades placed only in a time window `event_start - 5m` to `event_start`.
- Bet threshold based on `signalScore`/grade (A+ or A), not raw edge rating.
- Optional B bets (default: off).
- `isReady` must be met (min holder count + PnL coverage).
- Configurable max stake per market and daily loss cap.
- Safe retry behavior and idempotent order placement.

## Proposed Architecture (Service + Shared Grading)
Single service first; split later if needed.

### Components
- Market data client: fetches Polymarket markets and prices.
- Strategy engine: filters markets and computes bet decision from grade + timing.
- Risk engine: enforces stake limits, daily caps, and cooldowns.
- Execution engine: sends orders, monitors fills, handles retries/cancels.
- Storage/logging: local DB or remote store for audit trail and metrics.

### Integration options
1) Use server-side grading endpoint (bulk) as the source of truth.
2) Share grading logic via a common module used by both UI and server.
3) Hybrid: server grades + local execution layer.

## Strategy Logic (Initial)
- Only consider markets with `eventTime` within 5 minutes.
- Require grade A+ or A (configurable).
- Optional: allow B bets if enabled.
- Skip "EVEN" sharp side unless a separate rule allows it.
- Avoid low-confidence signals if warnings include low PnL coverage or low conviction.

## Risk Controls
- Per-market stake cap.
- Daily loss cap and auto-disable when breached.
- Minimum liquidity/volume threshold.
- Minimum holder count threshold to avoid thin markets.
- Cooldown period after consecutive losses.

## API Exposure
- Single-user: no public or shared API. Use local config and logs only.
- Local-only grading endpoint for UI + bot (bulk grades).

## Observability and Audit
- Append-only trade log with inputs (edge rating, side, price, time).
- Record order responses and fill outcomes.
- Daily summary report (PnL, win rate, exposure).

## Rollout Plan
1) Dry-run mode: compute and log trades without execution.
2) Paper trading on test or minimal stake.
3) Limited real trading with strict caps.
4) Expand to larger stakes and broader market coverage.

## Open Questions
- Confirm A+/A thresholds and grade floors for auto-trades.
- Decide whether to consume server grading endpoint or embed shared logic in bot.
- Validate Polymarket API rate limits and fill semantics.
- Define exact start-time source and latency tolerance.
- Determine how to cross-check FanDuel lines (manual vs automated).
