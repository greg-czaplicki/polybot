/**
 * Canonical Debug / Validation API — Phase 3
 *
 * Server functions for validating the canonical sports context pipeline:
 * - Query team game facts by team/split/window
 * - Look up trend snapshots as-of a point in time
 * - Verify SU/ATS/OU grading for sample games
 * - Process games through the canonical pipeline
 * - Seed canonical teams (admin/validation)
 * - Ingest games and lines from market data (admin/validation)
 * - Run manual pick backfill (admin/validation)
 *
 * These endpoints prove the pipeline works end-to-end.
 * Not intended for production dashboard use.
 */

import { createServerFn } from "@tanstack/react-start";
import { getDb } from "../env";
import { processGame, processGames } from "../pipeline/canonical-pipeline";
import {
	type MarketGameInput,
	batchIngestGames,
	ingestGameFromMarketData,
} from "../pipeline/game-ingestion";
import {
	type MarketLineInput,
	batchIngestLines,
	ingestLineFromMarket,
} from "../pipeline/line-ingestion";
import { backfillManualPicks } from "../pipeline/pick-backfill";
import {
	type SeedResult,
	seedAllTeams,
	seedTeamsForSport,
} from "../pipeline/team-seeder";
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

// ---------------------------------------------------------------------------
// Admin/Validation: Team seeding
// ---------------------------------------------------------------------------

/**
 * Seed all teams for a specific sport (or all sports).
 * Admin-only — upserts canonical team records from built-in seed data.
 *
 * Input: { sportTag?: string }
 * If sportTag is omitted, seeds all sports.
 */
export const seedTeamsFn = createServerFn({ method: "POST" }).handler(
	async ({ context, data }) => {
		const payload = (data ?? {}) as { sportTag?: string };
		const db = getDb(context);

		let results: SeedResult[];
		if (payload.sportTag) {
			const result = await seedTeamsForSport(db, payload.sportTag);
			results = [result];
		} else {
			results = await seedAllTeams(db);
		}

		const totalSeeded = results.reduce((sum, r) => sum + r.seeded, 0);
		return { results, totalSeeded };
	},
);

// ---------------------------------------------------------------------------
// Admin/Validation: Game ingestion
// ---------------------------------------------------------------------------

/**
 * Ingest a single game from market data.
 * Admin-only — creates/matches a canonical game and persists final scores.
 *
 * Input: MarketGameInput
 */
export const ingestGameFn = createServerFn({ method: "POST" }).handler(
	async ({ context, data }) => {
		const payload = (data ?? {}) as MarketGameInput;

		if (!payload.marketTitle || !payload.sportTag || !payload.eventTime) {
			return {
				result: null,
				error: "marketTitle, sportTag, and eventTime are required",
			};
		}

		const db = getDb(context);
		const result = await ingestGameFromMarketData(db, payload);

		if (!result) {
			return {
				result: null,
				error: "Could not resolve teams from market title",
			};
		}

		return { result };
	},
);

/**
 * Batch ingest games from market data.
 * Admin-only — creates/matches canonical games in bulk.
 *
 * Input: { games: MarketGameInput[] }
 */
export const batchIngestGamesFn = createServerFn({ method: "POST" }).handler(
	async ({ context, data }) => {
		const payload = (data ?? {}) as { games: MarketGameInput[] };

		if (!payload.games || payload.games.length === 0) {
			return { result: null, error: "games array is required" };
		}

		const db = getDb(context);
		const result = await batchIngestGames(db, payload.games);

		return { result };
	},
);

// ---------------------------------------------------------------------------
// Admin/Validation: Line ingestion
// ---------------------------------------------------------------------------

/**
 * Ingest a single line from market data.
 * Admin-only — creates a game_line record.
 *
 * Input: MarketLineInput
 */
export const ingestLineFn = createServerFn({ method: "POST" }).handler(
	async ({ context, data }) => {
		const payload = (data ?? {}) as MarketLineInput;

		if (!payload.gameId || !payload.marketTitle || !payload.snapshotType) {
			return {
				result: null,
				error: "gameId, marketTitle, and snapshotType are required",
			};
		}

		const db = getDb(context);
		const result = await ingestLineFromMarket(db, payload);

		return { result };
	},
);

/**
 * Batch ingest lines from market data.
 * Admin-only — creates game_line records in bulk.
 *
 * Input: { lines: MarketLineInput[] }
 */
export const batchIngestLinesFn = createServerFn({ method: "POST" }).handler(
	async ({ context, data }) => {
		const payload = (data ?? {}) as { lines: MarketLineInput[] };

		if (!payload.lines || payload.lines.length === 0) {
			return { result: null, error: "lines array is required" };
		}

		const db = getDb(context);
		const result = await batchIngestLines(db, payload.lines);

		return { result };
	},
);

// ---------------------------------------------------------------------------
// Admin/Validation: Manual pick backfill
// ---------------------------------------------------------------------------

/**
 * Run manual pick backfill — links picks to canonical teams/games.
 * Admin-only — scans unlinked picks and attempts team/game resolution.
 *
 * Input: {} (no parameters needed)
 */
export const backfillPicksFn = createServerFn({ method: "POST" }).handler(
	async ({ context }) => {
		const db = getDb(context);
		const result = await backfillManualPicks(db);

		return { result };
	},
);
