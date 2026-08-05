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
import { all, run } from "../db/client";
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
	// Bound each window at the as-of game's start time (inclusive of the
	// game itself). Without this, a game fact-processed out of chronological
	// order writes a snapshot whose window contains games played AFTER its
	// as_of_time — lookahead that every retrospective as-of consumer inherits.
	const bound = { beforeGameTime: gameTime + 1 };
	const [home, away] = await Promise.all([
		computeSnapshotsForTeam(db, homeTeamId, sportTag, gameId, gameTime, bound),
		computeSnapshotsForTeam(db, awayTeamId, sportTag, gameId, gameTime, bound),
	]);

	return { home, away };
}

/**
 * After a late-processed game lands, snapshots for the same team stamped
 * with a LATER as_of_time were computed without it — their windows are
 * stale. Recompute every existing as-of row newer than the late game.
 * Normal chronological processing finds nothing to do.
 */
export async function repairSnapshotsAfterLateGame(
	db: Db,
	teamId: string,
	sportTag: string,
	lateGameTime: number,
): Promise<number> {
	const newer = await all<{ as_of_game_id: string; as_of_time: number }>(
		db,
		`SELECT DISTINCT as_of_game_id, as_of_time FROM team_trend_snapshots
		 WHERE team_id = ? AND sport_tag = ? AND as_of_time > ?`,
		teamId,
		sportTag,
		lateGameTime,
	);

	let recomputed = 0;
	for (const row of newer) {
		const result = await computeSnapshotsForTeam(
			db,
			teamId,
			sportTag,
			row.as_of_game_id,
			row.as_of_time,
			{ beforeGameTime: row.as_of_time + 1 },
		);
		recomputed += result.snapshotsComputed;
	}
	return recomputed;
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
		{ windowSize, beforeGameTime: mostRecent.gameTime + 1 },
	);
}

export interface RebuildSnapshotHistoryResult {
	teamId: string;
	sportTag: string;
	gamesProcessed: number;
	snapshotsComputed: number;
}

/**
 * Delete and rebuild a team's snapshot history — one as-of row per fact
 * game in chronological order, each window bounded at its as-of time.
 * Repair tool for teams whose snapshots were computed from corrupted or
 * out-of-order facts (e.g. the 2026-07-22 BAL@BOS duplicate-game incident).
 *
 * `sinceGameTime` limits the rebuild (and the delete) to as-of rows at or
 * after that time — use it to keep the D1 query count bounded when only a
 * recent stretch is contaminated.
 */
export async function rebuildSnapshotHistoryForTeam(
	db: Db,
	teamId: string,
	sportTag: string,
	options?: { windowSize?: number; sinceGameTime?: number },
): Promise<RebuildSnapshotHistoryResult> {
	const since = options?.sinceGameTime ?? 0;

	const games = await all<{ game_id: string; game_time: number }>(
		db,
		`SELECT DISTINCT game_id, game_time FROM team_game_facts
		 WHERE team_id = ? AND sport_tag = ? AND game_time >= ?
		 ORDER BY game_time ASC`,
		teamId,
		sportTag,
		since,
	);

	await run(
		db,
		`DELETE FROM team_trend_snapshots
		 WHERE team_id = ? AND sport_tag = ? AND as_of_time >= ?`,
		teamId,
		sportTag,
		since,
	);

	let snapshotsComputed = 0;
	for (const game of games) {
		const result = await computeSnapshotsForTeam(
			db,
			teamId,
			sportTag,
			game.game_id,
			game.game_time,
			{
				windowSize: options?.windowSize,
				beforeGameTime: game.game_time + 1,
			},
		);
		snapshotsComputed += result.snapshotsComputed;
	}

	return {
		teamId,
		sportTag,
		gamesProcessed: games.length,
		snapshotsComputed,
	};
}

export interface BackfillSnapshotsResult {
	processedTeams: number;
	totalSnapshotsComputed: number;
	perSport: Record<string, { teams: number; snapshots: number }>;
	errors: Array<{ teamId: string; sportTag: string; error: string }>;
}

/**
 * Find every (team_id, sport_tag) pair that has team_game_facts but no
 * team_trend_snapshots, and recompute snapshots for each. Covers the gap
 * where facts were computed via a path that did not trigger snapshot compute
 * (or earlier code versions that only computed facts).
 *
 * Idempotent: safe to re-run. Each team's snapshots are deleted and rebuilt.
 */
export async function backfillMissingSnapshots(
	db: Db,
	options?: { sportTag?: string; windowSize?: number; limit?: number },
): Promise<BackfillSnapshotsResult> {
	const { sportTag, windowSize, limit = 500 } = options ?? {};

	const params: unknown[] = [];
	let sportFilter = "";
	if (sportTag) {
		sportFilter = "AND tgf.sport_tag = ?";
		params.push(sportTag);
	}
	params.push(limit);

	const rows = await all<{ team_id: string; sport_tag: string }>(
		db,
		`SELECT DISTINCT tgf.team_id, tgf.sport_tag
		FROM team_game_facts tgf
		LEFT JOIN team_trend_snapshots tts
			ON tts.team_id = tgf.team_id AND tts.sport_tag = tgf.sport_tag
		WHERE tts.id IS NULL ${sportFilter}
		LIMIT ?`,
		...params,
	);

	const result: BackfillSnapshotsResult = {
		processedTeams: 0,
		totalSnapshotsComputed: 0,
		perSport: {},
		errors: [],
	};

	for (const row of rows) {
		try {
			const recompute = await recomputeAllSnapshotsForTeam(
				db,
				row.team_id,
				row.sport_tag,
				{ windowSize },
			);
			result.processedTeams += 1;
			result.totalSnapshotsComputed += recompute.snapshotsComputed;
			const bucket =
				result.perSport[row.sport_tag] ??
				(result.perSport[row.sport_tag] = { teams: 0, snapshots: 0 });
			bucket.teams += 1;
			bucket.snapshots += recompute.snapshotsComputed;
		} catch (err) {
			result.errors.push({
				teamId: row.team_id,
				sportTag: row.sport_tag,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return result;
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
						(
							f,
						): f is TeamGameFact & {
							actualTotal: number;
							totalLine: number;
						} => f.actualTotal !== undefined && f.totalLine !== undefined,
					)
					.map((f) => f.actualTotal - f.totalLine);

	if (values.length === 0) return undefined;

	const sum = values.reduce((a, b) => a + b, 0);
	return Math.round((sum / values.length) * 100) / 100;
}
