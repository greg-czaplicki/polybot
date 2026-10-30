/**
 * NCAAB moneyline underdog lane — $4 live pilot (era v28, 2026-10-30).
 * Charter: docs/charters/ncaab-ml-dog-pilot.md. Every threshold below is the
 * contract; changing one after the forward start means a NEW charter
 * version and the prior rows become exploratory.
 *
 * Rule: college basketball game-winner market inside the bot window, take
 * the side priced in [0.30, 0.50). Evidence (POST-HOC, after the
 * pre-registered price read went 0/24 — docs/audits/2026-10-30-ncaab-price-backtest.md):
 * 2025-26 bot-window entry 547-689 +9.2 % z 2.6, discovery +7.6 % / holdout
 * +11.1 %, positive Nov–Dec, Jan and Feb+; mirror favourites 50–70c −4.1 %.
 * Owner 2026-10-30: "Yes please".
 */

import type { LaneConfig, LaneSide } from "./cs2-pickem-lane";

export const NCAAB_ML_DOG_LANE: LaneConfig & {
	priceLo: number;
	priceHi: number;
} = {
	name: "ncaab_ml_dog",
	sportTag: "ncaab",
	marketType: "moneyline",
	priceLo: 0.3,
	priceHi: 0.5,
	/** Fixed stake in USD. The bot's BOT_LANE_STAKES must match. */
	stakeUsd: 4,
	/** Saturdays bunch ~dozens of games; 10 open like cfb_hot_follow (v25). */
	maxOpenPicks: 10,
	oneTeamPerDay: false,
	killDrawdownUsd: -40,
	killTrailingN: 100,
	killMinSettled: 30,
	killZ: -1,
	/** 2026-11-02T00:00:00Z — season tip-off week. */
	forwardStart: 1793577600,
	enabled: true,
};

/** The side priced in band; none or both in band → no bet. */
export function ncaabMlDogSide(
	priceA: number | null | undefined,
	priceB: number | null | undefined,
	band: { priceLo: number; priceHi: number } = NCAAB_ML_DOG_LANE,
): LaneSide | null {
	const inBand = (p: number | null | undefined): boolean =>
		typeof p === "number" &&
		Number.isFinite(p) &&
		p >= band.priceLo &&
		p < band.priceHi;
	const a = inBand(priceA);
	const b = inBand(priceB);
	if (a && !b) return "A";
	if (b && !a) return "B";
	return null;
}
