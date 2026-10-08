/**
 * Open-exposure limit (owner decisions 2026-10-08): the bot may have at most
 * this much money riding on unsettled bets at once — every lane plus the
 * holder book. Settled bets free the room, so a winning day keeps firing.
 * Replaces the per-lane daily caps; the bot's rolling-24h placed limit
 * (BOT_DAILY_NOTIONAL_CAP, $100) stays only as a malfunction backstop.
 * Charter: docs/charters/lane-stake-ladder.md (§ open-bet limits).
 */
export const MAX_OPEN_NOTIONAL_USD = 50;
