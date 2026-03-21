/**
 * Strategy Analysis Repository — Phase 7
 *
 * Bucketed performance queries that join manual picks with canonical
 * trend context. Follows the same in-memory bucketing pattern used by
 * getManualPicksBucketPerformanceSummary in manual-picks.ts.
 *
 * All trend lookups are point-in-time safe: snapshots are loaded
 * as-of the pick's picked_at time.
 */

import type { Db } from "../db/client";
import { all } from "../db/client";
import { nowUnixSeconds } from "../env";
import {
	type CanonicalFeatureVector,
	type MatchupEdgeBucket,
	type TrendBucket,
	classifyAtsTrend,
	classifyMatchupEdge,
	classifyStreakBucket,
	extractPickFeatures,
	type PickForFeatures,
} from "../domain/canonical-features";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface StrategyBucketRow {
	bucket: string;
	picks: number;
	wins: number;
	losses: number;
	pushes: number;
	winRate: number | null;
	avgRoi: number | null;
	avgClvBps: number | null;
}

export interface StrategyAnalysisSummary {
	computedAt: number;
	settledPicks: number;
	enrichedPicks: number;
	buckets: StrategyBucketRow[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface MutableBucket {
	label: string;
	count: number;
	wins: number;
	losses: number;
	pushes: number;
	roiSum: number;
	roiCount: number;
	clvBpsSum: number;
	clvBpsCount: number;
}

function initBucket(label: string): MutableBucket {
	return {
		label,
		count: 0,
		wins: 0,
		losses: 0,
		pushes: 0,
		roiSum: 0,
		roiCount: 0,
		clvBpsSum: 0,
		clvBpsCount: 0,
	};
}

function applyToBucket(bucket: MutableBucket, fv: CanonicalFeatureVector) {
	bucket.count += 1;
	if (fv.pickResult === "win") bucket.wins += 1;
	if (fv.pickResult === "loss") bucket.losses += 1;
	if (fv.pickResult === "push") bucket.pushes += 1;
	if (typeof fv.roi === "number" && Number.isFinite(fv.roi)) {
		bucket.roiSum += fv.roi;
		bucket.roiCount += 1;
	}
	if (typeof fv.clv === "number" && Number.isFinite(fv.clv)) {
		bucket.clvBpsSum += fv.clv * 10000;
		bucket.clvBpsCount += 1;
	}
}

function toBucketRow(bucket: MutableBucket): StrategyBucketRow {
	return {
		bucket: bucket.label,
		picks: bucket.count,
		wins: bucket.wins,
		losses: bucket.losses,
		pushes: bucket.pushes,
		winRate:
			bucket.wins + bucket.losses > 0
				? bucket.wins / (bucket.wins + bucket.losses)
				: null,
		avgRoi: bucket.roiCount > 0 ? bucket.roiSum / bucket.roiCount : null,
		avgClvBps:
			bucket.clvBpsCount > 0 ? bucket.clvBpsSum / bucket.clvBpsCount : null,
	};
}

function buildSummary(
	bucketMap: Map<string, MutableBucket>,
	settledCount: number,
	enrichedCount: number,
): StrategyAnalysisSummary {
	const buckets = Array.from(bucketMap.values())
		.map(toBucketRow)
		.filter((r) => r.picks > 0)
		.sort((a, b) => b.picks - a.picks);
	return {
		computedAt: nowUnixSeconds(),
		settledPicks: settledCount,
		enrichedPicks: enrichedCount,
		buckets,
	};
}

// ---------------------------------------------------------------------------
// Data loading: settled picks with enrichment
// ---------------------------------------------------------------------------

const SETTLED_ENRICHED_QUERY = `
	SELECT id, picked_at, sport_tag, bet_type, venue_role, fav_dog_role,
	       spread_line, total_line, team_id, opponent_id,
	       actual_margin, actual_total, status, roi, clv
	FROM manual_picks
	WHERE status IN ('win', 'loss', 'push')
	  AND team_id IS NOT NULL
	ORDER BY picked_at DESC
	LIMIT ?
`;

async function loadSettledEnrichedPicks(
	db: Db,
	limit: number,
): Promise<PickForFeatures[]> {
	return all<PickForFeatures>(db, SETTLED_ENRICHED_QUERY, limit);
}

/**
 * Extract feature vectors for all settled enriched picks.
 * This is the core data pipeline: picks → features → bucketing.
 */
async function loadFeatureVectors(
	db: Db,
	limit: number,
): Promise<{ vectors: CanonicalFeatureVector[]; settledCount: number }> {
	const picks = await loadSettledEnrichedPicks(db, limit);
	// Extract features in parallel (each does 2-4 snapshot lookups)
	const vectors = await Promise.all(
		picks.map((pick) => extractPickFeatures(db, pick)),
	);
	return { vectors, settledCount: picks.length };
}

// ---------------------------------------------------------------------------
// Performance by ATS Trend Bucket
// ---------------------------------------------------------------------------

/**
 * Bucket settled picks by team ATS trend (hot/neutral/cold)
 * based on overall ATS win pct at time of pick.
 */
export async function getPerformanceByTrendBucket(
	db: Db,
	options?: { limit?: number },
): Promise<StrategyAnalysisSummary> {
	const { vectors, settledCount } = await loadFeatureVectors(
		db,
		options?.limit ?? 2000,
	);

	const TREND_LABELS: TrendBucket[] = ["hot", "neutral", "cold", "unknown"];
	const buckets = new Map<string, MutableBucket>(
		TREND_LABELS.map((label) => [label, initBucket(label)]),
	);

	let enriched = 0;
	for (const fv of vectors) {
		const trend = classifyAtsTrend(fv.team.atsWinPct);
		applyToBucket(buckets.get(trend)!, fv);
		if (fv.teamSnapshotFound) enriched += 1;
	}

	return buildSummary(buckets, settledCount, enriched);
}

// ---------------------------------------------------------------------------
// Performance by ATS Streak Bucket
// ---------------------------------------------------------------------------

/**
 * Bucket settled picks by team ATS streak type + length
 * (W1-2, W3-5, W6+, L1-2, L3-5, L6+, none).
 */
export async function getPerformanceByStreakBucket(
	db: Db,
	options?: { limit?: number },
): Promise<StrategyAnalysisSummary> {
	const { vectors, settledCount } = await loadFeatureVectors(
		db,
		options?.limit ?? 2000,
	);

	const STREAK_LABELS = [
		"W1-2",
		"W3-5",
		"W6+",
		"L1-2",
		"L3-5",
		"L6+",
		"none",
	];
	const buckets = new Map<string, MutableBucket>(
		STREAK_LABELS.map((label) => [label, initBucket(label)]),
	);

	let enriched = 0;
	for (const fv of vectors) {
		const label = classifyStreakBucket(
			fv.team.atsStreakType,
			fv.team.atsStreakLength,
		);
		if (!buckets.has(label)) {
			buckets.set(label, initBucket(label));
		}
		applyToBucket(buckets.get(label)!, fv);
		if (fv.teamSnapshotFound) enriched += 1;
	}

	return buildSummary(buckets, settledCount, enriched);
}

// ---------------------------------------------------------------------------
// Performance by Matchup Edge
// ---------------------------------------------------------------------------

/**
 * Bucket settled picks by matchup ATS delta
 * (strong_edge, slight_edge, neutral, slight_disadvantage, strong_disadvantage).
 */
export async function getPerformanceByMatchupEdge(
	db: Db,
	options?: { limit?: number },
): Promise<StrategyAnalysisSummary> {
	const { vectors, settledCount } = await loadFeatureVectors(
		db,
		options?.limit ?? 2000,
	);

	const EDGE_LABELS: MatchupEdgeBucket[] = [
		"strong_edge",
		"slight_edge",
		"neutral",
		"slight_disadvantage",
		"strong_disadvantage",
		"unknown",
	];
	const buckets = new Map<string, MutableBucket>(
		EDGE_LABELS.map((label) => [label, initBucket(label)]),
	);

	let enriched = 0;
	for (const fv of vectors) {
		const edge = classifyMatchupEdge(fv.matchupAtsDelta);
		applyToBucket(buckets.get(edge)!, fv);
		if (fv.teamSnapshotFound && fv.opponentSnapshotFound) enriched += 1;
	}

	return buildSummary(buckets, settledCount, enriched);
}

// ---------------------------------------------------------------------------
// Performance by Venue × Role
// ---------------------------------------------------------------------------

/**
 * Cross-tabulate settled pick performance by venue_role × fav_dog_role.
 * Produces buckets like "home_favorite", "away_dog", "home", "away", etc.
 */
export async function getPerformanceByVenueAndRole(
	db: Db,
	options?: { limit?: number },
): Promise<StrategyAnalysisSummary> {
	const { vectors, settledCount } = await loadFeatureVectors(
		db,
		options?.limit ?? 2000,
	);

	const buckets = new Map<string, MutableBucket>();

	let enriched = 0;
	for (const fv of vectors) {
		const venue = fv.venueRole ?? "unknown";
		const role = fv.favDogRole ?? "unknown";
		const label = role !== "unknown" ? `${venue}_${role}` : venue;

		if (!buckets.has(label)) {
			buckets.set(label, initBucket(label));
		}
		applyToBucket(buckets.get(label)!, fv);
		enriched += 1;
	}

	return buildSummary(buckets, settledCount, enriched);
}

// ---------------------------------------------------------------------------
// Performance by Combined Context
// ---------------------------------------------------------------------------

/**
 * Combine multiple context dimensions into composite buckets.
 * Format: "venue|trend|streak" (e.g., "home|hot|W3-5").
 */
export async function getPerformanceByContext(
	db: Db,
	options?: { limit?: number },
): Promise<StrategyAnalysisSummary> {
	const { vectors, settledCount } = await loadFeatureVectors(
		db,
		options?.limit ?? 2000,
	);

	const buckets = new Map<string, MutableBucket>();

	let enriched = 0;
	for (const fv of vectors) {
		const venue = fv.venueRole ?? "unk";
		const trend = classifyAtsTrend(fv.team.atsWinPct);
		const streak = classifyStreakBucket(
			fv.team.atsStreakType,
			fv.team.atsStreakLength,
		);
		const label = `${venue}|${trend}|${streak}`;

		if (!buckets.has(label)) {
			buckets.set(label, initBucket(label));
		}
		applyToBucket(buckets.get(label)!, fv);
		if (fv.teamSnapshotFound) enriched += 1;
	}

	return buildSummary(buckets, settledCount, enriched);
}

// ---------------------------------------------------------------------------
// Feature vector batch export
// ---------------------------------------------------------------------------

/**
 * Extract feature vectors for all settled enriched picks.
 * Returns the raw vectors for API consumption and frontend rendering.
 */
export async function getPickFeatureVectors(
	db: Db,
	options?: { limit?: number },
): Promise<{
	computedAt: number;
	vectors: CanonicalFeatureVector[];
	settledPicks: number;
	enrichedPicks: number;
}> {
	const { vectors, settledCount } = await loadFeatureVectors(
		db,
		options?.limit ?? 500,
	);
	const enrichedCount = vectors.filter((v) => v.teamSnapshotFound).length;
	return {
		computedAt: nowUnixSeconds(),
		vectors,
		settledPicks: settledCount,
		enrichedPicks: enrichedCount,
	};
}
