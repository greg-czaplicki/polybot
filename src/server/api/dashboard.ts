/**
 * Read API for the home dashboard: active bets, overnight recap, system
 * health, and current-era performance. Aggregates data that already exists
 * elsewhere (/bot, /stats, /shadow) into one glanceable payload.
 */

import { createServerFn } from "@tanstack/react-start";
import {
	evaluateLiveLadder,
	LIVE_OOS_SINCE,
	type LiveCohortInput,
	type LiveTrigger,
} from "@/lib/live-verdict";
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
	/** Pinnacle-close CLV over the window's settled picks; PM close as fallback */
	avgPinClvPct: number | null;
	pinClvN: number;
	avgClvPct: number | null;
	clvN: number;
}

export interface DashboardLiveBook {
	/** Unix seconds — start of the out-of-sample cohort. */
	since: number;
	all: LiveCohortInput & { wins: number; losses: number };
	totals: LiveCohortInput & { wins: number; losses: number };
	moneyline: LiveCohortInput & { wins: number; losses: number };
	triggers: LiveTrigger[];
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
	/** Bot-reported wallet bankroll (POST /api/bot/status); null until first report. */
	bankroll: number | null;
	bankrollSyncedAt: number | null;
	stakeMode: string | null;
	fixedStake: number | null;
	/** OddsPapi credits after the most recent Pinnacle fetch (null = none logged). */
	pinCredits: number | null;
	pinLastFetchAt: number | null;
	pinLastSportKey: string | null;
	pinFetches24h: number;
	/** Paper-lane heartbeat (bot_runtime_status key `paper_lanes`). */
	lanesEvaluatedAt: number | null;
	lanesEvaluated: number | null;
	lanesFired: number | null;
	lanesRecorded: number | null;
}

/** Live-book results over a trailing window (real fills only). */
export interface DashboardWindow {
	label: string;
	hours: number;
	placed: number;
	wins: number;
	losses: number;
	pushes: number;
	units: number | null;
	roiPct: number | null;
	avgPinClvPct: number | null;
	pinClvN: number;
}

