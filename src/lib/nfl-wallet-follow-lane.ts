/**
 * NFL totals wallet FOLLOW lane — live execution pilot (era v22,
 * 2026-10-09). Charter: docs/charters/nfl-wallet-follow-pilot.md. Every
 * threshold below is the contract; changing one after the forward start
 * means a NEW charter version and the prior rows become exploratory.
 *
 * Rule: polysharp (VPS, research/sharp/wallet_lane_live.py, RULE=S3SQ)
 * flags an upcoming NFL game total when TEAM-specialist wallets (≥ 10
 * settled NFL positions on one of the game's teams at ≥ +15 % ROI) bought a
 * side and/or SQUARE wallets (≥ 30 settled NFL positions at ≤ −15 % ROI)
 * bought the other side (≥ $100 summed over the game's total lines), with
 * no such support for the opposite side. This lane bets the supported side
 * inside the bot window, $4, priced in [0.35, 0.65). Support on both sides =
 * no bet. Regular season only.
 *
 * Evidence (docs/audits/2026-10-09-nfl-wallet-backtest.md): pre-registered
 * read 0/30 and the CFB rule (HT) did not replicate (2026 n 7); in the
 * constructive pass after it, "team specialist on a side OR square on the
 * other" one bet per game at the first in-window fill: 53-30, +26.8 %,
 * z 2.5, $4 → +$89; 2025 +25 % (n 73), 2026 +38 % (n 10); 7 of 7 months
 * positive. Exploratory (chosen after looking at ~6 combinations): an
 * execution pilot, not a promotion. Owner 2026-10-09: "go, start NFL
 * tonight" / "$50 … your life depends on it".
 *
 * Runs BEFORE the NFL totals pilot in the lane order.
 */

import { type LaneSignal, laneSignalSide } from "./cfb-hot-follow-lane";
import type { LaneConfig, LaneSide } from "./cs2-pickem-lane";
import { isNflPreseasonTime } from "./sports";

export const NFL_WALLET_FOLLOW_LANE: LaneConfig & {
	priceLo: number;
	priceHi: number;
} = {
	name: "nfl_wallet_follow",
	sportTag: "nfl",
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
	/** 2026-10-11T12:00:00Z — before the first Sunday slate after deploy. */
	forwardStart: 1791720000,
	/** Master switch (era-gated; flipping it is an era bump). */
	enabled: true,
};

/** The side to bet for an NFL wallet signal; null in the preseason. */
export function nflWalletSide(
	signal: LaneSignal | undefined,
	sideA: { label?: string | null; price?: number | null },
	sideB: { label?: string | null; price?: number | null },
	eventTimeMs: number | null | undefined,
	nowSeconds: number,
): LaneSide | null {
	if (typeof eventTimeMs !== "number" || !Number.isFinite(eventTimeMs)) {
		return null;
	}
	if (isNflPreseasonTime(eventTimeMs)) return null;
	return laneSignalSide(
		signal,
		sideA,
		sideB,
		nowSeconds,
		NFL_WALLET_FOLLOW_LANE,
	);
}
