/**
 * Opportunity Scoring — Phase 8
 *
 * Scores upcoming (pending) opportunities using only leakage-safe
 * pre-pick canonical features. Every score is fully explainable:
 * the output includes the total score, individual factor contributions,
 * warnings, and the raw feature values used.
 *
 * Leakage safety:
 * - ONLY uses features classified as "pre_pick" in FEATURE_SAFETY.
 * - Never reads actualMargin, actualTotal, pickResult, roi, or clv.
 * - All trend data comes from the latest available snapshot (current form).
 *
 * Consumers: opportunity-ranking repository, opportunity-ranking API.
 */

import type { SideFeatures } from "./canonical-features";
import {
	type ScoringConfig,
	DEFAULT_SCORING_CONFIG,
} from "./scoring-weights";

// ---------------------------------------------------------------------------
// Score factor types
// ---------------------------------------------------------------------------

/**
 * A single contributing factor to an opportunity score.
 * Positive points = favorable signal; negative = unfavorable.
 */
export interface ScoreFactor {
	/** Human-readable label for this factor */
	label: string;
	/** Category grouping (e.g., "ats_trend", "streak", "matchup") */
	category: string;
	/** Points contributed (positive or negative) */
	points: number;
	/** The raw feature value that drove this factor */
	rawValue: string | number | null;
}

/**
 * A warning about data quality or conflicting signals.
 */
export interface ScoreWarning {
	/** Warning type for programmatic handling */
	type:
		| "missing_team_snapshot"
		| "missing_opponent_snapshot"
		| "no_context"
		| "conflicting_signals"
		| "stale_data";
	/** Human-readable warning message */
	message: string;
}

/**
 * Pre-pick features used as scorer inputs.
 * This is the leakage-safe subset of CanonicalFeatureVector.
 * No post-result fields are included.
 */
export interface PrePickFeatures {
	sportTag: string | null;
	betType: string | null;
	venueRole: "home" | "away" | "neutral" | null;
	favDogRole: "favorite" | "dog" | "pickem" | null;
	spreadLine: number | null;
	totalLine: number | null;
	team: SideFeatures;
	opponent: SideFeatures;
	matchupAtsDelta: number | null;
	matchupOuDelta: number | null;
	matchupCoverMarginDelta: number | null;
	teamSnapshotFound: boolean;
	opponentSnapshotFound: boolean;
}

/**
 * Full scored opportunity result.
 */
export interface OpportunityScore {
	/** Normalized score 0–100 */
	score: number;
	/** Raw (un-normalized) score for debugging */
	rawScore: number;
	/** All contributing factors, sorted by abs(points) descending */
	factors: ScoreFactor[];
	/** Top positive factors */
	topPositive: ScoreFactor[];
	/** Top negative factors */
	topNegative: ScoreFactor[];
	/** Data quality and signal warnings */
	warnings: ScoreWarning[];
	/** The pre-pick features used for scoring */
	features: PrePickFeatures;
}

// ---------------------------------------------------------------------------
// Scorer implementation
// ---------------------------------------------------------------------------

/**
 * Score an opportunity using pre-pick features only.
 *
 * @param features - Leakage-safe pre-pick features
 * @param config - Scoring weights (defaults to DEFAULT_SCORING_CONFIG)
 * @returns Fully explainable opportunity score
 */
export function scoreOpportunity(
	features: PrePickFeatures,
	config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): OpportunityScore {
	const factors: ScoreFactor[] = [];
	const warnings: ScoreWarning[] = [];

	// --- Data quality checks ---
	scoreDataQuality(features, config, factors, warnings);

	// --- ATS trend scoring ---
	scoreAtsTrend(features, config, factors);

	// --- ATS split scoring ---
	scoreAtsSplit(features, config, factors);

	// --- Streak scoring ---
	scoreStreak(features, config, factors);

	// --- Matchup delta scoring ---
	scoreMatchupDelta(features, config, factors);

	// --- Venue/role scoring ---
	scoreVenueRole(features, config, factors);

	// --- OU trend scoring (for totals bets) ---
	scoreOuTrend(features, config, factors);

	// --- Check for conflicting signals ---
	checkConflictingSignals(factors, warnings);

	// Compute raw total
	const rawScore = factors.reduce((sum, f) => sum + f.points, 0);

	// Normalize to 0–100
	const normalized = Math.max(
		0,
		Math.min(100, Math.round((rawScore / config.maxRawScore) * 100)),
	);

	// Sort factors by absolute contribution
	factors.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));

	const topPositive = factors
		.filter((f) => f.points > 0)
		.slice(0, 3);
	const topNegative = factors
		.filter((f) => f.points < 0)
		.slice(0, 3);

	return {
		score: normalized,
		rawScore,
		factors,
		topPositive,
		topNegative,
		warnings,
		features,
	};
}

