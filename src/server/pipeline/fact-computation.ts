/**
 * Fact Computation — Phase 3
 *
 * Computes `team_game_facts` rows from finalized games + closing lines.
 * For each finalized game, produces two fact rows (one per team) with:
 *   venue_role, fav_dog_role, actual_margin, su_result,
 *   spread_line, cover_margin, ats_result,
 *   total_line, actual_total, ou_result
 *
 * Grading rules follow docs/stats-spec/grading-rules.md.
 * Edge cases follow docs/stats-spec/edge-cases.md.
 */

import type { Db } from "../db/client";
import { getGameLine } from "../repositories/game-lines";
import { getGameById } from "../repositories/games";
import {
	type UpsertTeamGameFactInput,
	upsertTeamGameFact,
} from "../repositories/team-game-facts";
import type {
	AtsResult,
	FavDogRole,
	Game,
	GameLine,
	OuResult,
	PickResult,
	VenueRole,
} from "../types/canonical";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ComputeFactsResult {
	gameId: string;
	homeFact: UpsertTeamGameFactInput;
	awayFact: UpsertTeamGameFactInput;
	warnings: string[];
}

/**
 * Compute and persist two team_game_facts rows for a finalized game.
 *
 * Requirements:
 * - Game must exist and be marked `is_final = true` with scores populated.
 * - Closing lines are optional but strongly preferred (enables ATS/OU grading).
 *
 * Returns the computed inputs for both sides plus any warnings.
 */
export async function computeFactsForGame(
	db: Db,
	gameId: string,
): Promise<ComputeFactsResult> {
	const game = await getGameById(db, gameId);
	if (!game) throw new Error(`Game not found: ${gameId}`);
	if (!game.isFinal)
		throw new Error(`Game is not final, cannot compute facts: ${gameId}`);
	if (game.homeScore === undefined || game.awayScore === undefined)
		throw new Error(`Game missing scores: ${gameId}`);

	const warnings: string[] = [];

	// Fetch closing line (preferred for ATS / OU grading)
	const closingLine = await getGameLine(db, gameId, "close");
	if (!closingLine) {
		warnings.push(`No closing line found for game ${gameId}`);
	}

	// Fall back to open line if no close line exists
	const openLine = closingLine ? null : await getGameLine(db, gameId, "open");
	const effectiveLine = closingLine ?? openLine ?? null;
	if (!closingLine && openLine) {
		warnings.push(
			`Using opening line as fallback for game ${gameId} (no closing line)`,
		);
	}

	const homeScore = game.homeScore;
	const awayScore = game.awayScore;
	const gameTime = game.gameTime ?? game.createdAt;

	// Derive fav/dog roles from the closing spread
	const { homeFavDog, awayFavDog } = deriveFavDogRoles(effectiveLine);

	// Build home team fact
	const homeFact = buildTeamFact({
		game,
		teamId: game.homeTeamId,
		opponentId: game.awayTeamId,
		venueRole: game.neutralSite ? "neutral" : "home",
		favDogRole: homeFavDog,
		teamScore: homeScore,
		opponentScore: awayScore,
		line: effectiveLine,
		isHome: true,
		gameTime,
	});

	// Build away team fact
	const awayFact = buildTeamFact({
		game,
		teamId: game.awayTeamId,
		opponentId: game.homeTeamId,
		venueRole: game.neutralSite ? "neutral" : "away",
		favDogRole: awayFavDog,
		teamScore: awayScore,
		opponentScore: homeScore,
		line: effectiveLine,
		isHome: false,
		gameTime,
	});

	// Persist both facts
	await upsertTeamGameFact(db, homeFact);
	await upsertTeamGameFact(db, awayFact);

	return { gameId, homeFact, awayFact, warnings };
}

/**
 * Compute facts for multiple games. Skips non-final games with a warning.
 */
