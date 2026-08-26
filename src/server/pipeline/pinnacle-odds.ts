/**
 * Pinnacle benchmark capture.
 *
 * Why Pinnacle: it is the sharp-book reference — beating Polymarket's own
 * close only proves we beat THIS market's price discovery; beating the
 * de-vigged Pinnacle close is the strongest available evidence of real
 * edge. DraftKings (via ESPN pickcenter, book-odds.ts) stays as the soft-
 * book anchor; FanDuel adds no information beyond DK and is skipped.
 *
 * Providers (env-gated; absent keys make the sweep a no-op):
 *   - pinnapi (pinnapi.com, PINNAPI_KEY) — PRIMARY since 2026-08-26. A
 *     Pinnacle-native relay: one request returns every prematch fixture
 *     for a SPORT (all leagues, all periods, full total/spread ladders,
 *     decimal odds). Free tier = 100 requests/day. Events are filtered to
 *     the leagues we track and converted into the OddsApiEvent shape
 *     below (American odds, one "pinnacle" bookmaker, h2h + every total
 *     line) so matching / extraction / caching / tests are provider-
 *     agnostic.
 *   - The Odds API (the-odds-api.com, ODDS_API_KEY) — FALLBACK when
 *     PINNAPI_KEY is unset. One request per league key, 2 credits each,
 *     500 credits/month free (~8 fetches/day); tennis keys are per-
 *     tournament and resolved against the /v4/sports index.
 *
 * Runs inside the scheduled cron. Two capture kinds per pick, both from
 * the same per-tag feed:
 *   - anchor (pin_*): first sweep after pick creation (≤ ~2-4 min lag).
 *   - close (pin_close_*): first sweep inside the close window, which
 *     opens CLOSE_WINDOW_BEFORE_SECONDS before event_time. This is a
 *     close PROXY (Pinnacle ~10 min pre-start), not a frozen closing line.
 *
 * De-vig and line-match semantics mirror book-odds.ts: two-way
 * multiplicative (three-way incl. the draw for soccer); totals fair prob
 * only when Pinnacle prices the SAME total line as the pick's market —
 * with pinnapi that is any line on the ladder, with The Odds API only the
 * main line. pin_clv = pin_close_fair_prob − pick price (same sign
 * convention as clv/book_clv).
 *
 * Budget pacing (both providers): the sweep
 *   - shares ONE per-tag feed cache (pinnacle_feed_cache) across pick
 *     anchors, pick closes, shadow anchors and shadow closes, with a
 *     per-role max age (live close ≤15 min, everything else ≤30 min);
 *   - spends against a hard ROLLING-24H fetch cap counted in
 *     pinnacle_fetch_log (rolling, not calendar-day, so an evening slate
 *     never straddles a budget reset and no fixed 24h window can exceed
 *     the provider's daily limit), with a reserve only live-pick closes
 *     may use and a per-sport share so one sport cannot starve the rest;
 *   - lets anchors fall back to a stale feed (still pre-T, staleness
 *     recorded in pin_feed_at) instead of fetching, while closes never
 *     use a feed older than their max age.
 * Every capture records the feed time so the staleness is auditable.
 */

import type { Db } from "../db/client";
import { all, first, run } from "../db/client";
import { nowUnixSeconds } from "../env";
import {
	americanToImpliedProb,
	devigTwoWay,
	parseMarketTotalLine,
} from "./book-odds";

// The Odds API sport keys for our canonical sport tags. NFL preseason is
// keyed separately upstream (americanfootball_nfl_preseason) and is NOT
// mapped: preseason is permanently gated from betting, so preseason rows
// go uncaptured by design (they no-match against the regular-season feed).
const ODDS_API_SPORT_KEYS: Record<string, string> = {
	mlb: "baseball_mlb",
	nba: "basketball_nba",
	nfl: "americanfootball_nfl",
	ncaaf: "americanfootball_ncaaf",
	ncaab: "basketball_ncaab",
	nhl: "icehockey_nhl",
	epl: "soccer_epl",
	championship: "soccer_efl_champ",
	laliga: "soccer_spain_la_liga",
	bundesliga: "soccer_germany_bundesliga",
	seriea: "soccer_italy_serie_a",
	ligue1: "soccer_france_ligue_one",
	ucl: "soccer_uefa_champs_league",
	mls: "soccer_usa_mls",
};

// pinnapi sport ids (stable integers, see pinnapi.com/docs "Sport IDs").
// One fetch per SPORT serves every tag mapped to it.
const PINNAPI_SPORT_IDS: Record<string, number> = {
	mlb: 6,
	nba: 3,
	ncaab: 3,
	nfl: 5,
	ncaaf: 5,
	nhl: 4,
	epl: 1,
	championship: 1,
	laliga: 1,
	bundesliga: 1,
	seriea: 1,
	ligue1: 1,
	ucl: 1,
	mls: 1,
	atp: 2,
	wta: 2,
};
// pinnapi league_name → our tag. Exact matches deliberately exclude the
// derivative boards Pinnacle lists as separate leagues ("Spain - La Liga
// Corners", "... Bookings") and tennis doubles. NFL preseason ("NFL Pre
// Season") stays unmapped (see ODDS_API_SPORT_KEYS). Labels verified
// 2026-08-26 for MLB/soccer/tennis/NFL/NCAA football; NBA/NHL/NCAAB
// assumed by analogy — VERIFY at season open.
const PINNAPI_LEAGUE_MATCHERS: Record<string, (league: string) => boolean> = {
	mlb: (l) => l === "MLB",
	nba: (l) => l === "NBA",
	ncaab: (l) => l === "NCAA",
	nfl: (l) => l === "NFL",
	ncaaf: (l) => l === "NCAA",
	nhl: (l) => l === "NHL",
	epl: (l) => l === "England - Premier League",
	championship: (l) => l === "England - Championship",
	laliga: (l) => l === "Spain - La Liga",
	bundesliga: (l) => l === "Germany - Bundesliga",
	seriea: (l) => l === "Italy - Serie A",
	ligue1: (l) => l === "France - Ligue 1",
	ucl: (l) =>
		l === "UEFA - Champions League" ||
		l === "UEFA - Champions League Qualifiers",
	mls: (l) => l === "USA - Major League Soccer",
	atp: (l) => l.startsWith("ATP ") && !/doubles/i.test(l),
	wta: (l) => l.startsWith("WTA ") && !/doubles/i.test(l),
};
/** Pure — exported for tests. */
export function pinnapiLeagueMatches(tag: string, league: string): boolean {
	const m = PINNAPI_LEAGUE_MATCHERS[tag];
	return m ? m(league) : false;
}

