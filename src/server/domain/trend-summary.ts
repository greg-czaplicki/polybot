/**
 * Trend Summary Domain Layer — Phase 4
 *
 * Higher-level summary builders that compose repository queries into
 * app-ready team trend summaries. Answers questions like:
 * - "Michigan last 10 as home favorite ATS"
 * - "Saint Louis last 10 as away underdog OU"
 * - "current ATS streak for team X"
 *
 * Consumers: server API functions (canonical-analytics.ts), app routes.
 * Not intended for direct frontend consumption.
 */

import type { Db } from "../db/client";
import {
	getTeamRecord,
	getTeamStreak,
	listTeamGameFacts,
} from "../repositories/team-game-facts";
import {
	getLatestTeamTrendSnapshot,
	getTeamTrendSnapshotAsOf,
} from "../repositories/team-trend-snapshots";
import { findTeamByAlias, getTeamById } from "../repositories/teams";
import type {
	FavDogRole,
	Team,
	TeamGameFact,
	TeamTrendSnapshot,
	TrendSnapshotType,
	VenueRole,
} from "../types/canonical";

// ---------------------------------------------------------------------------
// Types — app-ready shapes
// ---------------------------------------------------------------------------

/** Metric type for record/streak queries */
export type Metric = "su" | "ats" | "ou";

/** A formatted record (e.g., "7-3-0") */
export interface FormattedRecord {
	wins: number;
	losses: number;
	pushes: number;
	winPct: number | null;
	display: string; // e.g., "7-3-0"
}

/** A formatted streak (e.g., "W5") */
export interface FormattedStreak {
	type: "W" | "L";
	length: number;
	display: string; // e.g., "W5"
}

/** Full trend summary for a team in a specific split */
export interface TeamTrendSummary {
	team: { id: string; name: string; sportTag: string };
	split: {
		snapshotType: TrendSnapshotType;
		venueRole?: VenueRole;
		favDogRole?: FavDogRole;
		label: string; // e.g., "home favorite"
	};
	window: number;
	su: { record: FormattedRecord; streak: FormattedStreak | null };
	ats: {
		record: FormattedRecord;
		streak: FormattedStreak | null;
		avgCoverMargin: number | null;
	};
	ou: {
		record: FormattedRecord;
		streak: FormattedStreak | null;
		avgTotalMargin: number | null;
	};
	asOfTime: number | null;
	snapshotSource: "precomputed" | "live";
}

/** Compact trend line for a single metric in a split */
export interface TrendLine {
	metric: Metric;
	record: FormattedRecord;
	streak: FormattedStreak | null;
	avgMargin: number | null;
}

