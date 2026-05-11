/**
 * Opportunity Ranking Repository — Phase 8
 *
 * Loads upcoming opportunities from two sources:
 * 1. Pending manual picks (primary — already identified opportunities)
 * 2. Upcoming canonical games (secondary — all non-final games)
 *
 * Joins canonical trend context via latest snapshots, scores each
 * opportunity, and returns a ranked list.
 *
 * Leakage safety:
 * - Only pre-pick features feed the scorer.
 * - actual_margin, actual_total, roi, clv are never read for scoring.
 * - Snapshot lookup uses getLatestTeamTrendSnapshot (current form).
 */

import { deriveSnapshotType } from "../api/canonical-analytics";
import type { Db } from "../db/client";
import { all } from "../db/client";
import {
	deriveOpponentSnapshotType,
	extractSideFeatures,
} from "../domain/canonical-features";
import {
	type OpportunityScore,
	type PrePickFeatures,
	type ScoringFactor,
	scoreOpportunity,
} from "../domain/opportunity-scoring";
import type { ScoringConfig } from "../domain/scoring-weights";
import { nowUnixSeconds } from "../env";
import type {
	FavDogRole,
	TeamTrendSnapshot,
	VenueRole,
} from "../types/canonical";
import { getLatestTeamTrendSnapshot } from "./team-trend-snapshots";

// ---------------------------------------------------------------------------
// Re-export scoring types for API consumers
// ---------------------------------------------------------------------------

export type { ScoringFactor, OpportunityScore, PrePickFeatures };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single ranked opportunity with full score explanation. */
export interface RankedOpportunity {
	/** Pick ID or game-side ID */
	pickId: string;
	/** Human-readable matchup label (e.g., "Lakers vs Celtics") */
	matchupLabel: string;
	sportTag: string | null;
	betType: string | null;
	venueRole: string | null;
	favDogRole: string | null;
	spreadLine: number | null;
	totalLine: number | null;
	eventTime: string | null;
	/** Normalized score 0–100 */
	totalScore: number;
	/** All contributing factors */
	factors: ScoringFactor[];
	/** Warning messages */
	warnings: string[];
	/** Rank position (1-based) */
	rank: number;
	/** Additional metadata */
	signalScore: number | null;
	edgeRating: number | null;
	grade: string | null;
}

/** Summary returned by the ranking query. */
export interface RankedOpportunitySummary {
	computedAt: number;
	totalCandidates: number;
	scoredCount: number;
	excludedCount: number;
	opportunities: RankedOpportunity[];
}

// ---------------------------------------------------------------------------
// Pending picks query (primary source)
// ---------------------------------------------------------------------------

interface PendingPickRow {
	id: string;
	market_title: string;
	picked_at: number;
	sport_tag: string | null;
	bet_type: string | null;
	venue_role: string | null;
	fav_dog_role: string | null;
	spread_line: number | null;
	total_line: number | null;
	team_id: string | null;
	opponent_id: string | null;
	team_name: string | null;
	opponent_name: string | null;
	event_time: string | null;
	signal_score: number | null;
	edge_rating: number | null;
	grade: string | null;
}

const PENDING_PICKS_QUERY = `
	SELECT
		mp.id, mp.market_title, mp.picked_at,
		mp.sport_tag, mp.bet_type, mp.venue_role, mp.fav_dog_role,
		mp.spread_line, mp.total_line, mp.team_id, mp.opponent_id,
		mp.event_time, mp.signal_score, mp.edge_rating, mp.grade,
		t.name AS team_name,
		o.name AS opponent_name
	FROM manual_picks mp
	LEFT JOIN teams t ON mp.team_id = t.id
	LEFT JOIN teams o ON mp.opponent_id = o.id
	WHERE mp.status = 'pending'
	  AND mp.team_id IS NOT NULL
	ORDER BY mp.picked_at DESC
	LIMIT ?
`;

// ---------------------------------------------------------------------------
// Upcoming games query (secondary source)
// ---------------------------------------------------------------------------

interface UpcomingGameRow {
	id: string;
	sport_tag: string;
	game_time: number | null;
	home_team_id: string;
	away_team_id: string;
	home_team_name: string | null;
	away_team_name: string | null;
	home_spread: number | null;
	total_line: number | null;
}

const UPCOMING_GAMES_QUERY = `
	SELECT
		g.id, g.sport_tag, g.game_time,
		g.home_team_id, g.away_team_id,
		ht.name AS home_team_name,
		at2.name AS away_team_name,
		gl.home_spread,
		gl.total_line
	FROM games g
	LEFT JOIN teams ht ON g.home_team_id = ht.id
	LEFT JOIN teams at2 ON g.away_team_id = at2.id
	LEFT JOIN game_lines gl ON g.id = gl.game_id AND gl.snapshot_type = 'open'
	WHERE g.is_final = 0
	  AND g.game_time > ?
	ORDER BY g.game_time ASC
	LIMIT ?
`;

