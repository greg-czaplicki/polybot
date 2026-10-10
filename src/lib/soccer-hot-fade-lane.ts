/**
 * Soccer totals hot / team-specialist FADE lane — live execution pilot (era
 * v23, 2026-10-09). Charter: docs/charters/soccer-hot-fade-pilot.md. Every
 * threshold below is the contract; changing one after the forward start
 * means a NEW charter version and the prior rows become exploratory.
 *
 * Rule: the NHL hot-fade rule (src/lib/nhl-hot-fade-lane.ts) on soccer game
 * totals in the leagues the app tracks (EPL, MLS, Championship, La Liga,
 * Bundesliga, Serie A, Ligue 1, UCL): bet AGAINST the side that HOT (≥ 9 of
 * last 12 settled soccer positions won) or TEAM-specialist (≥ 10 settled on
 * one of the teams at ≥ +15 % ROI) wallets bought, when none bought the
 * other; bot window, $4, priced in [0.35, 0.65). Wallet records pool all
 * nine backfilled leagues (incl. UEL).
 *
 * Evidence (docs/audits/2026-10-09-nhl-soccer-wallet-backtest.md): the
 * pre-registered soccer read flagged no A-cell candidate; the NHL rule
 * (pre-registered pass) replicated out of sport: fade, one bet per game,
 * 323-282 +8.7 % z 2.1, $4 → +$211 over 607 games; 2025-26 +6.1 % (n 472),
 * 2026-27 +17.6 % (n 135). Exploratory (out-of-sport replication, not the
 * pre-registered primary): an execution pilot, not a promotion. Owner
 * 2026-10-09: "Open whatever lanes you think makes sense".
 */

import { type LaneSignal, laneSignalSide } from "./cfb-hot-follow-lane";
import type { LaneConfig, LaneSide } from "./cs2-pickem-lane";

export const SOCCER_HOT_FADE_LANE: LaneConfig & {
	priceLo: number;
	priceHi: number;
} = {
	name: "soccer_hot_fade",
	sportTag: "epl",
	sportTags: [
		"epl",
		"mls",
		"championship",
		"laliga",
		"bundesliga",
		"seriea",
		"ligue1",
		"ucl",
	],
	marketType: "total",
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

/** The side to bet for a soccer hot-fade signal. */
export function soccerHotFadeSide(
	signal: LaneSignal | undefined,
	sideA: { label?: string | null; price?: number | null },
	sideB: { label?: string | null; price?: number | null },
	nowSeconds: number,
): LaneSide | null {
	return laneSignalSide(signal, sideA, sideB, nowSeconds, SOCCER_HOT_FADE_LANE);
}
