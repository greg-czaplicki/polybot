import type { Db } from "../db/client";
import { all, first, run } from "../db/client";
import { nowUnixSeconds } from "../env";

const START_TIME_BUFFER_MINUTES = 10;

/**
 * Top holder data with PnL across multiple time periods
 */
export interface TopHolderPnlData {
	proxyWallet: string;
	name?: string;
	pseudonym?: string;
	profileImage?: string;
	amount: number;
	pnlDay?: number | null;
	pnlWeek?: number | null;
	pnlMonth?: number | null;
	pnlAll?: number | null;
	pnlAllUnits?: number | null;
	unitSize?: number | null;
	stakeUnits?: number | null;
	stakeUnitWeight?: number | null;
	volume?: number;
	momentumWeight: number;
	pnlTierWeight: number;
}

/**
 * Database row for sharp money cache
 */
export interface SharpMoneyCacheRow {
	id: string;
	condition_id: string;
	market_title: string;
	market_slug?: string | null;
	event_slug?: string | null;
	sport_series_id?: number | null;
	event_time?: string | null;
	pnl_coverage?: number | null;
	is_ready?: number | null;
	side_a_label: string;
	side_a_total_value: number;
	side_a_sharp_score: number;
	side_a_holder_count: number;
	side_a_price?: number | null;
	side_a_top_holders?: string | null;
	side_b_label: string;
	side_b_total_value: number;
	side_b_sharp_score: number;
	side_b_holder_count: number;
	side_b_price?: number | null;
	side_b_top_holders?: string | null;
	sharp_side?: string | null;
	confidence?: string | null;
	score_differential: number;
	sharp_side_value_ratio?: number | null;
	edge_rating?: number | null;
	computed_at?: number | null;
	history_updated_at?: number | null;
	updated_at: number;
}

/**
 * Parsed sharp money cache entry for frontend use
 */
export interface SharpMoneyCacheEntry {
	id: string;
	conditionId: string;
	marketTitle: string;
	marketSlug?: string;
	eventSlug?: string;
	sportSeriesId?: number;
	eventTime?: string;
	pnlCoverage?: number;
	isReady?: boolean;
	sideA: {
		label: string;
		totalValue: number;
		sharpScore: number;
		holderCount: number;
		price?: number | null;
		topHolders: TopHolderPnlData[];
	};
	sideB: {
		label: string;
		totalValue: number;
		sharpScore: number;
		holderCount: number;
		price?: number | null;
		topHolders: TopHolderPnlData[];
	};
	sharpSide: "A" | "B" | "EVEN";
	confidence: "HIGH" | "MEDIUM" | "LOW";
	scoreDifferential: number;
	sharpSideValueRatio?: number;
	edgeRating: number;
	computedAt?: number;
	historyUpdatedAt?: number;
	updatedAt: number;
}

export interface SharpMoneyHistoryEntry {
	conditionId: string;
	recordedAt: number;
	computedAt?: number;
	marketTitle: string;
	eventTime?: string;
	sportSeriesId?: number;
	sideA: {
		label: string;
		totalValue: number;
		sharpScore: number;
		price?: number | null;
	};
	sideB: {
		label: string;
		totalValue: number;
		sharpScore: number;
		price?: number | null;
	};
	sharpSide: "A" | "B" | "EVEN";
	confidence: "HIGH" | "MEDIUM" | "LOW";
	scoreDifferential: number;
	sharpSideValueRatio?: number;
	edgeRating: number;
	pnlCoverage?: number;
}

export type SharpMoneyHistoryEntryByConditionId = Record<
	string,
	SharpMoneyHistoryEntry[]
>;

/**
 * Input for upserting a sharp money cache entry
 */
