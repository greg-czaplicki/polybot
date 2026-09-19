/**
 * NCAAF totals lane — pre-registered live execution pilot (era v16,
 * 2026-09-19). Charter: docs/charters/ncaaf-totals-pilot.md. Every
 * threshold below is the contract; changing one after the forward start
 * means a NEW charter version and the prior rows become exploratory.
 *
 * Rule: an NCAAF game-total (O/U) market inside the bot's timing window
 * whose holder pipeline sighted a sharp side, take that side at $4. No
 * holder gate (grade, edge, price_edge, score) is applied — the population
 * is the `ncaaf_league_probation` shadow cohort itself, which is what the
 * owner asked to bet small "for now". Caps and a kill switch mirror the CS2
 * pilot (src/lib/cs2-pickem-lane.ts); the machinery is shared.
 *
 * Evidence at registration (docs/charters/ncaaf-totals-pilot.md): the
 * bettable cohort (in-window, ready, probation-only reject) is 10 settled
 * rows, 8-2, +61 %; the whole NCAAF totals shadow is 84 rows / 44 events,
 * +19 %, event-clustered z ≈ 1.35. Both are below the owner's n ≥ 50 +
 * z ≥ 2 rule: this is an execution pilot sized to be harmless, NOT a
 * promotion, and it produces no evidence about the edge — the shadow rows
 * keep being written and stay the read.
 */

import type { LaneConfig, LaneSide } from "./cs2-pickem-lane";

export const NCAAF_TOTALS_PILOT_LANE: LaneConfig & {
	priceLo: number;
	priceHi: number;
} = {
	name: "ncaaf_totals_pilot",
	sportTag: "ncaaf",
	marketType: "total",
	/**
	 * Sanity band on the taken side's sighted price, inclusive/exclusive.
	 * The floor is the era v9 entry-price floor; the ceiling keeps the lane
	 * off heavily juiced totals the shadow cohort never contained (every
	 * settled NCAAF totals shadow row sat in 0.40–0.60).
	 */
	priceLo: 0.25,
	priceHi: 0.75,
	/** Fixed stake in USD. The bot's BOT_LANE_STAKES must match. */
	stakeUsd: 4,
	/** Hard daily caps, UTC day. Saturday slates are the volume; one pick per game via the market-group key. */
	maxPicksPerDay: 5,
	maxNotionalPerDay: 20,
	/** Totals titles carry no team keys worth deduping ("A vs. B: O/U 53.5" → the market group already dedupes the game). */
	oneTeamPerDay: false,
	/** Kill: realized lane PnL at or below this (USD) stops emission. */
	killDrawdownUsd: -40,
	/** Kill: clustered z over the last `killTrailingN` settled picks below `killZ`, once `killMinSettled` have settled. */
	killTrailingN: 100,
	killMinSettled: 30,
	killZ: -1,
	/** 2026-09-19T22:10:00Z — first live pick may not precede this. Registered at 00:00Z 9/20, moved to deploy time the same hour at the owner's instruction ("there's games tonight") before any row existed. */
	forwardStart: 1789855800,
	/** Master switch (era-gated; flipping it is an era bump). */
	enabled: true,
};

/**
 * Which side the lane takes: the holder pipeline's sighted sharp side, if
 * its price sits in the sanity band. Null when no side was sighted or the
 * price is outside the band.
 */
export function totalsSide(
	sharpSide: string | null | undefined,
	priceA: number | null | undefined,
	priceB: number | null | undefined,
): LaneSide | null {
	const { priceLo, priceHi } = NCAAF_TOTALS_PILOT_LANE;
	const side: LaneSide | null =
		sharpSide === "A" ? "A" : sharpSide === "B" ? "B" : null;
	if (side === null) return null;
	const price = side === "A" ? priceA : priceB;
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
