/**
 * NBA totals sharp-consensus FADE lane — pre-registered live execution pilot
 * (era v19, 2026-10-07). Charter: docs/charters/nba-totals-fade-pilot.md.
 * Every threshold below is the contract; changing one after the forward
 * start means a NEW charter version and the prior rows become exploratory.
 *
 * Rule: polysharp (VPS, research/sharp/nba_fade_live.py) flags an NBA game
 * total once >= 2 wallets with an NBA record of >= 30 settled positions at
 * >= +10% ROI have bought the same side (first BUY >= $100, 0-24h out) and
 * none such has bought the other side. This lane bets the OTHER side inside
 * the bot window, $4, priced in [0.40, 0.60). Consensus on both sides = no
 * bet. The rule is cell S5_consensus/total of the pre-registered 2025-26
 * wallet backtest (docs/audits/2026-10-07-nba-wallet-backtest.md): one bet
 * per game at the executable fade price, discovery 181-145 +11.6 % z 2.1,
 * holdout 151-133 +7.7 % z 1.3, season +9.8 % z 2.4; entering in the bot's
 * 60-180 min window instead of at the trigger: +7.1 % z 1.5 (447 games).
 * Owner decision 2026-10-07: "Money pilot".
 */

import type { LaneConfig, LaneSide } from "./cs2-pickem-lane";
import { isNbaPreseasonTime } from "./sports";

export const NBA_TOTALS_FADE_LANE: LaneConfig & {
	priceLo: number;
	priceHi: number;
} = {
	name: "nba_totals_fade",
	sportTag: "nba",
	marketType: "total",
	/** 99 % of backtest fade entries sat in this band. */
	priceLo: 0.4,
	priceHi: 0.6,
	/** Fixed stake in USD. The bot's BOT_LANE_STAKES must match. */
	stakeUsd: 4,
	/** Open-bet limit (2026-10-08, replaces 5/day + $20/day): unsettled lane bets at once. */
	maxOpenPicks: 5,
	oneTeamPerDay: false,
	/** Kill: realized lane PnL at or below this (USD) stops emission. */
	killDrawdownUsd: -40,
	killTrailingN: 100,
	killMinSettled: 30,
	killZ: -1,
	/** 2026-10-20T00:00:00Z — NBA opening night; nothing before it. */
	forwardStart: 1792454400,
	/** Master switch (era-gated; flipping it is an era bump). */
	enabled: true,
};

export interface NbaFadeSignal {
	conditionId: string;
	fadeLabel: string | null;
	triggerTs: number | null;
	voided: boolean;
}

/**
 * The side to bet: the entry side whose label is the signal's fade label,
 * if the signal fired before now, is not voided, the game is regular season
 * and that side is priced in band.
 */
export function nbaFadeSide(
	signal: NbaFadeSignal | undefined,
	sideA: { label?: string | null; price?: number | null },
	sideB: { label?: string | null; price?: number | null },
	eventTimeMs: number | null | undefined,
	nowSeconds: number,
): LaneSide | null {
	if (!signal || signal.voided || !signal.fadeLabel) return null;
	if (signal.triggerTs === null || signal.triggerTs > nowSeconds) return null;
	if (typeof eventTimeMs !== "number" || !Number.isFinite(eventTimeMs)) {
		return null;
	}
	if (isNbaPreseasonTime(eventTimeMs)) return null;
	const want = signal.fadeLabel.trim().toLowerCase();
	const side: LaneSide | null =
		(sideA.label ?? "").trim().toLowerCase() === want
			? "A"
			: (sideB.label ?? "").trim().toLowerCase() === want
				? "B"
				: null;
	if (side === null) return null;
	const price = side === "A" ? sideA.price : sideB.price;
	const { priceLo, priceHi } = NBA_TOTALS_FADE_LANE;
	if (
		typeof price !== "number" ||
		!Number.isFinite(price) ||
		price < priceLo ||
		price >= priceHi
	) {
		return null;
	}
	return side;
}
