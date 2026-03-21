import type { Db } from "../db/client";
import { all, first, run } from "../db/client";
import { nowUnixSeconds } from "../env";
import type {
	AtsResult,
	FavDogRole,
	OuResult,
	PickResult,
	TeamGameFact,
	TeamGameFactFilter,
	TeamGameFactRow,
	VenueRole,
} from "../types/canonical";

function parseRow(row: TeamGameFactRow): TeamGameFact {
	return {
		id: row.id,
		gameId: row.game_id,
		teamId: row.team_id,
		opponentId: row.opponent_id,
		venueRole: row.venue_role as VenueRole,
		favDogRole: (row.fav_dog_role as FavDogRole) ?? undefined,
		teamScore: row.team_score ?? undefined,
		opponentScore: row.opponent_score ?? undefined,
		actualMargin: row.actual_margin ?? undefined,
		suResult: (row.su_result as PickResult) ?? undefined,
		spreadLine: row.spread_line ?? undefined,
		coverMargin: row.cover_margin ?? undefined,
		atsResult: (row.ats_result as AtsResult) ?? undefined,
		totalLine: row.total_line ?? undefined,
		actualTotal: row.actual_total ?? undefined,
		ouResult: (row.ou_result as OuResult) ?? undefined,
		gameTime: row.game_time,
		sportTag: row.sport_tag,
		season: row.season ?? undefined,
		createdAt: row.created_at,
	};
}

