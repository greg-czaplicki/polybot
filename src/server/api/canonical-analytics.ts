/**
 * Canonical Analytics Server API — Phase 4
 *
 * App-shaped server functions for team trends, matchup comparisons,
 * pick context lookup, and pipeline health status.
 *
 * Wraps the domain layer (trend-summary.ts, matchup-comparison.ts) into
 * TanStack Start server functions callable from app routes and debug surfaces.
 */

import { createServerFn } from "@tanstack/react-start";
import { all, first } from "../db/client";
import {
	buildMatchupComparison,
	buildMatchupComparisonByNames,
	buildMatchupComparisonFromGame,
} from "../domain/matchup-comparison";
import {
	buildTeamTrendOverview,
	buildTeamTrendSummary,
	buildTeamTrendSummaryByName,
} from "../domain/trend-summary";
import { getDb } from "../env";
import { findTeamByAlias, getTeamById } from "../repositories/teams";
import { getTeamTrendSnapshotAsOf } from "../repositories/team-trend-snapshots";
import type {
	FavDogRole,
	TrendSnapshotType,
	VenueRole,
} from "../types/canonical";

// ---------------------------------------------------------------------------
// Sport Tags
// ---------------------------------------------------------------------------

/**
 * List distinct sport tags that have at least one team seeded.
 * Used to populate sport-tag dropdowns on the canonical page.
 */
export const listSportTagsFn = createServerFn({ method: "GET" }).handler(
	async ({ context }) => {
		const db = getDb(context);
		const rows = await all<{ sport_tag: string }>(
			db,
			`SELECT DISTINCT sport_tag FROM teams ORDER BY sport_tag ASC`,
		);
		return { sportTags: rows.map((r) => r.sport_tag) };
	},
);

/**
 * List all teams, returning id/name/sportTag for dropdown population.
 */
export const listTeamsForDropdownFn = createServerFn({ method: "GET" }).handler(
	async ({ context }) => {
		const db = getDb(context);
		const rows = await all<{ id: string; name: string; sport_tag: string }>(
			db,
			`SELECT id, name, sport_tag FROM teams ORDER BY sport_tag ASC, name ASC`,
		);
		return {
			teams: rows.map((r) => ({
				id: r.id,
				name: r.name,
				sportTag: r.sport_tag,
			})),
		};
	},
);

// ---------------------------------------------------------------------------
// Team Trend Summary
// ---------------------------------------------------------------------------

/**
 * Get a composed team trend summary for app consumption.
 *
 * Supports lookup by teamId OR alias+sportTag. Returns a full trend summary
 * with SU/ATS/OU records, streaks, and average margins for a given split.
 *
 * Input: { teamId?, alias?, sportTag, snapshotType?, window?, asOfTime? }
 */
interface TrendSummaryInput {
	teamId?: string;
	alias?: string;
	sportTag: string;
	snapshotType?: TrendSnapshotType;
	window?: number;
	asOfTime?: number;
}

export const getTeamTrendSummaryFn = createServerFn({
	method: "POST",
})
	.inputValidator((d: TrendSummaryInput) => d)
	.handler(async ({ context, data }) => {
		if (!data.sportTag) {
			return { summary: null, error: "sportTag is required" };
		}

		if (!data.teamId && !data.alias) {
			return { summary: null, error: "teamId or alias is required" };
		}

		const db = getDb(context);
		const sportTag = data.sportTag.toLowerCase();
		const snapshotType = data.snapshotType ?? "overall";

		if (data.alias && !data.teamId) {
			const summary = await buildTeamTrendSummaryByName(
				db,
				data.alias,
				sportTag,
				snapshotType,
				{ window: data.window, asOfTime: data.asOfTime },
			);
			return { summary };
		}

		if (!data.teamId) {
			return { summary: null, error: "teamId or alias is required" };
		}

		const summary = await buildTeamTrendSummary(
			db,
			data.teamId,
			snapshotType,
			{
				sportTag,
				window: data.window,
				asOfTime: data.asOfTime,
			},
		);
		return { summary };
	});

/**
 * Get a multi-split team trend overview (all 9 snapshot types).
 *
 * Input: { teamId?, alias?, sportTag }
 */
interface TrendOverviewInput {
	teamId?: string;
	alias?: string;
	sportTag?: string;
}

export const getTeamTrendOverviewFn = createServerFn({
	method: "POST",
})
	.inputValidator((d: TrendOverviewInput) => d)
	.handler(async ({ context, data }) => {
		const db = getDb(context);
		const sportTag = data.sportTag?.toLowerCase();

		let teamId = data.teamId;
		if (!teamId && data.alias && sportTag) {
			const team = await findTeamByAlias(db, sportTag, data.alias);
			if (!team) {
				return { overview: null, error: `Team not found: ${data.alias}` };
			}
			teamId = team.id;
		}

		if (!teamId) {
			return {
				overview: null,
				error: "teamId or alias+sportTag is required",
			};
		}

		const overview = await buildTeamTrendOverview(db, teamId, {
			sportTag,
		});
		return { overview };
	});