// ---------------------------------------------------------------------------
// Shared feature extraction
// ---------------------------------------------------------------------------

async function loadSideSnapshots(
	db: Db,
	teamId: string,
	snapshotType: ReturnType<typeof deriveSnapshotType>,
): Promise<{
	overall: TeamTrendSnapshot | null;
	split: TeamTrendSnapshot | null;
}> {
	const promises: Promise<TeamTrendSnapshot | null>[] = [
		getLatestTeamTrendSnapshot(db, { teamId, snapshotType: "overall" }),
	];
	if (snapshotType !== "overall") {
		promises.push(getLatestTeamTrendSnapshot(db, { teamId, snapshotType }));
	}
	const [overall, split] = await Promise.all(promises);
	return { overall, split: split ?? null };
}

export async function buildPrePickFeatures(
	db: Db,
	teamId: string | null,
	opponentId: string | null,
	venueRole: VenueRole | null,
	favDogRole: FavDogRole | null,
	sportTag: string | null,
	betType: string | null,
	spreadLine: number | null,
	totalLine: number | null,
): Promise<PrePickFeatures> {
	const snapshotType = deriveSnapshotType(venueRole, favDogRole);

	let teamOverall: TeamTrendSnapshot | null = null;
	let teamSplit: TeamTrendSnapshot | null = null;
	if (teamId) {
		const s = await loadSideSnapshots(db, teamId, snapshotType);
		teamOverall = s.overall;
		teamSplit = s.split;
	}

	let opponentOverall: TeamTrendSnapshot | null = null;
	let opponentSplit: TeamTrendSnapshot | null = null;
	if (opponentId) {
		const oppSnapshotType = deriveOpponentSnapshotType(venueRole, favDogRole);
		const s = await loadSideSnapshots(db, opponentId, oppSnapshotType);
		opponentOverall = s.overall;
		opponentSplit = s.split;
	}

	const teamFeatures = extractSideFeatures(teamOverall, teamSplit);
	const opponentFeatures = extractSideFeatures(opponentOverall, opponentSplit);

	const matchupAtsDelta =
		teamFeatures.atsWinPct != null && opponentFeatures.atsWinPct != null
			? teamFeatures.atsWinPct - opponentFeatures.atsWinPct
			: null;
	const matchupOuDelta =
		teamFeatures.ouOverPct != null && opponentFeatures.ouOverPct != null
			? teamFeatures.ouOverPct - opponentFeatures.ouOverPct
			: null;
	const matchupCoverMarginDelta =
		teamFeatures.avgCoverMargin != null &&
		opponentFeatures.avgCoverMargin != null
			? teamFeatures.avgCoverMargin - opponentFeatures.avgCoverMargin
			: null;

	return {
		sportTag,
		betType,
		venueRole,
		favDogRole,
		spreadLine,
		totalLine,
		pickedDirection: null,
		team: teamFeatures,
		opponent: opponentFeatures,
		matchupAtsDelta,
		matchupOuDelta,
		matchupCoverMarginDelta,
		teamSnapshotFound: teamOverall !== null,
		opponentSnapshotFound: opponentOverall !== null,
	};
}

// ---------------------------------------------------------------------------
// Ranking from pending picks
// ---------------------------------------------------------------------------

async function rankPendingPicks(
	db: Db,
	limit: number,
	config?: ScoringConfig,
): Promise<{
	picks: PendingPickRow[];
	scored: Array<{ pick: PendingPickRow; scoring: OpportunityScore }>;
}> {
	const picks = await all<PendingPickRow>(db, PENDING_PICKS_QUERY, limit);

	const scored = await Promise.all(
		picks.map(async (pick) => {
			const features = await buildPrePickFeatures(
				db,
				pick.team_id,
				pick.opponent_id,
				(pick.venue_role as VenueRole) ?? null,
				(pick.fav_dog_role as FavDogRole) ?? null,
				pick.sport_tag,
				pick.bet_type,
				pick.spread_line,
				pick.total_line,
			);
			const scoring = scoreOpportunity(features, config);
			return { pick, scoring };
		}),
	);

	scored.sort((a, b) => b.scoring.totalScore - a.scoring.totalScore);
	return { picks, scored };
}

// ---------------------------------------------------------------------------
// Ranking from upcoming games
// ---------------------------------------------------------------------------

async function rankUpcomingGames(
	db: Db,
	limit: number,
	sportTag?: string,
	config?: ScoringConfig,
): Promise<
	Array<{
		game: UpcomingGameRow;
		side: "home" | "away";
		scoring: OpportunityScore;
	}>
