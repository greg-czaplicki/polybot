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
import { first } from "../db/client";
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
export const getTeamTrendSummaryFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as {
		teamId?: string;
		alias?: string;
		sportTag: string;
		snapshotType?: TrendSnapshotType;
		window?: number;
		asOfTime?: number;
	};

	if (!payload.sportTag) {
		return { summary: null, error: "sportTag is required" };
	}

	if (!payload.teamId && !payload.alias) {
		return { summary: null, error: "teamId or alias is required" };
	}

	const db = getDb(context);
	const snapshotType = payload.snapshotType ?? "overall";

	if (payload.alias && !payload.teamId) {
		const summary = await buildTeamTrendSummaryByName(
			db,
			payload.alias,
			payload.sportTag,
			snapshotType,
			{ window: payload.window, asOfTime: payload.asOfTime },
		);
		return { summary };
	}

	if (!payload.teamId) {
		return { summary: null, error: "teamId or alias is required" };
	}

	const summary = await buildTeamTrendSummary(
		db,
		payload.teamId,
		snapshotType,
		{
			sportTag: payload.sportTag,
			window: payload.window,
			asOfTime: payload.asOfTime,
		},
	);
	return { summary };
});

/**
 * Get a multi-split team trend overview (all 9 snapshot types).
 *
 * Input: { teamId?, alias?, sportTag }
 */
export const getTeamTrendOverviewFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as {
		teamId?: string;
		alias?: string;
		sportTag?: string;
	};

	const db = getDb(context);

	let teamId = payload.teamId;
	if (!teamId && payload.alias && payload.sportTag) {
		const team = await findTeamByAlias(db, payload.sportTag, payload.alias);
		if (!team) {
			return { overview: null, error: `Team not found: ${payload.alias}` };
		}
		teamId = team.id;
	}

	if (!teamId) {
		return { overview: null, error: "teamId or alias+sportTag is required" };
	}

	const overview = await buildTeamTrendOverview(db, teamId, {
		sportTag: payload.sportTag,
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
export const getMatchupComparisonFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as {
		teamId?: string;
		opponentId?: string;
		teamAlias?: string;
		opponentAlias?: string;
		sportTag: string;
		gameId?: string;
		teamVenueRole?: VenueRole;
		teamFavDogRole?: FavDogRole;
		asOfTime?: number;
	};

	if (!payload.sportTag) {
		return { comparison: null, error: "sportTag is required" };
	}

	const db = getDb(context);

	// If gameId provided, build comparison from game context
	if (payload.gameId && !payload.teamId && !payload.teamAlias) {
		const comparison = await buildMatchupComparisonFromGame(
			db,
			payload.gameId,
			{ asOfTime: payload.asOfTime },
		);
		return { comparison };
	}

	// Lookup by aliases
	if (payload.teamAlias && payload.opponentAlias) {
		const comparison = await buildMatchupComparisonByNames(
			db,
			payload.teamAlias,
			payload.opponentAlias,
			payload.sportTag,
			{
				gameId: payload.gameId,
				teamVenueRole: payload.teamVenueRole,
				teamFavDogRole: payload.teamFavDogRole,
				asOfTime: payload.asOfTime,
			},
		);
		return { comparison };
	}

	// Lookup by IDs
	if (!payload.teamId || !payload.opponentId) {
		return {
			comparison: null,
			error:
				"teamId+opponentId, teamAlias+opponentAlias, or gameId is required",
		};
	}

	const comparison = await buildMatchupComparison(
		db,
		payload.teamId,
		payload.opponentId,
		{
			sportTag: payload.sportTag,
			gameId: payload.gameId,
			teamVenueRole: payload.teamVenueRole,
			teamFavDogRole: payload.teamFavDogRole,
			asOfTime: payload.asOfTime,
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
export const getPickContextFn = createServerFn({ method: "POST" }).handler(
	async ({ context, data }) => {
		const payload = (data ?? {}) as { pickId: string };

		if (!payload.pickId) {
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
			payload.pickId,
		);

		if (!pick) {
			return { context: null, error: `Pick not found: ${payload.pickId}` };
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
export const getPipelineStatusFn = createServerFn({ method: "POST" }).handler(
	async ({ context }) => {
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
