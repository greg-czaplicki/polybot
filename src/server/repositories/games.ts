import type { Db } from "../db/client";
import { all, first, run } from "../db/client";
import { nowUnixSeconds } from "../env";
import type { Game, GameRow, GameStatus } from "../types/canonical";

function parseRow(row: GameRow): Game {
	return {
		id: row.id,
		externalId: row.external_id ?? undefined,
		sportTag: row.sport_tag,
		season: row.season ?? undefined,
		gameDate: row.game_date,
		homeTeamId: row.home_team_id,
		awayTeamId: row.away_team_id,
		venue: row.venue ?? undefined,
		isNeutralSite: row.is_neutral_site === 1,
		status: row.status as GameStatus,
		homeScore: row.home_score ?? undefined,
		awayScore: row.away_score ?? undefined,
		totalScore: row.total_score ?? undefined,
		isOvertime: row.is_overtime === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function generateId(): string {
	return `game_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export interface CreateGameInput {
	externalId?: string;
	sportTag: string;
	season?: string;
	gameDate: string;
	homeTeamId: string;
	awayTeamId: string;
	venue?: string;
	isNeutralSite?: boolean;
}

export interface UpdateGameResultInput {
	homeScore: number;
	awayScore: number;
	isOvertime?: boolean;
	status?: GameStatus;
}

export async function createGame(
	db: Db,
	input: CreateGameInput,
): Promise<Game> {
	const now = nowUnixSeconds();
	const id = generateId();

	await run(
		db,
		`INSERT INTO games (
			id, external_id, sport_tag, season, game_date,
			home_team_id, away_team_id, venue, is_neutral_site,
			status, home_score, away_score, total_score, is_overtime,
			created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?)`,
		id,
		input.externalId ?? null,
		input.sportTag,
		input.season ?? null,
		input.gameDate,
		input.homeTeamId,
		input.awayTeamId,
		input.venue ?? null,
		input.isNeutralSite ? 1 : 0,
		"scheduled",
		now,
		now,
	);

	const row = await first<GameRow>(db, `SELECT * FROM games WHERE id = ?`, id);
	if (!row) throw new Error(`Failed to create game: ${id}`);
	return parseRow(row);
}

export async function upsertGameByExternalId(
	db: Db,
	input: CreateGameInput & { externalId: string },
): Promise<Game> {
	const now = nowUnixSeconds();
	const id = generateId();

	await run(
		db,
		`INSERT INTO games (
			id, external_id, sport_tag, season, game_date,
			home_team_id, away_team_id, venue, is_neutral_site,
			status, home_score, away_score, total_score, is_overtime,
			created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?)
		ON CONFLICT(external_id) DO UPDATE SET
			sport_tag = excluded.sport_tag,
			season = COALESCE(excluded.season, games.season),
			game_date = excluded.game_date,
			home_team_id = excluded.home_team_id,
			away_team_id = excluded.away_team_id,
			venue = COALESCE(excluded.venue, games.venue),
			is_neutral_site = excluded.is_neutral_site,
			updated_at = excluded.updated_at`,
		id,
		input.externalId,
		input.sportTag,
		input.season ?? null,
		input.gameDate,
		input.homeTeamId,
		input.awayTeamId,
		input.venue ?? null,
		input.isNeutralSite ? 1 : 0,
		"scheduled",
		now,
		now,
	);

	const row = await first<GameRow>(
		db,
		`SELECT * FROM games WHERE external_id = ?`,
		input.externalId,
	);
	if (!row) throw new Error(`Failed to upsert game: ${input.externalId}`);
	return parseRow(row);
}

export async function updateGameResult(
	db: Db,
	gameId: string,
	input: UpdateGameResultInput,
): Promise<void> {
	const now = nowUnixSeconds();
	const totalScore = input.homeScore + input.awayScore;
	const status = input.status ?? "final";

	await run(
		db,
		`UPDATE games SET
			home_score = ?,
			away_score = ?,
			total_score = ?,
			is_overtime = ?,
			status = ?,
			updated_at = ?
		WHERE id = ?`,
		input.homeScore,
		input.awayScore,
		totalScore,
		input.isOvertime ? 1 : 0,
		status,
		now,
		gameId,
	);
}

export async function getGameById(db: Db, id: string): Promise<Game | null> {
	const row = await first<GameRow>(db, `SELECT * FROM games WHERE id = ?`, id);
	return row ? parseRow(row) : null;
}

export async function getGameByExternalId(
	db: Db,
	externalId: string,
): Promise<Game | null> {
	const row = await first<GameRow>(
		db,
		`SELECT * FROM games WHERE external_id = ?`,
		externalId,
	);
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
		`SELECT * FROM games WHERE ${where.join(" AND ")} ORDER BY game_date DESC LIMIT ?`,
		...params,
	);
	return rows.map(parseRow);
}

export async function listGamesByDate(
	db: Db,
	date: string,
	sportTag?: string,
): Promise<Game[]> {
	if (sportTag) {
		const rows = await all<GameRow>(
			db,
			`SELECT * FROM games WHERE game_date = ? AND sport_tag = ? ORDER BY home_team_id ASC`,
			date,
			sportTag,
		);
		return rows.map(parseRow);
	}
	const rows = await all<GameRow>(
		db,
		`SELECT * FROM games WHERE game_date = ? ORDER BY sport_tag ASC, home_team_id ASC`,
		date,
	);
	return rows.map(parseRow);
}
