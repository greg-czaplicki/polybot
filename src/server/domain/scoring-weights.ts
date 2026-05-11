/**
 * Scoring Weights & Configuration — Phase 8
 *
 * Centralized, configurable weights and thresholds for the
 * pre-pick opportunity scoring layer. All weights are transparent
 * and adjustable without code changes to the scorer.
 *
 * Design notes:
 * - Positive weights = signals that increase opportunity confidence.
 * - Each weight category has a max contribution to keep scores bounded.
 * - Thresholds define what qualifies as "strong" vs "weak" signals.
 * - Total score range: 0–100 (normalized from raw weighted sum).
 */

// ---------------------------------------------------------------------------
// ATS trend scoring
// ---------------------------------------------------------------------------

/** Weights for team ATS win percentage signals. */
export interface AtsTrendWeights {
	/** Weight applied when team ATS win pct >= hotThreshold */
	hotBonus: number;
	/** Weight applied when team ATS win pct <= coldThreshold */
	coldPenalty: number;
	/** ATS win pct at or above this = "hot" */
	hotThreshold: number;
	/** ATS win pct at or below this = "cold" */
	coldThreshold: number;
	/** Max contribution from ATS trend scoring */
	maxContribution: number;
}

// ---------------------------------------------------------------------------
// ATS split scoring
// ---------------------------------------------------------------------------

/** Weights for contextual split ATS (e.g., home-fav ATS). */
export interface AtsSplitWeights {
	/** Weight for strong split performance (>= splitHotThreshold) */
	splitHotBonus: number;
	/** Weight for weak split performance (<= splitColdThreshold) */
	splitColdPenalty: number;
	splitHotThreshold: number;
	splitColdThreshold: number;
	maxContribution: number;
}

// ---------------------------------------------------------------------------
// Streak scoring
// ---------------------------------------------------------------------------

/** Weights for ATS streak context. */
export interface StreakWeights {
	/** Points per win streak game (capped at maxStreakLength) */
	winStreakPerGame: number;
	/** Points per loss streak game (negative, capped at maxStreakLength) */
	lossStreakPerGame: number;
	/** Streak lengths beyond this are not given extra weight */
	maxStreakLength: number;
	maxContribution: number;
}

// ---------------------------------------------------------------------------
// Matchup delta scoring
// ---------------------------------------------------------------------------

/** Weights for matchup ATS delta (team vs opponent). */
export interface MatchupDeltaWeights {
	/** Multiplier applied to the ATS delta value (0–1 range delta) */
	deltaMultiplier: number;
	/** Threshold above which the matchup edge is "strong" */
	strongEdgeThreshold: number;
	/** Bonus for matchups above the strong edge threshold */
	strongEdgeBonus: number;
	maxContribution: number;
}

// ---------------------------------------------------------------------------
// Venue / fav-dog scoring
// ---------------------------------------------------------------------------

/** Weights for venue and favorite/dog context. */
export interface VenueRoleWeights {
	/** Bonus for home teams */
	homeBonus: number;
	/** Bonus for favorites */
	favoriteBonus: number;
	/** Penalty for away dogs (compounding disadvantage) */
	awayDogPenalty: number;
	maxContribution: number;
}

// ---------------------------------------------------------------------------
// OU trend scoring
// ---------------------------------------------------------------------------

/** Weights for over/under trend signals (used for totals bets). */
export interface OuTrendWeights {
	/** Bonus when team's OU trend aligns with pick direction */
	alignedBonus: number;
	/** Penalty when team's OU trend conflicts with pick direction */
	misalignedPenalty: number;
	/** Over pct at or above this = "strong over" lean */
	overHotThreshold: number;
	/** Over pct at or below this = "strong under" lean */
	underHotThreshold: number;
	maxContribution: number;
}

// ---------------------------------------------------------------------------
// OU matchup delta scoring
// ---------------------------------------------------------------------------

/**
 * Weights for combined team+opponent OU lean.
 * Input: average of team.ouOverPct and opponent.ouOverPct, compared against 0.5.
 */
export interface OuMatchupWeights {
	/** Multiplier on |combinedOverPct - 0.5| when aligned with pick direction */
	alignedMultiplier: number;
	/** Multiplier when misaligned (should be negative) */
	misalignedMultiplier: number;
	/** Threshold (absolute deviation from 0.5) above which the edge is "strong" */
	strongEdgeThreshold: number;
	/** Extra bonus when aligned and above strongEdgeThreshold */
	strongAlignedBonus: number;
	maxContribution: number;
}

