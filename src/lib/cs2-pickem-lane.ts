/**
 * CS2 near-pickem dog lane — pre-registered live execution pilot (era v14,
 * amended v1.1 / era v15 on 2026-09-18: one pick per team per UTC day).
 *
 * Charter: docs/charters/cs2-pickem-dog-pilot.md (2026-09-17). Every
 * threshold below is the contract; changing one after the forward start
 * means a NEW charter version and the prior rows become exploratory.
 *
 * Rule: CS2 match-winner (moneyline) market inside the bot's timing window,
 * take the side whose sighted price is in [PRICE_LO, PRICE_HI). Fixed
 * stake, hard daily caps, and a kill switch on realized drawdown or a
 * negative clustered z. The holder signal plays no part: this is the
 * exchange-frame cell from docs/audits/2026-09-11-counterparty-cells.md
 * (CS2 moneyline 40–50c, +5.5 % on 562 market-sides, z 1.4, positive in
 * both time halves) whose mirror — 50–60c favourites, −6.4 %, z −2.5 — is
 * the significant finding. The pilot buys execution truth (fills, slippage,
 * resolution quirks) at a size that cannot matter; the evidence read is the
 * polysharp forward lane `cs2_pickem_dog_cell`, never these picks.
 */

export const CS2_PICKEM_DOG_LANE = {
	name: "cs2_pickem_dog",
	sportTag: "cs2",
	marketType: "moneyline",
	/** Sighted price band for the taken side, half-open. */
	priceLo: 0.4,
	priceHi: 0.5,
	/** Fixed stake in USD. The bot's BOT_LANE_STAKES must match. */
	stakeUsd: 4,
	/** Hard daily caps, UTC day. */
	maxPicksPerDay: 3,
	maxNotionalPerDay: 20,
	/**
	 * v1.1 (era v15): a team that appears on EITHER side of a market the
	 * lane already picked today is excluded for the rest of the UTC day.
	 * Day 1 (2026-09-18) took BBL twice and 3DMAX both for and against out
	 * of one group stage: three stakes carrying about one and a half
	 * stakes of independent risk while the kill z counted three clusters.
	 */
	oneTeamPerDay: true,
	/** Kill: realized lane PnL at or below this (USD) stops emission. */
	killDrawdownUsd: -40,
	/** Kill: clustered z over the last `killTrailingN` settled picks below `killZ`, once `killMinSettled` have settled. */
	killTrailingN: 100,
	killMinSettled: 30,
	killZ: -1,
	/** 2026-09-18T00:00:00Z — first live pick may not precede this. */
	forwardStart: 1789689600,
	/** Master switch (era-gated; flipping it is an era bump). */
	enabled: true,
} as const;

export type LaneSide = "A" | "B";

/**
 * Which side (if any) the lane takes. Exactly one side must sit in the
 * band; when both do (a wide spread on a true coin-flip) the market is
 * ambiguous and is skipped rather than guessed.
 */
export function pickemSide(
	priceA: number | null | undefined,
	priceB: number | null | undefined,
): LaneSide | null {
	const { priceLo, priceHi } = CS2_PICKEM_DOG_LANE;
	const inBand = (p: number | null | undefined): boolean =>
		typeof p === "number" && Number.isFinite(p) && p >= priceLo && p < priceHi;
	const a = inBand(priceA);
	const b = inBand(priceB);
	if (a && !b) return "A";
	if (b && !a) return "B";
	return null;
}

/**
 * Team keys of an esports match-winner title, e.g.
 * "Counter-Strike: MOUZ vs Natus Vincere (BO3) - StarLadder StarSeries Playoffs"
 * → ["mouz", "natus vincere"]. The game prefix (up to the first ": "), the
 * "(BOn)" format tag and the " - <event>" suffix are stripped; keys are
 * lower-cased with collapsed whitespace. Empty when the title has no " vs ".
 */
export function matchTeamKeys(marketTitle: string): string[] {
	let s = marketTitle;
	const prefix = s.indexOf(": ");
	if (prefix >= 0) s = s.slice(prefix + 2);
	const parts = s.split(/\s+vs\.?\s+/i);
	if (parts.length !== 2) return [];
	const clean = (t: string): string =>
		t
			.replace(/\s*\(BO\d+\).*$/i, "")
			.replace(/\s+-\s.*$/, "")
			.replace(/\s+/g, " ")
			.trim()
			.toLowerCase();
	const keys = parts.map(clean).filter((t) => t.length > 0);
	return keys.length === 2 ? keys : [];
}

export interface LanePickRow {
	status: string;
	roi: number | null;
	/** Executed notional; the assumed stake is used when null (paper / unreported). */
	fillNotional: number | null;
	/** Cluster key: one match = one cluster. */
	clusterKey: string;
	/** Both teams of the picked market (`matchTeamKeys`), for the per-team day rule. */
	teams: string[];
	pickedAt: number;
	settledAt: number | null;
}

