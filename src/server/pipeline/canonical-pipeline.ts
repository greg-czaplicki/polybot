/**
 * Canonical Pipeline Orchestrator — Phase 3
 *
 * Single entry point for processing the canonical sports context pipeline:
 *   1. Compute team_game_facts from finalized games
 *   2. Recompute team_trend_snapshots after fact inserts
 *
 * Steps 1-2 are owned by this module. Team seeding, game ingestion,
 * and line ingestion are handled upstream by their respective modules.
 *
 * Usage:
 *   await processGame(db, gameId)  — facts + snapshots for one game
 *   await processGames(db, gameIds) — batch processing
 */

import type { Db } from "../db/client";
import { getGameById } from "../repositories/games";
import {
	type ComputeFactsResult,
	computeFactsForGame,
} from "./fact-computation";
import {
	type ComputeSnapshotsResult,
	computeSnapshotsForGame,
} from "./snapshot-computation";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PipelineGameResult {
	gameId: string;
	facts: ComputeFactsResult;
	snapshots: {
		home: ComputeSnapshotsResult;
		away: ComputeSnapshotsResult;
	};
}

export interface PipelineBatchResult {
	processed: PipelineGameResult[];
	skipped: string[];
	errors: Array<{ gameId: string; error: string }>;
}

/**
 * Process a single finalized game through the canonical pipeline:
 * 1. Compute team_game_facts (two rows — home and away)
 * 2. Recompute team_trend_snapshots for both teams
 *
 * Throws if the game doesn't exist or isn't finalized.
 */
export async function processGame(
	db: Db,
	gameId: string,
): Promise<PipelineGameResult> {
	// Compute facts
	const facts = await computeFactsForGame(db, gameId);

	// Get game details for snapshot computation
	const game = await getGameById(db, gameId);
	if (!game)
		throw new Error(`Game disappeared after fact computation: ${gameId}`);

	const gameTime = game.gameTime ?? game.createdAt;

	// Compute snapshots for both teams
	const snapshots = await computeSnapshotsForGame(
		db,
		gameId,
		game.homeTeamId,
		game.awayTeamId,
		game.sportTag,
		gameTime,
	);

	return { gameId, facts, snapshots };
}

/**
 * Process multiple games in sequence. Non-final games are skipped.
 * Errors on individual games don't halt the batch.
 */
export async function processGames(
	db: Db,
	gameIds: string[],
): Promise<PipelineBatchResult> {
	const processed: PipelineGameResult[] = [];
	const skipped: string[] = [];
	const errors: Array<{ gameId: string; error: string }> = [];

	for (const gameId of gameIds) {
		try {
			// Check if game is final before processing
			const game = await getGameById(db, gameId);
			if (!game) {
				errors.push({ gameId, error: "Game not found" });
				continue;
			}
			if (!game.isFinal) {
				skipped.push(gameId);
				continue;
			}

			const result = await processGame(db, gameId);
			processed.push(result);
		} catch (err) {
			errors.push({
				gameId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return { processed, skipped, errors };
}

/**
 * Process all finalized games for a sport/season that haven't been processed yet.
 * Useful for backfill: finds games where is_final=1 but no team_game_facts exist.
 */
export async function processUnprocessedGames(
	db: Db,
	sportTag: string,
	options?: { season?: string; limit?: number },
): Promise<PipelineBatchResult> {
	const { season, limit = 100 } = options ?? {};

	// Find finalized games without facts
	const params: unknown[] = [sportTag];
	let whereClause = "g.sport_tag = ? AND g.is_final = 1";

	if (season) {
		whereClause += " AND g.season = ?";
		params.push(season);
	}

	params.push(limit);

	const { all: allFn } = await import("../db/client");
	const rows = await allFn<{ id: string }>(
		db,
		`SELECT g.id FROM games g
		LEFT JOIN team_game_facts tgf ON tgf.game_id = g.id
		WHERE ${whereClause} AND tgf.id IS NULL
		ORDER BY g.game_time ASC
		LIMIT ?`,
		...params,
	);

	const gameIds = rows.map((r) => r.id);
	return processGames(db, gameIds);
}
