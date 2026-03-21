import type { Db } from "../db/client";
import { all, first, run } from "../db/client";
import { nowUnixSeconds } from "../env";
import type { Team, TeamRow } from "../types/canonical";

function parseRow(row: TeamRow): Team {
	return {
		id: row.id,
		name: row.name,
		shortName: row.short_name ?? undefined,
		abbreviation: row.abbreviation ?? undefined,
		sportTag: row.sport_tag,
		aliases: row.aliases_json ? (JSON.parse(row.aliases_json) as string[]) : [],
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function generateId(): string {
	return `team_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export interface UpsertTeamInput {
	name: string;
	shortName?: string;
	abbreviation?: string;
	sportTag: string;
	aliases?: string[];
}

export async function upsertTeam(
	db: Db,
	input: UpsertTeamInput,
): Promise<Team> {
	const now = nowUnixSeconds();
	const id = generateId();
	const aliasesJson =
		input.aliases && input.aliases.length > 0
			? JSON.stringify(input.aliases)
			: null;

	await run(
		db,
		`INSERT INTO teams (id, name, short_name, abbreviation, sport_tag, aliases_json, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(sport_tag, name) DO UPDATE SET
			short_name = COALESCE(excluded.short_name, teams.short_name),
			abbreviation = COALESCE(excluded.abbreviation, teams.abbreviation),
			aliases_json = COALESCE(excluded.aliases_json, teams.aliases_json),
			updated_at = excluded.updated_at`,
		id,
		input.name,
		input.shortName ?? null,
		input.abbreviation ?? null,
		input.sportTag,
		aliasesJson,
		now,
		now,
	);

	const row = await first<TeamRow>(
		db,
		`SELECT * FROM teams WHERE sport_tag = ? AND name = ?`,
		input.sportTag,
		input.name,
	);

	if (!row) {
		throw new Error(`Failed to upsert team: ${input.name}`);
	}

	return parseRow(row);
}

export async function getTeamById(db: Db, id: string): Promise<Team | null> {
	const row = await first<TeamRow>(db, `SELECT * FROM teams WHERE id = ?`, id);
	return row ? parseRow(row) : null;
}

export async function getTeamByName(
	db: Db,
	sportTag: string,
	name: string,
): Promise<Team | null> {
	const row = await first<TeamRow>(
		db,
		`SELECT * FROM teams WHERE sport_tag = ? AND name = ?`,
		sportTag,
		name,
	);
	return row ? parseRow(row) : null;
}

export async function findTeamByAlias(
	db: Db,
	sportTag: string,
	alias: string,
): Promise<Team | null> {
	// First try exact name match
	const exact = await getTeamByName(db, sportTag, alias);
	if (exact) return exact;

	// Search aliases (JSON array contains check)
	// Escape SQL LIKE wildcards (%, _) in the alias before using in LIKE pattern
	const escapedAlias = alias.replace(/[%_]/g, "\\$&");
	const rows = await all<TeamRow>(
		db,
		`SELECT * FROM teams WHERE sport_tag = ? AND aliases_json LIKE ? ESCAPE '\\'`,
		sportTag,
		`%${escapedAlias}%`,
	);

	for (const row of rows) {
		const team = parseRow(row);
		if (team.aliases.some((a) => a.toLowerCase() === alias.toLowerCase())) {
			return team;
		}
	}

	return null;
}

export async function listTeamsBySport(
	db: Db,
	sportTag: string,
): Promise<Team[]> {
	const rows = await all<TeamRow>(
		db,
		`SELECT * FROM teams WHERE sport_tag = ? ORDER BY name ASC`,
		sportTag,
	);
	return rows.map(parseRow);
}

export async function listAllTeams(db: Db): Promise<Team[]> {
	const rows = await all<TeamRow>(
		db,
		`SELECT * FROM teams ORDER BY sport_tag ASC, name ASC`,
	);
	return rows.map(parseRow);
}
