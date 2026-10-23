/**
 * Dota 2 match-winner sharp / team-specialist FOLLOW lane — live execution
 * pilot (era v26, 2026-10-23). Charter: docs/charters/dota2-wallet-follow-pilot.md.
 * Every threshold below is the contract; changing one after the forward
 * start means a NEW charter version and the prior rows become exploratory.
 *
 * Rule: polysharp (VPS, research/sharp/esports_follow_live.py) flags an
 * upcoming Dota 2 match winner when a SHARP wallet (≥ 30 settled Dota 2
 * positions at ≥ +10 % ROI) or, failing that, a TEAM specialist (≥ 10
 * settled positions on one of the match's teams at ≥ +15 % ROI) made a
 * pregame BUY ≥ $100 on one side within 24 h of start, and no wallet of
 * that kind bought the other side. This lane FOLLOWS that side inside the
 * bot window, $4. The pushed bet label is the outcome index ("A" = the
 * market's first outcome = sideA, "B" = second), because the cache's
 * esports side labels are parsed from the title and unreliable.
 *
 * Evidence: docs/audits/2026-10-21-dota2-wallet-backtest.md. The
 * pre-registered read (charter dota2-wallet-backtest.md) passed 0/15; this
 * rule is the POST-HOC combo pass: sharp ∪ team follow, one bet per match,
 * entered in the bot's 60-180 min window: since the 2026-05-06 split
 * 159-83 +10.7 % z 1.7 (n 242); full year +4.0 % (Jan-Apr warm-up
 * negative). Owner 2026-10-23: "Yes do it" (option 1, bot window).
 */

import type { LaneSignal } from "./cfb-hot-follow-lane";
import type { LaneConfig, LaneSide } from "./cs2-pickem-lane";

export const DOTA2_WALLET_FOLLOW_LANE: LaneConfig & {
	priceLo: number;
	priceHi: number;
} = {
	name: "dota2_wallet_follow",
	sportTag: "dota2",
	marketType: "moneyline",
	/** The backtest's entry band (first in-window fill 0.05–0.95). */
	priceLo: 0.05,
	priceHi: 0.95,
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
	/** 2026-10-23T12:00:00Z — deploy day. */
	forwardStart: 1792756800,
	/** Master switch (era-gated; flipping it is an era bump). */
	enabled: true,
};

/** The side to follow for a pushed Dota 2 signal (bet label "A" / "B"). */
export function dota2WalletFollowSide(
	signal: LaneSignal | undefined,
	sideA: { price?: number | null },
	sideB: { price?: number | null },
	nowSeconds: number,
	band: { priceLo: number; priceHi: number } = DOTA2_WALLET_FOLLOW_LANE,
): LaneSide | null {
	if (!signal || signal.voided || !signal.betLabel) return null;
	if (signal.triggerTs === null || signal.triggerTs > nowSeconds) return null;
	const want = signal.betLabel.trim().toUpperCase();
	if (want !== "A" && want !== "B") return null;
	const price = want === "A" ? sideA.price : sideB.price;
	if (
		typeof price !== "number" ||
		!Number.isFinite(price) ||
		price < band.priceLo ||
		price >= band.priceHi
	) {
		return null;
	}
	return want;
}