// ---------------------------------------------------------------------------
// Matchup Comparison
// ---------------------------------------------------------------------------

/**
 * Get a side-by-side matchup comparison between two teams.
 *
 * Supports lookup by IDs or aliases. If a gameId is provided, uses game
 * context (venue, fav/dog) to select the most relevant split pairs.
 *
 * Input: { teamId?, opponentId?, teamAlias?, opponentAlias?, sportTag,
 *          gameId?, teamVenueRole?, teamFavDogRole?, asOfTime? }
 */
interface MatchupComparisonInput {
	teamId?: string;
	opponentId?: string;
	teamAlias?: string;
	opponentAlias?: string;
	sportTag: string;
	gameId?: string;
	teamVenueRole?: VenueRole;
	teamFavDogRole?: FavDogRole;
	asOfTime?: number;
}

export const getMatchupComparisonFn = createServerFn({
	method: "POST",
})
	.inputValidator((d: MatchupComparisonInput) => d)
	.handler(async ({ context, data }) => {
		if (!data.sportTag) {
			return { comparison: null, error: "sportTag is required" };
		}

		const db = getDb(context);
		const sportTag = data.sportTag.toLowerCase();

		// If gameId provided, build comparison from game context
		if (data.gameId && !data.teamId && !data.teamAlias) {
			const comparison = await buildMatchupComparisonFromGame(
				db,
				data.gameId,
				{ asOfTime: data.asOfTime },
			);
			return { comparison };
		}

		// Lookup by aliases
		if (data.teamAlias && data.opponentAlias) {
			const comparison = await buildMatchupComparisonByNames(
				db,
				data.teamAlias,
				data.opponentAlias,
				sportTag,
				{
					gameId: data.gameId,
					teamVenueRole: data.teamVenueRole,
					teamFavDogRole: data.teamFavDogRole,
					asOfTime: data.asOfTime,
				},
			);
			return { comparison };
		}

		// Lookup by IDs
		if (!data.teamId || !data.opponentId) {
			return {
				comparison: null,
				error:
					"teamId+opponentId, teamAlias+opponentAlias, or gameId is required",
			};
		}

		const comparison = await buildMatchupComparison(
			db,
			data.teamId,
			data.opponentId,
			{
				sportTag,
				gameId: data.gameId,
				teamVenueRole: data.teamVenueRole,
				teamFavDogRole: data.teamFavDogRole,
				asOfTime: data.asOfTime,
			},
		);
		return { comparison };
	});

// ---------------------------------------------------------------------------
// Pick Context Lookup
// ---------------------------------------------------------------------------

/** Pick context: enrichment fields + attached trend snapshot */
interface PickContext {
	pickId: string;
	marketTitle: string;
	pickedAt: number;
	enrichment: {
		gameId: string | null;
		teamId: string | null;
		opponentId: string | null;
		betType: string | null;
		sportTag: string | null;
		venueRole: string | null;
		favDogRole: string | null;
		spreadLine: number | null;
		totalLine: number | null;
		actualMargin: number | null;
		actualTotal: number | null;
	};
	team: { id: string; name: string; sportTag: string } | null;
	opponent: { id: string; name: string; sportTag: string } | null;
	trendSnapshot: {
		overall: ReturnType<typeof formatSnapshotCompact> | null;
		contextual: ReturnType<typeof formatSnapshotCompact> | null;
	};
}

function formatSnapshotCompact(snapshot: {
	snapshotType: string;
	suWinPct?: number;
	atsWinPct?: number;
	ouOverPct?: number;
	atsStreakType?: string;
	atsStreakLength: number;
	windowSize: number;
}) {
	return {
		type: snapshot.snapshotType,
		window: snapshot.windowSize,
		suPct: snapshot.suWinPct ?? null,
		atsPct: snapshot.atsWinPct ?? null,
		ouPct: snapshot.ouOverPct ?? null,
		atsStreak: snapshot.atsStreakType
			? `${snapshot.atsStreakType}${snapshot.atsStreakLength}`
			: null,
	};
}

/**
 * Look up a pick's canonical context: enrichment fields + trend snapshots.
 *
 * Input: { pickId: string }
 */
