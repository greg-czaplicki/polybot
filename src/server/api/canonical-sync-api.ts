/**
 * Canonical Sync API — Phase 6
 *
 * Server functions for canonical pipeline freshness, status, and manual triggers.
 * Delegates to canonical-sync.ts for sync execution and run history (DRY).
 * Adds enhanced entity counts and staleness for the UI layer.
 */

import { createServerFn } from "@tanstack/react-start";
import { first } from "../db/client";
import { getDb } from "../env";
import type {
	CanonicalSyncResult,
	CanonicalSyncRun,
	CanonicalSyncStepResult,
} from "../pipeline/canonical-sync";

// ---------------------------------------------------------------------------
// Types (API-facing shapes for the UI layer)
// ---------------------------------------------------------------------------

export interface SyncRunSummary {
	id: string;
	startedAt: number;
	completedAt: number;
	durationMs: number;
	status: "success" | "partial" | "failed";
	gamesProcessed: number;
	factsComputed: number;
	picksBackfilled: number;
	steps: CanonicalSyncStepResult[];
	errorSummary: string | null;
}

export interface CanonicalFreshnessStatus {
	lastRun: SyncRunSummary | null;
	recentRuns: SyncRunSummary[];
	staleness: {
		isStale: boolean;
		lastSuccessAt: number | null;
		minutesSinceLastSuccess: number | null;
		staleThresholdMinutes: number;
	};
	counts: {
		teams: number;
		games: { total: number; finalized: number };
		facts: number;
		snapshots: number;
		picks: {
			total: number;
			enriched: number;
			enrichmentRate: number | null;
			fieldCoverage: {
				sportTag: number;
				teamId: number;
				opponentId: number;
				gameId: number;
				venueRole: number;
				favDogRole: number;
				spreadLine: number;
				totalLine: number;
			};
			betTypeBreakdown: Record<string, number>;
		};
		unprocessedGames: number;
	};
	backfillDiagnostics: {
		latestRunId: string | null;
		changedFields: Record<string, number>;
		failureReasons: Record<string, number>;
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function syncRunToSummary(run: CanonicalSyncRun): SyncRunSummary {
	let steps: CanonicalSyncStepResult[] = [];
	try {
		steps = JSON.parse(run.stepsJson);
	} catch {
		// ignore malformed JSON
	}

	return {
		id: run.id,
		startedAt: run.startedAt,
		completedAt: run.completedAt,
		durationMs: run.durationMs,
		status: run.status,
		gamesProcessed: run.gamesProcessed,
		factsComputed: run.factsComputed,
		picksBackfilled: run.picksBackfilled,
		steps,
		errorSummary: run.errorSummary,
	};
}

// ---------------------------------------------------------------------------
// Freshness / Status
// ---------------------------------------------------------------------------

/**
 * Get full canonical pipeline freshness status.
 * Delegates run history and staleness to canonical-sync.ts,
 * adds enhanced entity counts for the UI.
 */
export const getCanonicalFreshnessFn = createServerFn({
	method: "POST",
}).handler(async ({ context }) => {
	const db = getDb(context);

	// Delegate to canonical-sync.ts for freshness and run history
	const [coreFreshness, counts] = await Promise.all([
		import("../pipeline/canonical-sync")
			.then(({ getCanonicalFreshness }) => getCanonicalFreshness(db))
			.catch(() => null),
		getEnhancedEntityCounts(db),
	]);

	const summaries = coreFreshness?.recentRuns.map(syncRunToSummary) ?? [];
	const lastRun = summaries.length > 0 ? summaries[0] : null;
	const latestBackfillStep =
		lastRun?.steps.find((step) => step.step === "pick-backfill") ?? null;
	const changedFields = Object.fromEntries(
		Object.entries(latestBackfillStep?.counts ?? {})
			.filter(([key]) => key.startsWith("changed_"))
			.map(([key, value]) => [key.replace(/^changed_/, ""), value]),
	);
	const failureReasons = Object.fromEntries(
		Object.entries(latestBackfillStep?.counts ?? {})
			.filter(([key]) => key.startsWith("reason_"))
			.map(([key, value]) => [key.replace(/^reason_/, ""), value]),
	);

	const lastSuccessAt = coreFreshness?.lastSuccessAt ?? null;
	let minutesSinceLastSuccess: number | null = null;
	if (lastSuccessAt) {
		minutesSinceLastSuccess = Math.round((Date.now() - lastSuccessAt) / 60000);
	}

	// Use staleness threshold from canonical-sync.ts (6 hours = 360 minutes)
	const staleThresholdMinutes = 360;

	const freshness: CanonicalFreshnessStatus = {
		lastRun,
		recentRuns: summaries,
		staleness: {
			isStale: coreFreshness?.isStale ?? true,
			lastSuccessAt,
			minutesSinceLastSuccess,
			staleThresholdMinutes,
		},
		counts,
		backfillDiagnostics: {
			latestRunId: lastRun?.id ?? null,
			changedFields,
			failureReasons,
		},
	};

	return { freshness };
});

/**
 * Enhanced entity counts with game/pick breakdowns not in canonical-sync.ts.
 */
async function getEnhancedEntityCounts(db: D1Database) {
	const [
		teams,
		games,
		facts,
		snapshots,
		picksTotal,
		picksEnriched,
		pickCoverage,
		betTypeRows,
		unprocessed,
	] = await Promise.all([
		first<{ count: number }>(db, "SELECT COUNT(*) as count FROM teams"),
		first<{ total: number; finalized: number }>(
			db,
			"SELECT COUNT(*) as total, SUM(CASE WHEN is_final = 1 THEN 1 ELSE 0 END) as finalized FROM games",
		),
		first<{ count: number }>(
			db,
			"SELECT COUNT(*) as count FROM team_game_facts",
		),
		first<{ count: number }>(
			db,
			"SELECT COUNT(*) as count FROM team_trend_snapshots",
		),
		first<{ count: number }>(db, "SELECT COUNT(*) as count FROM manual_picks"),
		first<{ count: number }>(
			db,
			"SELECT COUNT(*) as count FROM manual_picks WHERE team_id IS NOT NULL",
		),
		first<{
			sport_tag: number;
			team_id: number;
			opponent_id: number;
			game_id: number;
			venue_role: number;
			fav_dog_role: number;
			spread_line: number;
			total_line: number;
		}>(
			db,
			`SELECT
					COUNT(sport_tag) as sport_tag,
					COUNT(team_id) as team_id,
					COUNT(opponent_id) as opponent_id,
					COUNT(game_id) as game_id,
					COUNT(venue_role) as venue_role,
					COUNT(fav_dog_role) as fav_dog_role,
					COUNT(spread_line) as spread_line,
					COUNT(total_line) as total_line
				 FROM manual_picks`,
		),
		first<{ breakdown_json: string | null }>(
			db,
			`SELECT json_group_object(bet_type_key, count_value) as breakdown_json
				 FROM (
				 	SELECT COALESCE(bet_type, 'NULL') as bet_type_key, COUNT(*) as count_value
				 	FROM manual_picks
				 	GROUP BY COALESCE(bet_type, 'NULL')
				 )`,
		),
		first<{ count: number }>(
			db,
			`SELECT COUNT(*) as count FROM games g
				 LEFT JOIN team_game_facts tgf ON tgf.game_id = g.id
				 WHERE g.is_final = 1 AND tgf.id IS NULL`,
		),
	]);

	const total = picksTotal?.count ?? 0;
	const enriched = picksEnriched?.count ?? 0;

	return {
		teams: teams?.count ?? 0,
		games: {
			total: games?.total ?? 0,
			finalized: games?.finalized ?? 0,
		},
		facts: facts?.count ?? 0,
		snapshots: snapshots?.count ?? 0,
		picks: {
			total,
			enriched,
			enrichmentRate: total > 0 ? enriched / total : null,
			fieldCoverage: {
				sportTag: pickCoverage?.sport_tag ?? 0,
				teamId: pickCoverage?.team_id ?? 0,
				opponentId: pickCoverage?.opponent_id ?? 0,
				gameId: pickCoverage?.game_id ?? 0,
				venueRole: pickCoverage?.venue_role ?? 0,
				favDogRole: pickCoverage?.fav_dog_role ?? 0,
				spreadLine: pickCoverage?.spread_line ?? 0,
				totalLine: pickCoverage?.total_line ?? 0,
			},
			betTypeBreakdown: betTypeRows?.breakdown_json
				? (JSON.parse(betTypeRows.breakdown_json) as Record<string, number>)
				: {},
		},
		unprocessedGames: unprocessed?.count ?? 0,
	};
}

// ---------------------------------------------------------------------------
// Manual Trigger
// ---------------------------------------------------------------------------

/**
 * Trigger a manual canonical sync cycle.
 * Calls the canonical sync runner directly and persists the result.
 *
 * Input: { skipSeeding?: boolean }
 */
export const triggerCanonicalSyncFn = createServerFn({
	method: "POST",
})
	.inputValidator((d: { skipSeeding?: boolean }) => d)
	.handler(async ({ context, data }) => {
		const db = getDb(context);

		try {
			const { runCanonicalSync, persistSyncRun } = await import(
				"../pipeline/canonical-sync"
			);
			const result: CanonicalSyncResult = await runCanonicalSync(db, {
				skipSeeding: data.skipSeeding,
			});
			await persistSyncRun(db, result);
			return { success: true as const, result };
		} catch (error) {
			return {
				success: false as const,
				error: `Sync trigger failed: ${error instanceof Error ? error.message : String(error)}`,
				result: null,
			};
		}
	});

// ---------------------------------------------------------------------------
// Recent Sync Runs
// ---------------------------------------------------------------------------

/**
 * Get recent canonical sync run history.
 * Delegates to getRecentSyncRuns from canonical-sync.ts.
 *
 * Input: { limit?: number }
 */
export const getCanonicalSyncRunsFn = createServerFn({
	method: "POST",
})
	.inputValidator((d: { limit?: number }) => d)
	.handler(async ({ context, data }) => {
		const db = getDb(context);
		const limit = Math.min(data.limit ?? 20, 50);

		try {
			const { getRecentSyncRuns } = await import("../pipeline/canonical-sync");
			const runs = await getRecentSyncRuns(db, limit);
			return { runs: runs.map(syncRunToSummary) };
		} catch {
			return { runs: [] as SyncRunSummary[] };
		}
	});
