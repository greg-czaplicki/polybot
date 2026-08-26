/**
 * Read API for the shadow book (gate-rejected candidates settled without
 * betting). Powers the /shadow page: per-gate performance + recent rows.
 */

import { createServerFn } from "@tanstack/react-start";
import { type GateVerdict, gateVerdict } from "../../lib/gate-verdict";
import { all } from "../db/client";
import { getDb } from "../env";
import {
	PROP_CLEAN_SQL,
	PROP_SUBTYPE_SQL,
	SOLE_BLOCKER_SQL,
} from "./shadow-sql";

/**
 * Promotion-read fields shared by the per-gate and gate×sport rows. All of
 * them describe the SOLE-BLOCKER cohort (SOLE_BLOCKER_SQL): the verdict is
 * the pre-registered rule from src/lib/gate-verdict.ts applied to it.
 */
export interface ShadowPromotionRead {
	cleanTotal: number;
	cleanWins: number;
	cleanLosses: number;
	cleanUnits: number | null;
	cleanRoiPct: number | null;
	/** ROI z-score on the sole-blocker cohort (mean / SE). */
	cleanZ: number | null;
	/** Mean Pinnacle-close CLV (%) on sole-blocker rows carrying it. */
	cleanAvgPinClvPct: number | null;
	cleanPinN: number;
	/** Mean Pinnacle MOVEMENT (%) = Pinnacle close − Pinnacle anchor on
	 * sole-blocker rows carrying both (anchors from 2026-08-25). Diagnostic
	 * only — NOT a verdict input. Unlike pin_clv it is free of the PM
	 * spread offset (PM prices sum to ~1.005, a de-vigged book sums to 1,
	 * so pin_clv carries ≈ −0.3%/side that is not line movement). */
	cleanAvgPinMovePct: number | null;
	cleanPinMoveN: number;
	/** Mean Polymarket self-close CLV (%) on sole-blocker rows. */
	cleanAvgClvPct: number | null;
	verdict: GateVerdict;
	/** Which criteria are still unmet, e.g. "n=34/50, z=0.9/2". */
	verdictReason: string;
	verdictClvSource: "pinnacle" | "polymarket" | "none";
}

/** SQL fragments for the sole-blocker cohort, appended to a GROUP BY select. */
const CLEAN_COLUMNS_SQL = `
			        SUM(${SOLE_BLOCKER_SQL}) AS clean_total,
			        SUM(CASE WHEN ${SOLE_BLOCKER_SQL} AND status = 'win' THEN 1 ELSE 0 END) AS clean_wins,
			        SUM(CASE WHEN ${SOLE_BLOCKER_SQL} AND status = 'loss' THEN 1 ELSE 0 END) AS clean_losses,
			        SUM(CASE WHEN ${SOLE_BLOCKER_SQL} AND status IN ('win','loss') THEN roi END) AS clean_units,
			        SUM(CASE WHEN ${SOLE_BLOCKER_SQL} AND status IN ('win','loss') THEN roi * roi END) AS clean_sumsq,
			        AVG(CASE WHEN ${SOLE_BLOCKER_SQL} AND status IN ('win','loss') THEN clv END) AS clean_avg_clv,
			        AVG(CASE WHEN ${SOLE_BLOCKER_SQL} AND status IN ('win','loss') THEN pin_clv END) AS clean_avg_pin_clv,
			        SUM(CASE WHEN ${SOLE_BLOCKER_SQL} AND status IN ('win','loss') AND pin_clv IS NOT NULL THEN 1 ELSE 0 END) AS clean_pin_n,
			        AVG(CASE WHEN ${SOLE_BLOCKER_SQL} AND status IN ('win','loss') AND pin_fair_prob IS NOT NULL THEN pin_close_fair_prob - pin_fair_prob END) AS clean_avg_pin_move,
			        SUM(CASE WHEN ${SOLE_BLOCKER_SQL} AND status IN ('win','loss') AND pin_fair_prob IS NOT NULL AND pin_close_fair_prob IS NOT NULL THEN 1 ELSE 0 END) AS clean_pin_move_n`;

interface CleanRow {
	clean_total: number;
	clean_wins: number;
	clean_losses: number;
	clean_units: number | null;
	clean_sumsq: number | null;
	clean_avg_clv: number | null;
	clean_avg_pin_clv: number | null;
	clean_pin_n: number;
	clean_avg_pin_move: number | null;
	clean_pin_move_n: number;
}

