/**
 * Read API for the shadow book (gate-rejected candidates settled without
 * betting). Powers the /shadow page: per-gate performance + recent rows.
 */

import { createServerFn } from "@tanstack/react-start";
import { all } from "../db/client";
import { getDb } from "../env";

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

/**
 * A row is a sole-blocker reject when every vector gate passes except the
 * gate its reject_reason maps to. Gates without a vector entry (timing,
 * microstructure, sport policies) get no exemption — for them "clean" means
 * all five vector gates pass. json_extract returns NULL for pass=null
 * (input unavailable at record time), which fails the =1 test: unknown is
 * never counted as a pass.
 */
const SOLE_BLOCKER_SQL = `(
	gates_json IS NOT NULL
	AND (json_extract(gates_json,'$.price_edge.pass') = 1
	     OR reject_reason = 'price_edge_below_floor')
	AND (json_extract(gates_json,'$.edge_rating.pass') = 1
	     OR reject_reason IN ('edge_rating_saturation','edge_rating_dead_zone','edge_rating_below_floor'))
	AND (json_extract(gates_json,'$.signal_score.pass') = 1
	     OR reject_reason = 'signal_score_saturation')
	AND (json_extract(gates_json,'$.score_differential.pass') = 1
	     OR reject_reason = 'low_score_differential')
	AND (json_extract(gates_json,'$.grade_vs_base.pass') = 1
	     OR reject_reason = 'below_policy_grade')
)`;

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
			recent,
		};
	},
);