function generateId(): string {
	return `tgf_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export interface UpsertTeamGameFactInput {
	gameId: string;
	teamId: string;
	opponentId: string;
	venueRole: VenueRole;
	favDogRole?: FavDogRole;
	teamScore?: number;
	opponentScore?: number;
	actualMargin?: number;
	suResult?: PickResult;
	spreadLine?: number;
	coverMargin?: number;
	atsResult?: AtsResult;
	totalLine?: number;
	actualTotal?: number;
	ouResult?: OuResult;
	gameTime: number;
	sportTag: string;
	season?: string;
}

export async function upsertTeamGameFact(
	db: Db,
	input: UpsertTeamGameFactInput,
): Promise<TeamGameFact> {
	const now = nowUnixSeconds();
	const id = generateId();

	await run(
		db,
		`INSERT INTO team_game_facts (
			id, game_id, team_id, opponent_id,
			venue_role, fav_dog_role,
			team_score, opponent_score, actual_margin,
			su_result, spread_line, cover_margin, ats_result,
			total_line, actual_total, ou_result,
			game_time, sport_tag, season,
			created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(game_id, team_id) DO UPDATE SET
			opponent_id = excluded.opponent_id,
			venue_role = excluded.venue_role,
			fav_dog_role = COALESCE(excluded.fav_dog_role, team_game_facts.fav_dog_role),
			team_score = COALESCE(excluded.team_score, team_game_facts.team_score),
			opponent_score = COALESCE(excluded.opponent_score, team_game_facts.opponent_score),
			actual_margin = COALESCE(excluded.actual_margin, team_game_facts.actual_margin),
			su_result = COALESCE(excluded.su_result, team_game_facts.su_result),
			spread_line = COALESCE(excluded.spread_line, team_game_facts.spread_line),
			cover_margin = COALESCE(excluded.cover_margin, team_game_facts.cover_margin),
			ats_result = COALESCE(excluded.ats_result, team_game_facts.ats_result),
			total_line = COALESCE(excluded.total_line, team_game_facts.total_line),
			actual_total = COALESCE(excluded.actual_total, team_game_facts.actual_total),
			ou_result = COALESCE(excluded.ou_result, team_game_facts.ou_result)`,
		id,
		input.gameId,
		input.teamId,
		input.opponentId,
		input.venueRole,
		input.favDogRole ?? null,
		input.teamScore ?? null,
		input.opponentScore ?? null,
		input.actualMargin ?? null,
		input.suResult ?? null,
		input.spreadLine ?? null,
		input.coverMargin ?? null,
		input.atsResult ?? null,
		input.totalLine ?? null,
		input.actualTotal ?? null,
		input.ouResult ?? null,
		input.gameTime,
		input.sportTag,
		input.season ?? null,
		now,
	);

	const row = await first<TeamGameFactRow>(
		db,
		`SELECT * FROM team_game_facts WHERE team_id = ? AND game_id = ?`,
		input.teamId,
		input.gameId,
	);
	if (!row)
		throw new Error(
			`Failed to upsert team game fact: ${input.teamId}/${input.gameId}`,
		);
	return parseRow(row);
}

/**
 * Query team game facts with filters. Primary access pattern for building trend stats.
 *
 * Supports queries like:
 * - "Michigan last 10 as home favorite ATS"
 * - "Saint Louis last 10 as away underdog OU"
 */
export async function listTeamGameFacts(
	db: Db,
	filter: TeamGameFactFilter,
): Promise<TeamGameFact[]> {
	const where: string[] = [`team_id = ?`];
	const params: unknown[] = [filter.teamId];

	if (filter.sportTag) {
		where.push(`sport_tag = ?`);
		params.push(filter.sportTag);
	}
	if (filter.season) {
		where.push(`season = ?`);
		params.push(filter.season);
	}
	if (filter.venueRole) {
		where.push(`venue_role = ?`);
		params.push(filter.venueRole);
	}
	if (filter.favDogRole) {
		where.push(`fav_dog_role = ?`);
		params.push(filter.favDogRole);
	}
	if (filter.beforeGameTime) {
		where.push(`game_time < ?`);
		params.push(filter.beforeGameTime);
	}

	const limit = filter.limit ?? 10;
	params.push(limit);

	const rows = await all<TeamGameFactRow>(
		db,
		`SELECT * FROM team_game_facts
		WHERE ${where.join(" AND ")}
		ORDER BY game_time DESC
		LIMIT ?`,
		...params,
	);
	return rows.map(parseRow);
}

export async function getTeamGameFact(
	db: Db,
	teamId: string,
	gameId: string,
): Promise<TeamGameFact | null> {
	const row = await first<TeamGameFactRow>(
		db,
		`SELECT * FROM team_game_facts WHERE team_id = ? AND game_id = ?`,
		teamId,
		gameId,
	);
	return row ? parseRow(row) : null;
}

/**
 * Get the current streak for a team in a given context.
 * Walks backward from most recent, skipping pushes per spec (grading-rules.md §6).
 */
export async function getTeamStreak(
	db: Db,
	teamId: string,
	metric: "su" | "ats" | "ou",
	options?: {
		sportTag?: string;
		venueRole?: VenueRole;
		favDogRole?: FavDogRole;
	},
): Promise<{ type: "W" | "L"; length: number } | null> {
	const where: string[] = [`team_id = ?`];
	const params: unknown[] = [teamId];

	const resultCol =
		metric === "su"
			? "su_result"
			: metric === "ats"
				? "ats_result"
				: "ou_result";

	where.push(`${resultCol} IS NOT NULL`);
	where.push(`${resultCol} != 'push'`);

	if (options?.sportTag) {
		where.push(`sport_tag = ?`);
		params.push(options.sportTag);
	}
	if (options?.venueRole) {
		where.push(`venue_role = ?`);
		params.push(options.venueRole);
	}
	if (options?.favDogRole) {
		where.push(`fav_dog_role = ?`);
		params.push(options.favDogRole);
	}

	const rows = await all<TeamGameFactRow>(
		db,
		`SELECT * FROM team_game_facts
		WHERE ${where.join(" AND ")}
		ORDER BY game_time DESC
		LIMIT 50`,
		...params,
	);

	if (rows.length === 0) return null;

	const facts = rows.map(parseRow);

	// For SU/ATS, streaks are W (win/cover) or L (loss/no_cover).
	// For OU, streaks track consecutive overs ("W") or unders ("L").
	const getStreakDirection = (fact: TeamGameFact): "W" | "L" | null => {
		if (metric === "su") {
			if (fact.suResult === "win") return "W";
			if (fact.suResult === "loss") return "L";
			return null;
		}
		if (metric === "ats") {
			if (fact.atsResult === "cover") return "W";
			if (fact.atsResult === "no_cover") return "L";
			return null;
		}
		// OU: "over" maps to "W", "under" maps to "L"
		if (fact.ouResult === "over") return "W";
		if (fact.ouResult === "under") return "L";
		return null;
	};

	let streakType: "W" | "L" | null = null;
	let streakLength = 0;

	for (const fact of facts) {
		const currentType = getStreakDirection(fact);
		if (currentType === null) continue;
		if (streakType === null) {
			streakType = currentType;
			streakLength = 1;
		} else if (currentType === streakType) {
			streakLength++;
		} else {
			break;
		}
	}

	if (streakType === null) return null;
	return { type: streakType, length: streakLength };
}

/**
 * Count records for a team with filters, useful for computing win rates and records.
 */
export async function getTeamRecord(
	db: Db,
	teamId: string,
	metric: "su" | "ats" | "ou",
	options?: {
		sportTag?: string;
		season?: string;
		venueRole?: VenueRole;
		favDogRole?: FavDogRole;
		limit?: number;
	},
): Promise<{
	wins: number;
	losses: number;
	pushes: number;
	winPct: number | null;
}> {
	const resultCol =
		metric === "su"
			? "su_result"
			: metric === "ats"
				? "ats_result"
				: "ou_result";

	const winValue =
		metric === "su" ? "win" : metric === "ats" ? "cover" : "over";
	const lossValue =
		metric === "su" ? "loss" : metric === "ats" ? "no_cover" : "under";

	const where: string[] = [`team_id = ?`, `${resultCol} IS NOT NULL`];
	const params: unknown[] = [teamId];

	if (options?.sportTag) {
		where.push(`sport_tag = ?`);
		params.push(options.sportTag);
	}
	if (options?.season) {
		where.push(`season = ?`);
		params.push(options.season);
	}
	if (options?.venueRole) {
		where.push(`venue_role = ?`);
		params.push(options.venueRole);
	}
	if (options?.favDogRole) {
		where.push(`fav_dog_role = ?`);
		params.push(options.favDogRole);
	}

	let query: string;
	if (options?.limit) {
		query = `SELECT
			SUM(CASE WHEN ${resultCol} = ? THEN 1 ELSE 0 END) as wins,
			SUM(CASE WHEN ${resultCol} = ? THEN 1 ELSE 0 END) as losses,
			SUM(CASE WHEN ${resultCol} = 'push' THEN 1 ELSE 0 END) as pushes
		FROM (
			SELECT ${resultCol} FROM team_game_facts
			WHERE ${where.join(" AND ")}
			ORDER BY game_time DESC
			LIMIT ?
		)`;
		params.push(options.limit);
	} else {
		query = `SELECT
			SUM(CASE WHEN ${resultCol} = ? THEN 1 ELSE 0 END) as wins,
			SUM(CASE WHEN ${resultCol} = ? THEN 1 ELSE 0 END) as losses,
			SUM(CASE WHEN ${resultCol} = 'push' THEN 1 ELSE 0 END) as pushes
		FROM team_game_facts
		WHERE ${where.join(" AND ")}`;
	}

	const row = await first<{ wins: number; losses: number; pushes: number }>(
		db,
		query,
		winValue,
		lossValue,
		...params,
	);

	const wins = row?.wins ?? 0;
	const losses = row?.losses ?? 0;
	const pushes = row?.pushes ?? 0;
	const winPct = wins + losses > 0 ? wins / (wins + losses) : null;

	return { wins, losses, pushes, winPct };
}
