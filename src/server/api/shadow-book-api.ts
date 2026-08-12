/**
 * Read API for the shadow book (gate-rejected candidates settled without
 * betting). Powers the /shadow page: per-gate performance + recent rows.
 */

import { createServerFn } from "@tanstack/react-start";
import { all } from "../db/client";
import { getDb } from "../env";
import {
	PROP_CLEAN_SQL,
	PROP_SUBTYPE_SQL,
	SOLE_BLOCKER_SQL,
} from "./shadow-sql";

export interface ShadowReasonSummary {
	rejectReason: string;
	total: number;
	pending: number;
	wins: number;
	losses: number;
	pushes: number;
	units: number | null;
	roiPct: number | null;
	avgClvPct: number | null;
	avgMinutesToStart: number | null;
	/**
	 * Sole-blocker cohort: rows where every gate in gates_json passes except
	 * the one that fired (pass=null counts as NOT passing). Only rows with a
	 * gate vector (2026-08-06+, migration 0027) qualify — this is the clean
	 * "what would loosening this one gate recover" population.
	 */
	cleanTotal: number;
	cleanWins: number;
	cleanLosses: number;
	cleanUnits: number | null;
	cleanRoiPct: number | null;
}

export interface ShadowSportSummary {
	rejectReason: string;
	sportTag: string;
	total: number;
	pending: number;
	wins: number;
	losses: number;
	pushes: number;
	units: number | null;
	roiPct: number | null;
	avgClvPct: number | null;
}

export interface ShadowPropSummary {
	subtype: string;
	total: number;
	pending: number;
	wins: number;
	losses: number;
	pushes: number;
	units: number | null;
	roiPct: number | null;
	avgClvPct: number | null;
	/**
	 * Prop-gate-sole-blocker cohort (PROP_CLEAN_SQL): rejected by the prop
	 * gate itself with all five vector gates passing — the only rows that
	 * answer "what would betting this subtype have returned". The raw
	 * columns above mix in props other gates would have rejected anyway.
	 */
	cleanTotal: number;
	cleanWins: number;
	cleanLosses: number;
	cleanUnits: number | null;
	cleanRoiPct: number | null;
	cleanAvgClvPct: number | null;
}

/**
 * Timing-gate shadows paired with a REAL pick on the same market: a direct
 * measurement of what the 60-180m window boundary does to entry price.
 * Drift is signed as (chronologically later price − earlier price) on the
 * SAME side, in probability points; positive = market moved toward the
 * sharp side between the two sightings. Two buckets:
 * - "outside_window": the shadow sighting (>180m) precedes the pick —
 *   what waiting into the window did to entry.
 * - "post_pick": the shadow sighting FOLLOWS the pick. Once a market is
 *   picked, later candidate sightings shadow as market_group_already_picked
 *   (too_close_to_start can't fire on picked markets), so that reason is
 *   the post-entry drift source; too_close_to_start is included for
 *   completeness but stays near-empty by construction.
 */
export interface ShadowTimingPairSummary {
	bucket: string;
	pairs: number;
	sideMatched: number;
	sideFlipped: number;
	avgDriftPct: number | null;
	medianDriftPct: number | null;
	movedTowardSide: number;
	movedAway: number;
	pickWins: number;
	pickLosses: number;
}

export interface ShadowRowSummary {
	marketTitle: string;
	rejectReason: string;
	sharpSide: string | null;
	sharpSideLabel: string | null;
	price: number | null;
	grade: string | null;
	minutesToStart: number | null;
	status: string;
	roi: number | null;
	strategyVersion: string | null;
	createdAt: number;
	eventTime: number | null;
	warnings: string | null;
}

