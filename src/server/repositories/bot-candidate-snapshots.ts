import type { GradeLabel } from "@/lib/sharp-grade";
import type { Db } from "../db/client";
import { all, run } from "../db/client";

export interface BotCandidateSnapshotInput {
	createdAt: number;
	minGrade: GradeLabel;
	windowMinutes?: number;
	minMinutesToStart?: number;
	maxMinutesToStart?: number;
	requireReady: boolean;
	includeStarted: boolean;
	requireMicrostructure: boolean;
	marketQualityThreshold: number;
	requested: number;
	returned: number;
	totalEntries: number;
	upcomingEntries: number;
	candidatesBeforeDedup: number;
	returnedAfterDedup: number;
	excluded: Record<string, number>;
	policyMatched: Record<string, number>;
	returnedByMarketType: Record<string, number>;
	returnedByTimingBucket: Record<string, number>;
	returnedBySportSeries: Record<string, number>;
}

export interface BotCandidateSnapshot {
	id: string;
	createdAt: number;
	minGrade: GradeLabel;
	windowMinutes: number | null;
	minMinutesToStart: number | null;
	maxMinutesToStart: number | null;
	requireReady: boolean;
	includeStarted: boolean;
	requireMicrostructure: boolean;
	marketQualityThreshold: number;
	requested: number;
	returned: number;
	totalEntries: number;
	upcomingEntries: number;
	candidatesBeforeDedup: number;
	returnedAfterDedup: number;
	excluded: Record<string, number>;
	policyMatched: Record<string, number>;
	returnedByMarketType: Record<string, number>;
	returnedByTimingBucket: Record<string, number>;
	returnedBySportSeries: Record<string, number>;
}

interface BotCandidateSnapshotRow {
	id: string;
	created_at: number;
	min_grade: GradeLabel;
	window_minutes: number | null;
	min_minutes_to_start: number | null;
	max_minutes_to_start: number | null;
	require_ready: number;
	include_started: number;
	require_microstructure: number;
	market_quality_threshold: number;
	requested: number;
	returned: number;
	total_entries: number;
	upcoming_entries: number;
	candidates_before_dedup: number;
	returned_after_dedup: number;
	excluded_json: string;
	policy_matched_json: string;
	returned_by_market_type_json: string;
	returned_by_timing_bucket_json: string;
	returned_by_sport_series_json: string;
}

function generateId(createdAt: number): string {
	return `bcs_${createdAt}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeParseRecord(raw: string): Record<string, number> {
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		return Object.fromEntries(
			Object.entries(parsed).filter(([, value]) => typeof value === "number"),
		);
	} catch {
		return {};
	}
}

function parseRow(row: BotCandidateSnapshotRow): BotCandidateSnapshot {
	return {
		id: row.id,
		createdAt: row.created_at,
		minGrade: row.min_grade,
		windowMinutes: row.window_minutes,
		minMinutesToStart: row.min_minutes_to_start,
		maxMinutesToStart: row.max_minutes_to_start,
		requireReady: row.require_ready === 1,
		includeStarted: row.include_started === 1,
		requireMicrostructure: row.require_microstructure === 1,
		marketQualityThreshold: row.market_quality_threshold,
		requested: row.requested,
		returned: row.returned,
		totalEntries: row.total_entries,
		upcomingEntries: row.upcoming_entries,
		candidatesBeforeDedup: row.candidates_before_dedup,
		returnedAfterDedup: row.returned_after_dedup,
		excluded: safeParseRecord(row.excluded_json),
		policyMatched: safeParseRecord(row.policy_matched_json),
		returnedByMarketType: safeParseRecord(row.returned_by_market_type_json),
		returnedByTimingBucket: safeParseRecord(row.returned_by_timing_bucket_json),
		returnedBySportSeries: safeParseRecord(row.returned_by_sport_series_json),
	};
}

export async function insertBotCandidateSnapshot(
	db: Db,
	input: BotCandidateSnapshotInput,
): Promise<void> {
	await run(
		db,
		`INSERT INTO bot_candidate_snapshots (
			id, created_at, min_grade, window_minutes, min_minutes_to_start, max_minutes_to_start,
			require_ready, include_started, require_microstructure, market_quality_threshold,
			requested, returned, total_entries, upcoming_entries, candidates_before_dedup,
			returned_after_dedup, excluded_json, policy_matched_json,
			returned_by_market_type_json, returned_by_timing_bucket_json, returned_by_sport_series_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		generateId(input.createdAt),
		input.createdAt,
		input.minGrade,
		input.windowMinutes ?? null,
		input.minMinutesToStart ?? null,
		input.maxMinutesToStart ?? null,
		input.requireReady ? 1 : 0,
		input.includeStarted ? 1 : 0,
		input.requireMicrostructure ? 1 : 0,
		input.marketQualityThreshold,
		input.requested,
		input.returned,
		input.totalEntries,
		input.upcomingEntries,
		input.candidatesBeforeDedup,
		input.returnedAfterDedup,
		JSON.stringify(input.excluded),
		JSON.stringify(input.policyMatched),
		JSON.stringify(input.returnedByMarketType),
		JSON.stringify(input.returnedByTimingBucket),
		JSON.stringify(input.returnedBySportSeries),
	);
}

export async function listBotCandidateSnapshots(
	db: Db,
	limit: number,
): Promise<BotCandidateSnapshot[]> {
	const rows = await all<BotCandidateSnapshotRow>(
		db,
		`SELECT * FROM bot_candidate_snapshots
		 ORDER BY created_at DESC
		 LIMIT ?`,
		limit,
	);
	return rows.map(parseRow);
}

export async function listBotCandidateSnapshotsInRange(
	db: Db,
	options: {
		sinceCreatedAt: number;
		untilCreatedAt: number;
		limit?: number;
	},
): Promise<BotCandidateSnapshot[]> {
	const limit =
		typeof options.limit === "number" && options.limit > 0
			? Math.min(options.limit, 5000)
			: 1000;
	const rows = await all<BotCandidateSnapshotRow>(
		db,
		`SELECT * FROM bot_candidate_snapshots
		 WHERE created_at >= ?
		   AND created_at < ?
		 ORDER BY created_at DESC
		 LIMIT ?`,
		options.sinceCreatedAt,
		options.untilCreatedAt,
		limit,
	);
	return rows.map(parseRow);
}