// Tennis has no season-long key upstream — tournaments each get their own
// (tennis_atp_us_open, ...), so atp/wta resolve dynamically against the
// /v4/sports index (a zero-credit call) at sweep time.
const TENNIS_TOUR_PREFIXES: Record<string, string> = {
	atp: "tennis_atp_",
	wta: "tennis_wta_",
};
/** Tournaments per tour fetched per sweep (each is its own request). On
 * the free tier that is ONE, preferring a Grand Slam key when active. */
const TENNIS_MAX_TOURNAMENTS_PER_TOUR = 1;
const TENNIS_PREFERRED_KEY_MARKERS = [
	"us_open",
	"wimbledon",
	"french_open",
	"aus_open",
];

// Live-bettable leagues (mirrors bot.ts policy) get priority on the
// budget; everything else is a shadow-only benchmark.
const LIVE_SPORT_TAGS = new Set([
	"mlb",
	"nba",
	"nfl",
	"ncaaf",
	"ncaab",
	"epl",
	"mls",
]);
/** Benchmark-only leagues don't fetch below this many remaining credits;
 * live sports keep fetching down to LIVE_MIN_CREDITS. */
const BENCHMARK_MIN_CREDITS = 20;
const LIVE_MIN_CREDITS = 2;
/** Rolling-24h fetch caps per provider. `shadow` bounds benchmark-only
 * roles, `liveAnchor` live-pick anchors, `liveClose` live-pick closes (the
 * highest — its headroom over the others is the live-close reserve), and
 * `perSport` bounds any single sport so MLB's all-day slate cannot starve
 * an evening soccer/tennis close. pinnapi trial = 100 requests/day (hard
 * 429 beyond); The Odds API = 500 credits/month at 2 per fetch. */
interface FetchCaps {
	shadow: number;
	liveAnchor: number;
	liveClose: number;
	perSport: number;
}
const PINNAPI_CAPS: FetchCaps = {
	shadow: 56,
	liveAnchor: 64,
	liveClose: 80,
	perSport: 40,
};
const ODDS_API_CAPS: FetchCaps = {
	shadow: 8,
	liveAnchor: 8,
	liveClose: 12,
	perSport: 12,
};
const FETCH_WINDOW_SECONDS = 24 * 3600;

/** Close window opens this long before event_time. */
const CLOSE_WINDOW_BEFORE_SECONDS = 600;
/** Close capture gives up this long after event_time (event leaves the feed). */
const CLOSE_WINDOW_AFTER_SECONDS = 1800;
/** Anchor capture only for picks created within this window. */
const ANCHOR_MAX_AGE_SECONDS = 2 * 3600;

// Feed reuse per capture role (seconds). A cached per-sport feed younger
// than the role's max age is used without a fetch. Closes never use an
// older feed; anchors may fall back to one up to ANCHOR_STALE_MAX_SECONDS
// old when the daily budget is spent (still pre-T; pin_feed_at records it).
type FeedRole = "live-anchor" | "live-close" | "shadow-anchor" | "shadow-close";
const FEED_MAX_AGE_SECONDS: Record<FeedRole, number> = {
	"live-close": 15 * 60,
	"live-anchor": 30 * 60,
	"shadow-close": 30 * 60,
	"shadow-anchor": 30 * 60,
};
const ANCHOR_STALE_MAX_SECONDS = 3 * 3600;
const SHADOW_ANCHOR_LIMIT = 40;
/** Rows rejected on timing alone would never have been bet at that sighting;
 * their anchor is not a would-have-bet benchmark, so they are skipped. */
const TIMING_REJECT_REASONS = [
	"outside_window",
	"too_close_to_start",
	"not_ready",
];

export interface OddsApiOutcome {
	name: string;
	price: number;
	point?: number;
}

export interface OddsApiEvent {
	id: string;
	commence_time: string;
	home_team: string;
	away_team: string;
	bookmakers: Array<{
		key: string;
		markets: Array<{ key: string; outcomes: OddsApiOutcome[] }>;
	}>;
}

// ---- pinnapi feed shape (subset we read) ------------------------------
interface PinnapiLine {
	home?: number | null;
	away?: number | null;
	over?: number | null;
	under?: number | null;
	points?: number | null;
}
export interface PinnapiEvent {
	event_id: number;
	league_name: string;
	starts: string;
	home: string;
	away: string;
	is_have_odds?: boolean;
	periods?: {
		num_0?: {
			money_line?: {
				home?: number | null;
				away?: number | null;
				draw?: number | null;
			} | null;
			totals?: Record<string, PinnapiLine> | null;
		};
	};
}

/** Decimal → American, one decimal place (2.08 → 108, 1.8547 → −117). */
export function decimalToAmerican(decimal: number): number | null {
	if (!Number.isFinite(decimal) || decimal <= 1) return null;
	const raw = decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1);
	return Math.round(raw * 10) / 10;
}

/**
 * Converts a pinnapi prematch event into the provider-agnostic feed
 * shape: full-game (num_0) moneyline (+ draw when priced) and EVERY
 * total line on the ladder, as one "pinnacle" bookmaker. Null when the
 * event carries no full-game prices. Pure — exported for tests.
 */
