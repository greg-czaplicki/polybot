/**
 * Shadow book: makes hard policy gates falsifiable.
 *
 * Every pick-time policy gate (0-15m timing, NBA >90m, NHL, NCAAB spread,
 * spread blanket, NFL preseason, ...) is a filter — rejected candidates never
 * produce outcomes, so a gate can never be proven right or wrong from the
 * pick book alone (2026-07-30 audit: all 318 settled picks are 1-3h; the
 * excluded windows have zero outcome data).
 *
 * This module records each policy-rejected candidate ONCE per
 * (condition_id, reject_reason) at first sight — the analog of pick time —
 * and settles it through the same Gamma resolution logic as real picks,
 * without betting. Audit query: ROI by reject_reason = what each gate
 * saved or cost.
 */

import { STRATEGY_VERSION } from "@/lib/strategy-version";
import {
	fetchGammaMarket,
	resolvePickResult,
} from "../api/manual-picks";
import { resolveSportTagFromSeriesId } from "../api/series-registry";
import type { Db } from "../db/client";
import { all, run } from "../db/client";
import { nowUnixSeconds } from "../env";

export interface ShadowCandidateInput {
	conditionId: string;
	rejectReason: string;
	marketTitle: string;
	marketType?: string;
	sportSeriesId?: number;
	sharpSide?: string;
	price?: number | null;
	grade?: string;
	baseMinGrade?: string;
	signalScore?: number;
	marketQualityScore?: number;
	minutesToStart?: number | null;
	eventTime?: string | null;
}

function generateId(): string {
	return `shadow_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Record policy-rejected candidates. INSERT OR IGNORE on
 * (condition_id, reject_reason): the first sighting wins, mirroring how a
 * real pick is placed the first time a candidate passes. Never throws —
 * the candidate scan must not break on shadow-book failures.
 */
export async function recordShadowCandidates(
	db: Db,
	inputs: ShadowCandidateInput[],
): Promise<number> {
	let recorded = 0;
	const seen = new Set<string>();
	for (const input of inputs) {
		// Only settleable candidates: need a side and an entry price.
		if (input.sharpSide !== "A" && input.sharpSide !== "B") continue;
		if (
			typeof input.price !== "number" ||
			!Number.isFinite(input.price) ||
			input.price <= 0
		)
			continue;
		const key = `${input.conditionId}|${input.rejectReason}`;
		if (seen.has(key)) continue;
		seen.add(key);

		const eventTimeSeconds = input.eventTime
			? Math.floor(new Date(input.eventTime).getTime() / 1000)
			: null;

		try {
			await run(
				db,
				`INSERT OR IGNORE INTO shadow_candidates (
					id, condition_id, reject_reason, market_title, market_type,
					sport_series_id, sport_tag, sharp_side, price, grade,
					base_min_grade, signal_score, market_quality_score,
					minutes_to_start, event_time, strategy_version, created_at, status
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
				generateId(),
				input.conditionId,
				input.rejectReason,
				input.marketTitle,
				input.marketType ?? null,
				input.sportSeriesId ?? null,
				resolveSportTagFromSeriesId(input.sportSeriesId) ?? null,
				input.sharpSide,
				input.price,
				input.grade ?? null,
				input.baseMinGrade ?? null,
				input.signalScore ?? null,
				input.marketQualityScore ?? null,
				input.minutesToStart ?? null,
				Number.isFinite(eventTimeSeconds) ? eventTimeSeconds : null,
				STRATEGY_VERSION,
				nowUnixSeconds(),
			);
			recorded += 1;
		} catch (error) {
			console.warn("[shadow-book] record failed:", error);
			return recorded;
		}
	}
	return recorded;
}

interface ShadowRow {
	id: string;
	condition_id: string;
	sharp_side: string;
	price: number;
	event_time: number | null;
}

/**
 * Settle pending shadow candidates whose events have started, via the same
 * Gamma resolution path as real picks (resolvePickResult — including the
 * mid-game-settlement guard). Bounded by `limit` Gamma fetches per call.
 */
export async function settleShadowCandidates(
	db: Db,
	options?: { limit?: number },
): Promise<{ checked: number; updated: number }> {
	const limit =
		typeof options?.limit === "number" && options.limit > 0
			? Math.min(options.limit, 50)
			: 15;
	// Same eligibility rule as picks: event started at least 15 minutes ago.
	// Rows with NULL event_time settle only once they are 24h old, as a
	// safety valve against permanently-pending rows.
	const now = nowUnixSeconds();
	const rows = await all<ShadowRow>(
		db,
		`SELECT id, condition_id, sharp_side, price, event_time
		 FROM shadow_candidates
		 WHERE status = 'pending'
		   AND (
		     (event_time IS NOT NULL AND event_time <= ?)
		     OR (event_time IS NULL AND created_at <= ?)
		   )
		 ORDER BY event_time ASC
		 LIMIT ?`,
		now - 15 * 60,
		now - 24 * 60 * 60,
		limit,
	);
	if (rows.length === 0) return { checked: 0, updated: 0 };

	let updated = 0;
	for (const row of rows) {
		const market = await fetchGammaMarket(row.condition_id);
		if (!market) continue;
		const resolution = resolvePickResult({
			sharpSide: row.sharp_side,
			entryPrice: row.price,
			market,
		});
		if (!resolution) continue;
		await run(
			db,
			`UPDATE shadow_candidates
			 SET status = ?, resolved_outcome = ?, roi = ?, settled_at = ?
			 WHERE id = ?`,
			resolution.status,
			resolution.resolvedOutcome ?? null,
			resolution.roi ?? null,
			now,
			row.id,
		);
		updated += 1;
	}
	return { checked: rows.length, updated };
}
