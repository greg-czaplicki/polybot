import type { Db } from "../db/client";
import { all, first, run } from "../db/client";
import { nowUnixSeconds } from "../env";
import type { GameLine, GameLineRow, SnapshotType } from "../types/canonical";

function parseRow(row: GameLineRow): GameLine {
	return {
		id: row.id,
		gameId: row.game_id,
		source: row.source,
		snapshotType: row.snapshot_type as SnapshotType,
		homeSpread: row.home_spread ?? undefined,
		awaySpread: row.away_spread ?? undefined,
		totalLine: row.total_line ?? undefined,
		homeMoneyline: row.home_moneyline ?? undefined,
		awayMoneyline: row.away_moneyline ?? undefined,
		recordedAt: row.recorded_at,
		createdAt: row.created_at,
	};
}

function generateId(): string {
	return `gl_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export interface UpsertGameLineInput {
	gameId: string;
	snapshotType: SnapshotType;
	source?: string;
	homeSpread?: number;
	awaySpread?: number;
	totalLine?: number;
	homeMoneyline?: number;
	awayMoneyline?: number;
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
			id, game_id, source, snapshot_type,
			home_spread, away_spread, total_line,
			home_moneyline, away_moneyline,
			recorded_at, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(game_id, snapshot_type) DO UPDATE SET
			source = excluded.source,
			home_spread = excluded.home_spread,
			away_spread = excluded.away_spread,
			total_line = excluded.total_line,
			home_moneyline = excluded.home_moneyline,
			away_moneyline = excluded.away_moneyline,
			recorded_at = excluded.recorded_at`,
		id,
		input.gameId,
		input.source ?? "consensus",
		input.snapshotType,
		input.homeSpread ?? null,
		input.awaySpread ?? null,
		input.totalLine ?? null,
		input.homeMoneyline ?? null,
		input.awayMoneyline ?? null,
		recordedAt,
		now,
	);

	const row = await first<GameLineRow>(
		db,
		`SELECT * FROM game_lines WHERE game_id = ? AND snapshot_type = ?`,
		input.gameId,
		input.snapshotType,
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
		`SELECT * FROM game_lines WHERE game_id = ? ORDER BY snapshot_type ASC`,
		gameId,
	);
	return rows.map(parseRow);
}

export async function getGameLine(
	db: Db,
	gameId: string,
	snapshotType: SnapshotType,
): Promise<GameLine | null> {
	const row = await first<GameLineRow>(
		db,
		`SELECT * FROM game_lines WHERE game_id = ? AND snapshot_type = ?`,
		gameId,
		snapshotType,
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
	const line = await getGameLine(db, gameId, "close");
	return line?.homeSpread ?? null;
}

/**
 * Get the closing total for a game, used for OU grading.
 */
export async function getClosingTotal(
	db: Db,
	gameId: string,
): Promise<number | null> {
	const line = await getGameLine(db, gameId, "close");
	return line?.totalLine ?? null;
}
