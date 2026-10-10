/**
 * CFB totals hot / team-specialist FOLLOW lane — live execution pilot
 * (era v21, 2026-10-09). Charter: docs/charters/cfb-hot-follow-pilot.md.
 * Every threshold below is the contract; changing one after the forward
 * start means a NEW charter version and the prior rows become exploratory.
 *
 * Rule: polysharp (VPS, research/sharp/cfb_hot_live.py) flags an upcoming
 * college-football game total when wallets that are HOT (≥ 9 winners in
 * their last 12 settled CFB positions) or TEAM specialists (≥ 10 settled
 * positions on one of the game's teams at ≥ +15 % ROI) have bought one side
 * (≥ $100 summed over the game's total lines) and none such has bought the
 * other. This lane bets THAT side inside the bot window, $4, priced in
 * [0.35, 0.65). Such wallets on both sides = no bet. Wallet records come
 * from the full maker+taker CFB tape, rebuilt daily on the owner's desktop.
 *
 * Evidence (docs/audits/2026-10-09-ncaaf-wallet-backtest.md): the union of
 * the backtest's S2 (hot) and S3 (team) follow cells, one bet per game at
 * the first in-window fill: 72-50, +19 %, z 2.1, $4 → +$93; 2025 season
 * +23 % (z 1.9), 2026 to date +14 % (z 1.0); 5 of 6 months positive; Over
 * +29 % and Under +11 %. The union was chosen AFTER the pre-registered 0/26
 * read (exploratory): an execution pilot, not a promotion. Owner decision
 * 2026-10-09: "live at $4, set it up for tomorrow".
 *
 * Runs BEFORE the NCAAF totals pilot in the lane order, so a game with a
 * hot/team signal is bet by this lane and the pilot keeps the rest.
 */

import type { LaneConfig, LaneSide } from "./cs2-pickem-lane";

export const CFB_HOT_FOLLOW_LANE: LaneConfig & {
	priceLo: number;
	priceHi: number;
} = {
	name: "cfb_hot_follow",
	sportTag: "ncaaf",
	marketType: "total",
	/** The backtest's line band (first in-window fill 0.35–0.65). */
	priceLo: 0.35,
	priceHi: 0.65,
	/** Fixed stake in USD. The bot's BOT_LANE_STAKES must match. */
	stakeUsd: 4,
	/** Unsettled lane bets at once (5 → 10, era v25, owner 2026-10-10:
	 * the lane hit 5 open early on its first Saturday and skipped the rest). */
	maxOpenPicks: 10,
	oneTeamPerDay: false,
	/** Kill: realized lane PnL at or below this (USD) stops emission. */
	killDrawdownUsd: -40,
	killTrailingN: 100,
	killMinSettled: 30,
	killZ: -1,
	/** 2026-10-10T12:00:00Z — before the first Saturday slate after deploy. */
	forwardStart: 1791633600,
	/** Master switch (era-gated; flipping it is an era bump). */
	enabled: true,
};

/** A pushed wallet signal for one market (lane_signals row). */
export interface LaneSignal {
	conditionId: string;
	betLabel: string | null;
	triggerTs: number | null;
	voided: boolean;
}

/**
 * The side to bet: the entry side whose label is the signal's bet label,
 * if the signal fired at or before now, is not voided and that side is
 * priced in band.
 */
export function laneSignalSide(
	signal: LaneSignal | undefined,
	sideA: { label?: string | null; price?: number | null },
	sideB: { label?: string | null; price?: number | null },
	nowSeconds: number,
	band: { priceLo: number; priceHi: number } = CFB_HOT_FOLLOW_LANE,
): LaneSide | null {
	if (!signal || signal.voided || !signal.betLabel) return null;
	if (signal.triggerTs === null || signal.triggerTs > nowSeconds) return null;
	const want = signal.betLabel.trim().toLowerCase();
	const side: LaneSide | null =
		(sideA.label ?? "").trim().toLowerCase() === want
			? "A"
			: (sideB.label ?? "").trim().toLowerCase() === want
				? "B"
				: null;
	if (side === null) return null;
	const price = side === "A" ? sideA.price : sideB.price;
	if (
		typeof price !== "number" ||
		!Number.isFinite(price) ||
		price < band.priceLo ||
		price >= band.priceHi
	) {
		return null;
	}
	return side;
}
