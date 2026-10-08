/**
 * NFL totals lane — pre-registered live execution pilot (era v18,
 * 2026-10-05). Charter: docs/charters/nfl-totals-pilot.md. Every threshold
 * below is the contract; changing one after the forward start means a NEW
 * charter version and the prior rows become exploratory.
 *
 * Rule: identical to the NCAAF totals pilot (src/lib/ncaaf-totals-lane.ts)
 * on NFL — an in-window regular-season NFL game-total (O/U) market whose
 * holder pipeline sighted a sharp side, take that side at $4. No holder gate.
 *
 * Evidence at registration: `nfl_league_probation` totals shadow, first row
 * per game, regular season (event ≥ 2026-09-10), weeks 1-4: 56 games 37-19,
 * +29.8 %, z 2.36 — CORRECTED same day: alt-line ties at the first sighting;
 * tie-averaged ≈ 35-21 +25.2 % z 2.02, range z 1.28-2.46 — (weeks 5-5 / 13-3 / 9-7 / 10-4; ex-week-2 24-16 ≈ +18 %).
 * All-gates-pass cohort 4 rows 3-1, so the n ≥ 50 sole-blocker promotion
 * rule is NOT met: an execution pilot, not a promotion. Owner decision
 * 2026-10-05: "Yes, open nfl lanes".
 */

import type { LaneConfig, LaneSide } from "./cs2-pickem-lane";
import { totalsSide } from "./ncaaf-totals-lane";
import { isNflPreseasonTime } from "./sports";

export const NFL_TOTALS_PILOT_LANE: LaneConfig & {
	priceLo: number;
	priceHi: number;
} = {
	name: "nfl_totals_pilot",
	sportTag: "nfl",
	marketType: "total",
	/** Same sanity band as the NCAAF pilot; every settled NFL cohort row sat in 0.45–0.73. */
	priceLo: 0.25,
	priceHi: 0.75,
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
	/** 2026-10-05T17:00:00Z — first live pick may not precede this. */
	forwardStart: 1791219600,
	/** Master switch (era-gated; flipping it is an era bump). */
	enabled: true,
};

/**
 * The sighted side if its price is in the band and the game is regular
 * season (preseason never enters the lane; the cohort excluded it).
 */
export function nflTotalsSide(
	sharpSide: string | null | undefined,
	priceA: number | null | undefined,
	priceB: number | null | undefined,
	eventTimeMs: number | null | undefined,
): LaneSide | null {
	if (typeof eventTimeMs !== "number" || !Number.isFinite(eventTimeMs)) {
		return null;
	}
	if (isNflPreseasonTime(eventTimeMs)) return null;
	return totalsSide(sharpSide, priceA, priceB, NFL_TOTALS_PILOT_LANE);
}
