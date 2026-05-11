/**
 * Opportunity Scoring — Phase 8
 *
 * Scores upcoming opportunities using only leakage-safe pre-pick
 * canonical features. Every score is fully explainable: the output
 * includes the total score, individual factor contributions,
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
import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from "./scoring-weights";

// ---------------------------------------------------------------------------
// Score factor types
// ---------------------------------------------------------------------------

/**
 * A single contributing factor to an opportunity score.
 * Positive points = favorable signal; negative = unfavorable.
 */
export interface ScoringFactor {
	/** Machine-readable factor name (e.g., "ats_trend") */
	name: string;
	/** Human-readable label for display */
	label: string;
	/** Points contributed (positive or negative) */
	points: number;
	/** Optional detail string (raw value formatted for display) */
	detail?: string;
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
	/**
	 * For totals bets: the direction the pick is on ("over" or "under").
	 * Required for the scorer to evaluate OU-trend alignment. Null for
	 * non-totals or when the direction cannot be inferred.
	 */
	pickedDirection: "over" | "under" | null;
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
	totalScore: number;
	/** Raw (un-normalized) score for debugging */
	rawScore: number;
	/** All contributing factors (positive and negative), sorted by abs(points) desc */
	factors: ScoringFactor[];
	/** Data quality and signal warnings as human-readable strings */
	warnings: string[];
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
	const factors: ScoringFactor[] = [];
	const warnings: string[] = [];
	const isTotals = features.betType === "total";

	// --- Data quality checks (always) ---
	scoreDataQuality(features, config, factors, warnings);

	if (isTotals) {
		// OU-specific scoring only — ATS signals don't apply to totals outcomes.
		scoreOuTrend(features, config, factors, warnings);
		scoreOuMatchupDelta(features, config, factors);
		scoreOuStreak(features, config, factors);
		scoreVenueRole(features, config, factors);
	} else {
		// ATS-style bets (spread, moneyline).
		scoreAtsTrend(features, config, factors);
		scoreAtsSplit(features, config, factors);
		scoreStreak(features, config, factors);
		scoreMatchupDelta(features, config, factors);
		scoreVenueRole(features, config, factors);
	}

	// --- Check for conflicting signals ---
	checkConflictingSignals(factors, warnings);

	// Compute raw total
	const rawScore = factors.reduce((sum, f) => sum + f.points, 0);

	// Normalize to 0–100 using bet-type-specific max.
	const denom = isTotals ? config.maxRawScoreTotals : config.maxRawScore;
	const totalScore = Math.max(
		0,
		Math.min(100, Math.round((rawScore / denom) * 100)),
	);

	// Sort factors by absolute contribution
	factors.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));

	return { totalScore, rawScore, factors, warnings };
}

/**
 * Score and rank multiple opportunities.
 * Returns scores sorted descending by totalScore.
 */
export function rankOpportunities(
	featuresList: PrePickFeatures[],
	config?: ScoringConfig,
): OpportunityScore[] {
	return featuresList
		.map((f) => scoreOpportunity(f, config))
		.sort((a, b) => b.totalScore - a.totalScore);
}

// ---------------------------------------------------------------------------
// Individual scoring functions
// ---------------------------------------------------------------------------

function scoreDataQuality(
	features: PrePickFeatures,
	config: ScoringConfig,
	factors: ScoringFactor[],
	warnings: string[],
): void {
	if (!features.teamSnapshotFound && !features.opponentSnapshotFound) {
		factors.push({
			name: "no_context",
			label: "No canonical context available",
			points: config.dataQuality.noContextPenalty,
		});
		warnings.push(
			"Neither team nor opponent has trend snapshot data. Score is unreliable.",
		);
		return;
	}

	if (!features.teamSnapshotFound) {
		factors.push({
			name: "missing_team_snapshot",
			label: "Missing team trend data",
			points: config.dataQuality.missingTeamSnapshotPenalty,
		});
		warnings.push(
			"Team trend snapshot not found. ATS/streak signals unavailable.",
		);
	}

	if (!features.opponentSnapshotFound) {
		factors.push({
			name: "missing_opponent_snapshot",
			label: "Missing opponent trend data",
			points: config.dataQuality.missingOpponentSnapshotPenalty,
		});
		warnings.push(
			"Opponent trend snapshot not found. Matchup delta unavailable.",
		);
	}
}

