import type { Db } from "../db/client";
import { all, first, run } from "../db/client";
import { nowUnixSeconds } from "../env";
import { listBotCandidateSnapshotsInRange } from "./bot-candidate-snapshots";
import {
	getManualPicksBucketPerformanceSummary,
	getManualPicksCalibrationSummary,
	getManualPicksMarketTypePerformanceSummary,
	getManualPicksSportPerformanceSummary,
	getManualPicksSummary,
} from "./manual-picks";

const DEFAULT_REFRESH_INTERVAL_SECONDS = 60 * 60;
const DEFAULT_HISTORY_LIMIT = 14;
const DAILY_QUALITY_THRESHOLD = 0.9;
const DAILY_PICK_LIMIT = 5000;

interface DailyStatsSnapshotRow {
	day_key: string;
	window_start_at: number;
	window_end_at: number;
	snapshot_created_at: number;
	manual_picks_json: string;
	candidate_funnel_json: string;
	drift_json: string;
}

export interface DailyStatsPickSummary {
	total: number;
	settled: number;
	wins: number;
	losses: number;
	pushes: number;
	avgRoi: number | null;
	totalRoi: number | null;
	avgClv: number | null;
	byTimeToStart: Array<{
		bucket: string;
		count: number;
		wins: number;
		losses: number;
		pushes: number;
		hitRate: number | null;
		avgRoi: number | null;
		avgClvBps: number | null;
	}>;
	byMarketType: Array<{
		marketType: string;
		label: string;
		totalCount: number;
		winRate: number | null;
		avgRoi: number | null;
		avgClvBps: number | null;
		qualityCount: number;
		qualityWinRate: number | null;
		qualityAvgRoi: number | null;
		qualityAvgClvBps: number | null;
	}>;
	bySport: Array<{
		sportTag: string;
		label: string;
		seriesId?: number;
		totalCount: number;
		winRate: number | null;
		avgRoi: number | null;
		avgClvBps: number | null;
		qualityCount: number;
		qualityWinRate: number | null;
		qualityAvgRoi: number | null;
		qualityAvgClvBps: number | null;
	}>;
	byScoreDifferential: Array<{
		label: string;
		count: number;
		wins: number;
		losses: number;
		pushes: number;
		winRate: number | null;
		avgRoi: number | null;
		avgClvBps: number | null;
	}>;
	byEdgeRating: Array<{
		label: string;
		count: number;
		wins: number;
		losses: number;
		pushes: number;
		winRate: number | null;
		avgRoi: number | null;
		avgClvBps: number | null;
	}>;
	byQualityScore: Array<{
		label: string;
		count: number;
		wins: number;
		losses: number;
		pushes: number;
		winRate: number | null;
		avgRoi: number | null;
		avgClvBps: number | null;
	}>;
}

export interface DailyStatsCandidateFunnel {
	runCount: number;
	totalRequested: number;
	totalReturned: number;
	totalEntries: number;
	totalUpcomingEntries: number;
	totalCandidatesBeforeDedup: number;
	totalDedupDropped: number;
	avgReturnedPerRun: number | null;
	avgReturnRate: number | null;
	topExclusions: Array<[string, number]>;
	topPolicyMatched: Array<[string, number]>;
	returnedByMarketType: Record<string, number>;
	returnedByTimingBucket: Record<string, number>;
	returnedBySportSeries: Record<string, number>;
}

export interface DailyStatsDrift {
	trailingDays: number;
	baselineDays: number;
	picks: {
		settledDelta: number | null;
		avgRoiDelta: number | null;
		avgClvDelta: number | null;
	};
	candidates: {
		runCountDelta: number | null;
		avgReturnedPerRunDelta: number | null;
		avgReturnRateDelta: number | null;
	};
}

export interface DailyStatsSnapshot {
	dayKey: string;
	windowStartAt: number;
	windowEndAt: number;
	snapshotCreatedAt: number;
	manualPicks: DailyStatsPickSummary;
	candidateFunnel: DailyStatsCandidateFunnel;
	drift: DailyStatsDrift;
}

function startOfUtcDay(unixSeconds: number): number {
	const date = new Date(unixSeconds * 1000);
	return Math.floor(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) /
			1000,
	);
}

