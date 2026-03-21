/**
 * Game ingestion — creates/updates canonical games from Polymarket market data.
 *
 * Groups related markets (spread, total, moneyline) for the same event
 * into a single canonical game using event_time + team matching.
 */

import type { Db } from "../db/client";
import { all, first } from "../db/client";
import {
	createGame,
	getGameById,
	updateGameResult,
} from "../repositories/games";
import type { Game } from "../types/canonical";
import { resolveTeamFromMarketTitle } from "./team-seeder";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input for ingesting a game from market/event data. */
export interface MarketGameInput {
	/** Market title (e.g., "Chiefs -3.5 vs Broncos") */
	marketTitle: string;
	/** Sport tag (e.g., "nfl") */
	sportTag: string;
	/** Event time as unix timestamp (seconds) */
	eventTime: number;
	/** Season identifier (e.g., "2025-26") */
	season?: string;
	/** Season type (e.g., "regular", "postseason") */
	seasonType?: string;
	/** Week identifier (e.g., "Week 1") */
	week?: string;
	/** Whether this is a neutral-site game */
	neutralSite?: boolean;
	/** Final home score (if game is complete) */
	homeScore?: number;
	/** Final away score (if game is complete) */
	awayScore?: number;
	/** Whether the game went to overtime */
	wentToOt?: boolean;
}

export interface GameIngestionResult {
	game: Game;
	/** Whether a new game was created vs. an existing one was matched */
	created: boolean;
	/** If matching failed, describes the reason */
	matchInfo?: string;
}

// ---------------------------------------------------------------------------
// Game matching
// ---------------------------------------------------------------------------

/** Returns true if the input contains both home and away scores. */
function hasScores(input: MarketGameInput): boolean {
	return input.homeScore != null && input.awayScore != null;
}

/**
 * Time window (seconds) for matching markets to the same game.
 * Markets within this window for the same teams are considered the same event.
 * Default: 6 hours (games rarely overlap within that window for same teams).
 */
const GAME_TIME_MATCH_WINDOW_SECONDS = 6 * 60 * 60;

/**
 * Attempts to find an existing game matching the same teams and time window.
 * This deduplicates markets for the same event (spread, total, ML).
 * Uses a lightweight ID query then delegates to the repository's getGameById
 * to avoid duplicating row parsing logic.
 */
async function findExistingGame(
	db: Db,
	homeTeamId: string,
	awayTeamId: string,
	eventTime: number,
	sportTag: string,
): Promise<Game | null> {
	const windowStart = eventTime - GAME_TIME_MATCH_WINDOW_SECONDS;
	const windowEnd = eventTime + GAME_TIME_MATCH_WINDOW_SECONDS;

	const row = await first<{ id: string }>(
		db,
		`SELECT id FROM games
		 WHERE sport_tag = ?
		   AND home_team_id = ?
		   AND away_team_id = ?
		   AND game_time BETWEEN ? AND ?
		 LIMIT 1`,
		sportTag,
		homeTeamId,
		awayTeamId,
		windowStart,
		windowEnd,
	);

	if (!row) return null;
	return getGameById(db, row.id);
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/**
 * Creates or matches a canonical game from Polymarket market data.
 *
 * Flow:
 * 1. Resolve home/away teams from market title via alias lookup
 * 2. Check for existing game (same teams + time window)
 * 3. Create new game if none found
 *
 * Returns the game and whether it was newly created.
 */
export async function ingestGameFromMarketData(
	db: Db,
	input: MarketGameInput,
): Promise<GameIngestionResult | null> {
	const resolved = await resolveTeamFromMarketTitle(
		db,
		input.sportTag,
		input.marketTitle,
	);
	if (!resolved) {
		return null; // Could not resolve teams — skip
	}

	const { homeTeam, awayTeam } = resolved;

	// Try to find existing game for these teams + time window
	const existing = await findExistingGame(
		db,
		homeTeam.id,
		awayTeam.id,
		input.eventTime,
		input.sportTag,
	);

	if (existing) {
		// If scores are provided and the game isn't finalized yet, update it
		if (hasScores(input) && !existing.isFinal) {
			await updateGameResult(db, existing.id, {
				homeScore: input.homeScore as number,
				awayScore: input.awayScore as number,
				wentToOt: input.wentToOt,
			});
			const updated = await getGameById(db, existing.id);
			return {
				game: updated ?? existing,
				created: false,
				matchInfo: `Matched existing game ${existing.id}, updated with final scores`,
			};
		}
		return {
			game: existing,
			created: false,
			matchInfo:
				hasScores(input) && existing.isFinal
					? `Matched existing game ${existing.id}, already finalized — scores not overwritten`
					: `Matched existing game ${existing.id}`,
		};
	}

	// Create new canonical game
	const game = await createGame(db, {
		sportTag: input.sportTag,
		season: input.season,
		seasonType: input.seasonType,
		week: input.week,
		gameTime: input.eventTime,
		homeTeamId: homeTeam.id,
		awayTeamId: awayTeam.id,
		neutralSite: input.neutralSite,
	});

	// If scores are provided at creation time, finalize immediately
	if (hasScores(input)) {
		await updateGameResult(db, game.id, {
			homeScore: input.homeScore as number,
			awayScore: input.awayScore as number,
			wentToOt: input.wentToOt,
		});
		const finalized = await getGameById(db, game.id);
		return {
			game: finalized ?? game,
			created: true,
			matchInfo: "Created with final scores",
		};
	}

	return {
		game,
		created: true,
	};
}

// ---------------------------------------------------------------------------
// Batch ingestion
// ---------------------------------------------------------------------------

/** Result of a batch game ingestion run. */
export interface BatchGameIngestionResult {
	created: number;
	matched: number;
	skipped: number;
	errors: number;
	details: Array<{
		marketTitle: string;
		gameId: string | null;
		status: "created" | "matched" | "skipped" | "error";
		reason?: string;
	}>;
}

/**
 * Ingests multiple markets, grouping them into canonical games.
 */
export async function batchIngestGames(
	db: Db,
	inputs: MarketGameInput[],
): Promise<BatchGameIngestionResult> {
	const result: BatchGameIngestionResult = {
		created: 0,
		matched: 0,
		skipped: 0,
		errors: 0,
		details: [],
	};

	for (const input of inputs) {
		try {
			const ingested = await ingestGameFromMarketData(db, input);

			if (!ingested) {
				result.skipped++;
				result.details.push({
					marketTitle: input.marketTitle,
					gameId: null,
					status: "skipped",
					reason: "Could not resolve teams from market title",
				});
				continue;
			}

			if (ingested.created) {
				result.created++;
			} else {
				result.matched++;
			}

			result.details.push({
				marketTitle: input.marketTitle,
				gameId: ingested.game.id,
				status: ingested.created ? "created" : "matched",
				reason: ingested.matchInfo,
			});
		} catch (err) {
			result.errors++;
			result.details.push({
				marketTitle: input.marketTitle,
				gameId: null,
				status: "error",
				reason: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return result;
}

/**
 * Lists games for a sport that lack final scores (candidates for score updates).
 */
export async function listUnfinalizedGames(
	db: Db,
	sportTag: string,
	limit = 100,
): Promise<Game[]> {
	const rows = await all<{ id: string }>(
		db,
		`SELECT id FROM games
		 WHERE sport_tag = ? AND is_final = 0
		 ORDER BY game_time ASC
		 LIMIT ?`,
		sportTag,
		limit,
	);
	const games: Game[] = [];
	for (const row of rows) {
		const game = await getGameById(db, row.id);
		if (game) games.push(game);
	}
	return games;
}
