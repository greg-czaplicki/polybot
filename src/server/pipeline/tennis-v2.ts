/**
 * Pin-divergence paper lanes.
 *
 * Two lanes, one rule (PM vs fresh Pinnacle de-vigged divergence on
 * moneyline markets, paper only, fire-once per condition):
 *
 * - `tennis_v2_paper` (atp/wta) — tennis-v2 R1. Charter:
 *   docs/charters/tennis-ground-up.md; thresholds FINAL in
 *   docs/charters/tennis-ground-up-addendum-1.md (2026-09-01).
 * - `pin_div_paper` (team sports incl. football + soccer) — the
 *   transparency-blind benchmark lane. Charter:
 *   docs/charters/pin-divergence-benchmark.md (FINAL 2026-09-01).
 *
 * Fair probs come from extractPinnaclePrices per side (home AND away
 * roles) so soccer's three-way de-vig is honored — the two sides' fairs
 * sum to < 1 when a draw carries mass; never derive one side as the
 * complement of the other.
 *
 * NOTE ON FIELD SEMANTICS in these lanes: sharp_side/sharp_side_label
 * mean "the side the rule bets" (price-derived), NOT the holder
 * signal's side, and top_holders_json is deliberately NULL — keep these
 * lanes out of holder-signal analyses. Rule inputs are stamped into
 * warnings_json. Nothing here feeds the bot.
 */

import type { Db } from "../db/client";
import { all, run } from "../db/client";
import { nowUnixSeconds } from "../env";
import { getMarketTypeLabel } from "./line-ingestion";
import {
	extractPinnaclePrices,
	matchOddsApiEvent,
	type OddsApiEvent,
	parseTitleTeams,
	teamNamesMatch,
} from "./pinnacle-odds";
import { recordShadowCandidates } from "./shadow-book";

export const TENNIS_V2_LANE = "tennis_v2_paper";
export const PIN_DIV_LANE = "pin_div_paper";
/** Lane per sport_tag; tags absent here never fire. */
export const LANE_BY_TAG: Record<string, string> = {
	atp: TENNIS_V2_LANE,
	wta: TENNIS_V2_LANE,
	nfl: PIN_DIV_LANE,
	ncaaf: PIN_DIV_LANE,
	mlb: PIN_DIV_LANE,
	epl: PIN_DIV_LANE,
	mls: PIN_DIV_LANE,
	laliga: PIN_DIV_LANE,
	bundesliga: PIN_DIV_LANE,
	seriea: PIN_DIV_LANE,
	ligue1: PIN_DIV_LANE,
	ucl: PIN_DIV_LANE,
	championship: PIN_DIV_LANE,
};
/** Both charters: |pm − pin_devigged| ≥ θ; clears Pinnacle vig ~2×. */
export const THETA1 = 0.05;
/** Era-v9 floor and its symmetric cap. */
export const R1_PRICE_MIN = 0.25;
export const R1_PRICE_MAX = 0.75;
/** Charter T: ≥ 30 min before the (session-proxy) start. */
export const R1_MIN_MINUTES_TO_START = 30;
/** The Pinnacle quote must be ≤ 20 min stale. */
export const R1_MAX_QUOTE_AGE_SECONDS = 20 * 60;
/** PM stamps tennis SESSION start, not the match slot — tennis pairings
 * need hours of tolerance; team sports use the sweep's default. */
const TENNIS_MATCH_GAP_SECONDS = 6 * 3600;
const TENNIS_TAGS = new Set(["atp", "wta"]);

export interface TennisV2Side {
	label?: string | null;
	price?: number | null;
}

export interface TennisV2Entry {
	conditionId: string;
	marketTitle: string;
	sportTag: string | null;
	/** Passed through so recordShadowCandidates stamps sport_tag — the
	 * pin sweep matches close-capture rows by tag, which is how these
	 * lanes accrue the pin_clv their promotion criterion needs. */
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
 * Pure divergence decision for one entry against one league's feed
 * events. Returns null when the rule does not fire.
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
		maxGapSeconds: TENNIS_TAGS.has(entry.sportTag ?? "")
			? TENNIS_MATCH_GAP_SECONDS
			: undefined,
	});
	if (!event) return null;

	// De-vig each side independently: with a draw outcome (soccer) the
	// two sides' fair probs sum to < 1, so no side is the complement of
	// the other. extractPinnaclePrices handles two- and three-way books.
	const fairFor = (role: "home" | "away"): number | null =>
		extractPinnaclePrices(event, {
			betType: "moneyline",
			venueRole: role,
			sideLabel: null,
			marketTotalLine: null,
		}).fairProb;
	const fairHome = fairFor("home");
	const fairAway = fairFor("away");
	if (fairHome === null || fairAway === null) return null;

	// Map PM sides onto the matched event's participants by name.
	const sideFair = (label: string): number | null =>
		teamNamesMatch(label, event.home_team)
			? fairHome
			: teamNamesMatch(label, event.away_team)
				? fairAway
				: null;
	const fairA = sideFair(a.label);
	const fairB = sideFair(b.label);
	if (fairA === null || fairB === null) return null;
	// Both labels resolving to the SAME participant would double-count.
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
 * Evaluate the divergence lanes over this tick's entries using the
 * cached Pinnacle feeds (fresh only). Records fire-once paper rows;
 * never throws.
 */
