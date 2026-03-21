/**
 * Canonical Sync Runner — Phase 6
 *
 * Orchestrates one full canonical pipeline cycle:
 *   1. Team seeding (upsert all canonical teams)
 *   2. Game ingestion (from sharp_money_cache market data)
 *   3. Line ingestion (extract lines from market titles)
 *   4. Fact computation (process finalized games without facts)
 *   5. Pick backfill (enrich manual_picks with canonical linkage)
 *
 * Each step is error-isolated so a failure in one does not halt the cycle.
 * Results are persisted to canonical_sync_runs for freshness/status visibility.
 */

import { detectSportTag } from "@/lib/sports";
import type { Db } from "../db/client";
import { all, first, run } from "../db/client";
import {
	type PipelineBatchResult,
	processUnprocessedGames,
} from "./canonical-pipeline";
import {
	type BatchGameIngestionResult,
	type MarketGameInput,
	batchIngestGames,
} from "./game-ingestion";
import {
	type BatchLineIngestionResult,
	type MarketLineInput,
	batchIngestLines,
} from "./line-ingestion";
import { type BackfillResult, backfillManualPicks } from "./pick-backfill";
import { resolveTeamFromMarketTitle, seedAllTeams } from "./team-seeder";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CanonicalSyncOptions {
	/** Restrict to specific sport tags. Defaults to all seeded sports. */
	sportTags?: string[];
	/** Max games to process per sport in fact computation. Default: 100 */
	limit?: number;
	/** Skip team seeding (safe when teams are already seeded). */
	skipSeeding?: boolean;
}

export interface CanonicalSyncStepResult {
	step: string;
	status: "success" | "skipped" | "error";
	durationMs: number;
	counts?: Record<string, number>;
	error?: string;
}

export interface CanonicalSyncResult {
	startedAt: number;
	completedAt: number;
	durationMs: number;
	status: "success" | "partial" | "failed";
	steps: CanonicalSyncStepResult[];
	gamesProcessed: number;
	factsComputed: number;
	picksBackfilled: number;
	errorSummary?: string;
}

export interface CanonicalSyncRun {
	id: string;
	startedAt: number;
	completedAt: number;
	durationMs: number;
	status: "success" | "partial" | "failed";
	stepsJson: string;
	gamesProcessed: number;
	factsComputed: number;
	picksBackfilled: number;
	errorSummary: string | null;
}

export interface CanonicalFreshness {
	lastRunAt: number | null;
	lastSuccessAt: number | null;
	lastStatus: string | null;
	isStale: boolean;
	totalGames: number;
	totalFacts: number;
	totalSnapshots: number;
	totalPicks: number;
	recentRuns: CanonicalSyncRun[];
}

// ---------------------------------------------------------------------------
// Helpers — market data from sharp_money_cache
// ---------------------------------------------------------------------------

/** Row shape from sharp_money_cache for building MarketGameInput. */
interface CacheRow {
	condition_id: string;
	market_title: string;
	event_slug: string | null;
	event_time: string | null;
	sport_series_id: number | null;
	side_a_label: string | null;
	side_b_label: string | null;
	market_volume: number | null;
}

/** Default sport tags with team seeding support. */
const DEFAULT_SPORT_TAGS = ["nfl", "nba", "mlb", "ncaab", "ncaaf"];

/** Staleness threshold: 6 hours without a successful run = stale. */
const STALENESS_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/**
 * Queries sharp_money_cache for sports markets and converts them to
 * MarketGameInput objects suitable for batchIngestGames.
 */
async function getMarketInputsFromCache(db: Db): Promise<MarketGameInput[]> {
	const rows = await all<CacheRow>(
		db,
		`SELECT condition_id, market_title, event_slug, event_time,
		        sport_series_id, side_a_label, side_b_label, market_volume
		 FROM sharp_money_cache
		 WHERE event_time IS NOT NULL
		 ORDER BY event_time ASC`,
	);

	const inputs: MarketGameInput[] = [];

	for (const row of rows) {
		const sportTag = detectSportTag({
			title: row.market_title,
			eventSlug: row.event_slug,
		});
		if (!sportTag) continue;

		// Parse event_time — stored as ISO string in sharp_money_cache
		const eventTimeMs = new Date(row.event_time as string).getTime();
		if (!Number.isFinite(eventTimeMs)) continue;
		const eventTime = Math.floor(eventTimeMs / 1000);

		inputs.push({
			marketTitle: row.market_title,
			sportTag,
			eventTime,
		});
	}

	return inputs;
}