export interface UpsertSharpMoneyCacheInput {
	conditionId: string;
	marketTitle: string;
	marketSlug?: string;
	eventSlug?: string;
	sportSeriesId?: number;
	eventTime?: string;
	pnlCoverage?: number;
	sideA: {
		label: string;
		totalValue: number;
		sharpScore: number;
		holderCount: number;
		price?: number | null;
		topHolders: TopHolderPnlData[];
	};
	sideB: {
		label: string;
		totalValue: number;
		sharpScore: number;
		holderCount: number;
		price?: number | null;
		topHolders: TopHolderPnlData[];
	};
	sharpSide: "A" | "B" | "EVEN";
	confidence: "HIGH" | "MEDIUM" | "LOW";
	scoreDifferential: number;
	sharpSideValueRatio?: number;
	edgeRating: number;
	computedAt?: number;
	historyUpdatedAt?: number;
}

const MIN_READY_HOLDER_COUNT = 10;
const MIN_READY_PNL_COVERAGE = 0.6;
const HISTORY_RETENTION_HOURS = 24 * 7;
const HISTORY_EVENT_WINDOW_HOURS = 24;

function getEasternOffset(date: Date): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/New_York",
		timeZoneName: "shortOffset",
	}).formatToParts(date);
	const offsetPart =
		parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT-0";
	const match = offsetPart.match(/GMT([+-]\d{1,2})/);
	if (!match) return "+00:00";
	const hours = Number(match[1]);
	const sign = hours >= 0 ? "+" : "-";
	const absHours = Math.abs(hours).toString().padStart(2, "0");
	return `${sign}${absHours}:00`;
}