> {
	const now = nowUnixSeconds();
	let games: UpcomingGameRow[];

	if (sportTag) {
		games = await all<UpcomingGameRow>(
			db,
			UPCOMING_GAMES_QUERY.replace(
				"WHERE g.is_final = 0",
				"WHERE g.is_final = 0 AND g.sport_tag = ?",
			),
			sportTag,
			now,
			limit,
		);
	} else {
		games = await all<UpcomingGameRow>(db, UPCOMING_GAMES_QUERY, now, limit);
	}

	const scored: Array<{
		game: UpcomingGameRow;
		side: "home" | "away";
		scoring: OpportunityScore;
	}> = [];

	await Promise.all(
		games.map(async (game) => {
			// Score from home team perspective
			const homeFeatures = await buildPrePickFeatures(
				db,
				game.home_team_id,
				game.away_team_id,
				"home",
				null,
				game.sport_tag,
				"spread",
				game.home_spread,
				game.total_line,
			);
			scored.push({
				game,
				side: "home",
				scoring: scoreOpportunity(homeFeatures, config),
			});

			// Score from away team perspective
			const awayFeatures = await buildPrePickFeatures(
				db,
				game.away_team_id,
				game.home_team_id,
				"away",
				null,
				game.sport_tag,
				"spread",
				game.home_spread != null ? -game.home_spread : null,
				game.total_line,
			);
			scored.push({
				game,
				side: "away",
				scoring: scoreOpportunity(awayFeatures, config),
			});
		}),
	);

	scored.sort((a, b) => b.scoring.totalScore - a.scoring.totalScore);
	return scored;
}

// ---------------------------------------------------------------------------
// Main ranking function
// ---------------------------------------------------------------------------

/**
 * Load, score, and rank all upcoming opportunities.
 *
 * Uses pending picks as the primary source. If no pending picks exist,
 * falls back to upcoming canonical games.
 */
export async function getRankedOpportunities(
	db: Db,
	options?: {
		limit?: number;
		minScore?: number;
		sportTag?: string;
		config?: ScoringConfig;
	},
): Promise<RankedOpportunitySummary> {
	const limit = options?.limit ?? 100;
	const minScore = options?.minScore ?? 0;
	const config = options?.config;

	// Try pending picks first
	const { picks, scored: picksScored } = await rankPendingPicks(
		db,
		limit,
		config,
	);

	let opportunities: RankedOpportunity[];
	let totalCandidates: number;

	if (picks.length > 0) {
		// Build from pending picks
		totalCandidates = picks.length;
		opportunities = picksScored
			.filter((s) => s.scoring.totalScore >= minScore)
			.map(({ pick, scoring }, index) => ({
				pickId: pick.id,
				matchupLabel: buildPickMatchupLabel(pick),
				sportTag: pick.sport_tag,
				betType: pick.bet_type,
				venueRole: pick.venue_role,
				favDogRole: pick.fav_dog_role,
				spreadLine: pick.spread_line,
				totalLine: pick.total_line,
				eventTime: pick.event_time,
				totalScore: scoring.totalScore,
				factors: scoring.factors,
				warnings: scoring.warnings,
				rank: index + 1,
				signalScore: pick.signal_score,
				edgeRating: pick.edge_rating,
				grade: pick.grade,
			}));
	} else {
		// Fall back to upcoming games
		const gamesScored = await rankUpcomingGames(
			db,
			limit,
			options?.sportTag,
			config,
		);
		totalCandidates = gamesScored.length;
		opportunities = gamesScored
			.filter((s) => s.scoring.totalScore >= minScore)
			.map(({ game, side, scoring }, index) => ({
				pickId: `${game.id}_${side}`,
				matchupLabel: buildGameMatchupLabel(game, side),
				sportTag: game.sport_tag,
				betType: "spread",
				venueRole: side,
				favDogRole: null,
				spreadLine:
					side === "home"
						? game.home_spread
						: game.home_spread != null
							? -game.home_spread
							: null,
				totalLine: game.total_line,
				eventTime: game.game_time
					? new Date(game.game_time * 1000).toISOString()
					: null,
				totalScore: scoring.totalScore,
				factors: scoring.factors,
				warnings: scoring.warnings,
				rank: index + 1,
				signalScore: null,
				edgeRating: null,
				grade: null,
			}));
	}

	// Re-number ranks after filtering
	for (let i = 0; i < opportunities.length; i++) {
		opportunities[i].rank = i + 1;
	}

	return {
		computedAt: nowUnixSeconds(),
		totalCandidates,
		scoredCount: opportunities.length,
		excludedCount: totalCandidates - opportunities.length,
		opportunities,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPickMatchupLabel(pick: PendingPickRow): string {
	const team = pick.team_name ?? "Team";
	const opp = pick.opponent_name ?? "Opponent";
	return `${team} vs ${opp}`;
}

function buildGameMatchupLabel(
	game: UpcomingGameRow,
	side: "home" | "away",
): string {
	const home = game.home_team_name ?? "Home";
	const away = game.away_team_name ?? "Away";
	if (side === "home") {
		return `${home} vs ${away}`;
	}
	return `${away} @ ${home}`;
}