/** Time window (seconds) for matching cache entries to games. */
const GAME_TIME_MATCH_WINDOW = 6 * 60 * 60;

/**
 * Builds MarketLineInput objects from sharp_money_cache for games that
 * don't yet have close lines. Uses team identity resolution (via
 * resolveTeamFromMarketTitle) plus a time window for safe matching.
 * Rows where teams cannot be resolved or the match is ambiguous are skipped.
 */
async function getLineInputsFromCache(db: Db): Promise<MarketLineInput[]> {
	// Fetch cache entries with event times
	const cacheRows = await all<CacheRow>(
		db,
		`SELECT condition_id, market_title, event_slug, event_time,
		        sport_series_id, side_a_label, side_b_label, market_volume
		 FROM sharp_money_cache
		 WHERE event_time IS NOT NULL
		 LIMIT 500`,
	);

	const inputs: MarketLineInput[] = [];

	for (const row of cacheRows) {
		// Detect sport tag in application code (DRY — uses shared detectSportTag)
		const sportTag = detectSportTag({
			title: row.market_title,
			eventSlug: row.event_slug,
		});
		if (!sportTag) continue;

		const eventTimeMs = new Date(row.event_time as string).getTime();
		if (!Number.isFinite(eventTimeMs)) continue;
		const eventTimeUnix = Math.floor(eventTimeMs / 1000);

		// Resolve teams from market title — skip if we can't identify both teams
		const resolved = await resolveTeamFromMarketTitle(
			db,
			sportTag,
			row.market_title,
		);
		if (!resolved) continue;

		const { homeTeam, awayTeam } = resolved;

		// Find a matching game by team IDs + sport + time window,
		// excluding games that already have close lines.
		// Match either (home, away) or (away, home) ordering since
		// market title parsing may not always get home/away correct.
		const matches = await all<{ id: string }>(
			db,
			`SELECT g.id FROM games g
			 LEFT JOIN game_lines gl ON gl.game_id = g.id AND gl.snapshot_type = 'close'
			 WHERE g.sport_tag = ?
			   AND ABS(g.game_time - ?) < ?
			   AND (
			     (g.home_team_id = ? AND g.away_team_id = ?)
			     OR (g.home_team_id = ? AND g.away_team_id = ?)
			   )
			   AND gl.id IS NULL
			 LIMIT 2`,
			sportTag,
			eventTimeUnix,
			GAME_TIME_MATCH_WINDOW,
			homeTeam.id,
			awayTeam.id,
			awayTeam.id,
			homeTeam.id,
		);

		// Skip ambiguous matches (0 or >1 games)
		if (matches.length !== 1) continue;

		inputs.push({
			gameId: matches[0].id,
			marketTitle: row.market_title,
			snapshotType: "close",
			source: "polymarket",
		});
	}

	return inputs;
}

// ---------------------------------------------------------------------------
// Step runners
// ---------------------------------------------------------------------------

async function runStep(
	name: string,
	fn: () => Promise<Record<string, number>>,
): Promise<CanonicalSyncStepResult> {
	const start = Date.now();
	try {
		const counts = await fn();
		return {
			step: name,
			status: "success",
			durationMs: Date.now() - start,
			counts,
		};
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		console.error(`[canonical-sync] Step "${name}" failed:`, error);
		return {
			step: name,
			status: "error",
			durationMs: Date.now() - start,
			error,
		};
	}
}

// ---------------------------------------------------------------------------
// Main sync runner
// ---------------------------------------------------------------------------

