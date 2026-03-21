import type { Db } from "../db/client";
import { all, first, run } from "../db/client";
import { nowUnixSeconds } from "../env";
import type {
	FavDogRole,
	TeamTrendSnapshot,
	TeamTrendSnapshotFilter,
	TeamTrendSnapshotRow,
	VenueRole,
} from "../types/canonical";

function parseRow(row: TeamTrendSnapshotRow): TeamTrendSnapshot {
	return {
		id: row.id,
		teamId: row.team_id,
		sportTag: row.sport_tag,
		season: row.season ?? undefined,
		windowSize: row.window_size,
		scope: row.scope,
		venueFilter: (row.venue_filter as VenueRole) ?? undefined,
		favDogFilter: (row.fav_dog_filter as FavDogRole) ?? undefined,
		suWins: row.su_wins,
		suLosses: row.su_losses,
		suPushes: row.su_pushes,
		suWinPct: row.su_win_pct ?? undefined,
		atsWins: row.ats_wins,
		atsLosses: row.ats_losses,
		atsPushes: row.ats_pushes,
		atsWinPct: row.ats_win_pct ?? undefined,
		ouWins: row.ou_wins,
		ouLosses: row.ou_losses,
		ouPushes: row.ou_pushes,
		ouWinPct: row.ou_win_pct ?? undefined,
		atsStreakType: (row.ats_streak_type as "W" | "L") ?? undefined,
		atsStreakLength: row.ats_streak_length,
		ouStreakType: (row.ou_streak_type as "W" | "L") ?? undefined,
		ouStreakLength: row.ou_streak_length,
		suStreakType: (row.su_streak_type as "W" | "L") ?? undefined,
		suStreakLength: row.su_streak_length,
		computedAt: row.computed_at,
		gameIds: row.game_ids_json
			? (JSON.parse(row.game_ids_json) as string[])
			: [],
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function generateId(): string {
	return `tts_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Build a unique scope key for snapshot deduplication.
 * Format: "last{windowSize}_{venueFilter}_{favDogFilter}" or "last10_home_favorite"
 */
function buildScopeKey(
	windowSize: number,
	venueFilter?: VenueRole,
	favDogFilter?: FavDogRole,
): string {
	const parts = [`last${windowSize}`];
	if (venueFilter) parts.push(venueFilter);
	if (favDogFilter) parts.push(favDogFilter);
	return parts.join("_");
}

export interface UpsertTeamTrendSnapshotInput {
	teamId: string;
	sportTag: string;
	season?: string;
	windowSize: number;
	venueFilter?: VenueRole;
	favDogFilter?: FavDogRole;
	suWins: number;
	suLosses: number;
	suPushes: number;
	atsWins: number;
	atsLosses: number;
	atsPushes: number;
	ouWins: number;
	ouLosses: number;
	ouPushes: number;
	atsStreakType?: "W" | "L";
	atsStreakLength: number;
	ouStreakType?: "W" | "L";
	ouStreakLength: number;
	suStreakType?: "W" | "L";
	suStreakLength: number;
	gameIds: string[];
}

export async function upsertTeamTrendSnapshot(
	db: Db,
	input: UpsertTeamTrendSnapshotInput,
): Promise<TeamTrendSnapshot> {
	const now = nowUnixSeconds();
	const id = generateId();
	const scope = buildScopeKey(
		input.windowSize,
		input.venueFilter,
		input.favDogFilter,
	);

	const suWinPct =
		input.suWins + input.suLosses > 0
			? input.suWins / (input.suWins + input.suLosses)
			: null;
	const atsWinPct =
		input.atsWins + input.atsLosses > 0
			? input.atsWins / (input.atsWins + input.atsLosses)
			: null;
	const ouWinPct =
		input.ouWins + input.ouLosses > 0
			? input.ouWins / (input.ouWins + input.ouLosses)
			: null;

	await run(
		db,
		`INSERT INTO team_trend_snapshots (
			id, team_id, sport_tag, season, window_size, scope,
			venue_filter, fav_dog_filter,
			su_wins, su_losses, su_pushes, su_win_pct,
			ats_wins, ats_losses, ats_pushes, ats_win_pct,
			ou_wins, ou_losses, ou_pushes, ou_win_pct,
			ats_streak_type, ats_streak_length,
			ou_streak_type, ou_streak_length,
			su_streak_type, su_streak_length,
			computed_at, game_ids_json,
			created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(team_id, sport_tag, scope) DO UPDATE SET
			season = excluded.season,
			su_wins = excluded.su_wins,
			su_losses = excluded.su_losses,
			su_pushes = excluded.su_pushes,
			su_win_pct = excluded.su_win_pct,
			ats_wins = excluded.ats_wins,
			ats_losses = excluded.ats_losses,
			ats_pushes = excluded.ats_pushes,
			ats_win_pct = excluded.ats_win_pct,
			ou_wins = excluded.ou_wins,
			ou_losses = excluded.ou_losses,
			ou_pushes = excluded.ou_pushes,
			ou_win_pct = excluded.ou_win_pct,
			ats_streak_type = excluded.ats_streak_type,
			ats_streak_length = excluded.ats_streak_length,
			ou_streak_type = excluded.ou_streak_type,
			ou_streak_length = excluded.ou_streak_length,
			su_streak_type = excluded.su_streak_type,
			su_streak_length = excluded.su_streak_length,
			computed_at = excluded.computed_at,
			game_ids_json = excluded.game_ids_json,
			updated_at = excluded.updated_at`,
		id,
		input.teamId,
		input.sportTag,
		input.season ?? null,
		input.windowSize,
		scope,
		input.venueFilter ?? null,
		input.favDogFilter ?? null,
		input.suWins,
		input.suLosses,
		input.suPushes,
		suWinPct,
		input.atsWins,
		input.atsLosses,
		input.atsPushes,
		atsWinPct,
		input.ouWins,
		input.ouLosses,
		input.ouPushes,
		ouWinPct,
		input.atsStreakType ?? null,
		input.atsStreakLength,
		input.ouStreakType ?? null,
		input.ouStreakLength,
		input.suStreakType ?? null,
		input.suStreakLength,
		now,
		input.gameIds.length > 0 ? JSON.stringify(input.gameIds) : null,
		now,
		now,
	);

	const row = await first<TeamTrendSnapshotRow>(
		db,
		`SELECT * FROM team_trend_snapshots WHERE team_id = ? AND sport_tag = ? AND scope = ?`,
		input.teamId,
		input.sportTag,
		scope,
	);
	if (!row)
		throw new Error(`Failed to upsert trend snapshot for team ${input.teamId}`);
	return parseRow(row);
}

/**
 * Get a specific trend snapshot for a team.
 * Primary access pattern: "join team trend snapshot to a pick by game/team/time"
 */
export async function getTeamTrendSnapshot(
	db: Db,
	filter: TeamTrendSnapshotFilter,
): Promise<TeamTrendSnapshot | null> {
	const scope = buildScopeKey(
		filter.windowSize ?? 10,
		filter.venueFilter,
		filter.favDogFilter,
	);

	const where: string[] = [`team_id = ?`, `scope = ?`];
	const params: unknown[] = [filter.teamId, scope];

	if (filter.sportTag) {
		where.push(`sport_tag = ?`);
		params.push(filter.sportTag);
	}

	const row = await first<TeamTrendSnapshotRow>(
		db,
		`SELECT * FROM team_trend_snapshots WHERE ${where.join(" AND ")}`,
		...params,
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
	options?: { sportTag?: string; season?: string },
): Promise<TeamTrendSnapshot[]> {
	const where: string[] = [`team_id = ?`];
	const params: unknown[] = [teamId];

	if (options?.sportTag) {
		where.push(`sport_tag = ?`);
		params.push(options.sportTag);
	}
	if (options?.season) {
		where.push(`season = ?`);
		params.push(options.season);
	}

	const rows = await all<TeamTrendSnapshotRow>(
		db,
		`SELECT * FROM team_trend_snapshots WHERE ${where.join(" AND ")} ORDER BY scope ASC`,
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
	windowSize?: number,
): Promise<{
	team: TeamTrendSnapshot[];
	opponent: TeamTrendSnapshot[];
}> {
	const [team, opponent] = await Promise.all([
		listTeamTrendSnapshots(db, teamId, { sportTag }),
		listTeamTrendSnapshots(db, opponentId, { sportTag }),
	]);

	const filterByWindow = (snapshots: TeamTrendSnapshot[]) =>
		windowSize
			? snapshots.filter((s) => s.windowSize === windowSize)
			: snapshots;

	return {
		team: filterByWindow(team),
		opponent: filterByWindow(opponent),
	};
}

/**
 * Delete old snapshots for a team (useful when recomputing).
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
