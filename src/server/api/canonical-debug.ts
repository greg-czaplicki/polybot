/**
 * Canonical Debug / Validation API — Phase 3
 *
 * Server functions for validating the canonical sports context pipeline:
 * - Query team game facts by team/split/window
 * - Look up trend snapshots as-of a point in time
 * - Verify SU/ATS/OU grading for sample games
 * - Process games through the canonical pipeline
 *
 * These endpoints prove the pipeline works end-to-end.
 * Not intended for production dashboard use.
 */

import { createServerFn } from "@tanstack/react-start";
import { getDb } from "../env";
import { processGame, processGames } from "../pipeline/canonical-pipeline";
import { getGameLines } from "../repositories/game-lines";
import { getGameById } from "../repositories/games";
import {
	getTeamGameFact,
	getTeamRecord,
	getTeamStreak,
	listTeamGameFacts,
} from "../repositories/team-game-facts";
import {
	getLatestTeamTrendSnapshot,
	getTeamTrendSnapshotAsOf,
	listTeamTrendSnapshots,
} from "../repositories/team-trend-snapshots";
import { findTeamByAlias, getTeamById } from "../repositories/teams";
import type {
	FavDogRole,
	TeamGameFactFilter,
	TrendSnapshotType,
	VenueRole,
} from "../types/canonical";

// ---------------------------------------------------------------------------
// Validation: Query team game facts by split
// ---------------------------------------------------------------------------

/**
 * Query team game facts with filters.
 * Proves: "Michigan last 10 as home favorite ATS" can be answered.
 *
 * Input: { teamId, sportTag?, venueRole?, favDogRole?, limit? }
 */
export const queryTeamFactsFn = createServerFn({ method: "POST" }).handler(
	async ({ context, data }) => {
		const payload = (data ?? {}) as {
			teamId: string;
			sportTag?: string;
			venueRole?: VenueRole;
			favDogRole?: FavDogRole;
			season?: string;
			limit?: number;
		};

		if (!payload.teamId) {
			return { facts: [], error: "teamId is required" };
		}

		const db = getDb(context);
		const filter: TeamGameFactFilter = {
			teamId: payload.teamId,
			sportTag: payload.sportTag,
			venueRole: payload.venueRole,
			favDogRole: payload.favDogRole,
			season: payload.season,
			limit: payload.limit ?? 10,
		};

		const facts = await listTeamGameFacts(db, filter);
		return { facts, count: facts.length };
	},
);

// ---------------------------------------------------------------------------
// Validation: Team record by metric and split
// ---------------------------------------------------------------------------

/**
 * Get win/loss/push record for a team.
 * Proves: SU/ATS/OU records can be computed by split.
 *
 * Input: { teamId, metric: "su"|"ats"|"ou", sportTag?, venueRole?, favDogRole?, limit? }
 */
export const queryTeamRecordFn = createServerFn({ method: "POST" }).handler(
	async ({ context, data }) => {
		const payload = (data ?? {}) as {
			teamId: string;
			metric: "su" | "ats" | "ou";
			sportTag?: string;
			season?: string;
			venueRole?: VenueRole;
			favDogRole?: FavDogRole;
			limit?: number;
		};

		if (!payload.teamId || !payload.metric) {
			return { record: null, error: "teamId and metric are required" };
		}

		const db = getDb(context);
		const record = await getTeamRecord(db, payload.teamId, payload.metric, {
			sportTag: payload.sportTag,
			season: payload.season,
			venueRole: payload.venueRole,
			favDogRole: payload.favDogRole,
			limit: payload.limit,
		});

		return { record };
	},
);

// ---------------------------------------------------------------------------
// Validation: Current streak
// ---------------------------------------------------------------------------

/**
 * Get current streak for a team.
 * Proves: "current ATS streak for team X" can be answered.
 *
 * Input: { teamId, metric: "su"|"ats"|"ou", sportTag?, venueRole?, favDogRole? }
 */
export const queryTeamStreakFn = createServerFn({ method: "POST" }).handler(
	async ({ context, data }) => {
		const payload = (data ?? {}) as {
			teamId: string;
			metric: "su" | "ats" | "ou";
			sportTag?: string;
			venueRole?: VenueRole;
			favDogRole?: FavDogRole;
		};

		if (!payload.teamId || !payload.metric) {
			return { streak: null, error: "teamId and metric are required" };
		}

		const db = getDb(context);
		const streak = await getTeamStreak(db, payload.teamId, payload.metric, {
			sportTag: payload.sportTag,
			venueRole: payload.venueRole,
			favDogRole: payload.favDogRole,
		});

		return {
			streak,
			display: streak ? `${streak.type}${streak.length}` : "—",
		};
	},
);

// ---------------------------------------------------------------------------
// Validation: Trend snapshot lookup
// ---------------------------------------------------------------------------

