/**
 * Opportunity Ranking Repository — Phase 8
 *
 * Loads upcoming (pending) opportunities from manual_picks, joins
 * canonical trend context via point-in-time snapshots, scores each
 * opportunity, and returns a ranked list.
 *
 * Data sources:
 * - manual_picks WHERE status = 'pending' AND team_id IS NOT NULL
 * - team_trend_snapshots (latest available per team/snapshot_type)
 * - game_lines (for line context already known at decision time)
 *
 * Leakage safety:
 * - Only pre-pick features feed the scorer.
 * - actual_margin, actual_total, roi, clv are never read for pending picks.
 * - Snapshot lookup uses getLatestTeamTrendSnapshot (current form),
 *   not as-of a future time.
 */

import type { Db } from "../db/client";
import { all } from "../db/client";
import { nowUnixSeconds } from "../env";
import type { FavDogRole, VenueRole } from "../types/canonical";
import { deriveSnapshotType } from "../api/canonical-analytics";
import { getLatestTeamTrendSnapshot } from "./team-trend-snapshots";
import type { SideFeatures } from "../domain/canonical-features";
import {
	type OpportunityScore,
	type PrePickFeatures,
	scoreOpportunity,
} from "../domain/opportunity-scoring";
import type { ScoringConfig } from "../domain/scoring-weights";
import type { TeamTrendSnapshot } from "../types/canonical";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal pending pick fields needed for opportunity ranking. */
interface PendingPickRow {
	id: string;
	condition_id: string;
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

/** A single ranked opportunity with full score explanation. */
export interface RankedOpportunity {
	pickId: string;
	conditionId: string;
	marketTitle: string;
	pickedAt: number;
	eventTime: string | null;
	sportTag: string | null;
	betType: string | null;
	teamName: string | null;
	opponentName: string | null;
	venueRole: string | null;
	favDogRole: string | null;
	spreadLine: number | null;
	totalLine: number | null;
	signalScore: number | null;
	edgeRating: number | null;
	grade: string | null;
	rank: number;
	scoring: OpportunityScore;
}

/** Summary returned by the ranking query. */
export interface OpportunityRankingSummary {
	computedAt: number;
	totalPending: number;
	scoredCount: number;
	excludedCount: number;
	opportunities: RankedOpportunity[];
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const PENDING_PICKS_QUERY = `
	SELECT
		mp.id, mp.condition_id, mp.market_title, mp.picked_at,
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
// Feature extraction for pending picks
// ---------------------------------------------------------------------------

function extractSideFeatures(
	overallSnapshot: TeamTrendSnapshot | null,
	splitSnapshot: TeamTrendSnapshot | null,
): SideFeatures {
	return {
		atsWinPct: overallSnapshot?.atsWinPct ?? null,
		atsSplitPct: splitSnapshot?.atsWinPct ?? null,
		atsStreakType: overallSnapshot?.atsStreakType ?? null,
		atsStreakLength:
			overallSnapshot?.atsStreakType != null
				? overallSnapshot.atsStreakLength
				: null,
		ouOverPct: overallSnapshot?.ouOverPct ?? null,
		ouStreakType: overallSnapshot?.ouStreakType ?? null,
		ouStreakLength:
			overallSnapshot?.ouStreakType != null
				? overallSnapshot.ouStreakLength
				: null,
		avgCoverMargin: overallSnapshot?.avgCoverMargin ?? null,
		avgTotalMargin: overallSnapshot?.avgTotalMargin ?? null,
		suWinPct: overallSnapshot?.suWinPct ?? null,
	};
}

/**
 * Derive the opponent's contextual snapshot type by mirroring venue role.
 */
function deriveOpponentSnapshotType(
	venueRole: VenueRole | null,
	favDogRole: FavDogRole | null,
): ReturnType<typeof deriveSnapshotType> {
	const mirroredVenue: VenueRole | null =
		venueRole === "home" ? "away" : venueRole === "away" ? "home" : venueRole;
	const mirroredFavDog: FavDogRole | null =
		favDogRole === "favorite"
			? "dog"
			: favDogRole === "dog"
				? "favorite"
				: favDogRole;
	return deriveSnapshotType(mirroredVenue, mirroredFavDog);
}

async function buildPrePickFeatures(
	db: Db,
	pick: PendingPickRow,
): Promise<PrePickFeatures> {
	const venueRole = (pick.venue_role as VenueRole) ?? null;
	const favDogRole = (pick.fav_dog_role as FavDogRole) ?? null;
	const snapshotType = deriveSnapshotType(venueRole, favDogRole);

	// Load latest team snapshots (current form, not as-of)
	let teamOverall: TeamTrendSnapshot | null = null;
	let teamSplit: TeamTrendSnapshot | null = null;
	if (pick.team_id) {
		const promises: Promise<TeamTrendSnapshot | null>[] = [
			getLatestTeamTrendSnapshot(db, {
				teamId: pick.team_id,
				snapshotType: "overall",
			}),
		];
		if (snapshotType !== "overall") {
			promises.push(
				getLatestTeamTrendSnapshot(db, {
					teamId: pick.team_id,
					snapshotType,
				}),
			);
		}
		const [overall, split] = await Promise.all(promises);
		teamOverall = overall;
		teamSplit = split ?? null;
	}

	// Load latest opponent snapshots
	let opponentOverall: TeamTrendSnapshot | null = null;
	let opponentSplit: TeamTrendSnapshot | null = null;
	if (pick.opponent_id) {
		const opponentSnapshotType = deriveOpponentSnapshotType(
			venueRole,
			favDogRole,
		);
		const promises: Promise<TeamTrendSnapshot | null>[] = [
			getLatestTeamTrendSnapshot(db, {
				teamId: pick.opponent_id,
				snapshotType: "overall",
			}),
		];
		if (opponentSnapshotType !== "overall") {
			promises.push(
				getLatestTeamTrendSnapshot(db, {
					teamId: pick.opponent_id,
					snapshotType: opponentSnapshotType,
				}),
			);
		}
		const [overall, split] = await Promise.all(promises);
		opponentOverall = overall;
		opponentSplit = split ?? null;
	}

	const teamFeatures = extractSideFeatures(teamOverall, teamSplit);
	const opponentFeatures = extractSideFeatures(opponentOverall, opponentSplit);

	// Compute matchup deltas
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
		sportTag: pick.sport_tag,
		betType: pick.bet_type,
		venueRole,
		favDogRole,
		spreadLine: pick.spread_line,
		totalLine: pick.total_line,
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
// Main ranking function
// ---------------------------------------------------------------------------

/**
 * Load, score, and rank all pending opportunities.
 *
 * Returns opportunities sorted by score descending, with full
 * explainable factor breakdowns.
 */
export async function getRankedOpportunities(
	db: Db,
	options?: { limit?: number; config?: ScoringConfig },
): Promise<OpportunityRankingSummary> {
	const limit = options?.limit ?? 100;
	const config = options?.config;

	const picks = await all<PendingPickRow>(db, PENDING_PICKS_QUERY, limit);

	// Score each pick in parallel
	const scoredPicks = await Promise.all(
		picks.map(async (pick) => {
			const features = await buildPrePickFeatures(db, pick);
			const scoring = scoreOpportunity(features, config);
			return { pick, scoring };
		}),
	);

	// Sort by score descending
	scoredPicks.sort((a, b) => b.scoring.score - a.scoring.score);

	// Build ranked output
	const opportunities: RankedOpportunity[] = scoredPicks.map(
		({ pick, scoring }, index) => ({
			pickId: pick.id,
			conditionId: pick.condition_id,
			marketTitle: pick.market_title,
			pickedAt: pick.picked_at,
			eventTime: pick.event_time,
			sportTag: pick.sport_tag,
			betType: pick.bet_type,
			teamName: pick.team_name,
			opponentName: pick.opponent_name,
			venueRole: pick.venue_role,
			favDogRole: pick.fav_dog_role,
			spreadLine: pick.spread_line,
			totalLine: pick.total_line,
			signalScore: pick.signal_score,
			edgeRating: pick.edge_rating,
			grade: pick.grade,
			rank: index + 1,
			scoring,
		}),
	);

	return {
		computedAt: nowUnixSeconds(),
		totalPending: picks.length,
		scoredCount: picks.length,
		excludedCount: 0,
		opportunities,
	};
}
