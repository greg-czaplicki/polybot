/**
 * Opportunity Ranking API — Phase 8
 *
 * Server functions exposing pre-pick opportunity scoring and ranking.
 * Each endpoint wraps a repository query into a TanStack Start server
 * function callable from the /opportunities route.
 *
 * Consumers: opportunities route (src/routes/opportunities.tsx)
 */

import { createServerFn } from "@tanstack/react-start";
import { getDb } from "../env";
import {
	getRankedOpportunities,
	type RankedOpportunitySummary,
} from "../repositories/opportunity-ranking";

// ---------------------------------------------------------------------------
// Ranked Opportunities
// ---------------------------------------------------------------------------

/** Fetch scored and ranked upcoming opportunities. */
export const getRankedOpportunitiesFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as { limit?: number };
	const db = getDb(context);
	const result: RankedOpportunitySummary = await getRankedOpportunities(db, {
		limit: payload.limit,
	});
	return { ranking: result };
});
