/**
 * Matchup Comparison Domain Layer — Phase 4
 *
 * Builds side-by-side trend comparisons for two teams facing each other.
 * Answers: "compare team and opponent recent splits before a matchup"
 *
 * Consumers: server API functions (canonical-analytics.ts), app routes.
 */

import type { Db } from "../db/client";
import { getGameById } from "../repositories/games";
import { findTeamByAlias, getTeamById } from "../repositories/teams";
import type {
	FavDogRole,
	Game,
	TrendSnapshotType,
	VenueRole,
} from "../types/canonical";
import {
	type TeamTrendSummary,
	buildTeamTrendSummary,
	snapshotTypeLabel,
} from "./trend-summary";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Edge in a comparison: which team is stronger for a metric */
export type ComparisonEdge = "team" | "opponent" | "even";

/** Single metric comparison between two teams */
export interface MetricComparison {
	metric: "su" | "ats" | "ou";
	team: { record: string; winPct: number | null; streak: string | null };
	opponent: { record: string; winPct: number | null; streak: string | null };
	edge: ComparisonEdge;
}

/** Full matchup comparison across relevant splits */
export interface MatchupComparison {
	team: { id: string; name: string; sportTag: string };
	opponent: { id: string; name: string; sportTag: string };
	game?: {
		id: string;
		gameTime?: number;
		venueInfo: string;
	};
	splits: MatchupSplitComparison[];
	headline: string;
}

