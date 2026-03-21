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
		teamId: row.team_id,
		gameId: row.game_id,
		opponentId: row.opponent_id,
		venueRole: (row.venue_role as VenueRole) ?? undefined,
		favDogRole: (row.fav_dog_role as FavDogRole) ?? undefined,
		suResult: (row.su_result as PickResult) ?? undefined,
		atsResult: (row.ats_result as AtsResult) ?? undefined,
		ouResult: (row.ou_result as OuResult) ?? undefined,
		spreadLine: row.spread_line ?? undefined,
		totalLine: row.total_line ?? undefined,
		actualMargin: row.actual_margin ?? undefined,
		coverMargin: row.cover_margin ?? undefined,
		totalMargin: row.total_margin ?? undefined,
		teamScore: row.team_score ?? undefined,
		opponentScore: row.opponent_score ?? undefined,
		gameDate: row.game_date,
		sportTag: row.sport_tag,
		season: row.season ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function generateId(): string {
	return `tgf_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export interface UpsertTeamGameFactInput {
	teamId: string;
	gameId: string;
	opponentId: string;
	venueRole?: VenueRole;
	favDogRole?: FavDogRole;
	suResult?: PickResult;
	atsResult?: AtsResult;
	ouResult?: OuResult;
	spreadLine?: number;
	totalLine?: number;
	actualMargin?: number;
	coverMargin?: number;
	totalMargin?: number;
	teamScore?: number;
	opponentScore?: number;
	gameDate: string;
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
			id, team_id, game_id, opponent_id,
			venue_role, fav_dog_role,
			su_result, ats_result, ou_result,
			spread_line, total_line,
			actual_margin, cover_margin, total_margin,
			team_score, opponent_score,
			game_date, sport_tag, season,
			created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(team_id, game_id) DO UPDATE SET
			opponent_id = excluded.opponent_id,
			venue_role = COALESCE(excluded.venue_role, team_game_facts.venue_role),
			fav_dog_role = COALESCE(excluded.fav_dog_role, team_game_facts.fav_dog_role),
			su_result = COALESCE(excluded.su_result, team_game_facts.su_result),
			ats_result = COALESCE(excluded.ats_result, team_game_facts.ats_result),
			ou_result = COALESCE(excluded.ou_result, team_game_facts.ou_result),
			spread_line = COALESCE(excluded.spread_line, team_game_facts.spread_line),
			total_line = COALESCE(excluded.total_line, team_game_facts.total_line),
			actual_margin = COALESCE(excluded.actual_margin, team_game_facts.actual_margin),
			cover_margin = COALESCE(excluded.cover_margin, team_game_facts.cover_margin),
			total_margin = COALESCE(excluded.total_margin, team_game_facts.total_margin),
			team_score = COALESCE(excluded.team_score, team_game_facts.team_score),
			opponent_score = COALESCE(excluded.opponent_score, team_game_facts.opponent_score),
			updated_at = excluded.updated_at`,
		id,
		input.teamId,
		input.gameId,
		input.opponentId,
		input.venueRole ?? null,
		input.favDogRole ?? null,
		input.suResult ?? null,
		input.atsResult ?? null,
		input.ouResult ?? null,
		input.spreadLine ?? null,
		input.totalLine ?? null,
		input.actualMargin ?? null,
		input.coverMargin ?? null,
		input.totalMargin ?? null,
		input.teamScore ?? null,
		input.opponentScore ?? null,
		input.gameDate,
		input.sportTag,
		input.season ?? null,
		now,
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
	if (filter.beforeDate) {
		where.push(`game_date < ?`);
		params.push(filter.beforeDate);
	}

	const limit = filter.limit ?? 10;
	params.push(limit);

	const rows = await all<TeamGameFactRow>(
		db,
		`SELECT * FROM team_game_facts
		WHERE ${where.join(" AND ")}
		ORDER BY game_date DESC
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
 * Walks backward from most recent, skipping pushes.
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

	// Exclude nulls and pushes from streak calculation
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

	// Fetch recent facts to walk the streak
	const rows = await all<TeamGameFactRow>(
		db,
		`SELECT * FROM team_game_facts
		WHERE ${where.join(" AND ")}
		ORDER BY game_date DESC
		LIMIT 50`,
		...params,
	);

	if (rows.length === 0) return null;

	const facts = rows.map(parseRow);
	const getResult = (fact: TeamGameFact): string | undefined => {
		if (metric === "su") return fact.suResult;
		if (metric === "ats") {
			if (!fact.atsResult || fact.atsResult === "push") return undefined;
			return fact.atsResult === "cover" ? "win" : "loss";
		}
		// ou
		if (!fact.ouResult || fact.ouResult === "push") return undefined;
		return fact.ouResult === "over" || fact.ouResult === "under"
			? "win"
			: "loss";
	};

	let streakType: "W" | "L" | null = null;
	let streakLength = 0;

	for (const fact of facts) {
		const result = getResult(fact);
		if (!result) continue;

		const currentType = result === "win" || result === "cover" ? "W" : "L";
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

	// If limit specified, use a subquery to restrict to last N games
	let query: string;
	if (options?.limit) {
		query = `SELECT
			SUM(CASE WHEN ${resultCol} = ? THEN 1 ELSE 0 END) as wins,
			SUM(CASE WHEN ${resultCol} = ? THEN 1 ELSE 0 END) as losses,
			SUM(CASE WHEN ${resultCol} = 'push' THEN 1 ELSE 0 END) as pushes
		FROM (
			SELECT ${resultCol} FROM team_game_facts
			WHERE ${where.join(" AND ")}
			ORDER BY game_date DESC
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
