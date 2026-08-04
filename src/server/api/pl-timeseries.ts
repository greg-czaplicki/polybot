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
		}>(
			db,
			`SELECT settled_at, roi, clv, strategy_version
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
			})),
			shadows: shadowRows.map((row) => ({
				settledAt: row.settled_at,
				roi: row.roi,
			})),
		};
	},
);