/** Multi-split overview: all 9 snapshot types for a team */
export interface TeamTrendOverview {
	team: { id: string; name: string; sportTag: string };
	splits: Record<TrendSnapshotType, TeamTrendSummary | null>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Human-readable label for a snapshot type */
export function snapshotTypeLabel(type: TrendSnapshotType): string {
	const labels: Record<TrendSnapshotType, string> = {
		overall: "Overall",
		home: "Home",
		away: "Away",
		favorite: "Favorite",
		dog: "Underdog",
		home_favorite: "Home Favorite",
		home_dog: "Home Underdog",
		away_favorite: "Away Favorite",
		away_dog: "Away Underdog",
	};
	return labels[type];
}

/** Derive venueRole/favDogRole filters from a snapshot type */
export function splitFiltersForSnapshotType(type: TrendSnapshotType): {
	venueRole?: VenueRole;
	favDogRole?: FavDogRole;
} {
	switch (type) {
		case "overall":
			return {};
		case "home":
			return { venueRole: "home" };
		case "away":
			return { venueRole: "away" };
		case "favorite":
			return { favDogRole: "favorite" };
		case "dog":
			return { favDogRole: "dog" };
		case "home_favorite":
			return { venueRole: "home", favDogRole: "favorite" };
		case "home_dog":
			return { venueRole: "home", favDogRole: "dog" };
		case "away_favorite":
			return { venueRole: "away", favDogRole: "favorite" };
		case "away_dog":
			return { venueRole: "away", favDogRole: "dog" };
	}
}

/** @internal Exported for testing */
export function formatRecord(
	wins: number,
	losses: number,
	pushes: number,
	winPct: number | null,
): FormattedRecord {
	return {
		wins,
		losses,
		pushes,
		winPct,
		display: `${wins}-${losses}${pushes > 0 ? `-${pushes}` : ""}`,
	};
}

/** @internal Exported for testing */
export function formatStreak(
	streak: { type: "W" | "L"; length: number } | null,
): FormattedStreak | null {
	if (!streak) return null;
	return { ...streak, display: `${streak.type}${streak.length}` };
}

// ---------------------------------------------------------------------------
// Core builders
// ---------------------------------------------------------------------------

/**
 * Build a full trend summary for a team in a specific split.
 *
 * Prefers precomputed snapshots when available, falls back to live
 * computation from team_game_facts.
 */
export async function buildTeamTrendSummary(
	db: Db,
	teamId: string,
	snapshotType: TrendSnapshotType,
	options?: {
		sportTag?: string;
		window?: number;
		asOfTime?: number;
	},
): Promise<TeamTrendSummary | null> {
	const team = await getTeamById(db, teamId);
	if (!team) return null;

	const sportTag = options?.sportTag ?? team.sportTag;
	const window = options?.window ?? 10;
	const filters = splitFiltersForSnapshotType(snapshotType);

	// Try precomputed snapshot first
	const snapshot = options?.asOfTime
		? await getTeamTrendSnapshotAsOf(
				db,
				teamId,
				snapshotType,
				options.asOfTime,
			)
		: await getLatestTeamTrendSnapshot(db, {
				teamId,
				snapshotType,
				sportTag,
			});

	if (snapshot) {
		return buildSummaryFromSnapshot(team, snapshotType, snapshot);
	}

	// Fall back to live computation from facts
	return buildSummaryLive(db, team, snapshotType, sportTag, window, filters);
}

/** Build summary from a precomputed snapshot */
function buildSummaryFromSnapshot(
	team: Team,
	snapshotType: TrendSnapshotType,
	snapshot: TeamTrendSnapshot,
): TeamTrendSummary {
	return {
		team: { id: team.id, name: team.name, sportTag: team.sportTag },
		split: {
			snapshotType,
			...splitFiltersForSnapshotType(snapshotType),
			label: snapshotTypeLabel(snapshotType),
		},
		window: snapshot.windowSize,
		su: {
			record: formatRecord(
				snapshot.suWins,
				snapshot.suLosses,
				snapshot.suPushes,
				snapshot.suWinPct ?? null,
			),
			streak: snapshot.suStreakType
				? formatStreak({
						type: snapshot.suStreakType,
						length: snapshot.suStreakLength,
					})
				: null,
		},
		ats: {
			record: formatRecord(
				snapshot.atsWins,
				snapshot.atsLosses,
				snapshot.atsPushes,
				snapshot.atsWinPct ?? null,
			),
			streak: snapshot.atsStreakType
				? formatStreak({
						type: snapshot.atsStreakType,
						length: snapshot.atsStreakLength,
					})
				: null,
			avgCoverMargin: snapshot.avgCoverMargin ?? null,
		},
		ou: {
			record: formatRecord(
				snapshot.ouOvers,
				snapshot.ouUnders,
				snapshot.ouPushes,
				snapshot.ouOverPct ?? null,
			),
			streak: snapshot.ouStreakType
				? formatStreak({
						type: snapshot.ouStreakType,
						length: snapshot.ouStreakLength,
					})
				: null,
			avgTotalMargin: snapshot.avgTotalMargin ?? null,
		},
		asOfTime: snapshot.asOfTime,
		snapshotSource: "precomputed",
	};
}

/** Build summary live from team_game_facts when no snapshot exists */
async function buildSummaryLive(
	db: Db,
	team: Team,
	snapshotType: TrendSnapshotType,
	sportTag: string,
	window: number,
	filters: { venueRole?: VenueRole; favDogRole?: FavDogRole },
): Promise<TeamTrendSummary> {
	const commonOpts = {
		sportTag,
		venueRole: filters.venueRole,
		favDogRole: filters.favDogRole,
		limit: window,
	};

	const [suRecord, atsRecord, ouRecord, suStreak, atsStreak, ouStreak, facts] =
		await Promise.all([
			getTeamRecord(db, team.id, "su", commonOpts),
			getTeamRecord(db, team.id, "ats", commonOpts),
			getTeamRecord(db, team.id, "ou", commonOpts),
			getTeamStreak(db, team.id, "su", {
				sportTag,
				...filters,
			}),
			getTeamStreak(db, team.id, "ats", {
				sportTag,
				...filters,
			}),
			getTeamStreak(db, team.id, "ou", {
				sportTag,
				...filters,
			}),
			listTeamGameFacts(db, {
				teamId: team.id,
				sportTag,
				...filters,
				limit: window,
			}),
		]);

	// Compute average margins from facts
	const validCoverMargins = facts
		.map((f) => f.coverMargin)
		.filter((m): m is number => m != null);
	const validTotalMargins = facts
		.map((f) => {
			if (f.actualTotal != null && f.totalLine != null)
				return f.actualTotal - f.totalLine;
			return null;
		})
		.filter((m): m is number => m != null);

	const avgCoverMargin =
		validCoverMargins.length > 0
			? validCoverMargins.reduce((s, v) => s + v, 0) /
				validCoverMargins.length
			: null;
	const avgTotalMargin =
		validTotalMargins.length > 0
			? validTotalMargins.reduce((s, v) => s + v, 0) /
				validTotalMargins.length
			: null;

	return {
		team: { id: team.id, name: team.name, sportTag: team.sportTag },
		split: {
			snapshotType,
			...filters,
			label: snapshotTypeLabel(snapshotType),
		},
		window,
		su: {
			record: formatRecord(
				suRecord.wins,
				suRecord.losses,
				suRecord.pushes,
				suRecord.winPct,
			),
			streak: formatStreak(suStreak),
		},
		ats: {
			record: formatRecord(
				atsRecord.wins,
				atsRecord.losses,
				atsRecord.pushes,
				atsRecord.winPct,
			),
			streak: formatStreak(atsStreak),
			avgCoverMargin,
		},
		ou: {
			record: formatRecord(
				ouRecord.wins,
				ouRecord.losses,
				ouRecord.pushes,
				ouRecord.winPct,
			),
			streak: formatStreak(ouStreak),
			avgTotalMargin,
		},
		asOfTime: facts[0]?.gameTime ?? null,
		snapshotSource: "live",
	};
}

/**
 * Build a multi-split overview for a team: all 9 snapshot types.
 * Used for the team trends dashboard.
 */
export async function buildTeamTrendOverview(
	db: Db,
	teamId: string,
	options?: { sportTag?: string },
): Promise<TeamTrendOverview | null> {
	const team = await getTeamById(db, teamId);
	if (!team) return null;

	const sportTag = options?.sportTag ?? team.sportTag;
	const snapshotTypes: TrendSnapshotType[] = [
		"overall",
		"home",
		"away",
		"favorite",
		"dog",
		"home_favorite",
		"home_dog",
		"away_favorite",
		"away_dog",
	];

	const summaries = await Promise.all(
		snapshotTypes.map((type) =>
			buildTeamTrendSummary(db, teamId, type, { sportTag }),
		),
	);

	const splits = {} as Record<TrendSnapshotType, TeamTrendSummary | null>;
	for (let i = 0; i < snapshotTypes.length; i++) {
		splits[snapshotTypes[i]] = summaries[i];
	}

	return {
		team: { id: team.id, name: team.name, sportTag: team.sportTag },
		splits,
	};
}

/**
 * Resolve a team by name/alias and build a trend summary.
 * Convenience method for API consumers that have a team name string.
 */
export async function buildTeamTrendSummaryByName(
	db: Db,
	teamName: string,
	sportTag: string,
	snapshotType: TrendSnapshotType,
	options?: { window?: number; asOfTime?: number },
): Promise<TeamTrendSummary | null> {
	const team = await findTeamByAlias(db, sportTag, teamName);
	if (!team) return null;

	return buildTeamTrendSummary(db, team.id, snapshotType, {
		sportTag,
		...options,
	});
}

/**
 * Get recent game facts for a team with a specific split, formatted for display.
 * Returns the raw facts that underlie a trend summary.
 */
export async function getRecentFactsForSplit(
	db: Db,
	teamId: string,
	snapshotType: TrendSnapshotType,
	options?: { sportTag?: string; limit?: number },
): Promise<TeamGameFact[]> {
	const filters = splitFiltersForSnapshotType(snapshotType);
	return listTeamGameFacts(db, {
		teamId,
		sportTag: options?.sportTag,
		...filters,
		limit: options?.limit ?? 10,
	});
}
