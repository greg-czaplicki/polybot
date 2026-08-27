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
	/** Decision-price ROI (the strategy metric — unchanged). */
	roi: number;
	clv: number | null;
	strategyVersion: string | null;
	/** REALIZED per-pick ROI from the actual fill price (2026-08-28 review:
	 * win → (1−fill)/fill, loss → −1, push → 0). Null without a matched
	 * fill price. Decision-price roi stays the strategy metric; this is the
	 * accounting one. */
	realizedRoi: number | null;
	/** Real-money P/L: matched fill notional × REALIZED ROI (decision-price
	 * ROI fallback only when fill_price is missing). Null for paper picks —
	 * the dollar curve skips them. */
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
			status: string;
			roi: number;
			clv: number | null;
			strategy_version: string | null;
			fill_status: string | null;
			fill_notional: number | null;
			fill_price: number | null;
		}>(
			db,
			`SELECT settled_at, status, roi, clv, strategy_version, fill_status,
			        fill_notional, fill_price
			 FROM manual_picks
			 WHERE status IN ('win','loss','push')
			   AND roi IS NOT NULL
			   AND settled_at IS NOT NULL
			   AND (fill_status IS NULL OR fill_status NOT IN ('paper','unknown','failed'))
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
			picks: pickRows.map((row) => {
				const matched =
					row.fill_status === "matched" &&
					typeof row.fill_notional === "number" &&
					row.fill_notional > 0;
				const realizedRoi =
					matched &&
					typeof row.fill_price === "number" &&
					row.fill_price > 0 &&
					row.fill_price < 1
						? row.status === "win"
							? (1 - row.fill_price) / row.fill_price
							: row.status === "loss"
								? -1
								: 0
						: null;
				return {
					settledAt: row.settled_at,
					roi: row.roi,
					clv: row.clv,
					strategyVersion: row.strategy_version,
					realizedRoi,
					dollars: matched
						? (row.fill_notional as number) * (realizedRoi ?? row.roi)
						: null,
					stake: matched ? row.fill_notional : null,
				};
			}),
			shadows: shadowRows.map((row) => ({
				settledAt: row.settled_at,
				roi: row.roi,
			})),
		};
	},
);
