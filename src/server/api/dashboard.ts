/**
 * Read API for the home dashboard: active bets, overnight recap, system
 * health, and current-era performance. Aggregates data that already exists
 * elsewhere (/bot, /stats, /shadow) into one glanceable payload.
 */

import { createServerFn } from "@tanstack/react-start";
import { STRATEGY_VERSION } from "../../lib/strategy-version";
import { all, first } from "../db/client";
import { getDb, nowUnixSeconds } from "../env";
import { getSharpMoneyCacheStats } from "../repositories/sharp-money";

export interface DashboardPickRow {
	id: string;
	conditionId: string;
	marketTitle: string;
	eventTime: string | null;
	pickedAt: number;
	grade: string | null;
	sharpSide: string | null;
	sharpSideLabel: string | null;
	price: number | null;
	betType: string | null;
	sportTag: string | null;
	fillStatus: string | null;
	status: string;
	roi: number | null;
	clv: number | null;
	settledAt: number | null;
}

export interface DashboardRecap {
	windowHours: number;
	wins: number;
	losses: number;
	pushes: number;
	units: number | null;
	picksPlaced: number;
}

export interface DashboardEraSummary {
	label: string;
	wins: number;
	losses: number;
	pushes: number;
	pending: number;
	units: number | null;
	roiPct: number | null;
	avgClvPct: number | null;
	avgBookClvPct: number | null;
	avgPinClvPct: number | null;
	/** Settled picks behind each CLV average — averages over thin coverage mislead */
	clvN: number;
	bookClvN: number;
	pinClvN: number;
}

export interface DashboardHealth {
	botLastSeenAt: number | null;
	pipelineNewestAt: number | null;
	canonicalLastRunAt: number | null;
	canonicalLastRunStatus: string | null;
	lastPickAt: number | null;
}

const PICK_COLUMNS = `id, condition_id, market_title, event_time, picked_at,
	grade, sharp_side, sharp_side_label, price, bet_type, sport_tag,
	fill_status, status, roi, clv, settled_at`;

interface PickRowRaw {
	id: string;
	condition_id: string;
	market_title: string;
	event_time: string | null;
	picked_at: number;
	grade: string | null;
	sharp_side: string | null;
	sharp_side_label: string | null;
	price: number | null;
	bet_type: string | null;
	sport_tag: string | null;
	fill_status: string | null;
	status: string;
	roi: number | null;
	clv: number | null;
	settled_at: number | null;
}

function toPickRow(r: PickRowRaw): DashboardPickRow {
	return {
		id: r.id,
		conditionId: r.condition_id,
		marketTitle: r.market_title,
		eventTime: r.event_time,
		pickedAt: r.picked_at,
		grade: r.grade,
		sharpSide: r.sharp_side,
		sharpSideLabel: r.sharp_side_label,
		price: r.price,
		betType: r.bet_type,
		sportTag: r.sport_tag,
		fillStatus: r.fill_status,
		status: r.status,
		roi: r.roi,
		clv: r.clv,
		settledAt: r.settled_at,
	};
}

interface EraAggRow {
	wins: number | null;
	losses: number | null;
	pushes: number | null;
	pending: number | null;
	units: number | null;
	avg_clv: number | null;
	avg_book_clv: number | null;
	avg_pin_clv: number | null;
	clv_n: number | null;
	book_clv_n: number | null;
	pin_clv_n: number | null;
}

function toEraSummary(label: string, r: EraAggRow): DashboardEraSummary {
	// SUM() over zero rows is NULL in SQLite — coerce counts to 0.
	const wins = r.wins ?? 0;
	const losses = r.losses ?? 0;
	const settled = wins + losses;
	return {
		label,
		wins,
		losses,
		pushes: r.pushes ?? 0,
		pending: r.pending ?? 0,
		units: r.units,
		roiPct: settled > 0 && r.units !== null ? (r.units / settled) * 100 : null,
		avgClvPct: r.avg_clv !== null ? r.avg_clv * 100 : null,
		avgBookClvPct: r.avg_book_clv !== null ? r.avg_book_clv * 100 : null,
		avgPinClvPct: r.avg_pin_clv !== null ? r.avg_pin_clv * 100 : null,
		clvN: r.clv_n ?? 0,
		bookClvN: r.book_clv_n ?? 0,
		pinClvN: r.pin_clv_n ?? 0,
	};
}

