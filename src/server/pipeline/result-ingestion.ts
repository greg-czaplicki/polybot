/**
 * Result ingestion — finalizes completed games with scores from ESPN's public API.
 *
 * The canonical sync pipeline creates games from Polymarket market data but
 * without final scores. This module closes that gap by fetching scores for
 * unfinalized games whose start time is safely in the past.
 *
 * ESPN endpoint pattern:
 *   https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard?dates={YYYYMMDD}
 *
 * Matching strategy: for each unfinalized canonical game, look up ESPN events
 * on the same date and match by team identity (abbreviation or name) on both sides.
 */

import type { Db } from "../db/client";
import { updateGameResult } from "../repositories/games";
import { getTeamById } from "../repositories/teams";
import type { Game, Team } from "../types/canonical";
import { listUnfinalizedGames } from "./game-ingestion";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResultIngestionResult {
	gameId: string;
	status: "finalized" | "not_found" | "skipped" | "error";
	homeScore?: number;
	awayScore?: number;
	reason?: string;
}

export interface BatchResultIngestionResult {
	finalized: number;
	notFound: number;
	skipped: number;
	errors: number;
	details: ResultIngestionResult[];
}

// ---------------------------------------------------------------------------
// ESPN API types (subset of the public scoreboard response)
// ---------------------------------------------------------------------------

interface EspnCompetitor {
	homeAway: "home" | "away";
	score: string;
	team: {
		abbreviation: string;
		displayName: string;
		shortDisplayName: string;
	};
}

interface EspnCompetition {
	competitors: EspnCompetitor[];
	status: {
		type: {
			completed: boolean;
		};
	};
}

interface EspnEvent {
	competitions: EspnCompetition[];
}

interface EspnScoreboardResponse {
	events: EspnEvent[];
}

// ---------------------------------------------------------------------------
// Sport → ESPN path mapping
// ---------------------------------------------------------------------------

const SPORT_ESPN_MAP: Record<string, { sport: string; league: string }> = {
	nfl: { sport: "football", league: "nfl" },
	nba: { sport: "basketball", league: "nba" },
	mlb: { sport: "baseball", league: "mlb" },
	ncaab: { sport: "basketball", league: "mens-college-basketball" },
	ncaaf: { sport: "football", league: "college-football" },
};

/** Only finalize games whose start time + this buffer is in the past. */
const COMPLETION_BUFFER_SECONDS = 4 * 60 * 60;

/** Max unfinalized games to process per sport per cycle. */
const PER_SPORT_LIMIT = 50;

// ---------------------------------------------------------------------------
// ESPN API helpers
// ---------------------------------------------------------------------------

/**
 * Fetches the ESPN scoreboard for a given sport on a given date.
 * Returns null on any HTTP or parse error (caller decides how to handle).
 */
async function fetchEspnScoreboard(
	sportTag: string,
	dateStr: string,
): Promise<EspnScoreboardResponse | null> {
	const mapping = SPORT_ESPN_MAP[sportTag];
	if (!mapping) return null;

	// Without an explicit limit ESPN truncates busy slates (NCAAB weekdays run
	// 300+ games) with no error or cursor.
	const url = `https://site.api.espn.com/apis/site/v2/sports/${mapping.sport}/${mapping.league}/scoreboard?dates=${dateStr}&limit=1000`;

	try {
		const res = await fetch(url);
		if (!res.ok) {
			console.warn(
				`[result-ingestion] ESPN API returned ${res.status} for ${sportTag} on ${dateStr}`,
			);
			return null;
		}
		return (await res.json()) as EspnScoreboardResponse;
	} catch (err) {
		console.warn(
			`[result-ingestion] ESPN fetch failed for ${sportTag} on ${dateStr}:`,
			err instanceof Error ? err.message : err,
		);
		return null;
	}
}

/**
 * Formats a unix timestamp (seconds) as YYYYMMDD in UTC.
 */
function formatDateUTC(unixSeconds: number): string {
	const d = new Date(unixSeconds * 1000);
	const yyyy = d.getUTCFullYear();
	const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(d.getUTCDate()).padStart(2, "0");
	return `${yyyy}${mm}${dd}`;
}

/**
 * Normalizes a team name for fuzzy comparison:
 * lowercase, strip non-alphanumeric, collapse whitespace.
 */
function normalizeName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Checks whether a canonical Team matches an ESPN competitor.
 * Matches on abbreviation or any of: full name, short name, aliases.
 */
function teamMatchesEspnCompetitor(
	team: Team,
	competitor: EspnCompetitor,
): boolean {
	const espnAbbr = competitor.team.abbreviation.toUpperCase();
	const espnDisplay = normalizeName(competitor.team.displayName);
	const espnShort = normalizeName(competitor.team.shortDisplayName);

	// Abbreviation match
	if (team.abbreviation?.toUpperCase() === espnAbbr) return true;

	// Full name match
	if (normalizeName(team.name) === espnDisplay) return true;

	// Short name match
	if (team.shortName && normalizeName(team.shortName) === espnShort)
		return true;

	// Alias match
	for (const alias of team.aliases) {
		const normalizedAlias = normalizeName(alias);
		if (normalizedAlias === espnDisplay || normalizedAlias === espnShort)
			return true;
	}

	return false;
}

