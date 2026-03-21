import type { Db } from "../db/client";
import { all, first, run } from "../db/client";
import { nowUnixSeconds } from "../env";
import type { Game, GameRow } from "../types/canonical";

function parseRow(row: GameRow): Game {
	return {
		id: row.id,
		sportTag: row.sport_tag,
		season: row.season ?? undefined,
		seasonType: row.season_type ?? undefined,
		week: row.week ?? undefined,
		gameTime: row.game_time ?? undefined,
		homeTeamId: row.home_team_id,
		awayTeamId: row.away_team_id,
		neutralSite: row.neutral_site === 1,
		homeScore: row.home_score ?? undefined,
		awayScore: row.away_score ?? undefined,
		totalScore: row.total_score ?? undefined,
		isFinal: row.is_final === 1,
		wentToOt: row.went_to_ot === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function generateId(): string {
	return `game_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export interface CreateGameInput {
	id?: string;
	sportTag: string;
	season?: string;
	seasonType?: string;
	week?: string;
	gameTime?: number;
	homeTeamId: string;
	awayTeamId: string;
	neutralSite?: boolean;
}

export interface UpdateGameResultInput {
	homeScore: number;
	awayScore: number;
	wentToOt?: boolean;
}

export async function createGame(
	db: Db,
	input: CreateGameInput,
): Promise<Game> {
	const now = nowUnixSeconds();
	const id = input.id ?? generateId();

	await run(
		db,
		`INSERT INTO games (
			id, sport_tag, season, season_type, week, game_time,
			home_team_id, away_team_id, neutral_site,
			home_score, away_score, total_score,
			is_final, went_to_ot, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, 0, ?, ?)`,
		id,
		input.sportTag,
		input.season ?? null,
		input.seasonType ?? null,
		input.week ?? null,
		input.gameTime ?? null,
		input.homeTeamId,
		input.awayTeamId,
		input.neutralSite ? 1 : 0,
		now,
		now,
	);

	const row = await first<GameRow>(db, `SELECT * FROM games WHERE id = ?`, id);
	if (!row) throw new Error(`Failed to create game: ${id}`);
	return parseRow(row);
}

export async function updateGameResult(
	db: Db,
	gameId: string,
	input: UpdateGameResultInput,
): Promise<void> {
	const now = nowUnixSeconds();
	const totalScore = input.homeScore + input.awayScore;

	await run(
		db,
		`UPDATE games SET
			home_score = ?,
			away_score = ?,
			total_score = ?,
			is_final = 1,
			went_to_ot = ?,
			updated_at = ?
		WHERE id = ?`,
		input.homeScore,
		input.awayScore,
		totalScore,
		input.wentToOt ? 1 : 0,
		now,
		gameId,
	);
}

export async function getGameById(db: Db, id: string): Promise<Game | null> {
	const row = await first<GameRow>(db, `SELECT * FROM games WHERE id = ?`, id);
	return row ? parseRow(row) : null;
}

export async function listGamesByTeam(
	db: Db,
	teamId: string,
	options?: { sportTag?: string; season?: string; limit?: number },
): Promise<Game[]> {
	const { sportTag, season, limit = 50 } = options ?? {};
	const where: string[] = [`(home_team_id = ? OR away_team_id = ?)`];
	const params: unknown[] = [teamId, teamId];

	if (sportTag) {
		where.push(`sport_tag = ?`);
		params.push(sportTag);
	}
	if (season) {
		where.push(`season = ?`);
		params.push(season);
	}

	params.push(limit);

	const rows = await all<GameRow>(
		db,
		`SELECT * FROM games WHERE ${where.join(" AND ")} ORDER BY game_time DESC LIMIT ?`,
		...params,
	);
	return rows.map(parseRow);
}

export async function listGamesBySportAndSeason(
	db: Db,
	sportTag: string,
	season?: string,
	limit?: number,
): Promise<Game[]> {
	if (season) {
		const rows = await all<GameRow>(
			db,
			`SELECT * FROM games WHERE sport_tag = ? AND season = ? ORDER BY game_time DESC LIMIT ?`,
			sportTag,
			season,
			limit ?? 100,
		);
		return rows.map(parseRow);
	}
	const rows = await all<GameRow>(
		db,
		`SELECT * FROM games WHERE sport_tag = ? ORDER BY game_time DESC LIMIT ?`,
		sportTag,
		limit ?? 100,
	);
	return rows.map(parseRow);
}