const ERA_AGG = `SELECT
	SUM(status = 'win') AS wins,
	SUM(status = 'loss') AS losses,
	SUM(status = 'push') AS pushes,
	SUM(status = 'pending') AS pending,
	SUM(CASE WHEN status IN ('win','loss') THEN roi END) AS units,
	AVG(CASE WHEN status IN ('win','loss') THEN clv END) AS avg_clv,
	AVG(CASE WHEN status IN ('win','loss') THEN book_clv END) AS avg_book_clv,
	AVG(CASE WHEN status IN ('win','loss') THEN pin_clv END) AS avg_pin_clv,
	SUM(status IN ('win','loss') AND clv IS NOT NULL) AS clv_n,
	SUM(status IN ('win','loss') AND book_clv IS NOT NULL) AS book_clv_n,
	SUM(status IN ('win','loss') AND pin_clv IS NOT NULL) AS pin_clv_n
 FROM manual_picks`;

export const getDashboardFn = createServerFn({ method: "GET" }).handler(
	async ({ context }) => {
		const db = getDb(context);
		const now = nowUnixSeconds();
		const dayAgo = now - 24 * 3600;
		const twoDaysAgo = now - 48 * 3600;

		const activeBets = (
			await all<PickRowRaw>(
				db,
				`SELECT ${PICK_COLUMNS} FROM manual_picks
				 WHERE status = 'pending'
				 ORDER BY event_time ASC`,
			)
		).map(toPickRow);

		const recentSettled = (
			await all<PickRowRaw>(
				db,
				`SELECT ${PICK_COLUMNS} FROM manual_picks
				 WHERE status IN ('win','loss','push') AND settled_at >= ?
				 ORDER BY settled_at DESC
				 LIMIT 25`,
				twoDaysAgo,
			)
		).map(toPickRow);

		const recapRow = await first<{
			wins: number;
			losses: number;
			pushes: number;
			units: number | null;
		}>(
			db,
			`SELECT SUM(status = 'win') AS wins,
			        SUM(status = 'loss') AS losses,
			        SUM(status = 'push') AS pushes,
			        SUM(CASE WHEN status IN ('win','loss') THEN roi END) AS units
			 FROM manual_picks
			 WHERE status IN ('win','loss','push') AND settled_at >= ?`,
			dayAgo,
		);
		const placedRow = await first<{ n: number }>(
			db,
			`SELECT COUNT(*) AS n FROM manual_picks WHERE picked_at >= ?`,
			dayAgo,
		);
		const recap: DashboardRecap = {
			windowHours: 24,
			wins: recapRow?.wins ?? 0,
			losses: recapRow?.losses ?? 0,
			pushes: recapRow?.pushes ?? 0,
			units: recapRow?.units ?? null,
			picksPlaced: placedRow?.n ?? 0,
		};

		// Current era by prefix (stamps are `${era}+${sha}`); "post-gate live"
		// is every non-backfilled pick since the v4 gates went live.
		const eraShort = STRATEGY_VERSION.split("-")[0];
		const currentEraRow = await first<EraAggRow>(
			db,
			`${ERA_AGG} WHERE strategy_version LIKE ?`,
			`${STRATEGY_VERSION}%`,
		);
		const postGateRow = await first<EraAggRow>(
			db,
			`${ERA_AGG} WHERE (strategy_version LIKE 'v4-%' OR strategy_version LIKE 'v5-%')
			 AND strategy_version NOT LIKE '%+backfill'`,
		);
		const eras: DashboardEraSummary[] = [];
		if (currentEraRow)
			eras.push(toEraSummary(`Current era (${eraShort})`, currentEraRow));
		if (postGateRow)
			eras.push(toEraSummary("Post-gate live (v4+v5)", postGateRow));

		const botRow = await first<{ last: number | null }>(
			db,
			`SELECT MAX(created_at) AS last FROM bot_candidate_snapshots`,
		);
		const syncRow = await first<{ started_at: number; status: string }>(
			db,
			`SELECT started_at, status FROM canonical_sync_runs
			 ORDER BY started_at DESC LIMIT 1`,
		);
		const lastPickRow = await first<{ last: number | null }>(
			db,
			`SELECT MAX(picked_at) AS last FROM manual_picks`,
		);
		const cacheStats = await getSharpMoneyCacheStats(db);

		const health: DashboardHealth = {
			botLastSeenAt: botRow?.last ?? null,
			pipelineNewestAt: cacheStats.newestEntry ?? null,
			// canonical_sync_runs timestamps are milliseconds
			canonicalLastRunAt: syncRow
				? Math.floor(syncRow.started_at / 1000)
				: null,
			canonicalLastRunStatus: syncRow?.status ?? null,
			lastPickAt: lastPickRow?.last ?? null,
		};

		return {
			computedAt: now,
			health,
			activeBets,
			recentSettled,
			recap,
			eras,
		};
	},
);