function scoreAtsTrend(
	features: PrePickFeatures,
	config: ScoringConfig,
	factors: ScoringFactor[],
): void {
	const { atsTrend } = config;
	const atsWinPct = features.team.atsWinPct;

	if (atsWinPct == null) return;

	if (atsWinPct >= atsTrend.hotThreshold) {
		const points = Math.min(atsTrend.hotBonus, atsTrend.maxContribution);
		factors.push({
			name: "ats_trend",
			label: `Team ATS hot (${(atsWinPct * 100).toFixed(0)}%)`,
			points,
			detail: `ATS win pct: ${(atsWinPct * 100).toFixed(1)}%`,
		});
	} else if (atsWinPct <= atsTrend.coldThreshold) {
		const points = Math.max(atsTrend.coldPenalty, -atsTrend.maxContribution);
		factors.push({
			name: "ats_trend",
			label: `Team ATS cold (${(atsWinPct * 100).toFixed(0)}%)`,
			points,
			detail: `ATS win pct: ${(atsWinPct * 100).toFixed(1)}%`,
		});
	}
}

function scoreAtsSplit(
	features: PrePickFeatures,
	config: ScoringConfig,
	factors: ScoringFactor[],
): void {
	const { atsSplit } = config;
	const splitPct = features.team.atsSplitPct;

	if (splitPct == null) return;

	if (splitPct >= atsSplit.splitHotThreshold) {
		const points = Math.min(atsSplit.splitHotBonus, atsSplit.maxContribution);
		factors.push({
			name: "ats_split",
			label: `Split ATS strong (${(splitPct * 100).toFixed(0)}%)`,
			points,
			detail: `Split ATS pct: ${(splitPct * 100).toFixed(1)}%`,
		});
	} else if (splitPct <= atsSplit.splitColdThreshold) {
		const points = Math.max(
			atsSplit.splitColdPenalty,
			-atsSplit.maxContribution,
		);
		factors.push({
			name: "ats_split",
			label: `Split ATS weak (${(splitPct * 100).toFixed(0)}%)`,
			points,
			detail: `Split ATS pct: ${(splitPct * 100).toFixed(1)}%`,
		});
	}
}

function scoreStreak(
	features: PrePickFeatures,
	config: ScoringConfig,
	factors: ScoringFactor[],
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
			name: "streak",
			label: `ATS win streak (${atsStreakLength}W)`,
			points,
			detail: `${atsStreakLength} consecutive ATS wins`,
		});
	} else {
		const raw = cappedLength * streak.lossStreakPerGame;
		const points = Math.max(raw, -streak.maxContribution);
		factors.push({
			name: "streak",
			label: `ATS loss streak (${atsStreakLength}L)`,
			points,
			detail: `${atsStreakLength} consecutive ATS losses`,
		});
	}
}

function scoreMatchupDelta(
	features: PrePickFeatures,
	config: ScoringConfig,
	factors: ScoringFactor[],
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
		name: "matchup",
		label: `Matchup ATS edge (${sign}${(delta * 100).toFixed(0)}pp)`,
		points: Math.round(points * 10) / 10,
		detail: `ATS delta: ${sign}${(delta * 100).toFixed(1)}pp`,
	});
}

function scoreVenueRole(
	features: PrePickFeatures,
	config: ScoringConfig,
	factors: ScoringFactor[],
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
	} else if (features.venueRole === "away" && features.favDogRole === "dog") {
		points += weights.awayDogPenalty;
		labels.push("away dog");
	}

	if (points === 0) return;

	points = Math.max(
		-weights.maxContribution,
		Math.min(weights.maxContribution, points),
	);

	factors.push({
		name: "venue_role",
		label: `Venue/role: ${labels.join(", ")}`,
		points,
		detail: `${features.venueRole ?? "?"} / ${features.favDogRole ?? "?"}`,
	});
}

/**
 * Score the OU trend signal per side (team + opponent). Rewards each side's
 * directional OU lean when it aligns with the pick direction, penalizes when
 * it opposes. Combined from both teams since a total is a joint outcome.
 */
function scoreOuTrend(
	features: PrePickFeatures,
	config: ScoringConfig,
	factors: ScoringFactor[],
	warnings: string[],
): void {
	const { ouTrend } = config;
	const pick = features.pickedDirection;

	if (pick == null) {
		if (
			features.team.ouOverPct != null ||
			features.opponent.ouOverPct != null
		) {
			warnings.push(
				"Pick direction (over/under) unavailable; OU trend signal skipped.",
			);
		}
		return;
	}

	let totalPoints = 0;
	const labels: string[] = [];

	for (const [sideLabel, side] of [
		["team", features.team] as const,
		["opp", features.opponent] as const,
	]) {
		const ouOverPct = side.ouOverPct;
		if (ouOverPct == null) continue;

		let leaning: "over" | "under" | null = null;
		if (ouOverPct >= ouTrend.overHotThreshold) leaning = "over";
		else if (ouOverPct <= ouTrend.underHotThreshold) leaning = "under";
		if (leaning == null) continue;

		const aligned = leaning === pick;
		const raw = aligned ? ouTrend.alignedBonus : ouTrend.misalignedPenalty;
		// Each side contributes half to keep category within maxContribution.
		totalPoints += raw / 2;
		const pct = leaning === "over" ? ouOverPct : 1 - ouOverPct;
		labels.push(
			`${sideLabel} ${leaning} ${(pct * 100).toFixed(0)}%${aligned ? "" : " (vs pick)"}`,
		);
	}

	if (labels.length === 0) return;

	const capped = Math.max(
		-ouTrend.maxContribution,
		Math.min(ouTrend.maxContribution, totalPoints),
	);
	factors.push({
		name: "ou_trend",
		label: `OU trend: ${labels.join(", ")}`,
		points: Math.round(capped * 10) / 10,
		detail: `pick=${pick}`,
	});
}

