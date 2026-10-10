/**
 * NHL totals hot / team-specialist FADE lane — live execution pilot (era v23,
 * 2026-10-09). Charter: docs/charters/nhl-hot-fade-pilot.md. Every threshold
 * below is the contract; changing one after the forward start means a NEW
 * charter version and the prior rows become exploratory.
 *
 * Rule: polysharp (VPS, research/sharp/wallet_lane_live.py, RULE=HTFADE)
 * flags an upcoming NHL game total when HOT wallets (≥ 9 of their last 12
 * settled NHL positions won) or TEAM specialists (≥ 10 settled positions on
 * one of the game's teams at ≥ +15 % ROI) bought one side (≥ $100 summed
 * over the game's total lines) and none bought the other. This lane bets the
 * OTHER side inside the bot window, $4, priced in [0.35, 0.65). Such wallets
 * on both sides = no bet. Regular season only.
 *
 * Evidence: the pre-registered NHL wallet backtest
 * (docs/charters/nhl-soccer-wallet-backtest.md; audit
 * docs/audits/2026-10-09-nhl-soccer-wallet-backtest.md) — cell A HT passed
 * the CANDIDATE rule as a negative: follow discovery −16.0 % z −2.1 (n 163),
 * holdout −12.0 % z −1.4 (n 125). Fade, one bet per game at the first
 * in-window fill: 164-124, +12.6 %, z 2.2, $4 → +$146; 7 of 10 months
 * positive. The same wallet types are FOLLOWED in CFB (era v21). Owner
 * 2026-10-09: "Open whatever lanes you think makes sense".
 */

import { type LaneSignal, laneSignalSide } from "./cfb-hot-follow-lane";
import type { LaneConfig, LaneSide } from "./cs2-pickem-lane";
import { isNhlPreseasonTime } from "./sports";

export const NHL_HOT_FADE_LANE: LaneConfig & {
	priceLo: number;
	priceHi: number;
} = {
	name: "nhl_hot_fade",
	sportTag: "nhl",
	marketType: "total",
	/** The backtest's line band (first in-window fill 0.35–0.65). */
	priceLo: 0.35,
	priceHi: 0.65,
	/** Fixed stake in USD. The bot's BOT_LANE_STAKES must match. */
	stakeUsd: 4,
	/** Unsettled lane bets at once. */
	maxOpenPicks: 5,
	oneTeamPerDay: false,
	/** Kill: realized lane PnL at or below this (USD) stops emission. */
	killDrawdownUsd: -40,
	killTrailingN: 100,
	killMinSettled: 30,
	killZ: -1,
	/** 2026-10-10T12:00:00Z — before the first slate after deploy. */
	forwardStart: 1791633600,
	/** Master switch (era-gated; flipping it is an era bump). */
	enabled: true,
};

/** The side to bet for an NHL hot-fade signal; null in the preseason. */
export function nhlHotFadeSide(
	signal: LaneSignal | undefined,
	sideA: { label?: string | null; price?: number | null },
	sideB: { label?: string | null; price?: number | null },
	eventTimeMs: number | null | undefined,
	nowSeconds: number,
): LaneSide | null {
	if (typeof eventTimeMs !== "number" || !Number.isFinite(eventTimeMs)) {
		return null;
	}
	if (isNhlPreseasonTime(eventTimeMs)) return null;
	return laneSignalSide(signal, sideA, sideB, nowSeconds, NHL_HOT_FADE_LANE);
}