export const getPickContextFn = createServerFn({ method: "POST" })
	.inputValidator((d: { pickId: string }) => d)
	.handler(async ({ context, data }) => {
		if (!data.pickId) {
			return { context: null, error: "pickId is required" };
		}

		const db = getDb(context);

		const pick = await first<{
			id: string;
			market_title: string;
			picked_at: number;
			game_id: string | null;
			team_id: string | null;
			opponent_id: string | null;
			bet_type: string | null;
			sport_tag: string | null;
			venue_role: string | null;
			fav_dog_role: string | null;
			spread_line: number | null;
			total_line: number | null;
			actual_margin: number | null;
			actual_total: number | null;
		}>(
			db,
			`SELECT id, market_title, picked_at, game_id, team_id, opponent_id,
			        bet_type, sport_tag, venue_role, fav_dog_role,
			        spread_line, total_line, actual_margin, actual_total
			 FROM manual_picks WHERE id = ?`,
			data.pickId,
		);

		if (!pick) {
			return { context: null, error: `Pick not found: ${data.pickId}` };
		}

		// Resolve team and opponent names
		const [team, opponent] = await Promise.all([
			pick.team_id ? getTeamById(db, pick.team_id) : null,
			pick.opponent_id ? getTeamById(db, pick.opponent_id) : null,
		]);

		// Look up point-in-time trend snapshots
		let overallSnapshot = null;
		let contextualSnapshot = null;

		if (pick.team_id && pick.sport_tag) {
			const asOfTime = pick.picked_at;

			const overall = await getTeamTrendSnapshotAsOf(
				db,
				pick.team_id,
				"overall",
				asOfTime,
			);
			if (overall) {
				overallSnapshot = formatSnapshotCompact(overall);
			}

			// Get the contextual snapshot matching the pick's venue+fav/dog role
			const contextualType = deriveSnapshotType(
				pick.venue_role as VenueRole | null,
				pick.fav_dog_role as FavDogRole | null,
			);
			if (contextualType && contextualType !== "overall") {
				const contextual = await getTeamTrendSnapshotAsOf(
					db,
					pick.team_id,
					contextualType,
					asOfTime,
				);
				if (contextual) {
					contextualSnapshot = formatSnapshotCompact(contextual);
				}
			}
		}

		const pickContext: PickContext = {
			pickId: pick.id,
			marketTitle: pick.market_title,
			pickedAt: pick.picked_at,
			enrichment: {
				gameId: pick.game_id,
				teamId: pick.team_id,
				opponentId: pick.opponent_id,
				betType: pick.bet_type,
				sportTag: pick.sport_tag,
				venueRole: pick.venue_role,
				favDogRole: pick.fav_dog_role,
				spreadLine: pick.spread_line,
				totalLine: pick.total_line,
				actualMargin: pick.actual_margin,
				actualTotal: pick.actual_total,
			},
			team: team
				? { id: team.id, name: team.name, sportTag: team.sportTag }
				: null,
			opponent: opponent
				? {
						id: opponent.id,
						name: opponent.name,
						sportTag: opponent.sportTag,
					}
				: null,
			trendSnapshot: {
				overall: overallSnapshot,
				contextual: contextualSnapshot,
			},
		};

		return { context: pickContext };
	},
);

/**
 * Derive the most specific snapshot type from venue and fav/dog roles.
 */
export function deriveSnapshotType(
	venueRole: VenueRole | null,
	favDogRole: FavDogRole | null,
): TrendSnapshotType {
	if (venueRole && favDogRole && favDogRole !== "pickem") {
		const combined = `${venueRole}_${favDogRole}` as TrendSnapshotType;
		const valid: TrendSnapshotType[] = [
			"home_favorite",
			"home_dog",
			"away_favorite",
			"away_dog",
		];
		if (valid.includes(combined)) return combined;
	}
	if (venueRole === "home") return "home";
	if (venueRole === "away") return "away";
	if (favDogRole === "favorite") return "favorite";
	if (favDogRole === "dog") return "dog";
	return "overall";
}

// ---------------------------------------------------------------------------
// Pipeline Status
// ---------------------------------------------------------------------------

/** Canonical pipeline health summary */
interface PipelineStatus {
	teams: number;
	games: { total: number; finalized: number };
	facts: number;
	snapshots: number;
	picks: { total: number; enriched: number; enrichmentRate: number | null };
}

/**
 * Get a summary of canonical pipeline health.
 * Total teams, games, facts, snapshots, and pick enrichment rate.
 *
 * Input: {} (no parameters)
 */
export const getPipelineStatusFn = createServerFn({
	method: "POST",
}).handler(async ({ context }) => {
		const db = getDb(context);

		const [teams, games, facts, snapshots, picksTotal, picksEnriched] =
			await Promise.all([
				first<{ count: number }>(db, "SELECT COUNT(*) as count FROM teams"),
				first<{ total: number; finalized: number }>(
					db,
					"SELECT COUNT(*) as total, SUM(CASE WHEN is_final = 1 THEN 1 ELSE 0 END) as finalized FROM games",
				),
				first<{ count: number }>(
					db,
					"SELECT COUNT(*) as count FROM team_game_facts",
				),
				first<{ count: number }>(
					db,
					"SELECT COUNT(*) as count FROM team_trend_snapshots",
				),
				first<{ count: number }>(
					db,
					"SELECT COUNT(*) as count FROM manual_picks",
				),
				first<{ count: number }>(
					db,
					"SELECT COUNT(*) as count FROM manual_picks WHERE team_id IS NOT NULL",
				),
			]);

		const total = picksTotal?.count ?? 0;
		const enriched = picksEnriched?.count ?? 0;

		const status: PipelineStatus = {
			teams: teams?.count ?? 0,
			games: {
				total: games?.total ?? 0,
				finalized: games?.finalized ?? 0,
			},
			facts: facts?.count ?? 0,
			snapshots: snapshots?.count ?? 0,
			picks: {
				total,
				enriched,
				enrichmentRate: total > 0 ? enriched / total : null,
			},
		};

		return { status };
	},
);