/**
 * Score the combined OU lean of team + opponent vs the pick direction.
 * Uses the average of both sides' ouOverPct as the combined signal and
 * rewards/penalizes based on how strongly it leans with/against the pick.
 */
function scoreOuMatchupDelta(
	features: PrePickFeatures,
	config: ScoringConfig,
	factors: ScoringFactor[],
): void {
	const { ouMatchup } = config;
	const pick = features.pickedDirection;
	if (pick == null) return;

	const teamPct = features.team.ouOverPct;
	const oppPct = features.opponent.ouOverPct;
	if (teamPct == null || oppPct == null) return;

	const combined = (teamPct + oppPct) / 2;
	const signedDeviation = pick === "over" ? combined - 0.5 : 0.5 - combined;
	// signedDeviation is positive when the combined lean matches the pick.

	const aligned = signedDeviation >= 0;
	let points = aligned
		? signedDeviation * ouMatchup.alignedMultiplier
		: signedDeviation * -ouMatchup.misalignedMultiplier;
	// (misalignedMultiplier is negative; -(-80)*negDev = positive penalty applied
	// via negDev sign, giving a negative score.)

	if (aligned && signedDeviation >= ouMatchup.strongEdgeThreshold) {
		points += ouMatchup.strongAlignedBonus;
	}

	points = Math.max(
		-ouMatchup.maxContribution,
		Math.min(ouMatchup.maxContribution, points),
	);

	const sign = signedDeviation >= 0 ? "+" : "";
	factors.push({
		name: "ou_matchup",
		label: `OU matchup lean ${sign}${(signedDeviation * 100).toFixed(0)}pp ${aligned ? "with" : "vs"} pick`,
		points: Math.round(points * 10) / 10,
		detail: `team ${(teamPct * 100).toFixed(0)}% / opp ${(oppPct * 100).toFixed(0)}% → combined ${(combined * 100).toFixed(0)}% over`,
	});
}

/**
 * Score OU streak alignment. A team currently going over (W = went over) lends
 * support to Over picks and detracts from Under picks, and vice versa.
 */
function scoreOuStreak(
	features: PrePickFeatures,
	config: ScoringConfig,
	factors: ScoringFactor[],
): void {
	const { ouStreak } = config;
	const pick = features.pickedDirection;
	if (pick == null) return;

	let totalPoints = 0;
	const labels: string[] = [];

	for (const [sideLabel, side] of [
		["team", features.team] as const,
		["opp", features.opponent] as const,
	]) {
		const { ouStreakType, ouStreakLength } = side;
		if (ouStreakType == null || ouStreakLength == null || ouStreakLength === 0)
			continue;

		// W = went over, L = went under (per snapshot convention).
		const streakDirection: "over" | "under" = ouStreakType === "W" ? "over" : "under";
		const aligned = streakDirection === pick;
		const capped = Math.min(ouStreakLength, ouStreak.maxStreakLength);
		const perGame = aligned ? ouStreak.alignedPerGame : ouStreak.misalignedPerGame;
		const contribution = (capped * perGame) / 2; // half per side
		totalPoints += contribution;
		labels.push(
			`${sideLabel} ${ouStreakLength}${streakDirection === "over" ? "O" : "U"}${aligned ? "" : "↯"}`,
		);
	}

	if (labels.length === 0) return;

	const capped = Math.max(
		-ouStreak.maxContribution,
		Math.min(ouStreak.maxContribution, totalPoints),
	);
	factors.push({
		name: "ou_streak",
		label: `OU streak: ${labels.join(", ")}`,
		points: Math.round(capped * 10) / 10,
		detail: `pick=${pick}`,
	});
}

function checkConflictingSignals(
	factors: ScoringFactor[],
	warnings: string[],
): void {
	const positive = factors.filter((f) => f.points > 0);
	const negative = factors.filter((f) => f.points < 0);

	const maxPositive = Math.max(0, ...positive.map((f) => f.points));
	const maxNegative = Math.min(0, ...negative.map((f) => f.points));

	if (maxPositive >= 10 && maxNegative <= -6) {
		const topPos = positive.sort((a, b) => b.points - a.points)[0];
		const topNeg = negative.sort((a, b) => a.points - b.points)[0];
		warnings.push(
			`Conflicting signals: ${topPos?.label} vs ${topNeg?.label}. Exercise caution.`,
		);
	}
}
