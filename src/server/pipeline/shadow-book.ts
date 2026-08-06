/**
 * Shadow book: makes hard policy gates falsifiable.
 *
 * Every pick-time policy gate (sub-60m timing, NBA >90m, NHL, NCAAB spread,
 * spread blanket, NFL preseason, ...) is a filter — rejected candidates never
 * produce outcomes, so a gate can never be proven right or wrong from the
 * pick book alone (2026-07-30 audit: all 318 settled picks are 1-3h; the
 * excluded windows have zero outcome data).
 *
 * This module records each policy-rejected candidate ONCE per
 * (condition_id, reject_reason) at first sight — the analog of pick time —
 * and settles it through the same Gamma resolution logic as real picks,
 * without betting.
 *
 * Reading the results: reject_reason is the FIRST gate that fired, not the
 * only one — the gate chain early-returns, so ROI GROUP BY reject_reason
 * answers "how did candidates that first failed here perform," NOT "what
 * would loosening this gate recover" (a candidate rejected by two gates is
 * not admitted by loosening one). For the recovery question, filter on
 * gates_json (migration 0027, populated from 2026-08-06): rows where every
 * gate EXCEPT the one under study passes. Pre-0027 rows have no vector;
 * among them only price_edge_below_floor — last in the chain — is a clean
 * single-gate cohort.
 */

import type { SignalScoreBreakdown } from "@/lib/sharp-grade";
import { computeGateVector } from "@/lib/sharp-grade";
import { STRATEGY_VERSION } from "@/lib/strategy-version";
import { fetchGammaMarket, resolvePickResult } from "../api/manual-picks";
import { resolveSportTagFromSeriesId } from "../api/series-registry";
import {
	computePriceEdgeFromEntry,
	computeSharpMoneyGrades,
} from "../api/sharp-money";
import type { Db } from "../db/client";
import { all, run } from "../db/client";
import { nowUnixSeconds } from "../env";
import { findPriceAtOrBefore } from "../repositories/manual-picks";
import {
	listSharpMoneyCache,
	listSharpMoneyHistoryByConditionIds,
} from "../repositories/sharp-money";
import { getMarketTypeLabel } from "./line-ingestion";

export interface ShadowCandidateInput {
	conditionId: string;
	rejectReason: string;
	marketTitle: string;
	marketType?: string;
	sportSeriesId?: number;
	sharpSide?: string;
	/** Outcome label of the sharp side ("Over", "Under", team name) — sharp_side alone is unreadable for totals. */
	sharpSideLabel?: string | null;
	price?: number | null;
	grade?: string;
	baseMinGrade?: string;
	signalScore?: number;
	marketQualityScore?: number;
	minutesToStart?: number | null;
	eventTime?: string | null;
	warnings?: string[];
	/**
	 * Canonical trend features at record time (fav/dog role, venue, streaks,
	 * canonical score) — same data the scorer sees for real picks. Serialized
	 * to trend_context_json.
	 */
	trendContext?: Record<string, unknown> | null;
	/**
	 * Signal-score component breakdown at record time (edge/diff/trend/
	 * novelty/volume terms). Serialized to signal_components_json so blend
	 * weights can be recalibrated from shadow outcomes.
	 */
	signalComponents?: SignalScoreBreakdown | null;
	/**
	 * Compact sharp-side top-holder roster at record time — joins shadow
	 * outcomes to wallet-CLV skill scores. Serialized to top_holders_json.
	 */
	topHolders?: Array<Record<string, unknown>> | null;
	/**
	 * Raw values behind the global calibration gates, captured at record time
	 * regardless of which gate fired. The gate chain early-returns, so without
	 * these a cohort's "would it have passed the other gates" is unknowable
	 * (2026-08-06: the price_edge/saturation shadow cohorts could not be
	 * compared because saturation fires before price edge is ever computed).
	 */
	priceEdge?: number | null;
	fairPrice?: number | null;
	edgeRating?: number | null;
	scoreDifferential?: number | null;
}

