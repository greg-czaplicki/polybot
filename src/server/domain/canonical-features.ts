/**
 * Canonical Feature Extraction — Phase 7
 *
 * Extracts a structured feature vector from canonical context for each pick.
 * All trend features are point-in-time safe: they use snapshot data from
 * BEFORE the game, never post-result information.
 *
 * Consumers: strategy-analysis repository (bucketed performance),
 *            strategy-analysis API (feature lookup endpoints).
 */

import type { Db } from "../db/client";
import { deriveSnapshotType } from "../api/canonical-analytics";
import { getTeamTrendSnapshotAsOf } from "../repositories/team-trend-snapshots";
import type {
	FavDogRole,
	TeamTrendSnapshot,
	TrendSnapshotType,
	VenueRole,
} from "../types/canonical";

// ---------------------------------------------------------------------------
// Leakage safety annotations
// ---------------------------------------------------------------------------

/**
 * Feature safety classification.
 *
 * - pre_pick:    Available before the game. Safe for modeling/prediction.
 * - post_result: Only known after the game finishes. MUST NOT be used as
 *                model inputs — only for outcome analysis and evaluation.
 */
export type FeatureSafety = "pre_pick" | "post_result";

/**
 * Metadata describing each feature's safety classification.
 * Used to programmatically prevent leakage in downstream consumers.
 */
export const FEATURE_SAFETY: Record<string, FeatureSafety> = {
	// --- Pre-pick features (safe for modeling) ---
	sportTag: "pre_pick",
	betType: "pre_pick",
	venueRole: "pre_pick",
	favDogRole: "pre_pick",
	spreadLine: "pre_pick",
	totalLine: "pre_pick",

	// Team trend features (from pre-game snapshots)
	teamAtsWinPct: "pre_pick",
	teamAtsSplitPct: "pre_pick",
	teamAtsStreakType: "pre_pick",
	teamAtsStreakLength: "pre_pick",
	teamOuOverPct: "pre_pick",
	teamOuStreakType: "pre_pick",
	teamOuStreakLength: "pre_pick",
	teamAvgCoverMargin: "pre_pick",
	teamAvgTotalMargin: "pre_pick",
	teamSuWinPct: "pre_pick",

	// Opponent trend features (from pre-game snapshots)
	opponentAtsWinPct: "pre_pick",
	opponentAtsSplitPct: "pre_pick",
	opponentAtsStreakType: "pre_pick",
	opponentAtsStreakLength: "pre_pick",
	opponentOuOverPct: "pre_pick",
	opponentOuStreakType: "pre_pick",
	opponentOuStreakLength: "pre_pick",
	opponentAvgCoverMargin: "pre_pick",
	opponentAvgTotalMargin: "pre_pick",
	opponentSuWinPct: "pre_pick",

	// Matchup delta features (derived from pre-game snapshots)
	matchupAtsDelta: "pre_pick",
	matchupOuDelta: "pre_pick",
	matchupCoverMarginDelta: "pre_pick",

	// --- Post-result features (for analysis only, NOT modeling) ---
	actualMargin: "post_result",
	actualTotal: "post_result",
	pickResult: "post_result",
	roi: "post_result",
	clv: "post_result",
} as const;

// ---------------------------------------------------------------------------
// Feature vector types
// ---------------------------------------------------------------------------

/** Snapshot-derived features for one side (team or opponent). */
export interface SideFeatures {
	atsWinPct: number | null;
	atsSplitPct: number | null;
	atsStreakType: "W" | "L" | null;
	atsStreakLength: number | null;
	ouOverPct: number | null;
	ouStreakType: "W" | "L" | null;
	ouStreakLength: number | null;
	avgCoverMargin: number | null;
	avgTotalMargin: number | null;
	suWinPct: number | null;
}

/**
 * Full canonical feature vector for a pick.
 *
 * Split into pre_pick (safe for modeling) and post_result (analysis only)
 * sections. Consumers MUST check FEATURE_SAFETY before using any field
 * as a model input.
 */
export interface CanonicalFeatureVector {
	pickId: string;
	pickedAt: number;

	// --- Context features (pre_pick) ---
	sportTag: string | null;
	betType: string | null;
	venueRole: VenueRole | null;
	favDogRole: FavDogRole | null;
	spreadLine: number | null;
	totalLine: number | null;

	// --- Team trend features (pre_pick) ---
	team: SideFeatures;

	// --- Opponent trend features (pre_pick) ---
	opponent: SideFeatures;

	// --- Matchup delta features (pre_pick) ---
	matchupAtsDelta: number | null;
	matchupOuDelta: number | null;
	matchupCoverMarginDelta: number | null;

	// --- Post-result features (analysis only — DO NOT use for modeling) ---
	actualMargin: number | null;
	actualTotal: number | null;
	pickResult: "win" | "loss" | "push" | "pending";
	roi: number | null;
	clv: number | null;

	// --- Metadata ---
	snapshotType: TrendSnapshotType;
	teamSnapshotFound: boolean;
	opponentSnapshotFound: boolean;
}

// ---------------------------------------------------------------------------
// Pick row shape (subset of ManualPickRow needed for feature extraction)
// ---------------------------------------------------------------------------

/** Minimal pick fields needed for feature extraction. */
export interface PickForFeatures {
	id: string;
	picked_at: number;
	sport_tag: string | null;
	bet_type: string | null;
	venue_role: string | null;
	fav_dog_role: string | null;
	spread_line: number | null;
	total_line: number | null;
	team_id: string | null;
	opponent_id: string | null;
	actual_margin: number | null;
	actual_total: number | null;
	status: string;
	roi: number | null;
	clv: number | null;
}

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