export async function computeFactsForGames(
	db: Db,
	gameIds: string[],
): Promise<{ results: ComputeFactsResult[]; errors: string[] }> {
	const results: ComputeFactsResult[] = [];
	const errors: string[] = [];

	for (const gameId of gameIds) {
		try {
			const result = await computeFactsForGame(db, gameId);
			results.push(result);
		} catch (err) {
			errors.push(
				`${gameId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	return { results, errors };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface BuildTeamFactParams {
	game: Game;
	teamId: string;
	opponentId: string;
	venueRole: VenueRole;
	favDogRole: FavDogRole | undefined;
	teamScore: number;
	opponentScore: number;
	line: GameLine | null;
	isHome: boolean;
	gameTime: number;
}

function buildTeamFact(params: BuildTeamFactParams): UpsertTeamGameFactInput {
	const {
		game,
		teamId,
		opponentId,
		venueRole,
		favDogRole,
		teamScore,
		opponentScore,
		line,
		isHome,
		gameTime,
	} = params;

	const actualMargin = teamScore - opponentScore;
	const suResult = deriveSuResult(actualMargin);
	const actualTotal = teamScore + opponentScore;

	// ATS grading: use the team's spread from the closing line
	const spreadLine = deriveSpreadLine(line, isHome);
	const { coverMargin, atsResult } = deriveAtsResult(actualMargin, spreadLine);

	// OU grading
	const totalLine = line?.totalLine;
	const ouResult = deriveOuResult(actualTotal, totalLine);

	return {
		gameId: game.id,
		teamId,
		opponentId,
		venueRole,
		favDogRole,
		teamScore,
		opponentScore,
		actualMargin,
		suResult,
		spreadLine,
		coverMargin,
		atsResult,
		totalLine,
		actualTotal,
		ouResult,
		gameTime,
		sportTag: game.sportTag,
		season: game.season,
	};
}

/**
 * Derive SU result from actual margin.
 * Per grading-rules.md §2.1: win if margin > 0, loss if < 0.
 * Ties are treated as push (rare in most sports but possible).
 */
function deriveSuResult(actualMargin: number): PickResult {
	if (actualMargin > 0) return "win";
	if (actualMargin < 0) return "loss";
	return "push";
}

/**
 * Extract the spread line for a team.
 * home_spread is the spread for the home team (negative = home favored).
 * For the away team, the spread is the negation of home_spread.
 */
function deriveSpreadLine(
	line: GameLine | null,
	isHome: boolean,
): number | undefined {
	if (!line) return undefined;
	if (isHome) {
		return line.homeSpread;
	}
	// Away spread: if homeSpread is stored, away is its negation
	// If awaySpread is explicitly stored, prefer that
	if (line.awaySpread !== undefined) return line.awaySpread;
	if (line.homeSpread !== undefined) return -line.homeSpread;
	return undefined;
}

/**
 * Derive ATS result from actual margin and spread line.
 * Per grading-rules.md §2.2:
 *   cover_margin = actual_margin - spread_line
 *   cover if cover_margin > 0, push if = 0, no_cover if < 0
 *
 * NOTE: spread_line is from the team's perspective. A home favorite at -3.5
 * means they need to win by > 3.5 to cover.
 * actual_margin = team_score - opponent_score.
 * cover_margin = actual_margin - spread_line
 *   e.g. won by 7 with spread -3.5 → cover_margin = 7 - (-3.5) = 10.5 → cover
 *   e.g. won by 3 with spread -3.5 → cover_margin = 3 - (-3.5) = 6.5 → cover
 *   e.g. lost by 1 with spread -3.5 → cover_margin = -1 - (-3.5) = 2.5 → cover
 *   e.g. lost by 4 with spread -3.5 → cover_margin = -4 - (-3.5) = -0.5 → no_cover
 */
function deriveAtsResult(
	actualMargin: number,
	spreadLine: number | undefined,
): { coverMargin: number | undefined; atsResult: AtsResult | undefined } {
	if (spreadLine === undefined) {
		return { coverMargin: undefined, atsResult: undefined };
	}

	const coverMargin = actualMargin - spreadLine;
	let atsResult: AtsResult;
	if (coverMargin > 0) {
		atsResult = "cover";
	} else if (coverMargin === 0) {
		atsResult = "push";
	} else {
		atsResult = "no_cover";
	}

	return { coverMargin, atsResult };
}

/**
 * Derive OU result from actual total and total line.
 * Per grading-rules.md §2.3:
 *   over if actual_total > total_line, push if equal, under if < total_line
 *
 * Note: OU result is the same for both teams in a game (it's a game-level metric).
 */
function deriveOuResult(
	actualTotal: number,
	totalLine: number | undefined,
): OuResult | undefined {
	if (totalLine === undefined) return undefined;

	if (actualTotal > totalLine) return "over";
	if (actualTotal < totalLine) return "under";
	return "push";
}

/**
 * Derive favorite/dog roles from the closing line.
 * Per metric-definitions.md §Split Dimensions:
 *   - Favorite: team favored by canonical pregame game line
 *   - Dog: team is the underdog
 *   - Pickem: spread is 0 (PK)
 *
 * home_spread < 0 means home is favored (they're "giving" points).
 * home_spread > 0 means away is favored (home is "getting" points).
 * home_spread = 0 means pick'em.
 */
function deriveFavDogRoles(line: GameLine | null): {
	homeFavDog: FavDogRole | undefined;
	awayFavDog: FavDogRole | undefined;
} {
	if (!line || line.homeSpread === undefined) {
		return { homeFavDog: undefined, awayFavDog: undefined };
	}

	const spread = line.homeSpread;

	if (spread === 0) {
		return { homeFavDog: "pickem", awayFavDog: "pickem" };
	}

	if (spread < 0) {
		// Home is favored (negative spread = giving points)
		return { homeFavDog: "favorite", awayFavDog: "dog" };
	}

	// Home is underdog (positive spread = getting points)
	return { homeFavDog: "dog", awayFavDog: "favorite" };
}