// ---------------------------------------------------------------------------
// Individual scoring functions
// ---------------------------------------------------------------------------

function scoreDataQuality(
	features: PrePickFeatures,
	config: ScoringConfig,
	factors: ScoreFactor[],
	warnings: ScoreWarning[],
): void {
	if (!features.teamSnapshotFound && !features.opponentSnapshotFound) {
		factors.push({
			label: "No canonical context available",
			category: "data_quality",
			points: config.dataQuality.noContextPenalty,
			rawValue: null,
		});
		warnings.push({
			type: "no_context",
			message:
				"Neither team nor opponent has trend snapshot data. Score is unreliable.",
		});
		return;
	}

	if (!features.teamSnapshotFound) {
		factors.push({
			label: "Missing team trend data",
			category: "data_quality",
			points: config.dataQuality.missingTeamSnapshotPenalty,
			rawValue: null,
		});
		warnings.push({
			type: "missing_team_snapshot",
			message: "Team trend snapshot not found. ATS/streak signals unavailable.",
		});
	}

	if (!features.opponentSnapshotFound) {
		factors.push({
			label: "Missing opponent trend data",
			category: "data_quality",
			points: config.dataQuality.missingOpponentSnapshotPenalty,
			rawValue: null,
		});
		warnings.push({
			type: "missing_opponent_snapshot",
			message:
				"Opponent trend snapshot not found. Matchup delta unavailable.",
		});
	}
}

function scoreAtsTrend(
	features: PrePickFeatures,
	config: ScoringConfig,
	factors: ScoreFactor[],
): void {
	const { atsTrend } = config;
	const atsWinPct = features.team.atsWinPct;

	if (atsWinPct == null) return;

	if (atsWinPct >= atsTrend.hotThreshold) {
		const points = Math.min(atsTrend.hotBonus, atsTrend.maxContribution);
		factors.push({
			label: `Team ATS hot (${(atsWinPct * 100).toFixed(0)}%)`,
			category: "ats_trend",
			points,
			rawValue: atsWinPct,
		});
	} else if (atsWinPct <= atsTrend.coldThreshold) {
		const points = Math.max(atsTrend.coldPenalty, -atsTrend.maxContribution);
		factors.push({
			label: `Team ATS cold (${(atsWinPct * 100).toFixed(0)}%)`,
			category: "ats_trend",
			points,
			rawValue: atsWinPct,
		});
	}
}

function scoreAtsSplit(
	features: PrePickFeatures,
	config: ScoringConfig,
	factors: ScoreFactor[],
): void {
	const { atsSplit } = config;
	const splitPct = features.team.atsSplitPct;

	if (splitPct == null) return;

	if (splitPct >= atsSplit.splitHotThreshold) {
		const points = Math.min(
			atsSplit.splitHotBonus,
			atsSplit.maxContribution,
		);
		factors.push({
			label: `Split ATS strong (${(splitPct * 100).toFixed(0)}%)`,
			category: "ats_split",
			points,
			rawValue: splitPct,
		});
	} else if (splitPct <= atsSplit.splitColdThreshold) {
		const points = Math.max(
			atsSplit.splitColdPenalty,
			-atsSplit.maxContribution,
		);
		factors.push({
			label: `Split ATS weak (${(splitPct * 100).toFixed(0)}%)`,
			category: "ats_split",
			points,
			rawValue: splitPct,
		});
	}
}