/** Per-market (sport) tape over the last 24h: what flowed, what the gates did. */
export interface DashboardTapeRow {
	sportTag: string;
	livePicks: number;
	shadowRows: number;
	/** Shadow rows that captured a Pinnacle anchor. */
	shadowAnchored: number;
	topReject: string | null;
	topRejectN: number;
	/** Shadow rows whose event is still ahead — the upcoming slate. */
	upcoming: number;
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

/**
 * Live-performance population (2026-08-28 review): exclude picks KNOWN not
 * to be real money — paper (dry-run), failed submissions, and unknown-state
 * fills awaiting reconciliation. NULL fill_status passes: every pick before
 * execution tracking (pre-2026-08-05) was a real bet.
 */
const REAL_FILL_SQL = `(fill_status IS NULL OR fill_status NOT IN ('paper','unknown','failed'))`;

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
 FROM manual_picks WHERE ${REAL_FILL_SQL}`;

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
			avg_pin_clv: number | null;
			pin_clv_n: number | null;
			avg_clv: number | null;
			clv_n: number | null;
		}>(
			db,
			`SELECT SUM(status = 'win') AS wins,
			        SUM(status = 'loss') AS losses,
			        SUM(status = 'push') AS pushes,
			        SUM(CASE WHEN status IN ('win','loss') THEN roi END) AS units,
			        AVG(CASE WHEN status IN ('win','loss') THEN pin_clv END) AS avg_pin_clv,
			        SUM(status IN ('win','loss') AND pin_clv IS NOT NULL) AS pin_clv_n,
			        AVG(CASE WHEN status IN ('win','loss') THEN clv END) AS avg_clv,
			        SUM(status IN ('win','loss') AND clv IS NOT NULL) AS clv_n
			 FROM manual_picks
			 WHERE status IN ('win','loss','push') AND settled_at >= ?
			   AND ${REAL_FILL_SQL}`,
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
			avgPinClvPct:
				recapRow?.avg_pin_clv != null ? recapRow.avg_pin_clv * 100 : null,
			pinClvN: recapRow?.pin_clv_n ?? 0,
			avgClvPct: recapRow?.avg_clv != null ? recapRow.avg_clv * 100 : null,
			clvN: recapRow?.clv_n ?? 0,
		};

		// Current era by prefix (stamps are `${era}+${sha}`); "post-gate live"
		// is every non-backfilled pick since the v4 gates went live.
		const eraShort = STRATEGY_VERSION.split("-")[0];
		const currentEraRow = await first<EraAggRow>(
			db,
			`${ERA_AGG} AND strategy_version LIKE ?`,
			`${STRATEGY_VERSION}%`,
		);
		const postGateRow = await first<EraAggRow>(
			db,
			`${ERA_AGG} AND (strategy_version LIKE 'v4-%' OR strategy_version LIKE 'v5-%')
			 AND strategy_version NOT LIKE '%+backfill'`,
		);
		const eras: DashboardEraSummary[] = [];
		if (currentEraRow)
			eras.push(toEraSummary(`Current era (${eraShort})`, currentEraRow));
		if (postGateRow)
			eras.push(toEraSummary("Post-gate live (v4+v5)", postGateRow));

		// Live-book stake ladder (pre-registered 2026-08-27, docs/STRATEGY.md):
		// post-gate out-of-sample cohort, overall / by bet type / trailing 100.
		const LIVE_AGG = `SELECT COUNT(*) AS settled,
		        SUM(status = 'win') AS wins, SUM(status = 'loss') AS losses,
		        SUM(roi) AS units, SUM(roi * roi) AS sumsq,
		        SUM(pin_fair_prob IS NOT NULL AND pin_close_fair_prob IS NOT NULL) AS pin_move_n,
		        AVG(CASE WHEN pin_fair_prob IS NOT NULL THEN pin_close_fair_prob - pin_fair_prob END) AS avg_pin_move
		 FROM manual_picks
		 WHERE status IN ('win','loss') AND picked_at > ?
		   AND ${REAL_FILL_SQL}`;
		type LiveRow = {
			settled: number;
			wins: number;
			losses: number;
			units: number | null;
			sumsq: number | null;
			pin_move_n: number;
			avg_pin_move: number | null;
		};
		const toCohort = (r: LiveRow | null) => ({
			settled: r?.settled ?? 0,
			wins: r?.wins ?? 0,
			losses: r?.losses ?? 0,
			units: r?.units ?? null,
			sumSq: r?.sumsq ?? null,
			pinMoveN: r?.pin_move_n ?? 0,
			avgPinMove: r?.avg_pin_move ?? null,
		});
		const liveAll = toCohort(
			await first<LiveRow>(db, LIVE_AGG, LIVE_OOS_SINCE),
		);
		const liveTotals = toCohort(
			await first<LiveRow>(
				db,
				`${LIVE_AGG} AND bet_type = 'total'`,
				LIVE_OOS_SINCE,
			),
		);
		const liveMl = toCohort(
			await first<LiveRow>(
				db,
				`${LIVE_AGG} AND bet_type = 'moneyline'`,
				LIVE_OOS_SINCE,
			),
		);
		const liveTrailing = toCohort(
			await first<LiveRow>(
				db,
				`SELECT COUNT(*) AS settled, SUM(status = 'win') AS wins,
				        SUM(status = 'loss') AS losses, SUM(roi) AS units,
				        SUM(roi * roi) AS sumsq, 0 AS pin_move_n, NULL AS avg_pin_move
				 FROM (SELECT status, roi FROM manual_picks
				       WHERE status IN ('win','loss') AND picked_at > ?
				         AND ${REAL_FILL_SQL}
				       ORDER BY settled_at DESC LIMIT 100)`,
				LIVE_OOS_SINCE,
			),
		);
		const liveBook: DashboardLiveBook = {
			since: LIVE_OOS_SINCE,
			all: liveAll,
			totals: liveTotals,
			moneyline: liveMl,
			triggers: evaluateLiveLadder({
				all: liveAll,
				totals: liveTotals,
				moneyline: liveMl,
				trailing100: liveTrailing,
			}),
		};

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

		// Table exists from migration 0034; a fresh deploy racing the
		// migration should degrade to "no bankroll", not a 500.
		let botStatus: {
			bankroll?: number;
			bankrollSyncedAt?: number | null;
			stakeMode?: string | null;
			fixedStake?: number | null;
		} | null = null;
		try {
			const statusRow = await first<{ value_json: string }>(
				db,
				`SELECT value_json FROM bot_runtime_status WHERE key = 'status'`,
			);
			if (statusRow?.value_json) botStatus = JSON.parse(statusRow.value_json);
		} catch {
			botStatus = null;
		}

		// Pinnacle feed budget — the sweep logs credits_remaining per fetch.
		let pinLast: {
			fetched_at: number;
			sport_key: string;
			credits_remaining: number | null;
		} | null = null;
		let pinFetches24h = 0;
		try {
			pinLast = await first(
				db,
				`SELECT fetched_at, sport_key, credits_remaining FROM pinnacle_fetch_log
				 ORDER BY fetched_at DESC LIMIT 1`,
			);
			const n = await first<{ n: number }>(
				db,
				`SELECT COUNT(*) AS n FROM pinnacle_fetch_log WHERE fetched_at >= ?`,
				dayAgo,
			);
			pinFetches24h = n?.n ?? 0;
		} catch {
			pinLast = null;
		}

		let lanes: {
			evaluatedAt?: number;
			evaluated?: number;
			fired?: number;
			recorded?: number;
		} | null = null;
		try {
			const laneRow = await first<{ value_json: string }>(
				db,
				`SELECT value_json FROM bot_runtime_status WHERE key = 'paper_lanes'`,
			);
			if (laneRow?.value_json) lanes = JSON.parse(laneRow.value_json);
		} catch {
			lanes = null;
		}

		// Trailing windows of the live book (real fills only).
		const windows: DashboardWindow[] = [];
		for (const w of [
			{ label: "24h", hours: 24 },
			{ label: "7d", hours: 24 * 7 },
			{ label: "30d", hours: 24 * 30 },
		]) {
			const since = now - w.hours * 3600;
			const r = await first<{
				wins: number;
				losses: number;
				pushes: number;
				units: number | null;
				avg_pin_clv: number | null;
				pin_clv_n: number | null;
			}>(
				db,
				`SELECT SUM(status = 'win') AS wins,
				        SUM(status = 'loss') AS losses,
				        SUM(status = 'push') AS pushes,
				        SUM(CASE WHEN status IN ('win','loss') THEN roi END) AS units,
				        AVG(CASE WHEN status IN ('win','loss') THEN pin_clv END) AS avg_pin_clv,
				        SUM(status IN ('win','loss') AND pin_clv IS NOT NULL) AS pin_clv_n
				 FROM manual_picks
				 WHERE status IN ('win','loss','push') AND settled_at >= ?
				   AND ${REAL_FILL_SQL}`,
				since,
			);
			const placed = await first<{ n: number }>(
				db,
				`SELECT COUNT(*) AS n FROM manual_picks WHERE picked_at >= ? AND ${REAL_FILL_SQL}`,
				since,
			);
			const settled = (r?.wins ?? 0) + (r?.losses ?? 0);
			windows.push({
				label: w.label,
				hours: w.hours,
				placed: placed?.n ?? 0,
				wins: r?.wins ?? 0,
				losses: r?.losses ?? 0,
				pushes: r?.pushes ?? 0,
				units: r?.units ?? null,
				roiPct:
					settled > 0 && r?.units != null ? (r.units / settled) * 100 : null,
				avgPinClvPct: r?.avg_pin_clv != null ? r.avg_pin_clv * 100 : null,
				pinClvN: r?.pin_clv_n ?? 0,
			});
		}

		// Per-market tape, last 24h.
		const tapeRows = await all<{
			sport_tag: string;
			shadow_rows: number;
			anchored: number;
			upcoming: number;
		}>(
			db,
			`SELECT sport_tag, COUNT(*) AS shadow_rows,
			        SUM(pin_captured_at IS NOT NULL) AS anchored,
			        SUM(event_time > ?) AS upcoming
			 FROM shadow_candidates
			 WHERE created_at >= ? AND sport_tag IS NOT NULL
			 GROUP BY sport_tag`,
			now,
			dayAgo,
		);
		const liveByTag = await all<{ sport_tag: string; n: number }>(
			db,
			`SELECT sport_tag, COUNT(*) AS n FROM manual_picks
			 WHERE picked_at >= ? AND sport_tag IS NOT NULL AND ${REAL_FILL_SQL}
			 GROUP BY sport_tag`,
			dayAgo,
		);
		const topRejects = await all<{
			sport_tag: string;
			reject_reason: string;
			n: number;
		}>(
			db,
			`SELECT sport_tag, reject_reason, COUNT(*) AS n FROM shadow_candidates
			 WHERE created_at >= ? AND sport_tag IS NOT NULL
			 GROUP BY sport_tag, reject_reason
			 ORDER BY n DESC`,
			dayAgo,
		);
		const liveMap = new Map(liveByTag.map((r) => [r.sport_tag, r.n]));
		const rejectMap = new Map<string, { reason: string; n: number }>();
		for (const r of topRejects) {
			if (!rejectMap.has(r.sport_tag))
				rejectMap.set(r.sport_tag, { reason: r.reject_reason, n: r.n });
		}
		const tape: DashboardTapeRow[] = tapeRows
			.map((r) => ({
				sportTag: r.sport_tag,
				livePicks: liveMap.get(r.sport_tag) ?? 0,
				shadowRows: r.shadow_rows,
				shadowAnchored: r.anchored,
				topReject: rejectMap.get(r.sport_tag)?.reason ?? null,
				topRejectN: rejectMap.get(r.sport_tag)?.n ?? 0,
				upcoming: r.upcoming,
			}))
			.sort((a, b) => b.livePicks - a.livePicks || b.shadowRows - a.shadowRows);
		for (const [tag, n] of liveMap) {
			if (!tape.some((t) => t.sportTag === tag))
				tape.unshift({
					sportTag: tag,
					livePicks: n,
					shadowRows: 0,
					shadowAnchored: 0,
					topReject: null,
					topRejectN: 0,
					upcoming: 0,
				});
		}

		const health: DashboardHealth = {
			botLastSeenAt: botRow?.last ?? null,
			pipelineNewestAt: cacheStats.newestEntry ?? null,
			// canonical_sync_runs timestamps are milliseconds
			canonicalLastRunAt: syncRow
				? Math.floor(syncRow.started_at / 1000)
				: null,
			canonicalLastRunStatus: syncRow?.status ?? null,
			lastPickAt: lastPickRow?.last ?? null,
			bankroll:
				typeof botStatus?.bankroll === "number" ? botStatus.bankroll : null,
			bankrollSyncedAt: botStatus?.bankrollSyncedAt ?? null,
			stakeMode: botStatus?.stakeMode ?? null,
			fixedStake: botStatus?.fixedStake ?? null,
			pinCredits: pinLast?.credits_remaining ?? null,
			pinLastFetchAt: pinLast?.fetched_at ?? null,
			pinLastSportKey: pinLast?.sport_key ?? null,
			pinFetches24h,
			lanesEvaluatedAt: lanes?.evaluatedAt ?? null,
			lanesEvaluated: lanes?.evaluated ?? null,
			lanesFired: lanes?.fired ?? null,
			lanesRecorded: lanes?.recorded ?? null,
		};

		return {
			computedAt: now,
			health,
			activeBets,
			recentSettled,
			recap,
			eras,
			liveBook,
			windows,
			tape,
		};
	},
);
