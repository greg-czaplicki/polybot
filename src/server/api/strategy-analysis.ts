/**
 * Strategy Analysis API — Phase 7
 *
 * Server functions exposing canonical context-based performance analysis.
 * Each endpoint wraps a strategy-analysis repository query into a
 * TanStack Start server function callable from app routes.
 *
 * Consumers: strategy route (src/routes/strategy.tsx) and frontend
 * components that render context-based performance tables.
 */

import { createServerFn } from "@tanstack/react-start";
import { getDb } from "../env";
import { extractPickFeatures, type PickForFeatures } from "../domain/canonical-features";
import { first } from "../db/client";
import {
	getPerformanceByContext,
	getPerformanceByMatchupEdge,
	getPerformanceByStreakBucket,
	getPerformanceByTrendBucket,
	getPerformanceByVenueAndRole,
	getPickFeatureVectors,
} from "../repositories/strategy-analysis";

// ---------------------------------------------------------------------------
// Performance by ATS Trend Bucket
// ---------------------------------------------------------------------------

/** Performance breakdown by team ATS trend (hot/neutral/cold). */
export const getStrategyTrendPerformanceFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as { limit?: number };
	const db = getDb(context);
	const result = await getPerformanceByTrendBucket(db, {
		limit: payload.limit,
	});
	return { analysis: result };
});

// ---------------------------------------------------------------------------
// Performance by ATS Streak Bucket
// ---------------------------------------------------------------------------

/** Performance breakdown by team ATS streak type and length. */
export const getStrategyStreakPerformanceFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as { limit?: number };
	const db = getDb(context);
	const result = await getPerformanceByStreakBucket(db, {
		limit: payload.limit,
	});
	return { analysis: result };
});

// ---------------------------------------------------------------------------
// Performance by Matchup Edge
// ---------------------------------------------------------------------------

/** Performance breakdown by matchup ATS delta (edge classification). */
export const getStrategyMatchupEdgePerformanceFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as { limit?: number };
	const db = getDb(context);
	const result = await getPerformanceByMatchupEdge(db, {
		limit: payload.limit,
	});
	return { analysis: result };
});

// ---------------------------------------------------------------------------
// Performance by Venue × Role
// ---------------------------------------------------------------------------

/** Performance cross-tabulated by venue role and fav/dog role. */
export const getStrategyVenueRolePerformanceFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as { limit?: number };
	const db = getDb(context);
	const result = await getPerformanceByVenueAndRole(db, {
		limit: payload.limit,
	});
	return { analysis: result };
});

// ---------------------------------------------------------------------------
// Performance by Combined Context
// ---------------------------------------------------------------------------

/** Performance by combined context (venue|trend|streak). */
export const getStrategyContextPerformanceFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as { limit?: number };
	const db = getDb(context);
	const result = await getPerformanceByContext(db, {
		limit: payload.limit,
	});
	return { analysis: result };
});

// ---------------------------------------------------------------------------
// Single Pick Feature Extraction
// ---------------------------------------------------------------------------

/** Extract canonical features for a single pick by ID. */
export const getPickFeaturesFn = createServerFn({
	method: "POST",
})
	.inputValidator((d: { pickId: string }) => d)
	.handler(async ({ context, data }) => {
		if (!data.pickId) {
			return { features: null, error: "pickId is required" };
		}

		const db = getDb(context);
		const pick = await first<PickForFeatures>(
			db,
			`SELECT id, picked_at, sport_tag, bet_type, venue_role, fav_dog_role,
			        spread_line, total_line, team_id, opponent_id,
			        actual_margin, actual_total, status, roi, clv
			 FROM manual_picks WHERE id = ?`,
			data.pickId,
		);

		if (!pick) {
			return { features: null, error: `Pick not found: ${data.pickId}` };
		}

		const features = await extractPickFeatures(db, pick);
		return { features };
	});

// ---------------------------------------------------------------------------
// Batch Feature Extraction
// ---------------------------------------------------------------------------

/** Extract canonical features for all settled enriched picks. */
export const getPickFeaturesBatchFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as { limit?: number };
	const db = getDb(context);
	const result = await getPickFeatureVectors(db, {
		limit: payload.limit,
	});
	return { batch: result };
});