function generateId(): string {
	return `shadow_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Compact sharp-side holder roster for persistence on picks and shadows —
 * enough to join outcomes to wallet-CLV skill scores later, small enough to
 * store on every row. (2026-08-04 deep-dive follow-up.)
 */
export function compactTopHolders(
	holders: Array<{
		proxyWallet: string;
		amount: number;
		unitSize?: number | null;
		pnlAll?: number | null;
		momentumWeight?: number | null;
		pnlTierWeight?: number | null;
	}>,
	limit = 10,
): Array<Record<string, unknown>> {
	return holders
		.slice()
		.sort((left, right) => right.amount - left.amount)
		.slice(0, limit)
		.map((holder) => ({
			wallet: holder.proxyWallet,
			amountUsd: Math.round(holder.amount),
			unitSize: holder.unitSize ?? null,
			pnlAll: holder.pnlAll ?? null,
			momentumWeight: holder.momentumWeight ?? null,
			pnlTierWeight: holder.pnlTierWeight ?? null,
		}));
}

/**
 * Keys ("conditionId|rejectReason") already present in shadow_candidates,
 * for the given condition ids. Lets callers skip expensive per-row work
 * (trend-context computation) for candidates whose first sighting was a
 * prior scan — INSERT OR IGNORE would drop the row anyway.
 */
export async function listExistingShadowKeys(
	db: Db,
	conditionIds: string[],
): Promise<Set<string>> {
	const keys = new Set<string>();
	const ids = [...new Set(conditionIds)];
	const CHUNK = 80;
	for (let i = 0; i < ids.length; i += CHUNK) {
		const chunk = ids.slice(i, i + CHUNK);
		const rows = await all<{ condition_id: string; reject_reason: string }>(
			db,
			`SELECT condition_id, reject_reason FROM shadow_candidates
			 WHERE condition_id IN (${chunk.map(() => "?").join(",")})`,
			...chunk,
		);
		for (const row of rows)
			keys.add(`${row.condition_id}|${row.reject_reason}`);
	}
	return keys;
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

		// Evaluated here — after late-grade enrichment has filled signalScore /
		// grade on pre-filter rejects — so the vector reflects the enriched row.
		const gateVector = computeGateVector({
			priceEdge: input.priceEdge,
			edgeRating: input.edgeRating,
			signalScore: input.signalScore,
			scoreDifferential: input.scoreDifferential,
			grade: input.grade,
			baseMinGrade: input.baseMinGrade,
		});

		try {
			await run(
				db,
				`INSERT OR IGNORE INTO shadow_candidates (
					id, condition_id, reject_reason, market_title, market_type,
					sport_series_id, sport_tag, sharp_side, sharp_side_label, price,
					grade, base_min_grade, signal_score, market_quality_score,
					minutes_to_start, event_time, strategy_version, created_at,
					warnings_json, trend_context_json, signal_components_json,
					top_holders_json, price_edge, fair_price, edge_rating,
					score_differential, gates_json, status
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
				generateId(),
				input.conditionId,
				input.rejectReason,
				input.marketTitle,
				input.marketType ?? null,
				input.sportSeriesId ?? null,
				resolveSportTagFromSeriesId(input.sportSeriesId) ?? null,
				input.sharpSide,
				input.sharpSideLabel ?? null,
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
				input.trendContext ? JSON.stringify(input.trendContext) : null,
				input.signalComponents ? JSON.stringify(input.signalComponents) : null,
				input.topHolders && input.topHolders.length > 0
					? JSON.stringify(input.topHolders)
					: null,
				input.priceEdge ?? null,
				input.fairPrice ?? null,
				input.edgeRating ?? null,
				input.scoreDifferential ?? null,
				JSON.stringify(gateVector),
			);
			recorded += 1;
		} catch (error) {
			console.warn("[shadow-book] record failed:", error);
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
 * price. First sightings are graded via the same pass as the scan so their
 * rows are comparable to would-have-been-picks (2026-08-03 checkpoint
 * caveat). D1-only (no external fetches); safe on every cron tick.
 */
export async function recordEarlyWindowShadows(
	db: Db,
	options?: { maxMinutesToStart?: number },
): Promise<number> {
	const maxMinutes = options?.maxMinutesToStart ?? BOT_MAX_MINUTES_TO_START;
	try {
		// limit must cover the full 24h window: listSharpMoneyCache orders by
		// edge_rating DESC, so a tight cap would silently bias the
		// outside_window shadow population toward high-edge candidates on
		// busy days (NFL Sunday / CFB Saturday).
		const entries = await listSharpMoneyCache(db, {
			limit: 200,
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
			const priceEdgeResult =
				entry.sharpSide === "A" || entry.sharpSide === "B"
					? computePriceEdgeFromEntry({
							sharpSide: entry.sharpSide,
							confidence: entry.confidence,
							edgeRating: entry.edgeRating,
							sideA: {
								sharpScore: entry.sideA.sharpScore,
								price: entry.sideA.price ?? null,
							},
							sideB: {
								sharpScore: entry.sideB.sharpScore,
								price: entry.sideB.price ?? null,
							},
						})
					: null;
			inputs.push({
				conditionId: entry.conditionId,
				rejectReason: "outside_window",
				marketTitle: entry.marketTitle,
				marketType: getMarketTypeLabel(entry.marketTitle),
				sportSeriesId: entry.sportSeriesId,
				sharpSide: entry.sharpSide,
				sharpSideLabel:
					entry.sharpSide === "A"
						? entry.sideA.label
						: entry.sharpSide === "B"
							? entry.sideB.label
							: null,
				price:
					entry.sharpSide === "A"
						? (entry.sideA.price ?? null)
						: entry.sharpSide === "B"
							? (entry.sideB.price ?? null)
							: null,
				minutesToStart,
				eventTime: entry.eventTime,
				priceEdge: priceEdgeResult?.priceEdge ?? null,
				fairPrice: priceEdgeResult?.fairPrice ?? null,
				edgeRating: entry.edgeRating,
				scoreDifferential: entry.scoreDifferential,
				topHolders: compactTopHolders(
					entry.sharpSide === "A"
						? entry.sideA.topHolders
						: entry.sharpSide === "B"
							? entry.sideB.topHolders
							: [],
				),
			});
		}
		if (inputs.length === 0) return 0;
		// Grade only first sightings — the insert would drop repeats anyway,
		// and this runs every cron tick. Grading failure must not lose rows.
		const existingKeys = await listExistingShadowKeys(
			db,
			inputs.map((input) => input.conditionId),
		);
		const fresh = inputs.filter(
			(input) =>
				!existingKeys.has(`${input.conditionId}|${input.rejectReason}`),
		);
		if (fresh.length === 0) return 0;
		try {
			const grades = await computeSharpMoneyGrades(db, {
				conditionIds: [...new Set(fresh.map((input) => input.conditionId))],
			});
			const gradeByConditionId = new Map(
				grades.results.map((result) => [result.conditionId, result]),
			);
			for (const input of fresh) {
				const grade = gradeByConditionId.get(input.conditionId);
				if (!grade || grade.error) continue;
				input.grade = grade.grade ?? undefined;
				input.signalScore = grade.signalScore;
				input.signalComponents = grade.signalComponents ?? null;
				input.marketQualityScore = grade.microstructureScore;
				input.warnings = grade.warnings;
			}
		} catch (error) {
			console.warn("[shadow-book] early-window grading failed:", error);
		}
		return await recordShadowCandidates(db, fresh);
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
 * A row failing this many settle attempts moves to an hourly retry cadence
 * instead of being checked every tick.
 */
const SETTLE_BACKOFF_AFTER_ATTEMPTS = 10;
const SETTLE_BACKOFF_SECONDS = 3600;
/**
 * A row still unresolved this long after its event is a canceled/delisted
 * market that will never settle — mark it 'void' so it stops consuming
 * settle slots. 'void' keeps the record but drops out of win/loss/pending
 * aggregates (UMA disputes and postponement make-ups resolve well within
 * this window).
 */
const VOID_AFTER_SECONDS = 14 * 24 * 60 * 60;

/**
 * Settle pending shadow candidates whose events have started, via the same
 * Gamma resolution path as real picks (resolvePickResult — including the
 * mid-game-settlement guard). Bounded by `limit` Gamma fetches per call.
 *
 * Queue order is settle_attempts ASC so rows whose market never resolves
 * cannot occupy the head of the event_time-ordered batch forever and starve
 * fresh settlements (observed 2026-08-03: one unresolved game held 4 of 10
 * slots on every tick).
 */
export async function settleShadowCandidates(
	db: Db,
	options?: { limit?: number },
): Promise<{ checked: number; updated: number }> {
	const limit =
		typeof options?.limit === "number" && options.limit > 0
			? Math.min(options.limit, 50)
			: 15;
	const now = nowUnixSeconds();
	try {
		const voided = await run(
			db,
			`UPDATE shadow_candidates
			 SET status = 'void', settled_at = ?
			 WHERE status = 'pending' AND COALESCE(event_time, created_at) < ?`,
			now,
			now - VOID_AFTER_SECONDS,
		);
		const changes = voided.meta?.changes;
		if (typeof changes === "number" && changes > 0) {
			console.warn(`[shadow-book] voided ${changes} unresolvable rows`);
		}
	} catch (error) {
		console.warn("[shadow-book] void sweep failed:", error);
	}
	// Same eligibility rule as picks: event started at least 15 minutes ago.
	// Rows with NULL event_time settle only once they are 24h old, as a
	// safety valve against permanently-pending rows.
	const rows = await all<ShadowRow>(
		db,
		`SELECT id, condition_id, sharp_side, price, event_time
		 FROM shadow_candidates
		 WHERE status = 'pending'
		   AND (
		     (event_time IS NOT NULL AND event_time <= ?)
		     OR (event_time IS NULL AND created_at <= ?)
		   )
		   AND (
		     settle_attempts < ?
		     OR last_checked_at IS NULL
		     OR last_checked_at <= ?
		   )
		 ORDER BY settle_attempts ASC, event_time ASC
		 LIMIT ?`,
		now - 15 * 60,
		now - 24 * 60 * 60,
		SETTLE_BACKOFF_AFTER_ATTEMPTS,
		now - SETTLE_BACKOFF_SECONDS,
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
		const resolution = market
			? resolvePickResult({
					sharpSide: row.sharp_side,
					entryPrice: row.price,
					market,
				})
			: null;
		if (!resolution) {
			try {
				await run(
					db,
					`UPDATE shadow_candidates
					 SET settle_attempts = settle_attempts + 1, last_checked_at = ?
					 WHERE id = ?`,
					now,
					row.id,
				);
			} catch (error) {
				console.warn("[shadow-book] attempt bump failed:", error);
			}
			continue;
		}
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