/** Comparison for a single split (e.g., "Home Favorite" vs "Away Underdog") */
export interface MatchupSplitComparison {
	teamSplit: {
		snapshotType: TrendSnapshotType;
		label: string;
		summary: TeamTrendSummary | null;
	};
	opponentSplit: {
		snapshotType: TrendSnapshotType;
		label: string;
		summary: TeamTrendSummary | null;
	};
	metrics: MetricComparison[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @internal Exported for testing */
export function determineEdge(
	teamPct: number | null,
	opponentPct: number | null,
): ComparisonEdge {
	if (teamPct == null && opponentPct == null) return "even";
	if (teamPct == null) return "opponent";
	if (opponentPct == null) return "team";
	if (Math.abs(teamPct - opponentPct) < 0.01) return "even";
	return teamPct > opponentPct ? "team" : "opponent";
}

/** @internal Exported for testing */
export function buildMetricComparisons(
	teamSummary: TeamTrendSummary | null,
	opponentSummary: TeamTrendSummary | null,
): MetricComparison[] {
	const metrics: ("su" | "ats" | "ou")[] = ["su", "ats", "ou"];
	return metrics.map((metric) => {
		const teamData = teamSummary?.[metric];
		const oppData = opponentSummary?.[metric];
		return {
			metric,
			team: {
				record: teamData?.record.display ?? "—",
				winPct: teamData?.record.winPct ?? null,
				streak: teamData?.streak?.display ?? null,
			},
			opponent: {
				record: oppData?.record.display ?? "—",
				winPct: oppData?.record.winPct ?? null,
				streak: oppData?.streak?.display ?? null,
			},
			edge: determineEdge(
				teamData?.record.winPct ?? null,
				oppData?.record.winPct ?? null,
			),
		};
	});
}

/**
 * Determine which split pairs are relevant for a matchup.
 * Maps team context (home/away, fav/dog) to the opposing context.
 */
/** @internal Exported for testing */
export function getRelevantSplitPairs(
	teamVenueRole?: VenueRole,
	teamFavDogRole?: FavDogRole,
): Array<{
	teamType: TrendSnapshotType;
	opponentType: TrendSnapshotType;
}> {
	const pairs: Array<{
		teamType: TrendSnapshotType;
		opponentType: TrendSnapshotType;
	}> = [
		// Always include overall
		{ teamType: "overall", opponentType: "overall" },
	];

	if (teamVenueRole === "home") {
		pairs.push({ teamType: "home", opponentType: "away" });
		if (teamFavDogRole === "favorite") {
			pairs.push({
				teamType: "home_favorite",
				opponentType: "away_dog",
			});
		} else if (teamFavDogRole === "dog") {
			pairs.push({
				teamType: "home_dog",
				opponentType: "away_favorite",
			});
		}
	} else if (teamVenueRole === "away") {
		pairs.push({ teamType: "away", opponentType: "home" });
		if (teamFavDogRole === "favorite") {
			pairs.push({
				teamType: "away_favorite",
				opponentType: "home_dog",
			});
		} else if (teamFavDogRole === "dog") {
			pairs.push({
				teamType: "away_dog",
				opponentType: "home_favorite",
			});
		}
	}

	// Add fav/dog split if known but no combined venue+favdog already added
	if (teamFavDogRole && !teamVenueRole) {
		const oppFavDog: TrendSnapshotType =
			teamFavDogRole === "favorite" ? "dog" : "favorite";
		pairs.push({
			teamType: teamFavDogRole as TrendSnapshotType,
			opponentType: oppFavDog,
		});
	}

	return pairs;
}

/** @internal Exported for testing */
export function buildHeadline(
	teamName: string,
	opponentName: string,
	splits: MatchupSplitComparison[],
): string {
	// Use overall split for headline
	const overall = splits.find(
		(s) => s.teamSplit.snapshotType === "overall",
	);
	if (!overall || !overall.metrics.length) {
		return `${teamName} vs ${opponentName}`;
	}

	const atsComparison = overall.metrics.find((m) => m.metric === "ats");
	if (atsComparison) {
		const teamRec = atsComparison.team.record;
		const oppRec = atsComparison.opponent.record;
		return `${teamName} (${teamRec} ATS) vs ${opponentName} (${oppRec} ATS)`;
	}

	return `${teamName} vs ${opponentName}`;
}

// ---------------------------------------------------------------------------
// Core builders
// ---------------------------------------------------------------------------

/**
 * Build a full matchup comparison between two teams.
 *
 * If a gameId is provided, uses game context (venue, fav/dog) to select
 * the most relevant split pairs. Otherwise, compares overall splits.
 */
export async function buildMatchupComparison(
	db: Db,
	teamId: string,
	opponentId: string,
	options?: {
		sportTag?: string;
		gameId?: string;
		teamVenueRole?: VenueRole;
		teamFavDogRole?: FavDogRole;
		asOfTime?: number;
	},
): Promise<MatchupComparison | null> {
	const [team, opponent] = await Promise.all([
		getTeamById(db, teamId),
		getTeamById(db, opponentId),
	]);
	if (!team || !opponent) return null;

	const sportTag = options?.sportTag ?? team.sportTag;

	// Resolve game context if gameId provided
	let game: Game | null = null;
	let teamVenueRole = options?.teamVenueRole;
	let teamFavDogRole = options?.teamFavDogRole;

	if (options?.gameId) {
		game = await getGameById(db, options.gameId);
		if (game) {
			if (!teamVenueRole) {
				teamVenueRole =
					game.homeTeamId === teamId
						? "home"
						: game.awayTeamId === teamId
							? "away"
							: undefined;
			}
		}
	}

	const splitPairs = getRelevantSplitPairs(teamVenueRole, teamFavDogRole);

	// Build summaries for all relevant split pairs in parallel
	const splitResults = await Promise.all(
		splitPairs.map(async (pair) => {
			const [teamSummary, opponentSummary] = await Promise.all([
				buildTeamTrendSummary(db, teamId, pair.teamType, {
					sportTag,
					asOfTime: options?.asOfTime,
				}),
				buildTeamTrendSummary(db, opponentId, pair.opponentType, {
					sportTag,
					asOfTime: options?.asOfTime,
				}),
			]);

			return {
				teamSplit: {
					snapshotType: pair.teamType,
					label: snapshotTypeLabel(pair.teamType),
					summary: teamSummary,
				},
				opponentSplit: {
					snapshotType: pair.opponentType,
					label: snapshotTypeLabel(pair.opponentType),
					summary: opponentSummary,
				},
				metrics: buildMetricComparisons(teamSummary, opponentSummary),
			} satisfies MatchupSplitComparison;
		}),
	);

	const venueInfo = game
		? game.neutralSite
			? "Neutral site"
			: `${team.name === teamVenueRole ? team.name : teamVenueRole === "home" ? team.name : opponent.name} home`
		: "Unknown venue";

	return {
		team: { id: team.id, name: team.name, sportTag: team.sportTag },
		opponent: {
			id: opponent.id,
			name: opponent.name,
			sportTag: opponent.sportTag,
		},
		game: game
			? {
					id: game.id,
					gameTime: game.gameTime,
					venueInfo,
				}
			: undefined,
		splits: splitResults,
		headline: buildHeadline(team.name, opponent.name, splitResults),
	};
}

/**
 * Build a matchup comparison by team names/aliases.
 * Convenience for API consumers with string identifiers.
 */
export async function buildMatchupComparisonByNames(
	db: Db,
	teamName: string,
	opponentName: string,
	sportTag: string,
	options?: {
		gameId?: string;
		teamVenueRole?: VenueRole;
		teamFavDogRole?: FavDogRole;
		asOfTime?: number;
	},
): Promise<MatchupComparison | null> {
	const [team, opponent] = await Promise.all([
		findTeamByAlias(db, sportTag, teamName),
		findTeamByAlias(db, sportTag, opponentName),
	]);

	if (!team || !opponent) return null;

	return buildMatchupComparison(db, team.id, opponent.id, {
		sportTag,
		...options,
	});
}

/**
 * Build a matchup comparison from a game ID.
 * Automatically resolves both teams and their venue roles.
 */
export async function buildMatchupComparisonFromGame(
	db: Db,
	gameId: string,
	options?: { asOfTime?: number },
): Promise<MatchupComparison | null> {
	const game = await getGameById(db, gameId);
	if (!game) return null;

	return buildMatchupComparison(db, game.homeTeamId, game.awayTeamId, {
		sportTag: game.sportTag,
		gameId,
		teamVenueRole: "home",
		asOfTime: options?.asOfTime,
	});
}
