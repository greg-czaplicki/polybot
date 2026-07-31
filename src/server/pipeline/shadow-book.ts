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
import { findPriceAtOrBefore } from "../repositories/manual-picks";
import {
	listSharpMoneyCache,
	listSharpMoneyHistoryByConditionIds,
} from "../repositories/sharp-money";

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
	warnings?: string[];
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
					minutes_to_start, event_time, strategy_version, created_at,
					warnings_json, status
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
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
				input.warnings && input.warnings.length > 0
					? JSON.stringify(input.warnings)
					: null,
			);
			recorded += 1;
		} catch (error) {
			console.warn("[shadow-book] record failed:", error);
			continue;
		}
	}
	return recorded;
}

/**
 * Mirrors the bot's max-minutes-to-start window (see bot_candidate_snapshots:
 * consistently 60-180). Entries beyond it never reach the candidate scan at
 * all — the scan's cache query is clipped to ceil(maxMinutesToStart/60) hours
 * — so the early-timing counterfactual must be recorded here, from the cron
 * tick, NOT by widening the scan (that could displace real in-window
 * candidates via the edge-rating-ordered LIMIT).
 */
const BOT_MAX_MINUTES_TO_START = 180;

/**
 * Record "what if we bet earlier than the bot's window" shadows: cache
 * entries starting more than BOT_MAX_MINUTES_TO_START out, at their current
 * price. Grade fields stay null — grading only runs inside the scan.
 * D1-only (no external fetches); safe on every cron tick.
 */
export async function recordEarlyWindowShadows(
	db: Db,
	options?: { maxMinutesToStart?: number },
): Promise<number> {
	const maxMinutes = options?.maxMinutesToStart ?? BOT_MAX_MINUTES_TO_START;
	try {
		const entries = await listSharpMoneyCache(db, {
			limit: 50,
			windowHours: 24,
		});
		const now = Date.now();
		const inputs: ShadowCandidateInput[] = [];
		for (const entry of entries) {
			if (!entry.eventTime) continue;
			const eventTimeMs = new Date(entry.eventTime).getTime();
			if (!Number.isFinite(eventTimeMs)) continue;
			const minutesToStart = (eventTimeMs - now) / 60_000;
			if (minutesToStart <= maxMinutes) continue;
			inputs.push({
				conditionId: entry.conditionId,
				rejectReason: "outside_window",
				marketTitle: entry.marketTitle,
				sportSeriesId: entry.sportSeriesId,
				sharpSide: entry.sharpSide,
				price:
					entry.sharpSide === "A"
						? (entry.sideA.price ?? null)
						: entry.sharpSide === "B"
							? (entry.sideB.price ?? null)
							: null,
				minutesToStart,
				eventTime: entry.eventTime,
			});
		}
		return await recordShadowCandidates(db, inputs);
	} catch (error) {
		console.warn("[shadow-book] early-window record failed:", error);
		return 0;
	}
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

	// Close prices from pre-event history (same rule as real picks: last
	// sample within 1h of start, NEVER post-resolution outcome prices).
	// History prunes at 7 days, so this must happen at settlement time.
	let historyByConditionId: Awaited<
		ReturnType<typeof listSharpMoneyHistoryByConditionIds>
	> = {};
	const eventTimes = rows
		.map((r) => r.event_time)
		.filter((t): t is number => typeof t === "number");
	if (eventTimes.length > 0) {
		try {
			historyByConditionId = await listSharpMoneyHistoryByConditionIds(
				db,
				[...new Set(rows.map((r) => r.condition_id))],
				Math.min(...eventTimes) - 4 * 60 * 60,
			);
		} catch (error) {
			console.warn("[shadow-book] close-price history lookup failed:", error);
		}
	}

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
		const history = historyByConditionId[row.condition_id];
		const closePrice =
			row.event_time !== null &&
			history &&
			history.length > 0 &&
			(row.sharp_side === "A" || row.sharp_side === "B")
				? findPriceAtOrBefore(history, row.sharp_side, row.event_time, 3600)
				: null;
		const clv =
			resolution.status !== "push" && closePrice !== null
				? closePrice - row.price
				: null;
		await run(
			db,
			`UPDATE shadow_candidates
			 SET status = ?, resolved_outcome = ?, roi = ?, close_price = ?, clv = ?, settled_at = ?
			 WHERE id = ?`,
			resolution.status,
			resolution.resolvedOutcome ?? null,
			resolution.roi ?? null,
			closePrice,
			clv,
			now,
			row.id,
		);
		updated += 1;
	}
	return { checked: rows.length, updated };
}