export interface PaperLaneStats {
	/** Entries whose sport_tag has a lane. */
	eligible: number;
	/** Leagues with a Pinnacle feed ≤ R1_MAX_QUOTE_AGE_SECONDS old. */
	freshFeeds: number;
	/** Eligible entries in a league with a fresh feed. */
	evaluated: number;
	/** Rule fired (before fire-once dedup). */
	fired: number;
	/** New paper rows written this tick. */
	recorded: number;
}
const EMPTY_STATS: PaperLaneStats = {
	eligible: 0,
	freshFeeds: 0,
	evaluated: 0,
	fired: 0,
	recorded: 0,
};

/** Durable heartbeat (bot_runtime_status key `paper_lanes`): worker logs
 * are not retained, so this is the only evidence the lanes ran. Written
 * only on ticks that evaluated at least one entry against a fresh feed. */
async function writeLaneHeartbeat(
	db: Db,
	now: number,
	stats: PaperLaneStats,
): Promise<void> {
	try {
		await run(
			db,
			`INSERT INTO bot_runtime_status (key, value_json, updated_at)
			 VALUES ('paper_lanes', ?, ?)
			 ON CONFLICT(key) DO UPDATE SET
			   value_json = excluded.value_json,
			   updated_at = excluded.updated_at`,
			JSON.stringify({ ...stats, evaluatedAt: now }),
			now,
		);
	} catch (error) {
		console.warn("[pin-divergence] heartbeat write failed:", error);
	}
}

export async function evaluatePinDivergenceLanes(
	db: Db,
	entries: TennisV2Entry[],
): Promise<PaperLaneStats> {
	const stats: PaperLaneStats = { ...EMPTY_STATS };
	try {
		const now = nowUnixSeconds();
		const eligible = entries.filter(
			(e) => e.sportTag !== null && LANE_BY_TAG[e.sportTag] !== undefined,
		);
		stats.eligible = eligible.length;
		if (eligible.length === 0) return stats;
		const tags = [...new Set(eligible.map((e) => e.sportTag as string))];
		const feeds = await all<{
			sport_tag: string;
			fetched_at: number;
			events_json: string;
		}>(
			db,
			`SELECT sport_tag, fetched_at, events_json FROM pinnacle_feed_cache
			 WHERE sport_tag IN (${tags.map(() => "?").join(",")})
			   AND fetched_at > ?`,
			...tags,
			now - R1_MAX_QUOTE_AGE_SECONDS,
		);
		if (feeds.length === 0) return stats;
		const eventsByTag = new Map<
			string,
			{ at: number; events: OddsApiEvent[] }
		>();
		for (const feed of feeds) {
			try {
				const events = JSON.parse(feed.events_json) as OddsApiEvent[];
				if (Array.isArray(events) && events.length > 0)
					eventsByTag.set(feed.sport_tag, {
						at: feed.fetched_at,
						events,
					});
			} catch {
				// unparseable cache row: skip the league this tick
			}
		}
		stats.freshFeeds = eventsByTag.size;
		if (eventsByTag.size === 0) return stats;

		const inputs = [];
		for (const entry of eligible) {
			const feed = eventsByTag.get(entry.sportTag as string);
			if (!feed) continue;
			stats.evaluated += 1;
			const decision = evaluateR1ForEntry(entry, feed.events, now);
			if (!decision) continue;
			stats.fired += 1;
			const eventTime = Math.floor(
				Date.parse(entry.eventTime as string) / 1000,
			);
			const lane = LANE_BY_TAG[entry.sportTag as string];
			inputs.push({
				conditionId: entry.conditionId,
				rejectReason: lane,
				marketTitle: entry.marketTitle,
				marketType: "moneyline",
				sportSeriesId: entry.sportSeriesId,
				sharpSide: decision.side,
				sharpSideLabel: decision.label,
				price: decision.price,
				minutesToStart: Math.round((eventTime - now) / 60),
				eventTime: entry.eventTime,
				warnings: [
					lane === TENNIS_V2_LANE ? "tennis_v2:R1" : "pin_div:benchmark",
					`theta1=${THETA1}`,
					`pm=${decision.price.toFixed(4)}`,
					`pin_fair=${decision.pinFair.toFixed(4)}`,
					`divergence=${decision.divergence.toFixed(4)}`,
					`pin_feed_at=${feed.at}`,
				],
			});
		}
		if (inputs.length > 0) {
			stats.recorded = await recordShadowCandidates(db, inputs);
			if (stats.recorded > 0)
				console.log(
					`[pin-divergence] recorded ${stats.recorded} paper rows across lanes`,
				);
		}
		if (stats.evaluated > 0) await writeLaneHeartbeat(db, now, stats);
		return stats;
	} catch (error) {
		console.warn("[pin-divergence] lane evaluation failed:", error);
		return stats;
	}
}