function scoreStreak(
	features: PrePickFeatures,
	config: ScoringConfig,
	factors: ScoreFactor[],
): void {
	const { streak } = config;
	const { atsStreakType, atsStreakLength } = features.team;

	if (atsStreakType == null || atsStreakLength == null || atsStreakLength === 0)
		return;

	const cappedLength = Math.min(atsStreakLength, streak.maxStreakLength);

	if (atsStreakType === "W") {
		const raw = cappedLength * streak.winStreakPerGame;
		const points = Math.min(raw, streak.maxContribution);
		factors.push({
			label: `ATS win streak (${atsStreakLength}W)`,
			category: "streak",
			points,
			rawValue: atsStreakLength,
		});
	} else {
		const raw = cappedLength * streak.lossStreakPerGame;
		const points = Math.max(raw, -streak.maxContribution);
		factors.push({
			label: `ATS loss streak (${atsStreakLength}L)`,
			category: "streak",
			points,
			rawValue: atsStreakLength,
		});
	}
}

function scoreMatchupDelta(
	features: PrePickFeatures,
	config: ScoringConfig,
	factors: ScoreFactor[],
): void {
	const { matchupDelta } = config;
	const delta = features.matchupAtsDelta;

	if (delta == null) return;

	let points = delta * matchupDelta.deltaMultiplier;

	if (delta >= matchupDelta.strongEdgeThreshold) {
		points += matchupDelta.strongEdgeBonus;
	}

	points = Math.max(
		-matchupDelta.maxContribution,
		Math.min(matchupDelta.maxContribution, points),
	);

	const sign = delta >= 0 ? "+" : "";
	factors.push({
		label: `Matchup ATS edge (${sign}${(delta * 100).toFixed(0)}pp)`,
		category: "matchup",
		points: Math.round(points * 10) / 10,
		rawValue: delta,
	});
}

function scoreVenueRole(
	features: PrePickFeatures,
	config: ScoringConfig,
	factors: ScoreFactor[],
): void {
	const { venueRole: weights } = config;
	let points = 0;
	const labels: string[] = [];

	if (features.venueRole === "home") {
		points += weights.homeBonus;
		labels.push("home");
	}

	if (features.favDogRole === "favorite") {
		points += weights.favoriteBonus;
		labels.push("favorite");
	} else if (
		features.venueRole === "away" &&
		features.favDogRole === "dog"
	) {
		points += weights.awayDogPenalty;
		labels.push("away dog");
	}

	if (points === 0) return;

	points = Math.max(
		-weights.maxContribution,
		Math.min(weights.maxContribution, points),
	);

	factors.push({
		label: `Venue/role: ${labels.join(", ")}`,
		category: "venue_role",
		points,
		rawValue: `${features.venueRole ?? "?"}_${features.favDogRole ?? "?"}`,
	});
}

function scoreOuTrend(
	features: PrePickFeatures,
	config: ScoringConfig,
	factors: ScoreFactor[],
): void {
	const { ouTrend } = config;
	const ouOverPct = features.team.ouOverPct;

	if (ouOverPct == null || features.betType !== "total") return;

	// For totals bets, strong directional OU trend is a signal
	if (ouOverPct >= ouTrend.overHotThreshold) {
		const points = Math.min(
			ouTrend.strongAlignmentBonus,
			ouTrend.maxContribution,
		);
		factors.push({
			label: `Strong over trend (${(ouOverPct * 100).toFixed(0)}%)`,
			category: "ou_trend",
			points,
			rawValue: ouOverPct,
		});
	} else if (ouOverPct <= ouTrend.underHotThreshold) {
		const points = Math.min(
			ouTrend.strongAlignmentBonus,
			ouTrend.maxContribution,
		);
		factors.push({
			label: `Strong under trend (${((1 - ouOverPct) * 100).toFixed(0)}%)`,
			category: "ou_trend",
			points,
			rawValue: ouOverPct,
		});
	}
}

function checkConflictingSignals(
	factors: ScoreFactor[],
	warnings: ScoreWarning[],
): void {
	const positive = factors.filter((f) => f.points > 0);
	const negative = factors.filter((f) => f.points < 0);

	// Flag if there are strong signals in both directions
	const maxPositive = Math.max(0, ...positive.map((f) => f.points));
	const maxNegative = Math.min(0, ...negative.map((f) => f.points));

	if (maxPositive >= 10 && maxNegative <= -6) {
		warnings.push({
			type: "conflicting_signals",
			message: `Strong positive signal (${positive[0]?.label}) conflicts with negative signal (${negative[0]?.label}). Exercise caution.`,
		});
	}
}
