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
	avgMinutesToStart: number | null;
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
}

export interface ShadowRowSummary {
	marketTitle: string;
	rejectReason: string;
	sharpSide: string | null;
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
			avg_mins: number | null;
		}>(
			db,
			`SELECT reject_reason,
			        COUNT(*) AS total,
			        SUM(status = 'pending') AS pending,
			        SUM(status = 'win') AS wins,
			        SUM(status = 'loss') AS losses,
			        SUM(status = 'push') AS pushes,
			        SUM(CASE WHEN status IN ('win','loss') THEN roi END) AS units,
			        AVG(minutes_to_start) AS avg_mins
			 FROM shadow_candidates
			 GROUP BY reject_reason
			 ORDER BY total DESC`,
		);

		const reasons: ShadowReasonSummary[] = reasonRows.map((r) => {
			const settled = r.wins + r.losses;
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
				avgMinutesToStart: r.avg_mins,
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
		}>(
			db,
			`SELECT reject_reason,
			        sport_tag,
			        COUNT(*) AS total,
			        SUM(status = 'pending') AS pending,
			        SUM(status = 'win') AS wins,
			        SUM(status = 'loss') AS losses,
			        SUM(status = 'push') AS pushes,
			        SUM(CASE WHEN status IN ('win','loss') THEN roi END) AS units
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
			};
		});

		const recentRows = await all<{
			market_title: string;
			reject_reason: string;
			sharp_side: string | null;
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
			`SELECT market_title, reject_reason, sharp_side, price, grade,
			        minutes_to_start, status, roi, strategy_version, created_at,
			        event_time, warnings_json
			 FROM shadow_candidates
			 ORDER BY created_at DESC
			 LIMIT 100`,
		);

		const recent: ShadowRowSummary[] = recentRows.map((r) => ({
			marketTitle: r.market_title,
			rejectReason: r.reject_reason,
			sharpSide: r.sharp_side,
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
