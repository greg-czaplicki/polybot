# Auto Trading Design (Polymarket)

Status: Draft
Owner: TBD
Date: TBD

## Background
We want an auto-trading bot for Polymarket that places moneyline bets in the final 5 minutes before event start. The bot should prioritize high-quality "A" bets (and optionally "B" bets) and integrate with existing sharp analysis in this repo.

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
- Grade thresholds:
  - A+ >= 90
  - A >= 80
  - B >= 70
  - C >= 65
  - D < 65
- `MIN_EDGE_RATING = 65` filters lower-quality entries from the default view.

## Assumptions
- Personal-use only; no multi-user access or external exposure required.
- Configuration is local and managed by the owner.

## Goals
- Auto-execute Polymarket moneyline bets within a 5-minute window before event start.
- Default to "A" bets; allow configurable inclusion of "B" bets.
- Maintain risk limits and a kill switch.
- Provide auditability for decisions and executed orders.

## Non-goals
- No spreads or O/U until Polymarket adds those markets.
- No high-frequency market making or arbitrage.

## Requirements
- Moneyline only (current Polymarket market types).
- Trades placed only in a time window `event_start - 5m` to `event_start`.
- A bet threshold based on edge rating (default: >= 80).
- Optional B bet threshold (default: 70-79).
- Configurable max stake per market and daily loss cap.
- Safe retry behavior and idempotent order placement.

## Proposed Architecture (Rust Service)
Single Rust service first; split later if needed.

### Components
- Market data client: fetches Polymarket markets and prices.
- Strategy engine: filters markets and computes bet decision from edge rating + timing.
- Risk engine: enforces stake limits, daily caps, and cooldowns.
- Execution engine: sends orders, monitors fills, handles retries/cancels.
- Storage/logging: local DB or remote store for audit trail and metrics.

### Integration options
1) Pull sharp analysis from the existing backend endpoints and reuse edge rating.
2) Port the analysis to Rust for fully local decisions.
3) Hybrid: use existing analysis for selection, add Rust-only execution layer.

## Strategy Logic (Initial)
- Only consider markets with `eventTime` within 5 minutes.
- Require `edgeRating >= 80` for A bets (configurable).
- Optional: allow B bets when `70 <= edgeRating < 80` if enabled.
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
- Optional local-only control surface if needed later (e.g., CLI or localhost dashboard).

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
- Confirm "A" bet threshold and edge rating mapping for auto-trades.
- Decide whether to consume existing sharp analysis or port to Rust.
- Validate Polymarket API rate limits and fill semantics.
- Define exact start-time source and latency tolerance.
- Determine how to cross-check FanDuel lines (manual vs automated).