export function pinnapiToOddsApiEvent(e: PinnapiEvent): OddsApiEvent | null {
	const p0 = e.periods?.num_0;
	if (!p0 || !e.home || !e.away || !e.starts) return null;
	const markets: OddsApiEvent["bookmakers"][number]["markets"] = [];
	const ml = p0.money_line;
	const home = ml?.home != null ? decimalToAmerican(ml.home) : null;
	const away = ml?.away != null ? decimalToAmerican(ml.away) : null;
	if (home !== null && away !== null) {
		const outcomes: OddsApiOutcome[] = [
			{ name: e.home, price: home },
			{ name: e.away, price: away },
		];
		const draw = ml?.draw != null ? decimalToAmerican(ml.draw) : null;
		if (draw !== null) outcomes.push({ name: "Draw", price: draw });
		markets.push({ key: "h2h", outcomes });
	}
	const totals = p0.totals;
	if (totals) {
		const outcomes: OddsApiOutcome[] = [];
		const lines = Object.values(totals)
			.filter((l) => l && typeof l.points === "number")
			.sort((a, b) => (a.points as number) - (b.points as number));
		for (const line of lines) {
			const over = line.over != null ? decimalToAmerican(line.over) : null;
			const under = line.under != null ? decimalToAmerican(line.under) : null;
			if (over === null || under === null) continue;
			outcomes.push({
				name: "Over",
				price: over,
				point: line.points as number,
			});
			outcomes.push({
				name: "Under",
				price: under,
				point: line.points as number,
			});
		}
		if (outcomes.length > 0) markets.push({ key: "totals", outcomes });
	}
	if (markets.length === 0) return null;
	return {
		id: String(e.event_id),
		commence_time: e.starts,
		home_team: e.home,
		away_team: e.away,
		bookmakers: [{ key: "pinnacle", markets }],
	};
}

