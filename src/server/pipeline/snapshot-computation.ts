/**
 * Snapshot Computation — Phase 3
 *
 * Recomputes the 9 canonical `team_trend_snapshots` types for a team
 * after fact inserts. Each snapshot is a rolling window (default 10 games)
 * of SU / ATS / OU records, streaks, and margins for a specific split.
 *
 * Snapshot types:
 *   overall, home, away, favorite, dog,
 *   home_favorite, home_dog, away_favorite, away_dog
 *
 * Grading and streak rules follow docs/stats-spec/grading-rules.md §6.
 */

import type { Db } from "../db/client";
import { listTeamGameFacts } from "../repositories/team-game-facts";
import {
	deleteTeamTrendSnapshots,
	type UpsertTeamTrendSnapshotInput,
	upsertTeamTrendSnapshot,
} from "../repositories/team-trend-snapshots";
import {
	type TeamGameFact,
	type TeamGameFactFilter,
	TREND_SNAPSHOT_TYPES,
	type TrendSnapshotType,
} from "../types/canonical";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ComputeSnapshotsOptions {
	/** Rolling window size (default 10) */
	windowSize?: number;
	/** If set, only compute snapshots as-of this game */
	asOfGameId?: string;
	/** If set, only compute snapshots before this time */
	beforeGameTime?: number;
}

export interface ComputeSnapshotsResult {
	teamId: string;
	sportTag: string;
	snapshotsComputed: number;
	warnings: string[];
}

/**
 * Recompute all 9 trend snapshots for a team in a given sport.
 *
 * For each snapshot type, queries the relevant subset of team_game_facts
 * (filtered by venue_role and/or fav_dog_role), computes the rolling stats
 * over the most recent `windowSize` games, and upserts the snapshot.
 */
export async function computeSnapshotsForTeam(
	db: Db,
	teamId: string,
	sportTag: string,
	asOfGameId: string,
	asOfTime: number,
	options?: ComputeSnapshotsOptions,
): Promise<ComputeSnapshotsResult> {
	const windowSize = options?.windowSize ?? 10;
	const warnings: string[] = [];
	let snapshotsComputed = 0;

	for (const snapshotType of TREND_SNAPSHOT_TYPES) {
		const filter = buildFilterForSnapshotType(
			teamId,
			sportTag,
			snapshotType,
			windowSize,
			options?.beforeGameTime,
		);

		const facts = await listTeamGameFacts(db, filter);

		if (facts.length === 0) {
			// No facts for this split — skip rather than writing an empty snapshot
			continue;
		}

		const snapshot = computeSnapshotFromFacts(
			facts,
			teamId,
			asOfGameId,
			asOfTime,
			sportTag,
			snapshotType,
			windowSize,
		);

		await upsertTeamTrendSnapshot(db, snapshot);
		snapshotsComputed++;
	}

	return { teamId, sportTag, snapshotsComputed, warnings };
}

/**
 * Recompute snapshots for both teams in a game.
 * Convenience method after computing facts for a game.
 */
export async function computeSnapshotsForGame(
	db: Db,
	gameId: string,
	homeTeamId: string,
	awayTeamId: string,
	sportTag: string,
	gameTime: number,
): Promise<{
	home: ComputeSnapshotsResult;
	away: ComputeSnapshotsResult;
}> {
	const [home, away] = await Promise.all([
		computeSnapshotsForTeam(db, homeTeamId, sportTag, gameId, gameTime),
		computeSnapshotsForTeam(db, awayTeamId, sportTag, gameId, gameTime),
	]);

	return { home, away };
}

/**
 * Full recompute: delete existing snapshots for a team/sport and rebuild
 * from all available facts. Useful for backfill scenarios.
 */