export const getShadowBookSummaryFn = createServerFn({ method: "GET" }).handler(
	async ({ context }) => {
		const db = getDb(context);

		const reasonRows = await all<{
			reject_reason: string;
			total: number;
			pending: number;
			wins: number;
			losses: number;
			pushes: number;
			units: number | null;
			avg_clv: number | null;
			avg_mins: number | null;
			clean_total: number;
			clean_wins: number;
			clean_losses: number;
			clean_units: number | null;
		}>(
			db,
			`SELECT reject_reason,
			        COUNT(*) AS total,
			        SUM(status = 'pending') AS pending,
			        SUM(status = 'win') AS wins,
			        SUM(status = 'loss') AS losses,
			        SUM(status = 'push') AS pushes,
			        SUM(CASE WHEN status IN ('win','loss') THEN roi END) AS units,
			        AVG(CASE WHEN status IN ('win','loss') THEN clv END) AS avg_clv,
			        AVG(minutes_to_start) AS avg_mins,
			        SUM(${SOLE_BLOCKER_SQL}) AS clean_total,
			        SUM(CASE WHEN ${SOLE_BLOCKER_SQL} AND status = 'win' THEN 1 ELSE 0 END) AS clean_wins,
			        SUM(CASE WHEN ${SOLE_BLOCKER_SQL} AND status = 'loss' THEN 1 ELSE 0 END) AS clean_losses,
			        SUM(CASE WHEN ${SOLE_BLOCKER_SQL} AND status IN ('win','loss') THEN roi END) AS clean_units
			 FROM shadow_candidates
			 GROUP BY reject_reason
			 ORDER BY total DESC`,
		);

		const reasons: ShadowReasonSummary[] = reasonRows.map((r) => {
			const settled = r.wins + r.losses;
			const cleanSettled = r.clean_wins + r.clean_losses;
			return {
				rejectReason: r.reject_reason,
				total: r.total,
				pending: r.pending,
				wins: r.wins,
				losses: r.losses,
				pushes: r.pushes,
				units: r.units,
				roiPct:
					settled > 0 && r.units !== null ? (r.units / settled) * 100 : null,
				avgClvPct: r.avg_clv !== null ? r.avg_clv * 100 : null,
				avgMinutesToStart: r.avg_mins,
				cleanTotal: r.clean_total,
				cleanWins: r.clean_wins,
				cleanLosses: r.clean_losses,
				cleanUnits: r.clean_units,
				cleanRoiPct:
					cleanSettled > 0 && r.clean_units !== null
						? (r.clean_units / cleanSettled) * 100
						: null,
			};
		});

		const sportRows = await all<{
			reject_reason: string;
			sport_tag: string | null;
			total: number;
			pending: number;
			wins: number;
			losses: number;
			pushes: number;
			units: number | null;
			avg_clv: number | null;
		}>(
			db,
			`SELECT reject_reason,
			        sport_tag,
			        COUNT(*) AS total,
			        SUM(status = 'pending') AS pending,
			        SUM(status = 'win') AS wins,
			        SUM(status = 'loss') AS losses,
			        SUM(status = 'push') AS pushes,
			        SUM(CASE WHEN status IN ('win','loss') THEN roi END) AS units,
			        AVG(CASE WHEN status IN ('win','loss') THEN clv END) AS avg_clv
			 FROM shadow_candidates
			 GROUP BY reject_reason, sport_tag
			 ORDER BY reject_reason ASC, total DESC`,
		);

		const bySport: ShadowSportSummary[] = sportRows.map((r) => {
			const settled = r.wins + r.losses;
			return {
				rejectReason: r.reject_reason,
				sportTag: r.sport_tag ?? "unknown",
				total: r.total,
				pending: r.pending,
				wins: r.wins,
				losses: r.losses,
				pushes: r.pushes,
				units: r.units,
				roiPct:
					settled > 0 && r.units !== null ? (r.units / settled) * 100 : null,
				avgClvPct: r.avg_clv !== null ? r.avg_clv * 100 : null,
			};
		});

		const propRows = await all<{
			subtype: string;
			total: number;
			pending: number;
			wins: number;
			losses: number;
			pushes: number;
			units: number | null;
			avg_clv: number | null;
			clean_total: number;
			clean_wins: number;
			clean_losses: number;
			clean_units: number | null;
			clean_avg_clv: number | null;
		}>(
			db,
			`SELECT ${PROP_SUBTYPE_SQL} AS subtype,
			        COUNT(*) AS total,
			        SUM(status = 'pending') AS pending,
			        SUM(status = 'win') AS wins,
			        SUM(status = 'loss') AS losses,
			        SUM(status = 'push') AS pushes,
			        SUM(CASE WHEN status IN ('win','loss') THEN roi END) AS units,
			        AVG(CASE WHEN status IN ('win','loss') THEN clv END) AS avg_clv,
			        SUM(${PROP_CLEAN_SQL}) AS clean_total,
			        SUM(CASE WHEN ${PROP_CLEAN_SQL} AND status = 'win' THEN 1 ELSE 0 END) AS clean_wins,
			        SUM(CASE WHEN ${PROP_CLEAN_SQL} AND status = 'loss' THEN 1 ELSE 0 END) AS clean_losses,
			        SUM(CASE WHEN ${PROP_CLEAN_SQL} AND status IN ('win','loss') THEN roi END) AS clean_units,
			        AVG(CASE WHEN ${PROP_CLEAN_SQL} AND status IN ('win','loss') THEN clv END) AS clean_avg_clv
			 FROM shadow_candidates
			 WHERE market_type = 'prop'
			 GROUP BY subtype
			 ORDER BY total DESC`,
		);

		const props: ShadowPropSummary[] = propRows.map((r) => {
			const settled = r.wins + r.losses;
			const cleanSettled = r.clean_wins + r.clean_losses;
			return {
				subtype: r.subtype,
				total: r.total,
				pending: r.pending,
				wins: r.wins,
				losses: r.losses,
				pushes: r.pushes,
				units: r.units,
				roiPct:
					settled > 0 && r.units !== null ? (r.units / settled) * 100 : null,
				avgClvPct: r.avg_clv !== null ? r.avg_clv * 100 : null,
				cleanTotal: r.clean_total,
				cleanWins: r.clean_wins,
				cleanLosses: r.clean_losses,
				cleanUnits: r.clean_units,
				cleanRoiPct:
					cleanSettled > 0 && r.clean_units !== null
						? (r.clean_units / cleanSettled) * 100
						: null,
				cleanAvgClvPct: r.clean_avg_clv !== null ? r.clean_avg_clv * 100 : null,
			};
		});

		const pairRows = await all<{
			reject_reason: string;
			shadow_label: string | null;
			shadow_price: number | null;
			pick_label: string | null;
			pick_price: number | null;
			pick_status: string;
		}>(
			db,
			`SELECT s.reject_reason,
			        s.sharp_side_label AS shadow_label,
			        s.price AS shadow_price,
			        p.sharp_side_label AS pick_label,
			        p.price AS pick_price,
			        p.status AS pick_status
			 FROM shadow_candidates s
			 JOIN manual_picks p ON p.condition_id = s.condition_id
			 WHERE s.reject_reason IN
			   ('outside_window','too_close_to_start','market_group_already_picked')
			 ORDER BY p.picked_at DESC
			 LIMIT 500`,
		);

		const timingBuckets: Array<{ bucket: string; reasons: string[] }> = [
			{ bucket: "outside_window", reasons: ["outside_window"] },
			{
				bucket: "post_pick",
				reasons: ["market_group_already_picked", "too_close_to_start"],
			},
		];
		const timingPairs: ShadowTimingPairSummary[] = timingBuckets.map(
			({ bucket, reasons: bucketReasons }) => {
			const rows = pairRows.filter((r) =>
				bucketReasons.includes(r.reject_reason),
			);
			const matched = rows.filter(
				(r) =>
					r.shadow_label !== null &&
					r.pick_label !== null &&
					r.shadow_label.toLowerCase() === r.pick_label.toLowerCase(),
			);
			const drifts = matched
				.filter((r) => r.shadow_price !== null && r.pick_price !== null)
				.map((r) => {
					const shadow = r.shadow_price as number;
					const pick = r.pick_price as number;
					// Later sighting minus earlier, on the same side.
					return bucket === "outside_window" ? pick - shadow : shadow - pick;
				})
				.sort((a, b) => a - b);
			const median =
				drifts.length === 0
					? null
					: drifts.length % 2 === 1
						? drifts[(drifts.length - 1) / 2]
						: (drifts[drifts.length / 2 - 1] + drifts[drifts.length / 2]) / 2;
			return {
				bucket,
				pairs: rows.length,
				sideMatched: matched.length,
				sideFlipped: rows.length - matched.length,
				avgDriftPct:
					drifts.length > 0
						? (drifts.reduce((s, d) => s + d, 0) / drifts.length) * 100
						: null,
				medianDriftPct: median !== null ? median * 100 : null,
				movedTowardSide: drifts.filter((d) => d > 0.005).length,
				movedAway: drifts.filter((d) => d < -0.005).length,
				pickWins: matched.filter((r) => r.pick_status === "win").length,
				pickLosses: matched.filter((r) => r.pick_status === "loss").length,
			};
		});

		const recentRows = await all<{
			market_title: string;
			reject_reason: string;
			sharp_side: string | null;
			sharp_side_label: string | null;
			price: number | null;
			grade: string | null;
			minutes_to_start: number | null;
			status: string;
			roi: number | null;
			strategy_version: string | null;
			created_at: number;
			event_time: number | null;
			warnings_json: string | null;
		}>(
			db,
			`SELECT market_title, reject_reason, sharp_side, sharp_side_label,
			        price, grade, minutes_to_start, status, roi, strategy_version,
			        created_at, event_time, warnings_json
			 FROM shadow_candidates
			 ORDER BY created_at DESC
			 LIMIT 100`,
		);

		const recent: ShadowRowSummary[] = recentRows.map((r) => ({
			marketTitle: r.market_title,
			rejectReason: r.reject_reason,
			sharpSide: r.sharp_side,
			sharpSideLabel: r.sharp_side_label,
			price: r.price,
			grade: r.grade,
			minutesToStart: r.minutes_to_start,
			status: r.status,
			roi: r.roi,
			strategyVersion: r.strategy_version,
			createdAt: r.created_at,
			eventTime: r.event_time,
			warnings: r.warnings_json,
		}));

		return {
			computedAt: Math.floor(Date.now() / 1000),
			reasons,
			bySport,
			props,
			timingPairs,
			recent,
		};
	},
);