function generateId(): string {
	return `sharp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function parseRow(row: SharpMoneyCacheRow): SharpMoneyCacheEntry {
	const computedAt = row.computed_at ?? row.updated_at;
	const historyUpdatedAt = row.history_updated_at ?? row.updated_at;
	return {
		id: row.id,
		conditionId: row.condition_id,
		marketTitle: row.market_title,
		marketSlug: row.market_slug ?? undefined,
		eventSlug: row.event_slug ?? undefined,
		sportSeriesId: row.sport_series_id ?? undefined,
		eventTime: row.event_time ?? undefined,
		pnlCoverage: row.pnl_coverage ?? undefined,
		isReady: row.is_ready === 1,
		sideA: {
			label: row.side_a_label,
			totalValue: row.side_a_total_value,
			sharpScore: row.side_a_sharp_score,
			holderCount: row.side_a_holder_count,
			price: row.side_a_price ?? null,
			topHolders: row.side_a_top_holders
				? (JSON.parse(row.side_a_top_holders) as TopHolderPnlData[])
				: [],
		},
		sideB: {
			label: row.side_b_label,
			totalValue: row.side_b_total_value,
			sharpScore: row.side_b_sharp_score,
			holderCount: row.side_b_holder_count,
			price: row.side_b_price ?? null,
			topHolders: row.side_b_top_holders
				? (JSON.parse(row.side_b_top_holders) as TopHolderPnlData[])
				: [],
		},
		sharpSide: (row.sharp_side as "A" | "B" | "EVEN") ?? "EVEN",
		confidence: (row.confidence as "HIGH" | "MEDIUM" | "LOW") ?? "LOW",
		scoreDifferential: row.score_differential,
		sharpSideValueRatio: row.sharp_side_value_ratio ?? undefined,
		edgeRating: row.edge_rating ?? 0,
		computedAt,
		historyUpdatedAt,
		updatedAt: row.updated_at,
	};
}

interface SharpMoneyHistoryRow {
	condition_id: string;
	recorded_at: number;
	computed_at?: number | null;
	market_title: string;
	event_time?: string | null;
	sport_series_id?: number | null;
	side_a_label: string;
	side_b_label: string;
	side_a_total_value: number;
	side_b_total_value: number;
	side_a_sharp_score: number;
	side_b_sharp_score: number;
	side_a_price?: number | null;
	side_b_price?: number | null;
	sharp_side?: string | null;
	confidence?: string | null;
	score_differential: number;
	sharp_side_value_ratio?: number | null;
	edge_rating?: number | null;
	pnl_coverage?: number | null;
}

function parseHistoryRow(row: SharpMoneyHistoryRow): SharpMoneyHistoryEntry {
	return {
		conditionId: row.condition_id,
		recordedAt: row.recorded_at,
		computedAt: row.computed_at ?? row.recorded_at,
		marketTitle: row.market_title,
		eventTime: row.event_time ?? undefined,
		sportSeriesId: row.sport_series_id ?? undefined,
		sideA: {
			label: row.side_a_label,
			totalValue: row.side_a_total_value,
			sharpScore: row.side_a_sharp_score,
			price: row.side_a_price ?? null,
		},
		sideB: {
			label: row.side_b_label,
			totalValue: row.side_b_total_value,
			sharpScore: row.side_b_sharp_score,
			price: row.side_b_price ?? null,
		},
		sharpSide: (row.sharp_side as "A" | "B" | "EVEN") ?? "EVEN",
		confidence: (row.confidence as "HIGH" | "MEDIUM" | "LOW") ?? "LOW",
		scoreDifferential: row.score_differential,
		sharpSideValueRatio: row.sharp_side_value_ratio ?? undefined,
		edgeRating: row.edge_rating ?? 0,
		pnlCoverage: row.pnl_coverage ?? undefined,
	};
}

interface SharpMoneyHistoryStatRow {
	recorded_at: number;
	edge_rating?: number | null;
}

/**
 * Upsert a sharp money cache entry
 */
export async function upsertSharpMoneyCache(
	db: Db,
	input: UpsertSharpMoneyCacheInput,
): Promise<void> {
	const now = nowUnixSeconds();
	const computedAt = input.computedAt ?? now;
	const historyUpdatedAt = input.historyUpdatedAt ?? computedAt;

	// Check if entry exists
	const existing = await first<
		Pick<SharpMoneyCacheRow, "id" | "pnl_coverage" | "is_ready">
	>(
		db,
		`SELECT id, pnl_coverage, is_ready FROM sharp_money_cache WHERE condition_id = ?`,
		input.conditionId,
	);

	const id = existing?.id ?? generateId();
	const minHolderCount = Math.min(
		input.sideA.holderCount,
		input.sideB.holderCount,
	);
	const pnlCoverage = input.pnlCoverage ?? null;
	const isReady =
		pnlCoverage !== null &&
		pnlCoverage >= MIN_READY_PNL_COVERAGE &&
		minHolderCount >= MIN_READY_HOLDER_COUNT;

	if (existing?.is_ready === 1 && !isReady) {
		return;
	}

	await run(
		db,
		`INSERT INTO sharp_money_cache (
      id, condition_id, market_title, market_slug, event_slug, sport_series_id, event_time, pnl_coverage, is_ready,
      side_a_label, side_a_total_value, side_a_sharp_score, side_a_holder_count, side_a_price, side_a_top_holders,
      side_b_label, side_b_total_value, side_b_sharp_score, side_b_holder_count, side_b_price, side_b_top_holders,
      sharp_side, confidence, score_differential, sharp_side_value_ratio, edge_rating, computed_at, history_updated_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(condition_id) DO UPDATE SET
      market_title = excluded.market_title,
      market_slug = excluded.market_slug,
      event_slug = excluded.event_slug,
      sport_series_id = excluded.sport_series_id,
      event_time = excluded.event_time,
      pnl_coverage = excluded.pnl_coverage,
      is_ready = excluded.is_ready,
      side_a_label = excluded.side_a_label,
      side_a_total_value = excluded.side_a_total_value,
      side_a_sharp_score = excluded.side_a_sharp_score,
      side_a_holder_count = excluded.side_a_holder_count,
      side_a_price = excluded.side_a_price,
      side_a_top_holders = excluded.side_a_top_holders,
      side_b_label = excluded.side_b_label,
      side_b_total_value = excluded.side_b_total_value,
      side_b_sharp_score = excluded.side_b_sharp_score,
      side_b_holder_count = excluded.side_b_holder_count,
      side_b_price = excluded.side_b_price,
      side_b_top_holders = excluded.side_b_top_holders,
      sharp_side = excluded.sharp_side,
      confidence = excluded.confidence,
      score_differential = excluded.score_differential,
      sharp_side_value_ratio = excluded.sharp_side_value_ratio,
      edge_rating = excluded.edge_rating,
      computed_at = excluded.computed_at,
      history_updated_at = excluded.history_updated_at,
      updated_at = excluded.updated_at`,
		id,
		input.conditionId,
		input.marketTitle,
		input.marketSlug ?? null,
		input.eventSlug ?? null,
		input.sportSeriesId ?? null,
		input.eventTime ?? null,
		pnlCoverage,
		isReady ? 1 : 0,
		input.sideA.label,
		input.sideA.totalValue,
		input.sideA.sharpScore,
		input.sideA.holderCount,
		input.sideA.price ?? null,
		JSON.stringify(input.sideA.topHolders),
		input.sideB.label,
		input.sideB.totalValue,
		input.sideB.sharpScore,
		input.sideB.holderCount,
		input.sideB.price ?? null,
		JSON.stringify(input.sideB.topHolders),
		input.sharpSide,
		input.confidence,
		input.scoreDifferential,
		input.sharpSideValueRatio ?? null,
		input.edgeRating,
		computedAt,
		historyUpdatedAt,
		now,
	);
}

/**
 * Get a single sharp money cache entry by condition ID
 */
export async function getSharpMoneyCacheByConditionId(
	db: Db,
	conditionId: string,
): Promise<SharpMoneyCacheEntry | null> {
	const row = await first<SharpMoneyCacheRow>(
		db,
		`SELECT * FROM sharp_money_cache WHERE condition_id = ?`,
		conditionId,
	);

	return row ? parseRow(row) : null;
}

/**
 * Get all sharp money cache entries, optionally filtered by sport
 */
export async function listSharpMoneyCache(
	db: Db,
	options?: {
		sportSeriesId?: number;
		limit?: number;
		windowHours?: number;
	},
): Promise<SharpMoneyCacheEntry[]> {
	const { sportSeriesId, limit = 50, windowHours = 24 } = options ?? {};

	let query = `SELECT * FROM sharp_money_cache`;
	const params: unknown[] = [];
	const whereClauses: string[] = [];

	const now = new Date();
	const startBufferMs = START_TIME_BUFFER_MINUTES * 60 * 1000;
	const windowStartIso = new Date(now.getTime() - startBufferMs).toISOString();
	const windowEndIso = new Date(
		now.getTime() + windowHours * 60 * 60 * 1000,
	).toISOString();
	whereClauses.push(`event_time IS NOT NULL`);
	whereClauses.push(`datetime(event_time) >= datetime(?)`);
	params.push(windowStartIso);
	whereClauses.push(`datetime(event_time) <= datetime(?)`);
	params.push(windowEndIso);

	if (sportSeriesId !== undefined) {
		whereClauses.push(`sport_series_id = ?`);
		params.push(sportSeriesId);
	}

	if (whereClauses.length > 0) {
		query += ` WHERE ${whereClauses.join(" AND ")}`;
	}

	// Order by: Edge Rating (highest first), then score differential (highest first),
	// then confidence (HIGH > MEDIUM > LOW), then conviction (balanced is better), then event time (soonest first)
	query += ` ORDER BY 
    edge_rating DESC NULLS LAST,
    score_differential DESC NULLS LAST,
    CASE confidence
      WHEN 'HIGH' THEN 3
      WHEN 'MEDIUM' THEN 2
      WHEN 'LOW' THEN 1
      ELSE 0
    END DESC,
    ABS(sharp_side_value_ratio - 0.5) ASC NULLS LAST,
    event_time ASC NULLS LAST
    LIMIT ?`;
	params.push(limit);

	const rows = await all<SharpMoneyCacheRow>(db, query, ...params);
	return rows.map(parseRow);
}

export async function listSharpMoneyCacheByConditionIds(
	db: Db,
	conditionIds: string[],
): Promise<SharpMoneyCacheEntry[]> {
	if (conditionIds.length === 0) return [];
	const placeholders = conditionIds.map(() => "?").join(", ");
	const rows = await all<SharpMoneyCacheRow>(
		db,
		`SELECT * FROM sharp_money_cache WHERE condition_id IN (${placeholders})`,
		...conditionIds,
	);
	return rows.map(parseRow);
}

/**
 * Get all unique sport tags from the cache
 */
/**
 * Delete old cache entries (older than specified hours)
 */
export async function pruneSharpMoneyCache(
	db: Db,
	olderThanHours: number = 24,
): Promise<number> {
	const cutoff = nowUnixSeconds() - olderThanHours * 60 * 60;
	const nowIso = new Date().toISOString();
	const result = await run(
		db,
		`DELETE FROM sharp_money_cache
     WHERE (event_time IS NOT NULL AND datetime(event_time) < datetime(?))
       OR (event_time IS NULL AND updated_at < ?)`,
		nowIso,
		cutoff,
	);
	return (result.meta?.changes as number) ?? 0;
}

/**
 * Delete a specific cache entry
 */
export async function deleteSharpMoneyCache(
	db: Db,
	conditionId: string,
): Promise<void> {
	await run(
		db,
		`DELETE FROM sharp_money_cache WHERE condition_id = ?`,
		conditionId,
	);
}

/**
 * Clear all sharp money cache entries
 */
export async function clearAllSharpMoneyCache(db: Db): Promise<void> {
	await run(db, `DELETE FROM sharp_money_cache`);
}

/**
 * Get cache stats
 */
export async function getSharpMoneyCacheStats(db: Db): Promise<{
	totalEntries: number;
	bySport: Record<string, number>;
	byConfidence: Record<string, number>;
	oldestEntry?: number;
	newestEntry?: number;
}> {
	const [countResult, sportCounts, confidenceCounts, timestamps] =
		await Promise.all([
			first<{ count: number }>(
				db,
				`SELECT COUNT(*) as count FROM sharp_money_cache`,
			),
			all<{ sport_series_id: number | null; count: number }>(
				db,
				`SELECT sport_series_id, COUNT(*) as count FROM sharp_money_cache GROUP BY sport_series_id`,
			),
			all<{ confidence: string; count: number }>(
				db,
				`SELECT confidence, COUNT(*) as count FROM sharp_money_cache GROUP BY confidence`,
			),
			first<{ oldest: number; newest: number }>(
				db,
				`SELECT MIN(updated_at) as oldest, MAX(updated_at) as newest FROM sharp_money_cache`,
			),
		]);

	const bySport: Record<string, number> = {};
	for (const row of sportCounts) {
		const key =
			row.sport_series_id === null ? "unknown" : String(row.sport_series_id);
		bySport[key] = row.count;
	}

	const byConfidence: Record<string, number> = {};
	for (const row of confidenceCounts) {
		byConfidence[row.confidence ?? "unknown"] = row.count;
	}

	return {
		totalEntries: countResult?.count ?? 0,
		bySport,
		byConfidence,
		oldestEntry: timestamps?.oldest,
		newestEntry: timestamps?.newest,
	};
}

export async function insertSharpMoneyHistory(
	db: Db,
	input: {
		conditionId: string;
		recordedAt?: number;
		computedAt?: number;
		marketTitle: string;
		eventTime?: string;
		sportSeriesId?: number;
		sideA: {
			label: string;
			totalValue: number;
			sharpScore: number;
			price?: number | null;
		};
		sideB: {
			label: string;
			totalValue: number;
			sharpScore: number;
			price?: number | null;
		};
		sharpSide: "A" | "B" | "EVEN";
		confidence: "HIGH" | "MEDIUM" | "LOW";
		scoreDifferential: number;
		sharpSideValueRatio?: number;
		edgeRating: number;
		pnlCoverage?: number;
	},
): Promise<void> {
	const now = input.recordedAt ?? nowUnixSeconds();
	const computedAt = input.computedAt ?? now;
	const cutoff = now - HISTORY_RETENTION_HOURS * 60 * 60;

	await run(
		db,
		`DELETE FROM sharp_money_history WHERE recorded_at < ?`,
		cutoff,
	);

	await run(
		db,
		`INSERT OR REPLACE INTO sharp_money_history (
      condition_id,
      recorded_at,
      computed_at,
      market_title,
      event_time,
      sport_series_id,
      side_a_label,
      side_b_label,
      side_a_total_value,
      side_b_total_value,
      side_a_sharp_score,
      side_b_sharp_score,
      side_a_price,
      side_b_price,
      sharp_side,
      confidence,
      score_differential,
      sharp_side_value_ratio,
      edge_rating,
      pnl_coverage
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		input.conditionId,
		now,
		computedAt,
		input.marketTitle,
		input.eventTime ?? null,
		input.sportSeriesId ?? null,
		input.sideA.label,
		input.sideB.label,
		input.sideA.totalValue,
		input.sideB.totalValue,
		input.sideA.sharpScore,
		input.sideB.sharpScore,
		input.sideA.price ?? null,
		input.sideB.price ?? null,
		input.sharpSide,
		input.confidence,
		input.scoreDifferential,
		input.sharpSideValueRatio ?? null,
		input.edgeRating,
		input.pnlCoverage ?? null,
	);
}

export async function listSharpMoneyHistory(
	db: Db,
	conditionId: string,
	sinceSeconds?: number,
): Promise<SharpMoneyHistoryEntry[]> {
	const cutoff =
		sinceSeconds ?? nowUnixSeconds() - HISTORY_EVENT_WINDOW_HOURS * 60 * 60;
	const rows = await all<SharpMoneyHistoryRow>(
		db,
		`SELECT * FROM sharp_money_history
     WHERE condition_id = ?
       AND recorded_at >= ?
     ORDER BY recorded_at ASC`,
		conditionId,
		cutoff,
	);
	return rows.map(parseHistoryRow);
}

export async function listSharpMoneyHistoryByConditionIds(
	db: Db,
	conditionIds: string[],
	sinceSeconds: number,
): Promise<SharpMoneyHistoryEntryByConditionId> {
	if (conditionIds.length === 0) return {};
	const placeholders = conditionIds.map(() => "?").join(", ");
	const rows = await all<SharpMoneyHistoryRow>(
		db,
		`SELECT * FROM sharp_money_history
     WHERE condition_id IN (${placeholders})
       AND recorded_at >= ?
     ORDER BY condition_id ASC, recorded_at ASC`,
		...conditionIds,
		sinceSeconds,
	);
	const grouped: SharpMoneyHistoryEntryByConditionId = {};
	for (const row of rows) {
		const entry = parseHistoryRow(row);
		if (!grouped[entry.conditionId]) {
			grouped[entry.conditionId] = [];
		}
		grouped[entry.conditionId].push(entry);
	}
	return grouped;
}

export async function listSharpMoneyHistoryWindow(
	db: Db,
	sinceSeconds: number,
): Promise<Array<{ recordedAt: number; edgeRating: number }>> {
	const rows = await all<SharpMoneyHistoryStatRow>(
		db,
		`SELECT recorded_at, edge_rating
     FROM sharp_money_history
     WHERE recorded_at >= ?`,
		sinceSeconds,
	);
	return rows
		.map((row) => ({
			recordedAt: row.recorded_at,
			edgeRating: row.edge_rating ?? 0,
		}))
		.filter((row) => Number.isFinite(row.edgeRating));
}
