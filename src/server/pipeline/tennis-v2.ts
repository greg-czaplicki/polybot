/**
 * tennis-v2 Stage 2 — R1 paper lane.
 *
 * Charter: docs/charters/tennis-ground-up.md; thresholds FINAL in
 * docs/charters/tennis-ground-up-addendum-1.md (2026-09-01, clause-(b)
 * folded in). R1 fires when Polymarket and a FRESH Pinnacle quote
 * disagree by >= THETA1 on a tennis match-winner market, recording the
 * underpriced PM side to shadow_candidates under
 * reject_reason 'tennis_v2_paper' (fire-once per condition via the
 * (condition_id, reject_reason) unique key). Paper only — nothing here
 * feeds the bot.
 *
 * NOTE ON FIELD SEMANTICS in this lane: sharp_side/sharp_side_label mean
 * "the side R1 bets" (price-derived), NOT the holder signal's side, and
 * top_holders_json is deliberately NULL — keep this lane out of
 * holder-signal analyses. Rule inputs are stamped into warnings_json.
 *
 * R2 (WTA model edge, no-fresh-quote branch) ships separately; R3 is
 * blocked on its own addendum per the charter.
 */

import type { Db } from "../db/client";
import { all } from "../db/client";
import { nowUnixSeconds } from "../env";
import {
	extractPinnaclePrices,
	matchOddsApiEvent,
	type OddsApiEvent,
	parseTitleTeams,
	teamNamesMatch,
} from "./pinnacle-odds";
import { getMarketTypeLabel } from "./line-ingestion";
import { recordShadowCandidates } from "./shadow-book";

export const TENNIS_V2_LANE = "tennis_v2_paper";
/** Addendum 1: |pm − pin_devigged| ≥ θ1; clears Pinnacle tennis vig ~2×. */
export const THETA1 = 0.05;
/** Era-v9 floor and its symmetric cap (addendum 1). */
export const R1_PRICE_MIN = 0.25;
export const R1_PRICE_MAX = 0.75;
/** Charter T: ≥ 30 min before the (session-proxy) start. */
export const R1_MIN_MINUTES_TO_START = 30;
/** Addendum 1: the Pinnacle quote must be ≤ 20 min stale. */
export const R1_MAX_QUOTE_AGE_SECONDS = 20 * 60;
/** PM stamps session start, not match slot — same tolerance as the
 * pin sweep's tennis matching. */
const TENNIS_MATCH_GAP_SECONDS = 6 * 3600;

export interface TennisV2Side {
	label?: string | null;
	price?: number | null;
}

export interface TennisV2Entry {
	conditionId: string;
	marketTitle: string;
	sportTag: string | null;
	/** Passed through so recordShadowCandidates stamps sport_tag — the
	 * pin sweep matches close-capture rows by tag, which is how this
	 * lane accrues the pin_clv its promotion criterion needs. */
	sportSeriesId?: number;
	eventTime?: string | null;
	sideA: TennisV2Side;
	sideB: TennisV2Side;
}

export interface R1Decision {
	side: "A" | "B";
	label: string;
	price: number;
	pinFair: number;
	divergence: number;
}

/**
 * Pure R1 decision for one entry against one tour's feed events.
 * Returns null when the rule does not fire.
 */
