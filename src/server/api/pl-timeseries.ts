/**
 * Timeseries API for the P/L charts on /stats: every settled real pick and
 * settled shadow row with just the fields the chart math needs. Filtering by
 * date range happens client-side so preset switching is instant.
 */

import { createServerFn } from "@tanstack/react-start";
import { all } from "../db/client";
import { getDb } from "../env";

export interface PlPickPoint {
	settledAt: number;
	roi: number;
	clv: number | null;
	strategyVersion: string | null;
	/** Real-money P/L for this pick: matched fill notional × ROI. Null for
	 * paper picks (no matched fill) — the dollar curve skips them. */
	dollars: number | null;
	/** Matched fill notional (the stake actually at risk), null for paper. */
	stake: number | null;
}

export interface PlShadowPoint {
	settledAt: number;
	roi: number;
}

export interface PlTimeseriesResult {
	picks: PlPickPoint[];
	shadows: PlShadowPoint[];
}

export const getPlTimeseriesFn = createServerFn({ method: "GET" }).handler(
	async ({ context }): Promise<PlTimeseriesResult> => {
		const db = getDb(context);

		const pickRows = await all<{
			settled_at: number;
			roi: number;
			clv: number | null;
			strategy_version: string | null;
			fill_status: string | null;
			fill_notional: number | null;
		}>(
			db,
			`SELECT settled_at, roi, clv, strategy_version, fill_status, fill_notional
			 FROM manual_picks
			 WHERE status IN ('win','loss','push')
			   AND roi IS NOT NULL
			   AND settled_at IS NOT NULL
			 ORDER BY settled_at ASC`,
		);

		const shadowRows = await all<{
			settled_at: number;
			roi: number;
		}>(
			db,
			`SELECT settled_at, roi
			 FROM shadow_candidates
			 WHERE status IN ('win','loss')
			   AND roi IS NOT NULL
			   AND settled_at IS NOT NULL
			 ORDER BY settled_at ASC`,
		);

		return {
			picks: pickRows.map((row) => ({
				settledAt: row.settled_at,
				roi: row.roi,
				clv: row.clv,
				strategyVersion: row.strategy_version,
				dollars:
					row.fill_status === "matched" &&
					typeof row.fill_notional === "number" &&
					row.fill_notional > 0
						? row.fill_notional * row.roi
						: null,
				stake:
					row.fill_status === "matched" &&
					typeof row.fill_notional === "number" &&
					row.fill_notional > 0
						? row.fill_notional
						: null,
			})),
			shadows: shadowRows.map((row) => ({
				settledAt: row.settled_at,
				roi: row.roi,
			})),
		};
	},
);
