import type { Db } from "../db/client";
import { all, first, run } from "../db/client";
import { nowUnixSeconds } from "../env";
import type {
	TeamTrendSnapshot,
	TeamTrendSnapshotFilter,
	TeamTrendSnapshotRow,
	TrendSnapshotType,
} from "../types/canonical";

function parseRow(row: TeamTrendSnapshotRow): TeamTrendSnapshot {
	return {
		id: row.id,
		teamId: row.team_id,
		asOfGameId: row.as_of_game_id,
		asOfTime: row.as_of_time,
		sportTag: row.sport_tag,
		snapshotType: row.snapshot_type as TrendSnapshotType,
		windowSize: row.window_size,
		suWins: row.su_wins,
		suLosses: row.su_losses,
		suPushes: row.su_pushes,
		suWinPct: row.su_win_pct ?? undefined,
		atsWins: row.ats_wins,
		atsLosses: row.ats_losses,
		atsPushes: row.ats_pushes,
		atsWinPct: row.ats_win_pct ?? undefined,
		ouOvers: row.ou_overs,
		ouUnders: row.ou_unders,
		ouPushes: row.ou_pushes,
		ouOverPct: row.ou_over_pct ?? undefined,
		atsStreakType: (row.ats_streak_type as "W" | "L") ?? undefined,
		atsStreakLength: row.ats_streak_length,
		ouStreakType: (row.ou_streak_type as "W" | "L") ?? undefined,
		ouStreakLength: row.ou_streak_length,
		suStreakType: (row.su_streak_type as "W" | "L") ?? undefined,
		suStreakLength: row.su_streak_length,
		avgCoverMargin: row.avg_cover_margin ?? undefined,
		avgTotalMargin: row.avg_total_margin ?? undefined,
		createdAt: row.created_at,
	};
}