/** Extract SideFeatures from a trend snapshot, or nulls if not found. */
export function extractSideFeatures(
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
 * Extract a full CanonicalFeatureVector for a single pick.
 *
 * Loads point-in-time trend snapshots for both team and opponent,
 * using the pick's picked_at time as the as-of boundary. This ensures
 * no future information leaks into the feature vector.
 */
export async function extractPickFeatures(
	db: Db,
	pick: PickForFeatures,
): Promise<CanonicalFeatureVector> {
	const venueRole = (pick.venue_role as VenueRole) ?? null;
	const favDogRole = (pick.fav_dog_role as FavDogRole) ?? null;
	const snapshotType = deriveSnapshotType(venueRole, favDogRole);
	const asOfTime = pick.picked_at;

	// Load team snapshots (overall + contextual split)
	let teamOverall: TeamTrendSnapshot | null = null;
	let teamSplit: TeamTrendSnapshot | null = null;
	if (pick.team_id) {
		const promises: Promise<TeamTrendSnapshot | null>[] = [
			getTeamTrendSnapshotAsOf(db, pick.team_id, "overall", asOfTime),
		];
		if (snapshotType !== "overall") {
			promises.push(
				getTeamTrendSnapshotAsOf(db, pick.team_id, snapshotType, asOfTime),
			);
		}
		const [overall, split] = await Promise.all(promises);
		teamOverall = overall;
		teamSplit = split ?? null;
	}

	// Load opponent snapshots (overall + mirror split)
	let opponentOverall: TeamTrendSnapshot | null = null;
	let opponentSplit: TeamTrendSnapshot | null = null;
	if (pick.opponent_id) {
		const opponentSnapshotType = deriveOpponentSnapshotType(
			venueRole,
			favDogRole,
		);
		const promises: Promise<TeamTrendSnapshot | null>[] = [
			getTeamTrendSnapshotAsOf(db, pick.opponent_id, "overall", asOfTime),
		];
		if (opponentSnapshotType !== "overall") {
			promises.push(
				getTeamTrendSnapshotAsOf(
					db,
					pick.opponent_id,
					opponentSnapshotType,
					asOfTime,
				),
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
		pickId: pick.id,
		pickedAt: pick.picked_at,

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

		// Post-result (analysis only)
		actualMargin: pick.actual_margin,
		actualTotal: pick.actual_total,
		pickResult: pick.status as "win" | "loss" | "push" | "pending",
		roi: pick.roi,
		clv: pick.clv,

		// Metadata
		snapshotType,
		teamSnapshotFound: teamOverall !== null,
		opponentSnapshotFound: opponentOverall !== null,
	};
}

/**
 * Derive the opponent's contextual snapshot type by mirroring venue role.
 * If our team is home favorite, opponent is away dog (and vice versa).
 */
export function deriveOpponentSnapshotType(
	venueRole: VenueRole | null,
	favDogRole: FavDogRole | null,
): TrendSnapshotType {
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

// ---------------------------------------------------------------------------
// Bucketing helpers for strategy analysis
// ---------------------------------------------------------------------------

/** ATS trend bucket based on win percentage thresholds. */
export type TrendBucket = "hot" | "neutral" | "cold" | "unknown";

/** Classify an ATS win percentage into a trend bucket. */
export function classifyAtsTrend(atsWinPct: number | null): TrendBucket {
	if (atsWinPct == null) return "unknown";
	if (atsWinPct >= 0.6) return "hot";
	if (atsWinPct <= 0.4) return "cold";
	return "neutral";
}

/** Streak bucket label (e.g., "W1-2", "L3-5", "L6+"). */
export function classifyStreakBucket(
	streakType: "W" | "L" | null,
	streakLength: number | null,
): string {
	if (streakType == null || streakLength == null || streakLength === 0) {
		return "none";
	}
	const prefix = streakType;
	if (streakLength <= 2) return `${prefix}1-2`;
	if (streakLength <= 5) return `${prefix}3-5`;
	return `${prefix}6+`;
}

/** Matchup edge bucket based on ATS delta magnitude. */
export type MatchupEdgeBucket =
	| "strong_edge"
	| "slight_edge"
	| "neutral"
	| "slight_disadvantage"
	| "strong_disadvantage"
	| "unknown";

/** Classify a matchup ATS delta into an edge bucket. */
export function classifyMatchupEdge(
	atsDelta: number | null,
): MatchupEdgeBucket {
	if (atsDelta == null) return "unknown";
	if (atsDelta >= 0.2) return "strong_edge";
	if (atsDelta >= 0.1) return "slight_edge";
	if (atsDelta >= -0.1) return "neutral";
	if (atsDelta >= -0.2) return "slight_disadvantage";
	return "strong_disadvantage";
}

/**
 * Returns only the pre-pick-safe features from a full vector.
 * Use this when exporting features for model training to ensure
 * no post-result data leaks into the training set.
 */
export function getPrePickFeatures(
	vector: CanonicalFeatureVector,
): Omit<
	CanonicalFeatureVector,
	"actualMargin" | "actualTotal" | "pickResult" | "roi" | "clv"
> {
	const { actualMargin, actualTotal, pickResult, roi, clv, ...safe } = vector;
	return safe;
}