export function evaluateR1ForEntry(
	entry: TennisV2Entry,
	events: OddsApiEvent[],
	now: number,
): R1Decision | null {
	if (getMarketTypeLabel(entry.marketTitle) !== "moneyline") return null;
	const a = entry.sideA;
	const b = entry.sideB;
	if (
		typeof a.price !== "number" ||
		typeof b.price !== "number" ||
		!Number.isFinite(a.price) ||
		!Number.isFinite(b.price) ||
		!a.label ||
		!b.label
	)
		return null;
	const eventTime = entry.eventTime
		? Math.floor(Date.parse(entry.eventTime) / 1000)
		: Number.NaN;
	if (!Number.isFinite(eventTime)) return null;
	if (eventTime - now < R1_MIN_MINUTES_TO_START * 60) return null;

	const teams = parseTitleTeams(entry.marketTitle);
	if (!teams) return null;
	const event = matchOddsApiEvent(events, {
		homeName: teams.teamA,
		awayName: teams.teamB,
		eventTime,
		maxGapSeconds: TENNIS_MATCH_GAP_SECONDS,
	});
	if (!event) return null;

	// De-vig once from the home perspective; two-way devig is symmetric.
	const prices = extractPinnaclePrices(event, {
		betType: "moneyline",
		venueRole: "home",
		sideLabel: null,
		marketTotalLine: null,
	});
	if (prices.fairProb === null) return null;
	const fairHome = prices.fairProb;

	// Map PM sides onto the matched event's players by name.
	const sideFair = (label: string): number | null =>
		teamNamesMatch(label, event.home_team)
			? fairHome
			: teamNamesMatch(label, event.away_team)
				? 1 - fairHome
				: null;
	const fairA = sideFair(a.label);
	const fairB = sideFair(b.label);
	if (fairA === null || fairB === null) return null;
	// Both labels resolving to the SAME player would double-count.
	if (
		teamNamesMatch(a.label, event.home_team) ===
		teamNamesMatch(b.label, event.home_team)
	)
		return null;

	const candidates: R1Decision[] = [];
	const consider = (side: "A" | "B", s: TennisV2Side, fair: number) => {
		const price = s.price as number;
		const divergence = fair - price;
		if (
			divergence >= THETA1 &&
			price >= R1_PRICE_MIN &&
			price <= R1_PRICE_MAX
		) {
			candidates.push({
				side,
				label: s.label as string,
				price,
				pinFair: fair,
				divergence,
			});
		}
	};
	consider("A", a, fairA);
	consider("B", b, fairB);
	candidates.sort((x, y) => y.divergence - x.divergence);
	return candidates[0] ?? null;
}

/**
 * Evaluate R1 over this tick's tennis entries using the cached Pinnacle
 * tennis feeds (fresh only). Records fire-once paper rows; never throws.
 */
export async function evaluateTennisV2R1(
	db: Db,
	entries: TennisV2Entry[],
): Promise<number> {
	try {
		const now = nowUnixSeconds();
		const tennis = entries.filter(
			(e) => e.sportTag === "atp" || e.sportTag === "wta",
		);
		if (tennis.length === 0) return 0;
		const feeds = await all<{
			sport_tag: string;
			fetched_at: number;
			events_json: string;
		}>(
			db,
			`SELECT sport_tag, fetched_at, events_json FROM pinnacle_feed_cache
			 WHERE sport_tag IN ('atp','wta') AND fetched_at > ?`,
			now - R1_MAX_QUOTE_AGE_SECONDS,
		);
		if (feeds.length === 0) return 0;
		const eventsByTour = new Map<string, { at: number; events: OddsApiEvent[] }>();
		for (const feed of feeds) {
			try {
				const events = JSON.parse(feed.events_json) as OddsApiEvent[];
				if (Array.isArray(events) && events.length > 0)
					eventsByTour.set(feed.sport_tag, {
						at: feed.fetched_at,
						events,
					});
			} catch {
				// unparseable cache row: skip the tour this tick
			}
		}
		if (eventsByTour.size === 0) return 0;

		const inputs = [];
		for (const entry of tennis) {
			const feed = eventsByTour.get(entry.sportTag as string);
			if (!feed) continue;
			const decision = evaluateR1ForEntry(entry, feed.events, now);
			if (!decision) continue;
			const eventTime = Math.floor(
				Date.parse(entry.eventTime as string) / 1000,
			);
			inputs.push({
				conditionId: entry.conditionId,
				rejectReason: TENNIS_V2_LANE,
				marketTitle: entry.marketTitle,
				marketType: "moneyline",
				sportSeriesId: entry.sportSeriesId,
				sharpSide: decision.side,
				sharpSideLabel: decision.label,
				price: decision.price,
				minutesToStart: Math.round((eventTime - now) / 60),
				eventTime: entry.eventTime,
				warnings: [
					"tennis_v2:R1",
					`theta1=${THETA1}`,
					`pm=${decision.price.toFixed(4)}`,
					`pin_fair=${decision.pinFair.toFixed(4)}`,
					`divergence=${decision.divergence.toFixed(4)}`,
					`pin_feed_at=${feed.at}`,
				],
			});
		}
		if (inputs.length === 0) return 0;
		const recorded = await recordShadowCandidates(db, inputs);
		if (recorded > 0)
			console.log(`[tennis-v2] R1 recorded ${recorded} paper rows`);
		return recorded;
	} catch (error) {
		console.warn("[tennis-v2] R1 evaluation failed:", error);
		return 0;
	}
}