// ---------------------------------------------------------------------------
// OU streak scoring
// ---------------------------------------------------------------------------

/**
 * Weights for OU streaks. A team on an "over" streak (W = went over) reinforces
 * over picks and weakens under picks.
 */
export interface OuStreakWeights {
	/** Points per streak game when streak direction matches pick direction */
	alignedPerGame: number;
	/** Points per streak game when streak direction opposes pick direction (negative) */
	misalignedPerGame: number;
	/** Streak lengths beyond this are capped */
	maxStreakLength: number;
	maxContribution: number;
}

// ---------------------------------------------------------------------------
// Data quality penalties
// ---------------------------------------------------------------------------

/** Penalties for missing or stale data. */
export interface DataQualityWeights {
	/** Penalty when team snapshot is not found */
	missingTeamSnapshotPenalty: number;
	/** Penalty when opponent snapshot is not found */
	missingOpponentSnapshotPenalty: number;
	/** Penalty when both sides lack data */
	noContextPenalty: number;
}

// ---------------------------------------------------------------------------
// Complete scoring config
// ---------------------------------------------------------------------------

/** Full scoring configuration combining all weight categories. */
export interface ScoringConfig {
	atsTrend: AtsTrendWeights;
	atsSplit: AtsSplitWeights;
	streak: StreakWeights;
	matchupDelta: MatchupDeltaWeights;
	venueRole: VenueRoleWeights;
	ouTrend: OuTrendWeights;
	ouMatchup: OuMatchupWeights;
	ouStreak: OuStreakWeights;
	dataQuality: DataQualityWeights;
	/**
	 * Raw score normalization for ATS-style bets (spread, moneyline).
	 * Sum of applicable maxContributions.
	 */
	maxRawScore: number;
	/**
	 * Raw score normalization for totals bets. ATS scorers are bypassed
	 * for totals, so the effective max is the sum of OU + venue + data-quality
	 * maxes.
	 */
	maxRawScoreTotals: number;
}

/**
 * Default scoring configuration.
 *
 * Assumptions:
 * - ATS trend and matchup delta are the strongest signals.
 * - Streak and split context provide moderate additional signal.
 * - Venue/role context is a minor tiebreaker.
 * - Missing data is penalized to surface stale-context warnings.
 * - Total max possible raw score ≈ 85 (sum of all maxContributions).
 *   This maps to 100 on the normalized scale.
 */
export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
	atsTrend: {
		hotBonus: 20,
		coldPenalty: -10,
		hotThreshold: 0.6,
		coldThreshold: 0.4,
		maxContribution: 20,
	},
	atsSplit: {
		splitHotBonus: 12,
		splitColdPenalty: -6,
		splitHotThreshold: 0.6,
		splitColdThreshold: 0.4,
		maxContribution: 12,
	},
	streak: {
		winStreakPerGame: 3,
		lossStreakPerGame: -2,
		maxStreakLength: 5,
		maxContribution: 15,
	},
	matchupDelta: {
		deltaMultiplier: 50,
		strongEdgeThreshold: 0.2,
		strongEdgeBonus: 5,
		maxContribution: 20,
	},
	venueRole: {
		homeBonus: 3,
		favoriteBonus: 2,
		awayDogPenalty: -3,
		maxContribution: 5,
	},
	ouTrend: {
		alignedBonus: 10,
		misalignedPenalty: -10,
		overHotThreshold: 0.6,
		underHotThreshold: 0.4,
		maxContribution: 10,
	},
	ouMatchup: {
		alignedMultiplier: 80,
		misalignedMultiplier: -80,
		strongEdgeThreshold: 0.15,
		strongAlignedBonus: 5,
		maxContribution: 20,
	},
	ouStreak: {
		alignedPerGame: 3,
		misalignedPerGame: -2,
		maxStreakLength: 5,
		maxContribution: 12,
	},
	dataQuality: {
		missingTeamSnapshotPenalty: -15,
		missingOpponentSnapshotPenalty: -10,
		noContextPenalty: -25,
	},
	maxRawScore: 82,
	// Totals: ouTrend(10) + ouMatchup(20) + ouStreak(12) + venueRole(5) = 47
	maxRawScoreTotals: 47,
};