function formatDayKey(unixSeconds: number): string {
	return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function safeParse<T>(raw: string, fallback: T): T {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

function sumRecord(
	target: Record<string, number>,
	source: Record<string, number>,
): void {
	for (const [key, value] of Object.entries(source)) {
		if (!Number.isFinite(value)) continue;
		target[key] = (target[key] ?? 0) + value;
	}
}

function topEntries(
	record: Record<string, number>,
	limit: number = 8,
): Array<[string, number]> {
	return Object.entries(record)
		.sort((left, right) => right[1] - left[1])
		.slice(0, limit);
}

function averageOrNull(total: number, count: number): number | null {
	return count > 0 ? total / count : null;
}

function parseRow(row: DailyStatsSnapshotRow): DailyStatsSnapshot {
	return {
		dayKey: row.day_key,
		windowStartAt: row.window_start_at,
		windowEndAt: row.window_end_at,
		snapshotCreatedAt: row.snapshot_created_at,
		manualPicks: safeParse<DailyStatsPickSummary>(row.manual_picks_json, {
			total: 0,
			settled: 0,
			wins: 0,
			losses: 0,
			pushes: 0,
			avgRoi: null,
			totalRoi: null,
			avgClv: null,
			byTimeToStart: [],
			byMarketType: [],
			bySport: [],
			byScoreDifferential: [],
			byEdgeRating: [],
			byQualityScore: [],
		}),
		candidateFunnel: safeParse<DailyStatsCandidateFunnel>(
			row.candidate_funnel_json,
			{
				runCount: 0,
				totalRequested: 0,
				totalReturned: 0,
				totalEntries: 0,
				totalUpcomingEntries: 0,
				totalCandidatesBeforeDedup: 0,
				totalDedupDropped: 0,
				avgReturnedPerRun: null,
				avgReturnRate: null,
				topExclusions: [],
				topPolicyMatched: [],
				returnedByMarketType: {},
				returnedByTimingBucket: {},
				returnedBySportSeries: {},
			},
		),
		drift: safeParse<DailyStatsDrift>(row.drift_json, {
			trailingDays: 7,
			baselineDays: 0,
			picks: {
				settledDelta: null,
				avgRoiDelta: null,
				avgClvDelta: null,
			},
			candidates: {
				runCountDelta: null,
				avgReturnedPerRunDelta: null,
				avgReturnRateDelta: null,
			},
		}),
	};
}

async function buildCandidateFunnel(
	db: Db,
	windowStartAt: number,
	windowEndAt: number,
): Promise<DailyStatsCandidateFunnel> {
	const snapshots = await listBotCandidateSnapshotsInRange(db, {
		sinceCreatedAt: windowStartAt,
		untilCreatedAt: windowEndAt,
		limit: 2000,
	});
	const exclusionTotals: Record<string, number> = {};
	const policyMatchedTotals: Record<string, number> = {};
	const marketTypeTotals: Record<string, number> = {};
	const timingTotals: Record<string, number> = {};
	const sportSeriesTotals: Record<string, number> = {};

	let totalRequested = 0;
	let totalReturned = 0;
	let totalEntries = 0;
	let totalUpcomingEntries = 0;
	let totalCandidatesBeforeDedup = 0;
	let totalDedupDropped = 0;

	for (const snapshot of snapshots) {
		totalRequested += snapshot.requested;
		totalReturned += snapshot.returnedAfterDedup;
		totalEntries += snapshot.totalEntries;
		totalUpcomingEntries += snapshot.upcomingEntries;
		totalCandidatesBeforeDedup += snapshot.candidatesBeforeDedup;
		totalDedupDropped += Math.max(
			snapshot.candidatesBeforeDedup - snapshot.returnedAfterDedup,
			0,
		);
		sumRecord(exclusionTotals, snapshot.excluded);
		sumRecord(policyMatchedTotals, snapshot.policyMatched);
		sumRecord(marketTypeTotals, snapshot.returnedByMarketType);
		sumRecord(timingTotals, snapshot.returnedByTimingBucket);
		sumRecord(sportSeriesTotals, snapshot.returnedBySportSeries);
	}

	return {
		runCount: snapshots.length,
		totalRequested,
		totalReturned,
		totalEntries,
		totalUpcomingEntries,
		totalCandidatesBeforeDedup,
		totalDedupDropped,
		avgReturnedPerRun: averageOrNull(totalReturned, snapshots.length),
		avgReturnRate: totalRequested > 0 ? totalReturned / totalRequested : null,
		topExclusions: topEntries(exclusionTotals),
		topPolicyMatched: topEntries(policyMatchedTotals),
		returnedByMarketType: marketTypeTotals,
		returnedByTimingBucket: timingTotals,
		returnedBySportSeries: sportSeriesTotals,
	};
}

async function buildManualPickSummary(
	db: Db,
	windowStartAt: number,
	windowEndAt: number,
): Promise<DailyStatsPickSummary> {
	const summary = await getManualPicksSummary(db, {
		sincePickedAt: windowStartAt,
		untilPickedAt: windowEndAt,
	});
	const performance = await getManualPicksBucketPerformanceSummary(db, {
		limit: DAILY_PICK_LIMIT,
		sincePickedAt: windowStartAt,
		untilPickedAt: windowEndAt,
	});
	const calibration = await getManualPicksCalibrationSummary(db, {
		limit: DAILY_PICK_LIMIT,
		sincePickedAt: windowStartAt,
		untilPickedAt: windowEndAt,
	});
	const marketType = await getManualPicksMarketTypePerformanceSummary(db, {
		limit: DAILY_PICK_LIMIT,
		qualityThreshold: DAILY_QUALITY_THRESHOLD,
		sincePickedAt: windowStartAt,
		untilPickedAt: windowEndAt,
	});
	const sport = await getManualPicksSportPerformanceSummary(db, {
		limit: DAILY_PICK_LIMIT,
		qualityThreshold: DAILY_QUALITY_THRESHOLD,
		sincePickedAt: windowStartAt,
		untilPickedAt: windowEndAt,
	});

	return {
		total: summary.total,
		settled: summary.settled,
		wins: summary.wins,
		losses: summary.losses,
		pushes: summary.pushes,
		avgRoi: summary.avgRoi,
		totalRoi: summary.totalRoi,
		avgClv: summary.avgClv,
		byTimeToStart: performance.byTimeToStart,
		byMarketType: marketType.rows,
		bySport: sport.rows,
		byScoreDifferential: calibration.byScoreDifferential,
		byEdgeRating: calibration.byEdgeRating,
		byQualityScore: calibration.byQualityScore,
	};
}

async function buildDrift(
	db: Db,
	currentDayKey: string,
	currentManualPicks: DailyStatsPickSummary,
	currentCandidateFunnel: DailyStatsCandidateFunnel,
): Promise<DailyStatsDrift> {
	// Strictly earlier days only: != let a historical-day rebuild compare
	// against days that came after it.
	const baselineRows = await all<DailyStatsSnapshotRow>(
		db,
		`SELECT * FROM daily_stats_snapshots
		 WHERE day_key < ?
		 ORDER BY day_key DESC
		 LIMIT 7`,
		currentDayKey,
	);
	const baseline = baselineRows.map(parseRow);
	if (baseline.length === 0) {
		return {
			trailingDays: 7,
			baselineDays: 0,
			picks: {
				settledDelta: null,
				avgRoiDelta: null,
				avgClvDelta: null,
			},
			candidates: {
				runCountDelta: null,
				avgReturnedPerRunDelta: null,
				avgReturnRateDelta: null,
			},
		};
	}

	// Average only days that have a value: coercing NULL (no settled picks
	// that day) to 0 dragged ROI/CLV baselines toward zero on quiet days.
	const avgDefined = (values: Array<number | null>): number | null => {
		const defined = values.filter(
			(value): value is number => value !== null && Number.isFinite(value),
		);
		if (defined.length === 0) return null;
		return defined.reduce((sum, value) => sum + value, 0) / defined.length;
	};

	const pickSettledBaseline =
		baseline.reduce((sum, row) => sum + row.manualPicks.settled, 0) /
		baseline.length;
	const pickRoiBaseline = avgDefined(
		baseline.map((row) => row.manualPicks.avgRoi),
	);
	const pickClvBaseline = avgDefined(
		baseline.map((row) => row.manualPicks.avgClv),
	);
	const runCountBaseline =
		baseline.reduce((sum, row) => sum + row.candidateFunnel.runCount, 0) /
		baseline.length;
	const avgReturnedPerRunBaseline = avgDefined(
		baseline.map((row) => row.candidateFunnel.avgReturnedPerRun),
	);
	const avgReturnRateBaseline = avgDefined(
		baseline.map((row) => row.candidateFunnel.avgReturnRate),
	);

	return {
		trailingDays: 7,
		baselineDays: baseline.length,
		picks: {
			settledDelta: currentManualPicks.settled - pickSettledBaseline,
			avgRoiDelta:
				currentManualPicks.avgRoi !== null && pickRoiBaseline !== null
					? currentManualPicks.avgRoi - pickRoiBaseline
					: null,
			avgClvDelta:
				currentManualPicks.avgClv !== null && pickClvBaseline !== null
					? currentManualPicks.avgClv - pickClvBaseline
					: null,
		},
		candidates: {
			runCountDelta: currentCandidateFunnel.runCount - runCountBaseline,
			avgReturnedPerRunDelta:
				currentCandidateFunnel.avgReturnedPerRun !== null &&
				avgReturnedPerRunBaseline !== null
					? currentCandidateFunnel.avgReturnedPerRun -
						avgReturnedPerRunBaseline
					: null,
			avgReturnRateDelta:
				currentCandidateFunnel.avgReturnRate !== null &&
				avgReturnRateBaseline !== null
					? currentCandidateFunnel.avgReturnRate - avgReturnRateBaseline
					: null,
		},
	};
}

export async function buildDailyStatsSnapshot(
	db: Db,
	windowStartAt: number,
): Promise<DailyStatsSnapshot> {
	const normalizedStartAt = startOfUtcDay(windowStartAt);
	const windowEndAt = normalizedStartAt + 24 * 60 * 60;
	const dayKey = formatDayKey(normalizedStartAt);
	const manualPicks = await buildManualPickSummary(
		db,
		normalizedStartAt,
		windowEndAt,
	);
	const candidateFunnel = await buildCandidateFunnel(
		db,
		normalizedStartAt,
		windowEndAt,
	);
	const drift = await buildDrift(db, dayKey, manualPicks, candidateFunnel);

	return {
		dayKey,
		windowStartAt: normalizedStartAt,
		windowEndAt,
		snapshotCreatedAt: nowUnixSeconds(),
		manualPicks,
		candidateFunnel,
		drift,
	};
}

export async function upsertDailyStatsSnapshot(
	db: Db,
	windowStartAt: number,
): Promise<DailyStatsSnapshot> {
	const snapshot = await buildDailyStatsSnapshot(db, windowStartAt);
	await run(
		db,
		`INSERT INTO daily_stats_snapshots (
			day_key,
			window_start_at,
			window_end_at,
			snapshot_created_at,
			manual_picks_json,
			candidate_funnel_json,
			drift_json
		) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(day_key) DO UPDATE SET
			window_start_at = excluded.window_start_at,
			window_end_at = excluded.window_end_at,
			snapshot_created_at = excluded.snapshot_created_at,
			manual_picks_json = excluded.manual_picks_json,
			candidate_funnel_json = excluded.candidate_funnel_json,
			drift_json = excluded.drift_json`,
		snapshot.dayKey,
		snapshot.windowStartAt,
		snapshot.windowEndAt,
		snapshot.snapshotCreatedAt,
		JSON.stringify(snapshot.manualPicks),
		JSON.stringify(snapshot.candidateFunnel),
		JSON.stringify(snapshot.drift),
	);
	return snapshot;
}

export async function maybeRefreshDailyStatsSnapshot(
	db: Db,
	options?: {
		nowSeconds?: number;
		minRefreshIntervalSeconds?: number;
	},
): Promise<DailyStatsSnapshot | null> {
	const nowSeconds = options?.nowSeconds ?? nowUnixSeconds();
	const minRefreshIntervalSeconds =
		options?.minRefreshIntervalSeconds ?? DEFAULT_REFRESH_INTERVAL_SECONDS;
	const dayStartAt = startOfUtcDay(nowSeconds);
	const dayKey = formatDayKey(dayStartAt);
	const existing = await first<{ snapshot_created_at: number }>(
		db,
		`SELECT snapshot_created_at
		 FROM daily_stats_snapshots
		 WHERE day_key = ?`,
		dayKey,
	);
	if (
		existing?.snapshot_created_at &&
		nowSeconds - existing.snapshot_created_at < minRefreshIntervalSeconds
	) {
		return null;
	}

	// Picks placed late in day D settle after the UTC rollover; a snapshot
	// frozen at midnight undercounts settled/wins for every such pick. Keep
	// re-freezing yesterday until well past its last possible settlement.
	const previousDayStartAt = dayStartAt - 24 * 60 * 60;
	const previousDayEndAt = dayStartAt;
	const settlementGraceSeconds = 12 * 60 * 60;
	const previousExisting = await first<{ snapshot_created_at: number }>(
		db,
		`SELECT snapshot_created_at
		 FROM daily_stats_snapshots
		 WHERE day_key = ?`,
		formatDayKey(previousDayStartAt),
	);
	if (
		!previousExisting?.snapshot_created_at ||
		previousExisting.snapshot_created_at <
			previousDayEndAt + settlementGraceSeconds
	) {
		await upsertDailyStatsSnapshot(db, previousDayStartAt);
	}

	return upsertDailyStatsSnapshot(db, dayStartAt);
}

export async function listDailyStatsSnapshots(
	db: Db,
	limit: number = DEFAULT_HISTORY_LIMIT,
): Promise<DailyStatsSnapshot[]> {
	const rows = await all<DailyStatsSnapshotRow>(
		db,
		`SELECT * FROM daily_stats_snapshots
		 ORDER BY day_key DESC
		 LIMIT ?`,
		Math.max(1, Math.min(limit, 90)),
	);
	return rows.map(parseRow);
}