/**
 * Runs one full canonical sync cycle.
 *
 * Steps:
 * 1. Team seeding (safe upserts)
 * 2. Game ingestion from sharp_money_cache
 * 3. Line ingestion for newly-matched games
 * 4. Fact computation for finalized games without facts
 * 5. Pick backfill for manual_picks missing linkage
 *
 * Each step is error-isolated. Returns a structured result.
 */
export async function runCanonicalSync(
	db: Db,
	options?: CanonicalSyncOptions,
): Promise<CanonicalSyncResult> {
	const startedAt = Date.now();
	const steps: CanonicalSyncStepResult[] = [];
	const sportTags = options?.sportTags ?? DEFAULT_SPORT_TAGS;
	const limit = options?.limit ?? 100;

	let gamesProcessed = 0;
	let factsComputed = 0;
	let picksBackfilled = 0;

	// Step 1: Team seeding
	if (!options?.skipSeeding) {
		const seedStep = await runStep("team-seeding", async () => {
			const results = await seedAllTeams(db);
			const totalSeeded = results.reduce((sum, r) => sum + r.seeded, 0);
			const totalTeams = results.reduce((sum, r) => sum + r.total, 0);
			return {
				seeded: totalSeeded,
				total: totalTeams,
				sports: results.length,
			};
		});
		steps.push(seedStep);
	} else {
		steps.push({
			step: "team-seeding",
			status: "skipped",
			durationMs: 0,
		});
	}

	// Step 2: Game ingestion from sharp_money_cache
	const gameStep = await runStep("game-ingestion", async () => {
		const inputs = await getMarketInputsFromCache(db);
		if (inputs.length === 0) {
			return { markets: 0, created: 0, matched: 0, skipped: 0, errors: 0 };
		}
		const result: BatchGameIngestionResult = await batchIngestGames(
			db,
			inputs,
		);
		gamesProcessed += result.created + result.matched;
		return {
			markets: inputs.length,
			created: result.created,
			matched: result.matched,
			skipped: result.skipped,
			errors: result.errors,
		};
	});
	steps.push(gameStep);

	// Step 3: Line ingestion
	const lineStep = await runStep("line-ingestion", async () => {
		const inputs = await getLineInputsFromCache(db);
		if (inputs.length === 0) {
			return { inputs: 0, ingested: 0, skipped: 0, errors: 0 };
		}
		const result: BatchLineIngestionResult = await batchIngestLines(db, inputs);
		return {
			inputs: inputs.length,
			ingested: result.ingested,
			skipped: result.skipped,
			errors: result.errors,
		};
	});
	steps.push(lineStep);

	// Step 4: Fact computation for each sport
	const factStep = await runStep("fact-computation", async () => {
		let totalProcessed = 0;
		let totalSkipped = 0;
		let totalErrors = 0;

		for (const sportTag of sportTags) {
			const result: PipelineBatchResult = await processUnprocessedGames(
				db,
				sportTag,
				{ limit },
			);
			totalProcessed += result.processed.length;
			totalSkipped += result.skipped.length;
			totalErrors += result.errors.length;
		}

		factsComputed = totalProcessed;
		return {
			processed: totalProcessed,
			skipped: totalSkipped,
			errors: totalErrors,
		};
	});
	steps.push(factStep);

	// Step 5: Pick backfill
	const backfillStep = await runStep("pick-backfill", async () => {
		const result: BackfillResult = await backfillManualPicks(db);
		picksBackfilled = result.updated;
		return {
			total: result.total,
			updated: result.updated,
			skipped: result.skipped,
			errors: result.errors,
		};
	});
	steps.push(backfillStep);

	// Compute overall status
	const completedAt = Date.now();
	const hasErrors = steps.some((s) => s.status === "error");
	const allErrors = steps.every(
		(s) => s.status === "error" || s.status === "skipped",
	);
	const errorSteps = steps.filter((s) => s.status === "error");

	const status: CanonicalSyncResult["status"] = allErrors
		? "failed"
		: hasErrors
			? "partial"
			: "success";

	const errorSummary =
		errorSteps.length > 0
			? errorSteps.map((s) => `${s.step}: ${s.error}`).join("; ")
			: undefined;

	return {
		startedAt,
		completedAt,
		durationMs: completedAt - startedAt,
		status,
		steps,
		gamesProcessed,
		factsComputed,
		picksBackfilled,
		errorSummary,
	};
}