function promotionRead(r: CleanRow): ShadowPromotionRead {
	const cleanSettled = r.clean_wins + r.clean_losses;
	const v = gateVerdict({
		settled: cleanSettled,
		units: r.clean_units,
		sumSq: r.clean_sumsq,
		avgPinClv: r.clean_avg_pin_clv,
		pinN: r.clean_pin_n,
		avgClv: r.clean_avg_clv,
	});
	return {
		cleanTotal: r.clean_total,
		cleanWins: r.clean_wins,
		cleanLosses: r.clean_losses,
		cleanUnits: r.clean_units,
		cleanRoiPct:
			cleanSettled > 0 && r.clean_units !== null
				? (r.clean_units / cleanSettled) * 100
				: null,
		cleanZ: v.z,
		cleanAvgPinClvPct:
			r.clean_avg_pin_clv !== null ? r.clean_avg_pin_clv * 100 : null,
		cleanPinN: r.clean_pin_n,
		cleanAvgPinMovePct:
			r.clean_avg_pin_move !== null ? r.clean_avg_pin_move * 100 : null,
		cleanPinMoveN: r.clean_pin_move_n,
		cleanAvgClvPct: r.clean_avg_clv !== null ? r.clean_avg_clv * 100 : null,
		verdict: v.verdict,
		verdictReason: v.reason,
		verdictClvSource: v.clvSource,
	};
}

/**
 * Sole-blocker cohort (the clean* fields, via ShadowPromotionRead): rows
 * where every gate in gates_json passes except the one that fired
 * (pass=null counts as NOT passing). Only rows with a gate vector
 * (2026-08-06+, migration 0027) qualify — this is the clean "what would
 * loosening this one gate recover" population, and the ONLY one the
 * verdict reads.
 */
export interface ShadowReasonSummary extends ShadowPromotionRead {
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
}

export interface ShadowSportSummary extends ShadowPromotionRead {
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
 * outside_window shadows paired with a REAL pick on the same market: the
 * shadow sighting (>180m out) precedes the pick, so drift = pick price −
 * shadow price on the SAME side (probability points) measures what
 * waiting from first sighting into the 60-180m window did to entry.
 * Positive = market moved toward the sharp side before we got in.
 *
 * There is deliberately NO post-entry bucket: once a market is picked it
 * stops being shadowed (later sightings land under
 * market_group_already_picked, which fires on DIFFERENT markets in the
 * group — different condition_id), and same-market post-entry drift is
 * exactly what clv already measures (close price − pick price).
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

		const reasonRows = await all<
			{
				reject_reason: string;
				total: number;
				pending: number;
				wins: number;
				losses: number;
				pushes: number;
				units: number | null;
				avg_clv: number | null;
				avg_mins: number | null;
			} & CleanRow
		>(
			db,
			`SELECT reject_reason,
			        COUNT(*) AS total,
			        SUM(status = 'pending') AS pending,
			        SUM(status = 'win') AS wins,
			        SUM(status = 'loss') AS losses,
			        SUM(status = 'push') AS pushes,
			        SUM(CASE WHEN status IN ('win','loss') THEN roi END) AS units,
			        AVG(CASE WHEN status IN ('win','loss') THEN clv END) AS avg_clv,
			        AVG(minutes_to_start) AS avg_mins,${CLEAN_COLUMNS_SQL}
			 FROM shadow_candidates
			 GROUP BY reject_reason
			 ORDER BY total DESC`,
		);

		const reasons: ShadowReasonSummary[] = reasonRows.map((r) => {
			const settled = r.wins + r.losses;
			return {
				...promotionRead(r),
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
			};
		});

		const sportRows = await all<
			{
				reject_reason: string;
				sport_tag: string | null;
				total: number;
				pending: number;
				wins: number;
				losses: number;
				pushes: number;
				units: number | null;
				avg_clv: number | null;
			} & CleanRow
		>(
			db,
			`SELECT reject_reason,
			        sport_tag,
			        COUNT(*) AS total,
			        SUM(status = 'pending') AS pending,
			        SUM(status = 'win') AS wins,
			        SUM(status = 'loss') AS losses,
			        SUM(status = 'push') AS pushes,
			        SUM(CASE WHEN status IN ('win','loss') THEN roi END) AS units,
			        AVG(CASE WHEN status IN ('win','loss') THEN clv END) AS avg_clv,${CLEAN_COLUMNS_SQL}
			 FROM shadow_candidates
			 GROUP BY reject_reason, sport_tag
			 ORDER BY (clean_wins + clean_losses) DESC, total DESC, reject_reason ASC`,
		);

		const bySport: ShadowSportSummary[] = sportRows.map((r) => {
			const settled = r.wins + r.losses;
			return {
				...promotionRead(r),
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
			 WHERE s.reject_reason = 'outside_window'
			 ORDER BY p.picked_at DESC
			 LIMIT 500`,
		);

		const timingPairs: ShadowTimingPairSummary[] = ["outside_window"].map(
			(bucket) => {
				const rows = pairRows;
				const matched = rows.filter(
					(r) =>
						r.shadow_label !== null &&
						r.pick_label !== null &&
						r.shadow_label.toLowerCase() === r.pick_label.toLowerCase(),
				);
				const drifts = matched
					.filter((r) => r.shadow_price !== null && r.pick_price !== null)
					.map((r) => {
						// Later sighting (pick) minus earlier (shadow), same side.
						return (r.pick_price as number) - (r.shadow_price as number);
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
			},
		);

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