/**
 * Get the trend snapshot that was active at a given time.
 * Proves: "what trend snapshot was active when this pick was made?"
 *
 * Input: { teamId, snapshotType, asOfTime }
 */
export const queryTrendSnapshotAsOfFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as {
		teamId: string;
		snapshotType: TrendSnapshotType;
		asOfTime: number;
	};

	if (!payload.teamId || !payload.snapshotType || !payload.asOfTime) {
		return {
			snapshot: null,
			error: "teamId, snapshotType, and asOfTime are required",
		};
	}

	const db = getDb(context);
	const snapshot = await getTeamTrendSnapshotAsOf(
		db,
		payload.teamId,
		payload.snapshotType,
		payload.asOfTime,
	);

	return { snapshot };
});

/**
 * Get the latest trend snapshot for a team by type.
 *
 * Input: { teamId, snapshotType?, sportTag? }
 */
export const queryLatestTrendSnapshotFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as {
		teamId: string;
		snapshotType?: TrendSnapshotType;
		sportTag?: string;
	};

	if (!payload.teamId) {
		return { snapshot: null, error: "teamId is required" };
	}

	const db = getDb(context);
	const snapshot = await getLatestTeamTrendSnapshot(db, {
		teamId: payload.teamId,
		snapshotType: payload.snapshotType,
		sportTag: payload.sportTag,
	});

	return { snapshot };
});

/**
 * List all trend snapshots for a team.
 *
 * Input: { teamId, sportTag?, snapshotType? }
 */
export const listTrendSnapshotsFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as {
		teamId: string;
		sportTag?: string;
		snapshotType?: TrendSnapshotType;
	};

	if (!payload.teamId) {
		return { snapshots: [], error: "teamId is required" };
	}

	const db = getDb(context);
	const snapshots = await listTeamTrendSnapshots(db, payload.teamId, {
		sportTag: payload.sportTag,
		snapshotType: payload.snapshotType,
	});

	return { snapshots, count: snapshots.length };
});

// ---------------------------------------------------------------------------
// Validation: Game detail + facts
// ---------------------------------------------------------------------------

/**
 * Get full game context: game, lines, and facts for both teams.
 * Proves: SU/ATS/OU outcomes match expected results for a game.
 *
 * Input: { gameId }
 */
export const queryGameDetailFn = createServerFn({ method: "POST" }).handler(
	async ({ context, data }) => {
		const payload = (data ?? {}) as { gameId: string };

		if (!payload.gameId) {
			return { game: null, error: "gameId is required" };
		}

		const db = getDb(context);
		const game = await getGameById(db, payload.gameId);
		if (!game) {
			return { game: null, error: `Game not found: ${payload.gameId}` };
		}

		const lines = await getGameLines(db, payload.gameId);

		const [homeFact, awayFact, homeTeam, awayTeam] = await Promise.all([
			getTeamGameFact(db, game.homeTeamId, payload.gameId),
			getTeamGameFact(db, game.awayTeamId, payload.gameId),
			getTeamById(db, game.homeTeamId),
			getTeamById(db, game.awayTeamId),
		]);

		return {
			game,
			lines,
			homeTeam,
			awayTeam,
			homeFact,
			awayFact,
		};
	},
);

// ---------------------------------------------------------------------------
// Validation: Team lookup by alias
// ---------------------------------------------------------------------------

/**
 * Resolve a team name/alias to a canonical team.
 *
 * Input: { alias, sportTag }
 */
export const resolveTeamFn = createServerFn({ method: "POST" }).handler(
	async ({ context, data }) => {
		const payload = (data ?? {}) as { alias: string; sportTag: string };

		if (!payload.alias || !payload.sportTag) {
			return { team: null, error: "alias and sportTag are required" };
		}

		const db = getDb(context);
		const team = await findTeamByAlias(db, payload.sportTag, payload.alias);

		return { team };
	},
);

// ---------------------------------------------------------------------------
// Pipeline: Process game(s)
// ---------------------------------------------------------------------------

/**
 * Process a single game through the canonical pipeline.
 * Computes facts + snapshots.
 *
 * Input: { gameId }
 */
export const processGameFn = createServerFn({ method: "POST" }).handler(
	async ({ context, data }) => {
		const payload = (data ?? {}) as { gameId: string };

		if (!payload.gameId) {
			return { result: null, error: "gameId is required" };
		}

		const db = getDb(context);
		const result = await processGame(db, payload.gameId);

		return { result };
	},
);

/**
 * Process multiple games through the canonical pipeline.
 *
 * Input: { gameIds: string[] }
 */
export const processGamesFn = createServerFn({ method: "POST" }).handler(
	async ({ context, data }) => {
		const payload = (data ?? {}) as { gameIds: string[] };

		if (!payload.gameIds || payload.gameIds.length === 0) {
			return { result: null, error: "gameIds array is required" };
		}

		const db = getDb(context);
		const result = await processGames(db, payload.gameIds);

		return { result };
	},
);