/**
 * Finds a completed ESPN event matching a canonical game's home/away teams.
 * Returns { homeScore, awayScore } or null if no confident match found.
 */
function findMatchingScore(
	events: EspnEvent[],
	homeTeam: Team,
	awayTeam: Team,
): { homeScore: number; awayScore: number; wentToOt: boolean } | null {
	for (const event of events) {
		const comp = event.competitions[0];
		if (!comp) continue;
		if (!comp.status.type.completed) continue;

		const espnHome = comp.competitors.find((c) => c.homeAway === "home");
		const espnAway = comp.competitors.find((c) => c.homeAway === "away");
		if (!espnHome || !espnAway) continue;

		const homeMatch = teamMatchesEspnCompetitor(homeTeam, espnHome);
		const awayMatch = teamMatchesEspnCompetitor(awayTeam, espnAway);

		if (homeMatch && awayMatch) {
			const homeScore = Number.parseInt(espnHome.score, 10);
			const awayScore = Number.parseInt(espnAway.score, 10);
			if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore))
				continue;

			// ESPN competitions may have a period count indicating OT
			// but minimal approach: we don't have OT info in the basic response
			return { homeScore, awayScore, wentToOt: false };
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Finalizes completed games by fetching scores from ESPN.
 *
 * For each sport tag:
 *   1. List unfinalized games (capped at PER_SPORT_LIMIT)
 *   2. Filter to games whose game_time + 4h < now
 *   3. Group by game date (to batch ESPN API calls)
 *   4. Fetch ESPN scoreboard per date
 *   5. Match and finalize
 *
 * Idempotent: already-final games are excluded by listUnfinalizedGames.
 */
export async function finalizeCompletedGames(
	db: Db,
	sportTags: string[],
): Promise<BatchResultIngestionResult> {
	const result: BatchResultIngestionResult = {
		finalized: 0,
		notFound: 0,
		skipped: 0,
		errors: 0,
		details: [],
	};

	const nowSeconds = Math.floor(Date.now() / 1000);

	for (const sportTag of sportTags) {
		if (!SPORT_ESPN_MAP[sportTag]) {
			// No ESPN mapping for this sport — skip silently
			continue;
		}

		let games: Game[];
		try {
			games = await listUnfinalizedGames(db, sportTag, PER_SPORT_LIMIT);
		} catch (err) {
			console.error(
				`[result-ingestion] Failed to list unfinalized ${sportTag} games:`,
				err instanceof Error ? err.message : err,
			);
			continue;
		}

		// Filter to games safely in the past
		const eligible = games.filter(
			(g) =>
				g.gameTime != null &&
				g.gameTime + COMPLETION_BUFFER_SECONDS < nowSeconds,
		);

		// Group by date string for batched ESPN calls
		const byDate = new Map<string, Game[]>();
		for (const game of eligible) {
			const dateStr = formatDateUTC(game.gameTime as number);
			const group = byDate.get(dateStr);
			if (group) {
				group.push(game);
			} else {
				byDate.set(dateStr, [game]);
			}
		}

		// Process each date
		for (const [dateStr, dateGames] of byDate) {
			let scoreboard: EspnScoreboardResponse | null;
			try {
				scoreboard = await fetchEspnScoreboard(sportTag, dateStr);
			} catch (err) {
				// fetchEspnScoreboard already handles errors, but guard against unexpected throws
				for (const game of dateGames) {
					result.errors++;
					result.details.push({
						gameId: game.id,
						status: "error",
						reason: `ESPN fetch error: ${err instanceof Error ? err.message : err}`,
					});
				}
				continue;
			}

			if (!scoreboard || !scoreboard.events) {
				for (const game of dateGames) {
					result.notFound++;
					result.details.push({
						gameId: game.id,
						status: "not_found",
						reason: `No ESPN scoreboard data for ${sportTag} on ${dateStr}`,
					});
				}
				continue;
			}

			for (const game of dateGames) {
				try {
					// Resolve team entities
					const homeTeam = await getTeamById(db, game.homeTeamId);
					const awayTeam = await getTeamById(db, game.awayTeamId);
					if (!homeTeam || !awayTeam) {
						result.skipped++;
						result.details.push({
							gameId: game.id,
							status: "skipped",
							reason: `Missing team record (home=${!!homeTeam}, away=${!!awayTeam})`,
						});
						continue;
					}

					const match = findMatchingScore(
						scoreboard.events,
						homeTeam,
						awayTeam,
					);

					if (!match) {
						result.notFound++;
						result.details.push({
							gameId: game.id,
							status: "not_found",
							reason: `No ESPN event matched ${homeTeam.name} vs ${awayTeam.name} on ${dateStr}`,
						});
						continue;
					}

					await updateGameResult(db, game.id, {
						homeScore: match.homeScore,
						awayScore: match.awayScore,
						wentToOt: match.wentToOt,
					});

					result.finalized++;
					result.details.push({
						gameId: game.id,
						status: "finalized",
						homeScore: match.homeScore,
						awayScore: match.awayScore,
					});
				} catch (err) {
					result.errors++;
					result.details.push({
						gameId: game.id,
						status: "error",
						reason: err instanceof Error ? err.message : String(err),
					});
				}
			}
		}
	}

	return result;
}