export async function recomputeAllSnapshotsForTeam(
	db: Db,
	teamId: string,
	sportTag: string,
	options?: { windowSize?: number },
): Promise<ComputeSnapshotsResult> {
	const windowSize = options?.windowSize ?? 10;

	// Get all facts for this team, ordered by game_time DESC
	const allFacts = await listTeamGameFacts(db, {
		teamId,
		sportTag,
		limit: 1000,
	});

	if (allFacts.length === 0) {
		return {
			teamId,
			sportTag,
			snapshotsComputed: 0,
			warnings: ["No facts found"],
		};
	}

	// Delete existing snapshots
	await deleteTeamTrendSnapshots(db, teamId, sportTag);

	// Use the most recent fact as the as-of reference
	const mostRecent = allFacts[0];

	return computeSnapshotsForTeam(
		db,
		teamId,
		sportTag,
		mostRecent.gameId,
		mostRecent.gameTime,
		{ windowSize },
	);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a TeamGameFactFilter for a given snapshot type.
 * Maps snapshot types to venue_role / fav_dog_role constraints.
 */
function buildFilterForSnapshotType(
	teamId: string,
	sportTag: string,
	snapshotType: TrendSnapshotType,
	windowSize: number,
	beforeGameTime?: number,
): TeamGameFactFilter {
	const base: TeamGameFactFilter = {
		teamId,
		sportTag,
		limit: windowSize,
		beforeGameTime,
	};

	switch (snapshotType) {
		case "overall":
			return base;
		case "home":
			return { ...base, venueRole: "home" };
		case "away":
			return { ...base, venueRole: "away" };
		case "favorite":
			return { ...base, favDogRole: "favorite" };
		case "dog":
			return { ...base, favDogRole: "dog" };
		case "home_favorite":
			return { ...base, venueRole: "home", favDogRole: "favorite" };
		case "home_dog":
			return { ...base, venueRole: "home", favDogRole: "dog" };
		case "away_favorite":
			return { ...base, venueRole: "away", favDogRole: "favorite" };
		case "away_dog":
			return { ...base, venueRole: "away", favDogRole: "dog" };
		default: {
			const _exhaustive: never = snapshotType;
			throw new Error(`Unknown snapshot type: ${_exhaustive}`);
		}
	}
}

/**
 * Compute a single trend snapshot from a list of team game facts.
 * Facts are expected to be in reverse chronological order (most recent first).
 */
function computeSnapshotFromFacts(
	facts: TeamGameFact[],
	teamId: string,
	asOfGameId: string,
	asOfTime: number,
	sportTag: string,
	snapshotType: TrendSnapshotType,
	windowSize: number,
): UpsertTeamTrendSnapshotInput {
	// SU record
	const suWins = countResults(facts, "su", "win");
	const suLosses = countResults(facts, "su", "loss");
	const suPushes = countResults(facts, "su", "push");

	// ATS record
	const atsWins = countResults(facts, "ats", "cover");
	const atsLosses = countResults(facts, "ats", "no_cover");
	const atsPushes = countResults(facts, "ats", "push");

	// OU record
	const ouOvers = countResults(facts, "ou", "over");
	const ouUnders = countResults(facts, "ou", "under");
	const ouPushes = countResults(facts, "ou", "push");

	// Streaks (computed from facts in reverse-chrono order, skipping pushes)
	const suStreak = computeStreak(facts, "su");
	const atsStreak = computeStreak(facts, "ats");
	const ouStreak = computeStreak(facts, "ou");

	// Average margins
	const avgCoverMargin = computeAvgMargin(facts, "cover");
	const avgTotalMargin = computeAvgMargin(facts, "total");

	return {
		teamId,
		asOfGameId,
		asOfTime,
		sportTag,
		snapshotType,
		windowSize,
		suWins,
		suLosses,
		suPushes,
		atsWins,
		atsLosses,
		atsPushes,
		ouOvers,
		ouUnders,
		ouPushes,
		atsStreakType: atsStreak?.type,
		atsStreakLength: atsStreak?.length ?? 0,
		ouStreakType: ouStreak?.type,
		ouStreakLength: ouStreak?.length ?? 0,
		suStreakType: suStreak?.type,
		suStreakLength: suStreak?.length ?? 0,
		avgCoverMargin,
		avgTotalMargin,
	};
}

type MetricType = "su" | "ats" | "ou";

/**
 * Count occurrences of a specific result value within the metric column.
 */
function countResults(
	facts: TeamGameFact[],
	metric: MetricType,
	value: string,
): number {
	return facts.filter((f) => getResultValue(f, metric) === value).length;
}

/**
 * Get the result value for a fact by metric type.
 */
function getResultValue(
	fact: TeamGameFact,
	metric: MetricType,
): string | undefined {
	switch (metric) {
		case "su":
			return fact.suResult;
		case "ats":
			return fact.atsResult;
		case "ou":
			return fact.ouResult;
	}
}

/**
 * Compute streak from facts (reverse-chrono order).
 * Per grading-rules.md §6.1: pushes are skipped, pending excluded.
 *
 * For SU: W = win, L = loss
 * For ATS: W = cover, L = no_cover
 * For OU: W = over, L = under
 */
function computeStreak(
	facts: TeamGameFact[],
	metric: MetricType,
): { type: "W" | "L"; length: number } | null {
	let streakType: "W" | "L" | null = null;
	let streakLength = 0;

	for (const fact of facts) {
		const direction = getStreakDirection(fact, metric);
		if (direction === null) continue; // skip pushes and nulls

		if (streakType === null) {
			streakType = direction;
			streakLength = 1;
		} else if (direction === streakType) {
			streakLength++;
		} else {
			break;
		}
	}

	if (streakType === null) return null;
	return { type: streakType, length: streakLength };
}

/**
 * Map a fact's result to a streak direction (W/L) for a given metric.
 * Returns null for pushes and missing values (which are skipped per spec).
 */
function getStreakDirection(
	fact: TeamGameFact,
	metric: MetricType,
): "W" | "L" | null {
	switch (metric) {
		case "su":
			if (fact.suResult === "win") return "W";
			if (fact.suResult === "loss") return "L";
			return null;
		case "ats":
			if (fact.atsResult === "cover") return "W";
			if (fact.atsResult === "no_cover") return "L";
			return null;
		case "ou":
			if (fact.ouResult === "over") return "W";
			if (fact.ouResult === "under") return "L";
			return null;
	}
}

/**
 * Compute average margin for facts that have the relevant value.
 * For "cover": average of cover_margin (how much the spread was beaten by).
 * For "total": average of total_margin = actual_total - total_line (per metric-definitions.md).
 */
function computeAvgMargin(
	facts: TeamGameFact[],
	type: "cover" | "total",
): number | undefined {
	const values =
		type === "cover"
			? facts
					.map((f) => f.coverMargin)
					.filter((v): v is number => v !== undefined)
			: facts
					.filter(
						(f) => f.actualTotal !== undefined && f.totalLine !== undefined,
					)
					.map((f) => f.actualTotal! - f.totalLine!);

	if (values.length === 0) return undefined;

	const sum = values.reduce((a, b) => a + b, 0);
	return Math.round((sum / values.length) * 100) / 100;
}