export interface LaneState {
	active: boolean;
	reason:
		| "ok"
		| "disabled"
		| "before_forward_start"
		| "daily_pick_cap"
		| "daily_notional_cap"
		| "kill_drawdown"
		| "kill_z";
	todayPicks: number;
	todayNotional: number;
	/** How many more picks the lane may emit right now. */
	remainingToday: number;
	settled: number;
	wins: number;
	realizedPnl: number;
	roi: number | null;
	/** Event-clustered z over the trailing `killTrailingN` settled picks (null until `killMinSettled`). */
	z: number | null;
	/** Teams on either side of today's lane picks; excluded for the rest of the UTC day (v1.1). */
	teamsToday: string[];
}

/** Start of the UTC day containing `nowSeconds`. */
export function utcDayStart(nowSeconds: number): number {
	return nowSeconds - (nowSeconds % 86400);
}

/**
 * Event-clustered z: mean of per-cluster mean ROI over its standard error
 * (same estimator as grade-floor-test.ts). Null under 5 clusters.
 */
export function clusteredZ(
	rows: Array<{ roi: number; clusterKey: string }>,
): number | null {
	const byCluster = new Map<string, { sum: number; n: number }>();
	for (const r of rows) {
		const agg = byCluster.get(r.clusterKey) ?? { sum: 0, n: 0 };
		agg.sum += r.roi;
		agg.n += 1;
		byCluster.set(r.clusterKey, agg);
	}
	const means = Array.from(byCluster.values(), (a) => a.sum / a.n);
	const k = means.length;
	if (k < 5) return null;
	const mean = means.reduce((s, m) => s + m, 0) / k;
	const variance = means.reduce((s, m) => s + (m - mean) ** 2, 0) / (k - 1);
	if (variance <= 0) return null;
	return mean / Math.sqrt(variance / k);
}

/**
 * Pure cap/kill evaluation over the lane's own pick rows. The caller
 * loads every row with `lane = name` (cheap: the pilot is capped at 3/day).
 */
export function evaluateLaneState(
	rows: LanePickRow[],
	nowSeconds: number,
	lane = CS2_PICKEM_DOG_LANE,
): LaneState {
	const dayStart = utcDayStart(nowSeconds);
	const today = rows.filter((r) => r.pickedAt >= dayStart);
	const todayPicks = today.length;
	const todayNotional = today.reduce(
		(s, r) => s + (r.fillNotional ?? lane.stakeUsd),
		0,
	);
	const teamsToday = lane.oneTeamPerDay
		? Array.from(new Set(today.flatMap((r) => r.teams)))
		: [];
	const settledRows = rows
		.filter((r) => (r.status === "win" || r.status === "loss") && r.roi != null)
		.sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
	const settled = settledRows.length;
	const wins = settledRows.filter((r) => r.status === "win").length;
	const realizedPnl = settledRows.reduce(
		(s, r) => s + (r.roi as number) * (r.fillNotional ?? lane.stakeUsd),
		0,
	);
	const roi =
		settled > 0
			? settledRows.reduce((s, r) => s + (r.roi as number), 0) / settled
			: null;
	const trailing = settledRows.slice(0, lane.killTrailingN);
	const z =
		settled >= lane.killMinSettled
			? clusteredZ(
					trailing.map((r) => ({
						roi: r.roi as number,
						clusterKey: r.clusterKey,
					})),
				)
			: null;
	const remainingPicks = Math.max(0, lane.maxPicksPerDay - todayPicks);
	const remainingNotional = lane.maxNotionalPerDay - todayNotional;
	const remainingByNotional = Math.max(
		0,
		Math.floor(remainingNotional / lane.stakeUsd + 1e-9),
	);
	const remainingToday = Math.min(remainingPicks, remainingByNotional);

	const base = {
		todayPicks,
		todayNotional,
		settled,
		wins,
		realizedPnl,
		roi,
		z,
		teamsToday,
	};
	const stopped = (reason: LaneState["reason"]): LaneState => ({
		...base,
		active: false,
		reason,
		remainingToday: 0,
	});
	if (!lane.enabled) return stopped("disabled");
	if (nowSeconds < lane.forwardStart) return stopped("before_forward_start");
	if (realizedPnl <= lane.killDrawdownUsd) return stopped("kill_drawdown");
	if (z !== null && z < lane.killZ) return stopped("kill_z");
	if (remainingPicks === 0) return stopped("daily_pick_cap");
	if (remainingByNotional === 0) return stopped("daily_notional_cap");
	return { ...base, active: true, reason: "ok", remainingToday };
}