function normalizeTeamName(name: string): string {
	return name.toLowerCase().replace(/[.']/g, "").replace(/\s+/g, " ").trim();
}

function teamNamesMatch(a: string, b: string): boolean {
	const na = normalizeTeamName(a);
	const nb = normalizeTeamName(b);
	return na === nb || na.includes(nb) || nb.includes(na);
}

/**
 * Finds the feed event for a canonical game: both team names match
 * (either orientation guards vs home/away parse differences) and
 * commence_time within 45 min of our event_time (tight enough to split
 * doubleheaders, loose enough for reschedule drift).
 */
export function matchOddsApiEvent(
	events: OddsApiEvent[],
	game: {
		homeName: string;
		awayName: string;
		eventTime: number;
		/** Override the 45-min commence gap (tennis: PM stamps the session
		 * start, not the match slot, so a pairing needs hours of tolerance —
		 * safe because a pairing is unique within a tournament day). */
		maxGapSeconds?: number;
	},
): OddsApiEvent | null {
	const maxGap = game.maxGapSeconds ?? 45 * 60;
	let best: OddsApiEvent | null = null;
	let bestGap = Number.POSITIVE_INFINITY;
	for (const event of events) {
		const commence = Math.floor(Date.parse(event.commence_time) / 1000);
		if (!Number.isFinite(commence)) continue;
		const gap = Math.abs(commence - game.eventTime);
		if (gap > maxGap) continue;
		const straight =
			teamNamesMatch(event.home_team, game.homeName) &&
			teamNamesMatch(event.away_team, game.awayName);
		const flipped =
			teamNamesMatch(event.home_team, game.awayName) &&
			teamNamesMatch(event.away_team, game.homeName);
		if (!straight && !flipped) continue;
		if (gap < bestGap) {
			best = event;
			bestGap = gap;
		}
	}
	return best;
}

export interface PinnaclePrices {
	mlSide: number | null;
	mlOpp: number | null;
	totalLine: number | null;
	overOdds: number | null;
	underOdds: number | null;
	/** De-vigged prob of the PICK side (ML via venue role, totals via label+line match) */
	fairProb: number | null;
}

/**
 * Extracts pick-side-aware Pinnacle prices from a matched event.
 * Pure — exported for tests.
 */
export function extractPinnaclePrices(
	event: OddsApiEvent,
	pick: {
		betType: string | null;
		venueRole: string | null;
		sideLabel: string | null;
		marketTotalLine: number | null;
	},
): PinnaclePrices {
	const out: PinnaclePrices = {
		mlSide: null,
		mlOpp: null,
		totalLine: null,
		overOdds: null,
		underOdds: null,
		fairProb: null,
	};
	const book = event.bookmakers.find((b) => b.key === "pinnacle");
	if (!book) return out;

	const h2h = book.markets.find((m) => m.key === "h2h");
	const totals = book.markets.find((m) => m.key === "totals");

	if (totals) {
		// The feed may carry one line (Odds API main line) or the whole
		// ladder (pinnapi). Prefer the line the pick's market is priced on;
		// otherwise report the main line = the most balanced pair.
		const byLine = new Map<number, { over?: number; under?: number }>();
		for (const o of totals.outcomes) {
			const key = typeof o.point === "number" ? o.point : Number.NaN;
			const slot = byLine.get(key) ?? {};
			const name = o.name.toLowerCase();
			if (name === "over") slot.over = o.price;
			else if (name === "under") slot.under = o.price;
			byLine.set(key, slot);
		}
		let chosen: { line: number; over?: number; under?: number } | null = null;
		if (pick.betType === "total" && pick.marketTotalLine !== null) {
			for (const [line, slot] of byLine) {
				if (Math.abs(line - pick.marketTotalLine) <= 0.01) {
					chosen = { line, ...slot };
					break;
				}
			}
		}
		if (!chosen) {
			let bestSkew = Number.POSITIVE_INFINITY;
			for (const [line, slot] of byLine) {
				const po =
					slot.over !== undefined ? americanToImpliedProb(slot.over) : null;
				const pu =
					slot.under !== undefined ? americanToImpliedProb(slot.under) : null;
				const skew =
					po !== null && pu !== null
						? Math.abs(po - pu)
						: Number.POSITIVE_INFINITY;
				if (chosen === null || skew < bestSkew) {
					chosen = { line, ...slot };
					bestSkew = skew;
				}
			}
		}
		if (chosen) {
			out.totalLine = Number.isNaN(chosen.line) ? null : chosen.line;
			out.overOdds = chosen.over ?? null;
			out.underOdds = chosen.under ?? null;
		}
	}

	if (pick.betType === "moneyline" && h2h) {
		if (pick.venueRole !== "home" && pick.venueRole !== "away") return out;
		const home = h2h.outcomes.find((o) =>
			teamNamesMatch(o.name, event.home_team),
		);
		const away = h2h.outcomes.find((o) =>
			teamNamesMatch(o.name, event.away_team),
		);
		// Soccer h2h is three-way: the draw must join the overround or the
		// two-way de-vig overstates both sides' win probabilities.
		const draw = h2h.outcomes.find((o) => o.name.toLowerCase() === "draw");
		const side = pick.venueRole === "home" ? home : away;
		const opp = pick.venueRole === "home" ? away : home;
		if (side && opp && side.price !== 0 && opp.price !== 0) {
			out.mlSide = side.price;
			out.mlOpp = opp.price;
			if (draw && draw.price !== 0) {
				const ps = americanToImpliedProb(side.price);
				const po = americanToImpliedProb(opp.price);
				const pd = americanToImpliedProb(draw.price);
				if (ps !== null && po !== null && pd !== null && ps + po + pd > 0) {
					out.fairProb = ps / (ps + po + pd);
				}
			} else {
				out.fairProb = devigTwoWay(side.price, opp.price);
			}
		}
	} else if (pick.betType === "total") {
		const label = pick.sideLabel?.toLowerCase();
		if (
			(label === "over" || label === "under") &&
			pick.marketTotalLine !== null &&
			out.totalLine !== null &&
			Math.abs(out.totalLine - pick.marketTotalLine) <= 0.01 &&
			out.overOdds !== null &&
			out.underOdds !== null &&
			out.overOdds !== 0 &&
			out.underOdds !== 0
		) {
			const side = label === "over" ? out.overOdds : out.underOdds;
			const opp = label === "over" ? out.underOdds : out.overOdds;
			out.fairProb = devigTwoWay(side, opp);
		}
	}
	return out;
}

/** Sweep-scoped credit tracker, fed from x-requests-remaining headers. */
interface CreditState {
	remaining: number | null;
}

async function fetchOddsApiEvents(
	apiKey: string,
	sportKey: string,
	credits: CreditState,
): Promise<OddsApiEvent[] | null> {
	const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${apiKey}&bookmakers=pinnacle&markets=h2h,totals&oddsFormat=american`;
	try {
		const res = await fetch(url);
		const remaining = res.headers.get("x-requests-remaining");
		if (remaining !== null) {
			const parsed = Number.parseFloat(remaining);
			if (Number.isFinite(parsed)) credits.remaining = parsed;
			if (parsed < 50) {
				console.warn(
					`[pinnacle-odds] Odds API credits low: ${remaining} remaining`,
				);
			}
		}
		if (!res.ok) {
			console.warn(
				`[pinnacle-odds] Odds API returned ${res.status} for ${sportKey}`,
			);
			return null;
		}
		return (await res.json()) as OddsApiEvent[];
	} catch (err) {
		console.warn(
			`[pinnacle-odds] Odds API fetch failed for ${sportKey}:`,
			err instanceof Error ? err.message : err,
		);
		return null;
	}
}

/**
 * Active sport keys from the /v4/sports index (zero-credit call). Used to
 * resolve tennis tournament keys. Null on fetch failure.
 */
async function fetchActiveSportKeys(apiKey: string): Promise<string[] | null> {
	const url = `https://api.the-odds-api.com/v4/sports?apiKey=${apiKey}`;
	try {
		const res = await fetch(url);
		if (!res.ok) {
			console.warn(`[pinnacle-odds] Odds API sports index ${res.status}`);
			return null;
		}
		const sports = (await res.json()) as Array<{
			key: string;
			active?: boolean;
		}>;
		return sports.filter((s) => s.active !== false).map((s) => s.key);
	} catch (err) {
		console.warn(
			`[pinnacle-odds] Odds API sports index fetch failed:`,
			err instanceof Error ? err.message : err,
		);
		return null;
	}
}

/**
 * One pinnapi request: every prematch fixture for a sport. Null on any
 * failure (429 included — the rolling cap should keep us well under the
 * provider's own daily limit, so a 429 is logged loudly).
 */
async function fetchPinnapiSport(
	apiKey: string,
	sportId: number,
): Promise<PinnapiEvent[] | null> {
	const url = `https://pinnapi.com/kit/v1/prematch/fixtures?sport_id=${sportId}`;
	try {
		const res = await fetch(url, { headers: { "x-portal-apikey": apiKey } });
		if (!res.ok) {
			console.warn(
				`[pinnacle-odds] pinnapi returned ${res.status} for sport ${sportId}${res.status === 429 ? " (RATE LIMITED — cap breached?)" : ""}`,
			);
			return null;
		}
		const body = (await res.json()) as { events?: PinnapiEvent[] };
		return Array.isArray(body.events) ? body.events : [];
	} catch (err) {
		console.warn(
			`[pinnacle-odds] pinnapi fetch failed for sport ${sportId}:`,
			err instanceof Error ? err.message : err,
		);
		return null;
	}
}

/**
 * Extracts the two team names from a Polymarket game-market title
 * ("Colorado Rockies vs. Arizona Diamondbacks: O/U 9.5" → both teams).
 * Orientation doesn't matter — matchOddsApiEvent checks both. Pure —
 * exported for tests.
 */
export function parseTitleTeams(
	marketTitle: string,
): { teamA: string; teamB: string } | null {
	// The matchup can sit on either side of a colon: "A vs. B: O/U 9.5"
	// (totals suffix), "Will ...?: A vs. B" (prop-style prefix), or
	// "US Open, Qualification ATP: A vs B" (tournament prefix). Tennis
	// titles separate with bare " vs " — no period.
	const hasVs = (s: string) => s.includes(" vs. ") || s.includes(" vs ");
	const colonIdx = marketTitle.indexOf(":");
	let matchup = marketTitle;
	if (colonIdx > 0) {
		const before = marketTitle.slice(0, colonIdx);
		const after = marketTitle.slice(colonIdx + 1);
		if (hasVs(before)) matchup = before;
		else if (hasVs(after)) matchup = after;
	}
	const sep = matchup.includes(" vs. ") ? " vs. " : " vs ";
	const parts = matchup.split(sep);
	if (parts.length !== 2) return null;
	const teamA = parts[0].trim();
	const teamB = parts[1].trim();
	if (!teamA || !teamB) return null;
	return { teamA, teamB };
}

interface SweepPickRow {
	id: string;
	price: number | null;
	bet_type: string | null;
	venue_role: string | null;
	sharp_side_label: string | null;
	market_title: string;
	event_time: number;
	sport_tag: string;
	home_name: string;
	away_name: string;
	pin_captured_at: number | null;
	pin_close_captured_at: number | null;
}

/**
 * One cron sweep: capture Pinnacle anchors for fresh picks and close
 * proxies for picks near start. One Odds API fetch per sport with any
 * eligible pick (2 credits each); no eligible picks → zero fetches.
 * No-op when apiKey is empty/undefined.
 */
interface ShadowCloseRow {
	id: string;
	price: number | null;
	market_type: string;
	sharp_side_label: string | null;
	market_title: string;
	event_time: number;
	sport_tag: string | null;
}

type ShadowAnchorRow = ShadowCloseRow;

interface FeedCacheRow {
	fetched_at: number;
	events_json: string;
}

async function readFeedCache(
	db: Db,
	tag: string,
): Promise<{ fetchedAt: number; events: OddsApiEvent[] } | null> {
	const row = await first<FeedCacheRow>(
		db,
		`SELECT fetched_at, events_json FROM pinnacle_feed_cache WHERE sport_tag = ?`,
		tag,
	);
	if (!row) return null;
	try {
		const events = JSON.parse(row.events_json) as OddsApiEvent[];
		return Array.isArray(events) ? { fetchedAt: row.fetched_at, events } : null;
	} catch {
		return null;
	}
}

async function writeFeedCache(
	db: Db,
	tag: string,
	fetchedAt: number,
	events: OddsApiEvent[],
	creditsRemaining: number | null,
): Promise<void> {
	await run(
		db,
		`INSERT INTO pinnacle_feed_cache (sport_tag, fetched_at, events_json, credits_remaining)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(sport_tag) DO UPDATE SET
		   fetched_at = excluded.fetched_at, events_json = excluded.events_json,
		   credits_remaining = excluded.credits_remaining`,
		tag,
		fetchedAt,
		JSON.stringify(events),
		creditsRemaining,
	);
}

interface Feed {
	events: OddsApiEvent[];
	fetchedAt: number;
}

export type PinnacleProvider = "pinnapi" | "odds-api";

export interface PinnacleKeys {
	pinnapiKey?: string;
	oddsApiKey?: string;
}

export async function capturePinnacleOddsForPicks(
	db: Db,
	keys: PinnacleKeys | string | undefined,
	options?: { limit?: number },
): Promise<{
	checked: number;
	anchors: number;
	closes: number;
	shadowCloses: number;
	shadowAnchors: number;
	fetches: number;
	/** Fetches in the rolling 24h window after this sweep (cap basis). */
	fetches24h: number;
	creditsRemaining: number | null;
	provider: PinnacleProvider | null;
}> {
	const empty = {
		checked: 0,
		anchors: 0,
		closes: 0,
		shadowCloses: 0,
		shadowAnchors: 0,
		fetches: 0,
		fetches24h: 0,
		creditsRemaining: null,
		provider: null,
	};
	// A bare string is the legacy Odds API key.
	const resolved: PinnacleKeys =
		typeof keys === "string" ? { oddsApiKey: keys } : (keys ?? {});
	const provider: PinnacleProvider | null = resolved.pinnapiKey
		? "pinnapi"
		: resolved.oddsApiKey
			? "odds-api"
			: null;
	if (provider === null) return empty;
	const apiKey = (
		provider === "pinnapi" ? resolved.pinnapiKey : resolved.oddsApiKey
	) as string;
	const caps = provider === "pinnapi" ? PINNAPI_CAPS : ODDS_API_CAPS;
	const tracked = (tag: string): boolean =>
		provider === "pinnapi"
			? PINNAPI_SPORT_IDS[tag] !== undefined
			: !!(ODDS_API_SPORT_KEYS[tag] || TENNIS_TOUR_PREFIXES[tag]);
	// Fetch-log key per tag: pinnapi spends per SPORT (one fetch serves
	// every tag of that sport), The Odds API per league key.
	const sportLogKey = (tag: string): string =>
		provider === "pinnapi"
			? `pinnapi:${PINNAPI_SPORT_IDS[tag]}`
			: (ODDS_API_SPORT_KEYS[tag] ?? TENNIS_TOUR_PREFIXES[tag] ?? tag);
	const limit =
		typeof options?.limit === "number" && options.limit > 0
			? Math.min(options.limit, 50)
			: 25;
	const now = nowUnixSeconds();

	// manual_picks.event_time is ISO-8601 TEXT, not unix seconds: compare and
	// select it via unixepoch(), or TEXT-vs-INTEGER affinity makes every
	// comparison silently wrong (TEXT > INTEGER is always true in SQLite, and
	// the raw string coerces to NaN in JS).
	const rows = await all<SweepPickRow>(
		db,
		`SELECT p.id, p.price, p.bet_type, p.venue_role, p.sharp_side_label,
		        p.market_title, unixepoch(p.event_time) AS event_time, g.sport_tag,
		        ht.name AS home_name, at2.name AS away_name,
		        p.pin_captured_at, p.pin_close_captured_at
		 FROM manual_picks p
		 JOIN games g ON g.id = p.game_id
		 JOIN teams ht ON ht.id = g.home_team_id
		 JOIN teams at2 ON at2.id = g.away_team_id
		 WHERE p.bet_type IN ('moneyline','total')
		   AND (
		     (p.pin_captured_at IS NULL
		      AND p.picked_at > ?
		      AND unixepoch(p.event_time) > ?)
		     OR
		     (p.pin_close_captured_at IS NULL
		      AND unixepoch(p.event_time) BETWEEN ? AND ?)
		   )
		 ORDER BY p.event_time ASC
		 LIMIT ?`,
		now - ANCHOR_MAX_AGE_SECONDS,
		now,
		now - CLOSE_WINDOW_AFTER_SECONDS,
		now + CLOSE_WINDOW_BEFORE_SECONDS,
		limit,
	);

	// shadow_candidates.event_time is INTEGER seconds, unlike manual_picks.
	const shadowRows = await all<ShadowCloseRow>(
		db,
		`SELECT id, price, market_type, sharp_side_label, market_title,
		        event_time, sport_tag
		 FROM shadow_candidates
		 WHERE status = 'pending'
		   AND market_type IN ('moneyline','total')
		   AND pin_close_captured_at IS NULL
		   AND event_time BETWEEN ? AND ?
		 ORDER BY event_time ASC
		 LIMIT 20`,
		now - CLOSE_WINDOW_AFTER_SECONDS,
		now + CLOSE_WINDOW_BEFORE_SECONDS,
	);

	const timingPlaceholders = TIMING_REJECT_REASONS.map(() => "?").join(",");
	const shadowAnchorRows = await all<ShadowAnchorRow>(
		db,
		`SELECT id, price, market_type, sharp_side_label, market_title,
		        event_time, sport_tag
		 FROM shadow_candidates
		 WHERE status = 'pending'
		   AND market_type IN ('moneyline','total')
		   AND pin_captured_at IS NULL
		   AND created_at > ?
		   AND event_time > ?
		   AND reject_reason NOT IN (${timingPlaceholders})
		 ORDER BY created_at ASC
		 LIMIT ?`,
		now - ANCHOR_MAX_AGE_SECONDS,
		now,
		...TIMING_REJECT_REASONS,
		SHADOW_ANCHOR_LIMIT,
	);

	if (
		rows.length === 0 &&
		shadowRows.length === 0 &&
		shadowAnchorRows.length === 0
	)
		return empty;

	// ---- Budget state (rolling 24h) --------------------------------------
	const windowStart = now - FETCH_WINDOW_SECONDS;
	const windowRows = await all<{ sport_key: string; n: number }>(
		db,
		`SELECT sport_key, COUNT(*) AS n FROM pinnacle_fetch_log
		 WHERE fetched_at > ? GROUP BY sport_key`,
		windowStart,
	);
	const perSport = new Map<string, number>();
	let fetchesInWindow = 0;
	for (const r of windowRows) {
		perSport.set(r.sport_key, r.n);
		fetchesInWindow += r.n;
	}
	let fetches = 0;
	// Odds API only: seed the credit tracker from the last persisted balance
	// so the floors apply from the first fetch of the sweep, not the second.
	// pinnapi exposes no balance (its limit is the request cap above).
	const credits: CreditState = { remaining: null };
	if (provider === "odds-api") {
		const lastCredits = await first<{ credits_remaining: number | null }>(
			db,
			`SELECT credits_remaining FROM pinnacle_feed_cache
			 WHERE credits_remaining IS NOT NULL
			 ORDER BY fetched_at DESC LIMIT 1`,
		);
		credits.remaining = lastCredits?.credits_remaining ?? null;
	}

	// This sweep's fresh feeds (null = fetched and failed) and cache reads.
	const fresh = new Map<string, OddsApiEvent[] | null>();
	const cacheReads = new Map<string, Feed | null>();
	let activeSportKeys: string[] | null | undefined;

	const canSpend = (tag: string, role: FeedRole): boolean => {
		const live = LIVE_SPORT_TAGS.has(tag);
		if (
			credits.remaining !== null &&
			credits.remaining < (live ? LIVE_MIN_CREDITS : BENCHMARK_MIN_CREDITS)
		) {
			return false;
		}
		const cap =
			role === "live-close"
				? caps.liveClose
				: role === "live-anchor"
					? caps.liveAnchor
					: caps.shadow;
		if (fetchesInWindow >= cap) return false;
		return (perSport.get(sportLogKey(tag)) ?? 0) < caps.perSport;
	};

	const logFetch = async (sportKey: string): Promise<void> => {
		fetchesInWindow += 1;
		perSport.set(sportKey, (perSport.get(sportKey) ?? 0) + 1);
		fetches += 1;
		await run(
			db,
			`INSERT INTO pinnacle_fetch_log (fetched_at, sport_key, credits_remaining)
			 VALUES (?, ?, ?)`,
			now,
			sportKey,
			credits.remaining,
		);
	};

	// pinnapi: raw per-SPORT feeds fetched this sweep (null = failed).
	const pinnapiSportFeeds = new Map<number, PinnapiEvent[] | null>();

	// Fresh fetch for a tag. pinnapi: one request per SPORT, then every tag
	// of that sport is filtered/converted, marked fresh and cached at once.
	// Odds API: one request for static keys; for tennis, the active
	// tournament keys for the tour (capped, Grand Slam preferred).
	// Null = fetch failed (rows retry next sweep). Empty array = feed
	// answered with no listing (rows stamp).
	const fetchFresh = async (tag: string): Promise<OddsApiEvent[] | null> => {
		if (provider === "pinnapi") {
			const sportId = PINNAPI_SPORT_IDS[tag];
			let raw = pinnapiSportFeeds.get(sportId);
			if (raw === undefined) {
				raw = await fetchPinnapiSport(apiKey, sportId);
				await logFetch(`pinnapi:${sportId}`);
				pinnapiSportFeeds.set(sportId, raw);
				if (raw !== null) {
					for (const [t, sid] of Object.entries(PINNAPI_SPORT_IDS)) {
						if (sid !== sportId) continue;
						const events: OddsApiEvent[] = [];
						for (const e of raw) {
							if (!pinnapiLeagueMatches(t, e.league_name ?? "")) continue;
							const converted = pinnapiToOddsApiEvent(e);
							if (converted) events.push(converted);
						}
						fresh.set(t, events);
						await writeFeedCache(db, t, now, events, null);
					}
					console.log(
						`[pinnacle-odds] pinnapi sport ${sportId}: ${raw.length} events, ${tag}=${fresh.get(tag)?.length ?? 0}`,
					);
				}
			}
			if (raw === null) {
				fresh.set(tag, null);
				return null;
			}
			return fresh.get(tag) ?? [];
		}
		let events: OddsApiEvent[] | null = null;
		const staticKey = ODDS_API_SPORT_KEYS[tag];
		const tennisPrefix = TENNIS_TOUR_PREFIXES[tag];
		if (staticKey) {
			events = await fetchOddsApiEvents(apiKey, staticKey, credits);
			await logFetch(staticKey);
		} else if (tennisPrefix) {
			if (activeSportKeys === undefined) {
				activeSportKeys = await fetchActiveSportKeys(apiKey);
			}
			if (activeSportKeys !== null) {
				const tourKeys = activeSportKeys.filter((k) =>
					k.startsWith(tennisPrefix),
				);
				const preferred = tourKeys.filter((k) =>
					TENNIS_PREFERRED_KEY_MARKERS.some((m) => k.includes(m)),
				);
				const chosen = [
					...preferred,
					...tourKeys.filter((k) => !preferred.includes(k)),
				].slice(0, TENNIS_MAX_TOURNAMENTS_PER_TOUR);
				if (chosen.length === 0) {
					events = [];
				} else {
					const fetched: Array<OddsApiEvent[] | null> = [];
					for (const k of chosen) {
						fetched.push(await fetchOddsApiEvents(apiKey, k, credits));
						await logFetch(k);
					}
					if (fetched.some((e) => e !== null))
						events = fetched.flatMap((e) => e ?? []);
				}
				console.log(
					`[pinnacle-odds] tennis ${tag}: keys=${JSON.stringify(chosen)} events=${events === null ? "null" : events.length}`,
				);
			}
		}
		fresh.set(tag, events);
		if (events !== null)
			await writeFeedCache(db, tag, now, events, credits.remaining);
		return events;
	};

	// The feed for a tag under a role's freshness rule: this sweep's fresh
	// fetch → cache within max age → fetch if the budget allows → for
	// anchors only, a stale cache up to ANCHOR_STALE_MAX_SECONDS → null.
	const getFeed = async (tag: string, role: FeedRole): Promise<Feed | null> => {
		if (fresh.has(tag)) {
			const events = fresh.get(tag);
			return events ? { events, fetchedAt: now } : null;
		}
		let cached = cacheReads.get(tag);
		if (cached === undefined) {
			cached = await readFeedCache(db, tag);
			cacheReads.set(tag, cached);
		}
		if (cached && now - cached.fetchedAt <= FEED_MAX_AGE_SECONDS[role]) {
			return cached;
		}
		if (canSpend(tag, role)) {
			const events = await fetchFresh(tag);
			return events ? { events, fetchedAt: now } : null;
		}
		const anchorRole = role === "live-anchor" || role === "shadow-anchor";
		if (
			anchorRole &&
			cached &&
			now - cached.fetchedAt <= ANCHOR_STALE_MAX_SECONDS
		) {
			return cached;
		}
		return null;
	};

	let anchors = 0;
	let closes = 0;
	let shadowCloses = 0;
	let shadowAnchors = 0;

	// ---- Live picks ----------------------------------------------------
	for (const row of rows) {
		if (!tracked(row.sport_tag)) continue;

		const wantsAnchor = row.pin_captured_at === null && row.event_time > now;
		const inCloseWindow =
			row.pin_close_captured_at === null &&
			now >= row.event_time - CLOSE_WINDOW_BEFORE_SECONDS &&
			now <= row.event_time + CLOSE_WINDOW_AFTER_SECONDS;
		const closeExpired =
			row.pin_close_captured_at === null &&
			now > row.event_time + CLOSE_WINDOW_AFTER_SECONDS;

		// Window passed without a capture (outage, budget, never matched):
		// stamp so the row stops occupying the sweep LIMIT forever.
		if (closeExpired && !wantsAnchor) {
			await run(
				db,
				`UPDATE manual_picks SET pin_close_captured_at = ? WHERE id = ?`,
				now,
				row.id,
			);
			continue;
		}
		if (!wantsAnchor && !inCloseWindow) continue;

		const feed = await getFeed(
			row.sport_tag,
			wantsAnchor ? "live-anchor" : "live-close",
		);
		// No usable feed (failure / budget): leave untouched, next sweep retries.
		if (!feed) continue;

		const event = matchOddsApiEvent(feed.events, {
			homeName: row.home_name,
			awayName: row.away_name,
			eventTime: row.event_time,
		});
		if (!event) {
			// No Pinnacle listing for this game — stamp whichever capture was
			// due so we don't retry for it every sweep.
			if (wantsAnchor) {
				await run(
					db,
					`UPDATE manual_picks SET pin_captured_at = ?, pin_feed_at = ? WHERE id = ?`,
					now,
					feed.fetchedAt,
					row.id,
				);
			} else {
				await run(
					db,
					`UPDATE manual_picks SET pin_close_captured_at = ?, pin_close_feed_at = ? WHERE id = ?`,
					now,
					feed.fetchedAt,
					row.id,
				);
			}
			continue;
		}

		const prices = extractPinnaclePrices(event, {
			betType: row.bet_type,
			venueRole: row.venue_role,
			sideLabel: row.sharp_side_label,
			marketTotalLine: parseMarketTotalLine(row.market_title),
		});
		const entryPrice =
			typeof row.price === "number" && row.price > 0 ? row.price : null;

		if (wantsAnchor) {
			const ev =
				prices.fairProb !== null && entryPrice !== null
					? prices.fairProb / entryPrice - 1
					: null;
			await run(
				db,
				`UPDATE manual_picks SET
					pin_captured_at = ?, pin_feed_at = ?, pin_ml_side = ?, pin_ml_opp = ?,
					pin_total_line = ?, pin_total_over_odds = ?,
					pin_total_under_odds = ?, pin_fair_prob = ?, pin_ev = ?
				 WHERE id = ?`,
				now,
				feed.fetchedAt,
				prices.mlSide,
				prices.mlOpp,
				prices.totalLine,
				prices.overOdds,
				prices.underOdds,
				prices.fairProb,
				ev,
				row.id,
			);
			anchors += 1;
		} else {
			const pinClv =
				prices.fairProb !== null && entryPrice !== null
					? prices.fairProb - entryPrice
					: null;
			await run(
				db,
				`UPDATE manual_picks SET
					pin_close_captured_at = ?, pin_close_feed_at = ?, pin_close_ml_side = ?,
					pin_close_ml_opp = ?, pin_close_total_line = ?,
					pin_close_total_over_odds = ?, pin_close_total_under_odds = ?,
					pin_close_fair_prob = ?, pin_clv = ?
				 WHERE id = ?`,
				now,
				feed.fetchedAt,
				prices.mlSide,
				prices.mlOpp,
				prices.totalLine,
				prices.overOdds,
				prices.underOdds,
				prices.fairProb,
				pinClv,
				row.id,
			);
			closes += 1;
		}
	}

	// ---- Shadow helpers ------------------------------------------------
	const shadowVenueRole = (
		row: ShadowCloseRow,
		event: OddsApiEvent,
	): string | null => {
		// ML venue role isn't stored on shadow rows; derive it from which
		// feed side the sharp label matches.
		if (row.market_type !== "moneyline" || !row.sharp_side_label) return null;
		if (teamNamesMatch(row.sharp_side_label, event.home_team)) return "home";
		if (teamNamesMatch(row.sharp_side_label, event.away_team)) return "away";
		return null;
	};
	const shadowTracked = (tag: string | null): tag is string =>
		!!tag && tracked(tag);
	// Draw-question markets ("Will X vs. Y end in a draw?") carry junk side
	// labels that substring-match real team names and would benchmark a
	// draw price against a team-win fair prob. Stamp with NULL fair prob.
	const isDrawQuestion = (title: string) => /end in a draw/i.test(title);
	const matchShadow = (row: ShadowCloseRow, tag: string, feed: Feed) => {
		const teams = parseTitleTeams(row.market_title);
		return teams
			? matchOddsApiEvent(feed.events, {
					homeName: teams.teamA,
					awayName: teams.teamB,
					eventTime: row.event_time,
					maxGapSeconds: TENNIS_TOUR_PREFIXES[tag] ? 6 * 3600 : undefined,
				})
			: null;
	};

	// ---- Shadow closes -------------------------------------------------
	for (const row of shadowRows) {
		const tag = row.sport_tag;
		if (!shadowTracked(tag) || isDrawQuestion(row.market_title)) {
			await run(
				db,
				`UPDATE shadow_candidates SET pin_close_captured_at = ? WHERE id = ?`,
				now,
				row.id,
			);
			continue;
		}
		const feed = await getFeed(tag, "shadow-close");
		// No usable feed inside the window: leave untouched; the window's
		// expiry stamps it via the next eligible sweep's close-expired path
		// (shadow rows are only selected inside the window, so an unserved
		// row simply drops out of the query once the window passes).
		if (!feed) continue;
		const event = matchShadow(row, tag, feed);
		if (!event) {
			await run(
				db,
				`UPDATE shadow_candidates SET pin_close_captured_at = ?, pin_close_feed_at = ? WHERE id = ?`,
				now,
				feed.fetchedAt,
				row.id,
			);
			continue;
		}
		const prices = extractPinnaclePrices(event, {
			betType: row.market_type,
			venueRole: shadowVenueRole(row, event),
			sideLabel: row.sharp_side_label,
			marketTotalLine: parseMarketTotalLine(row.market_title),
		});
		const entryPrice =
			typeof row.price === "number" && row.price > 0 ? row.price : null;
		const pinClv =
			prices.fairProb !== null && entryPrice !== null
				? prices.fairProb - entryPrice
				: null;
		await run(
			db,
			`UPDATE shadow_candidates
			 SET pin_close_captured_at = ?, pin_close_feed_at = ?, pin_close_total_line = ?,
			     pin_close_fair_prob = ?, pin_clv = ?
			 WHERE id = ?`,
			now,
			feed.fetchedAt,
			prices.totalLine,
			prices.fairProb,
			pinClv,
			row.id,
		);
		shadowCloses += 1;
	}

	// ---- Shadow anchors ------------------------------------------------
	for (const row of shadowAnchorRows) {
		const tag = row.sport_tag;
		if (!shadowTracked(tag) || isDrawQuestion(row.market_title)) {
			await run(
				db,
				`UPDATE shadow_candidates SET pin_captured_at = ? WHERE id = ?`,
				now,
				row.id,
			);
			continue;
		}
		const feed = await getFeed(tag, "shadow-anchor");
		// No usable feed (even stale): leave untouched; the row retries while
		// inside ANCHOR_MAX_AGE, then simply never anchors.
		if (!feed) continue;
		const event = matchShadow(row, tag, feed);
		if (!event) {
			await run(
				db,
				`UPDATE shadow_candidates SET pin_captured_at = ?, pin_feed_at = ? WHERE id = ?`,
				now,
				feed.fetchedAt,
				row.id,
			);
			continue;
		}
		const prices = extractPinnaclePrices(event, {
			betType: row.market_type,
			venueRole: shadowVenueRole(row, event),
			sideLabel: row.sharp_side_label,
			marketTotalLine: parseMarketTotalLine(row.market_title),
		});
		const entryPrice =
			typeof row.price === "number" && row.price > 0 ? row.price : null;
		const ev =
			prices.fairProb !== null && entryPrice !== null
				? prices.fairProb / entryPrice - 1
				: null;
		await run(
			db,
			`UPDATE shadow_candidates
			 SET pin_captured_at = ?, pin_feed_at = ?, pin_total_line = ?,
			     pin_fair_prob = ?, pin_ev = ?
			 WHERE id = ?`,
			now,
			feed.fetchedAt,
			prices.totalLine,
			prices.fairProb,
			ev,
			row.id,
		);
		shadowAnchors += 1;
	}

	return {
		checked: rows.length + shadowRows.length + shadowAnchorRows.length,
		anchors,
		closes,
		shadowCloses,
		shadowAnchors,
		fetches,
		fetches24h: fetchesInWindow,
		creditsRemaining: credits.remaining,
		provider,
	};
}