function generateId(): string {
	return `tts_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export interface UpsertTeamTrendSnapshotInput {
	teamId: string;
	asOfGameId: string;
	asOfTime: number;
	sportTag: string;
	snapshotType: TrendSnapshotType;
	windowSize?: number;
	suWins: number;
	suLosses: number;
	suPushes: number;
	atsWins: number;
	atsLosses: number;
	atsPushes: number;
	ouOvers: number;
	ouUnders: number;
	ouPushes: number;
	atsStreakType?: "W" | "L";
	atsStreakLength: number;
	ouStreakType?: "W" | "L";
	ouStreakLength: number;
	suStreakType?: "W" | "L";
	suStreakLength: number;
	avgCoverMargin?: number;
	avgTotalMargin?: number;
}

export async function upsertTeamTrendSnapshot(
	db: Db,
	input: UpsertTeamTrendSnapshotInput,
): Promise<TeamTrendSnapshot> {
	const now = nowUnixSeconds();
	const id = generateId();
	const windowSize = input.windowSize ?? 10;

	const suWinPct =
		input.suWins + input.suLosses > 0
			? input.suWins / (input.suWins + input.suLosses)
			: null;
	const atsWinPct =
		input.atsWins + input.atsLosses > 0
			? input.atsWins / (input.atsWins + input.atsLosses)
			: null;
	const ouOverPct =
		input.ouOvers + input.ouUnders > 0
			? input.ouOvers / (input.ouOvers + input.ouUnders)
			: null;

	await run(
		db,
		`INSERT INTO team_trend_snapshots (
			id, team_id, as_of_game_id, as_of_time,
			sport_tag, snapshot_type, window_size,
			su_wins, su_losses, su_pushes, su_win_pct,
			ats_wins, ats_losses, ats_pushes, ats_win_pct,
			ou_overs, ou_unders, ou_pushes, ou_over_pct,
			ats_streak_type, ats_streak_length,
			ou_streak_type, ou_streak_length,
			su_streak_type, su_streak_length,
			avg_cover_margin, avg_total_margin,
			created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(team_id, snapshot_type, as_of_game_id) DO UPDATE SET
			as_of_time = excluded.as_of_time,
			window_size = excluded.window_size,
			su_wins = excluded.su_wins,
			su_losses = excluded.su_losses,
			su_pushes = excluded.su_pushes,
			su_win_pct = excluded.su_win_pct,
			ats_wins = excluded.ats_wins,
			ats_losses = excluded.ats_losses,
			ats_pushes = excluded.ats_pushes,
			ats_win_pct = excluded.ats_win_pct,
			ou_overs = excluded.ou_overs,
			ou_unders = excluded.ou_unders,
			ou_pushes = excluded.ou_pushes,
			ou_over_pct = excluded.ou_over_pct,
			ats_streak_type = excluded.ats_streak_type,
			ats_streak_length = excluded.ats_streak_length,
			ou_streak_type = excluded.ou_streak_type,
			ou_streak_length = excluded.ou_streak_length,
			su_streak_type = excluded.su_streak_type,
			su_streak_length = excluded.su_streak_length,
			avg_cover_margin = excluded.avg_cover_margin,
			avg_total_margin = excluded.avg_total_margin`,
		id,
		input.teamId,
		input.asOfGameId,
		input.asOfTime,
		input.sportTag,
		input.snapshotType,
		windowSize,
		input.suWins,
		input.suLosses,
		input.suPushes,
		suWinPct,
		input.atsWins,
		input.atsLosses,
		input.atsPushes,
		atsWinPct,
		input.ouOvers,
		input.ouUnders,
		input.ouPushes,
		ouOverPct,
		input.atsStreakType ?? null,
		input.atsStreakLength,
		input.ouStreakType ?? null,
		input.ouStreakLength,
		input.suStreakType ?? null,
		input.suStreakLength,
		input.avgCoverMargin ?? null,
		input.avgTotalMargin ?? null,
		now,
	);

	const row = await first<TeamTrendSnapshotRow>(
		db,
		`SELECT * FROM team_trend_snapshots WHERE team_id = ? AND snapshot_type = ? AND as_of_game_id = ?`,
		input.teamId,
		input.snapshotType,
		input.asOfGameId,
	);
	if (!row)
		throw new Error(`Failed to upsert trend snapshot for team ${input.teamId}`);
	return parseRow(row);
}

/**
 * Get the most recent trend snapshot for a team, optionally filtered by
 * snapshot type, sport, and window size. Returns the absolute latest snapshot
 * matching the filter — not time-bounded. For pick-join lookups bounded by
 * pick time, use {@link getTeamTrendSnapshotAsOf} instead.
 */
export async function getLatestTeamTrendSnapshot(
	db: Db,
	filter: TeamTrendSnapshotFilter,
): Promise<TeamTrendSnapshot | null> {
	const where: string[] = [`team_id = ?`];
	const params: unknown[] = [filter.teamId];

	if (filter.snapshotType) {
		where.push(`snapshot_type = ?`);
		params.push(filter.snapshotType);
	}
	if (filter.sportTag) {
		where.push(`sport_tag = ?`);
		params.push(filter.sportTag);
	}
	if (filter.windowSize) {
		where.push(`window_size = ?`);
		params.push(filter.windowSize);
	}

	const row = await first<TeamTrendSnapshotRow>(
		db,
		`SELECT * FROM team_trend_snapshots
		WHERE ${where.join(" AND ")}
		ORDER BY as_of_time DESC
		LIMIT 1`,
		...params,
	);
	return row ? parseRow(row) : null;
}

/**
 * Get the trend snapshot for a team as of a specific game.
 * Used to join trend context to a pick at decision time.
 */
export async function getTeamTrendSnapshotAtGame(
	db: Db,
	teamId: string,
	gameId: string,
	snapshotType: TrendSnapshotType,
): Promise<TeamTrendSnapshot | null> {
	const row = await first<TeamTrendSnapshotRow>(
		db,
		`SELECT * FROM team_trend_snapshots
		WHERE team_id = ? AND as_of_game_id = ? AND snapshot_type = ?`,
		teamId,
		gameId,
		snapshotType,
	);
	return row ? parseRow(row) : null;
}

/**
 * Get the most recent trend snapshot for a team at or before a given time.
 * This is the canonical lookup for attaching trend context to picks —
 * it finds the snapshot that was current when a pick was made.
 *
 * SQL: snapshot_type = ? AND as_of_time < ? ORDER BY as_of_time DESC LIMIT 1
 *
 * Strictly-before comparison: snapshots are stamped with the game time of the
 * last game they INCLUDE, so an equal timestamp would hand back a snapshot
 * containing that game's own result.
 */
export async function getTeamTrendSnapshotAsOf(
	db: Db,
	teamId: string,
	snapshotType: TrendSnapshotType,
	asOfTime: number,
): Promise<TeamTrendSnapshot | null> {
	const row = await first<TeamTrendSnapshotRow>(
		db,
		`SELECT * FROM team_trend_snapshots
		WHERE team_id = ? AND snapshot_type = ? AND as_of_time < ?
		ORDER BY as_of_time DESC
		LIMIT 1`,
		teamId,
		snapshotType,
		asOfTime,
	);
	return row ? parseRow(row) : null;
}

/**
 * List all trend snapshots for a team.
 * Access pattern: "compare team and opponent recent splits for a matchup"
 */
export async function listTeamTrendSnapshots(
	db: Db,
	teamId: string,
	options?: { sportTag?: string; snapshotType?: TrendSnapshotType },
): Promise<TeamTrendSnapshot[]> {
	const where: string[] = [`team_id = ?`];
	const params: unknown[] = [teamId];

	if (options?.sportTag) {
		where.push(`sport_tag = ?`);
		params.push(options.sportTag);
	}
	if (options?.snapshotType) {
		where.push(`snapshot_type = ?`);
		params.push(options.snapshotType);
	}

	const rows = await all<TeamTrendSnapshotRow>(
		db,
		`SELECT * FROM team_trend_snapshots
		WHERE ${where.join(" AND ")}
		ORDER BY snapshot_type ASC, as_of_time DESC`,
		...params,
	);
	return rows.map(parseRow);
}

/**
 * Get trend snapshots for both teams in a matchup for comparison.
 */
export async function getMatchupTrendSnapshots(
	db: Db,
	teamId: string,
	opponentId: string,
	sportTag: string,
): Promise<{
	team: TeamTrendSnapshot[];
	opponent: TeamTrendSnapshot[];
}> {
	const [team, opponent] = await Promise.all([
		listTeamTrendSnapshots(db, teamId, { sportTag }),
		listTeamTrendSnapshots(db, opponentId, { sportTag }),
	]);

	return { team, opponent };
}

/**
 * Delete snapshots for a team (useful when recomputing).
 */
export async function deleteTeamTrendSnapshots(
	db: Db,
	teamId: string,
	sportTag?: string,
): Promise<void> {
	if (sportTag) {
		await run(
			db,
			`DELETE FROM team_trend_snapshots WHERE team_id = ? AND sport_tag = ?`,
			teamId,
			sportTag,
		);
	} else {
		await run(db, `DELETE FROM team_trend_snapshots WHERE team_id = ?`, teamId);
	}
}
