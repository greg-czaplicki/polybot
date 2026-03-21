import type { Db } from "../db/client";
import { all, first, run } from "../db/client";
import { nowUnixSeconds } from "../env";
import type {
	GameLine,
	GameLineRow,
	LineSnapshot,
	LineType,
} from "../types/canonical";

function parseRow(row: GameLineRow): GameLine {
	return {
		id: row.id,
		gameId: row.game_id,
		lineType: row.line_type as LineType,
		snapshot: row.snapshot as LineSnapshot,
		homeValue: row.home_value ?? undefined,
		awayValue: row.away_value ?? undefined,
		totalValue: row.total_value ?? undefined,
		source: row.source ?? undefined,
		recordedAt: row.recorded_at,
		createdAt: row.created_at,
	};
}

function generateId(): string {
	return `gl_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export interface UpsertGameLineInput {
	gameId: string;
	lineType: LineType;
	snapshot: LineSnapshot;
	homeValue?: number;
	awayValue?: number;
	totalValue?: number;
	source?: string;
	recordedAt?: number;
}

export async function upsertGameLine(
	db: Db,
	input: UpsertGameLineInput,
): Promise<GameLine> {
	const now = nowUnixSeconds();
	const id = generateId();
	const recordedAt = input.recordedAt ?? now;

	await run(
		db,
		`INSERT INTO game_lines (
			id, game_id, line_type, snapshot,
			home_value, away_value, total_value,
			source, recorded_at, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(game_id, line_type, snapshot) DO UPDATE SET
			home_value = excluded.home_value,
			away_value = excluded.away_value,
			total_value = excluded.total_value,
			source = COALESCE(excluded.source, game_lines.source),
			recorded_at = excluded.recorded_at`,
		id,
		input.gameId,
		input.lineType,
		input.snapshot,
		input.homeValue ?? null,
		input.awayValue ?? null,
		input.totalValue ?? null,
		input.source ?? null,
		recordedAt,
		now,
	);

	const row = await first<GameLineRow>(
		db,
		`SELECT * FROM game_lines WHERE game_id = ? AND line_type = ? AND snapshot = ?`,
		input.gameId,
		input.lineType,
		input.snapshot,
	);
	if (!row)
		throw new Error(`Failed to upsert game line for game ${input.gameId}`);
	return parseRow(row);
}

export async function getGameLines(
	db: Db,
	gameId: string,
): Promise<GameLine[]> {
	const rows = await all<GameLineRow>(
		db,
		`SELECT * FROM game_lines WHERE game_id = ? ORDER BY line_type ASC, snapshot ASC`,
		gameId,
	);
	return rows.map(parseRow);
}

export async function getGameLine(
	db: Db,
	gameId: string,
	lineType: LineType,
	snapshot: LineSnapshot,
): Promise<GameLine | null> {
	const row = await first<GameLineRow>(
		db,
		`SELECT * FROM game_lines WHERE game_id = ? AND line_type = ? AND snapshot = ?`,
		gameId,
		lineType,
		snapshot,
	);
	return row ? parseRow(row) : null;
}

/**
 * Get the closing spread for a game, used for ATS grading and fav/dog classification.
 * Returns the home team's spread value (negative = home favored).
 */
export async function getClosingSpread(
	db: Db,
	gameId: string,
): Promise<number | null> {
	const line = await getGameLine(db, gameId, "spread", "close");
	return line?.homeValue ?? null;
}

/**
 * Get the closing total for a game, used for OU grading.
 */
export async function getClosingTotal(
	db: Db,
	gameId: string,
): Promise<number | null> {
	const line = await getGameLine(db, gameId, "total", "close");
	return line?.totalValue ?? null;
}