// ---------------------------------------------------------------------------
// Persistence — save/query sync runs
// ---------------------------------------------------------------------------

/**
 * Persists a sync run result to the canonical_sync_runs table.
 */
export async function persistSyncRun(
	db: Db,
	result: CanonicalSyncResult,
): Promise<string> {
	const id = crypto.randomUUID();
	await run(
		db,
		`INSERT INTO canonical_sync_runs
		   (id, started_at, completed_at, duration_ms, status, steps_json,
		    games_processed, facts_computed, picks_backfilled, error_summary)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id,
		result.startedAt,
		result.completedAt,
		result.durationMs,
		result.status,
		JSON.stringify(result.steps),
		result.gamesProcessed,
		result.factsComputed,
		result.picksBackfilled,
		result.errorSummary ?? null,
	);
	return id;
}

/**
 * Retrieves recent canonical sync runs for status display.
 */
export async function getRecentSyncRuns(
	db: Db,
	limit = 10,
): Promise<CanonicalSyncRun[]> {
	const rows = await all<{
		id: string;
		started_at: number;
		completed_at: number;
		duration_ms: number;
		status: string;
		steps_json: string;
		games_processed: number;
		facts_computed: number;
		picks_backfilled: number;
		error_summary: string | null;
	}>(
		db,
		`SELECT id, started_at, completed_at, duration_ms, status, steps_json,
		        games_processed, facts_computed, picks_backfilled, error_summary
		 FROM canonical_sync_runs
		 ORDER BY started_at DESC
		 LIMIT ?`,
		limit,
	);

	return rows.map((row) => ({
		id: row.id,
		startedAt: row.started_at,
		completedAt: row.completed_at,
		durationMs: row.duration_ms,
		status: row.status as CanonicalSyncRun["status"],
		stepsJson: row.steps_json,
		gamesProcessed: row.games_processed,
		factsComputed: row.facts_computed,
		picksBackfilled: row.picks_backfilled,
		errorSummary: row.error_summary,
	}));
}

/**
 * Returns freshness information for the canonical pipeline.
 * Used by admin/status surfaces to determine if data is current.
 */
export async function getCanonicalFreshness(
	db: Db,
): Promise<CanonicalFreshness> {
	// Last run (any status)
	const lastRun = await first<{ started_at: number; status: string }>(
		db,
		`SELECT started_at, status FROM canonical_sync_runs
		 ORDER BY started_at DESC LIMIT 1`,
	);

	// Last successful run
	const lastSuccess = await first<{ started_at: number }>(
		db,
		`SELECT started_at FROM canonical_sync_runs
		 WHERE status = 'success'
		 ORDER BY started_at DESC LIMIT 1`,
	);

	// Entity counts
	const gameCount = await first<{ c: number }>(
		db,
		"SELECT COUNT(*) as c FROM games",
	);
	const factCount = await first<{ c: number }>(
		db,
		"SELECT COUNT(*) as c FROM team_game_facts",
	);
	const snapshotCount = await first<{ c: number }>(
		db,
		"SELECT COUNT(*) as c FROM team_trend_snapshots",
	);
	const pickCount = await first<{ c: number }>(
		db,
		"SELECT COUNT(*) as c FROM manual_picks WHERE team_id IS NOT NULL",
	);

	// Recent runs for display
	const recentRuns = await getRecentSyncRuns(db, 5);

	const now = Date.now();
	const lastSuccessAt = lastSuccess?.started_at ?? null;
	const isStale = lastSuccessAt
		? now - lastSuccessAt > STALENESS_THRESHOLD_MS
		: true;

	return {
		lastRunAt: lastRun?.started_at ?? null,
		lastSuccessAt,
		lastStatus: lastRun?.status ?? null,
		isStale,
		totalGames: gameCount?.c ?? 0,
		totalFacts: factCount?.c ?? 0,
		totalSnapshots: snapshotCount?.c ?? 0,
		totalPicks: pickCount?.c ?? 0,
		recentRuns,
	};
}
