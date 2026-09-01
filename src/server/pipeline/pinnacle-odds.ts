/**
 * Pinnacle benchmark capture.
 *
 * Why Pinnacle: it is the sharp-book reference — beating Polymarket's own
 * close only proves we beat THIS market's price discovery; beating the
 * de-vigged Pinnacle close is the strongest available evidence of real
 * edge. DraftKings (via ESPN pickcenter, book-odds.ts) stays as the soft-
 * book anchor; FanDuel adds no information beyond DK and is skipped.
 *
 * Providers (env-gated; absent keys make the sweep a no-op; the first key
 * set is primary, an auth failure falls through to the next for 30 min):
 *   - OddsPapi (oddspapi.io, ODDSPAPI_KEY) — PRIMARY since 2026-08-28.
 *     Aggregator with Pinnacle on its free plan: 250 requests/month, one
 *     request = one call; /v4/odds-by-tournaments returns every upcoming
 *     Pinnacle-priced fixture for up to FIVE league ids (full alt-line
 *     ladders, decimal odds, participant names). Tags are fetched in
 *     groups (ODDSPAPI_GROUPS) and converted into the OddsApiEvent shape
 *     below (American odds, one "pinnacle" bookmaker, h2h + every total
 *     line) so matching / extraction / caching / tests are provider-
 *     agnostic. Market selection uses the OddsPapi catalog
 *     (oddspapi-markets.ts, regenerate with scripts/gen-oddspapi-markets.mjs).
 *   - pinnapi (pinnapi.com, PINNAPI_KEY) — Pinnacle-native relay, one
 *     request per SPORT. Primary 2026-08-26 → 08-27 until the vendor
 *     deleted both trial keys and the account; adapter kept, key unset.
 *   - The Odds API (the-odds-api.com, ODDS_API_KEY) — last fallback. One
 *     request per league key, 2 credits each, 500 credits/month free
 *     (~8 fetches/day); tennis keys are per-tournament and resolved
 *     against the /v4/sports index.
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
import {
	ODDSPAPI_H2H_MARKET,
	ODDSPAPI_TOTALS_MARKET,
} from "./oddspapi-markets";

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

// ---- OddsPapi (oddspapi.io) — PRIMARY since 2026-08-28 ------------------
// Free plan: 250 requests/month, every bookmaker incl. Pinnacle, 1 request
// = 1 call regardless of payload. /v4/odds-by-tournaments takes up to FIVE
// tournament ids per call, so tags are fetched in GROUPS: one call serves
// every tag in its group (like pinnapi's per-sport feed). Tournament ids
// are season-stable league ids (verified 2026-08-28 via /v4/tournaments);
// tennis tournaments are per-event and resolve dynamically (see
// selectOddspapiTennisTournaments).
const ODDSPAPI_BASE_URL = "https://api.oddspapi.io/v4";
const ODDSPAPI_TOURNAMENT_IDS: Record<string, number> = {
	mlb: 109,
	nba: 132,
	ncaab: 648,
	nfl: 31,
	ncaaf: 27653,
	nhl: 234,
	epl: 17,
	championship: 18,
	laliga: 8,
	bundesliga: 35,
	seriea: 23,
	ligue1: 34,
	ucl: 7,
	mls: 242,
};
/** Fetch groups (≤ ODDSPAPI_MAX_TOURNAMENTS_PER_CALL tags each). Live
 * leagues share a group so one live fetch also refreshes their shadows. */
const ODDSPAPI_GROUPS: Record<string, string[]> = {
	mlb: ["mlb"],
	"soccer-a": ["epl", "mls", "laliga", "bundesliga", "seriea"],
	"soccer-b": ["ligue1", "ucl", "championship"],
	football: ["nfl", "ncaaf"],
	winter: ["nba", "nhl", "ncaab"],
	tennis: ["atp", "wta"],
};
const ODDSPAPI_GROUP_OF: Record<string, string> = Object.fromEntries(
	Object.entries(ODDSPAPI_GROUPS).flatMap(([group, tags]) =>
		tags.map((tag) => [tag, group]),
	),
);
const ODDSPAPI_MAX_TOURNAMENTS_PER_CALL = 5;
const ODDSPAPI_TENNIS_SPORT_ID = 12;
/** pinnacle_feed_cache row holding the resolved tennis tournament ids. */
const ODDSPAPI_TENNIS_INDEX_TAG = "oddspapi-tennis-index";
/** pinnacle_feed_cache row holding the last OddsPapi error (path, status, body). */
const ODDSPAPI_LAST_ERROR_TAG = "oddspapi-last-error";
const ODDSPAPI_TENNIS_INDEX_MAX_AGE_SECONDS = 24 * 3600;
const ODDSPAPI_TENNIS_PREFERRED = [
	/us open/i,
	/wimbledon/i,
	/french open|roland garros/i,
	/australian open/i,
];
/** Documented per-endpoint cooldown is 1000 ms. */
const ODDSPAPI_REQUEST_GAP_MS = 1100;

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
export interface FetchCaps {
	shadow: number;
	liveAnchor: number;
	liveClose: number;
	perSport: number;
}

/** The role caps share one rolling-24h window, so a group whose demand
 * peaks late in the day (football's Saturday-evening slate) can find the
 * window already filled by MLB live fetches and the morning tennis/soccer
 * sweeps — and never fetch at all (zero NCAAF anchors on the 2026-08-29
 * opening slate). A group with no spend in the window may make one fetch
 * past its role cap, still under the absolute live-close ceiling, so the
 * daily worst case stays caps.liveClose. */
export function starvedGroupMayFetch(
	spentOnGroup: number,
	fetchesInWindow: number,
	caps: FetchCaps,
): boolean {
	return spentOnGroup === 0 && fetchesInWindow < caps.liveClose;
}

/** US Open fortnight boost (self-reverts): the tennis group shares the
 * shadow window with the soccer groups and was landing ~1-2 fetches/day,
 * anchoring only ~10% of ATP/WTA shadows — too thin for the tennis-verdict
 * read (n≈200, ~mid-Sept) and the WTA-fade charter, both of which consume
 * pin_clv. Until the tournament ends the tennis group may fetch past the
 * shared shadow cap up to its own daily allowance, still under the absolute
 * live-close ceiling and the credit floors (worst case ≈ +1-2 requests/day
 * for two weeks, inside the 250/month budget). The boost stops ONE slot
 * short of that ceiling: a starved group's demand peaks late in the day
 * (football's Saturday slate), and both NCAAF Saturdays left in the
 * fortnight (9/5, 9/12) would otherwise find the window boosted to the
 * ceiling before their first-ever fetch. */
export const TENNIS_BOOST_UNTIL_SECONDS = Date.UTC(2026, 8, 14) / 1000;
const TENNIS_BOOST_DAILY_FETCHES = 3;
export function tennisBoostMayFetch(
	now: number,
	spentOnGroup: number,
	fetchesInWindow: number,
	caps: FetchCaps,
): boolean {
	return (
		now < TENNIS_BOOST_UNTIL_SECONDS &&
		spentOnGroup < TENNIS_BOOST_DAILY_FETCHES &&
		fetchesInWindow < caps.liveClose - 1
	);
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
/** OddsPapi: 250 requests/month ≈ 8/day. Same shape as the Odds API
 * budget, but every request serves a whole group (up to 5 leagues), and
 * the monthly balance is enforced separately via /v4/account (unmetered)
 * through the LIVE/BENCHMARK_MIN_CREDITS floors. */
const ODDSPAPI_CAPS: FetchCaps = {
	shadow: 5,
	liveAnchor: 6,
	liveClose: 8,
	perSport: 4,
};
const FETCH_WINDOW_SECONDS = 24 * 3600;
/** After any pinnapi request fails (auth, 429, 5xx, network) no pinnapi
 * request is made for this long — a failed fetch caches nothing, so
 * without a backoff the 2-minute cron would retry every sweep. */
const PINNAPI_FAIL_BACKOFF_SECONDS = 10 * 60;
/** After a pinnapi AUTH failure (401/403) the sweep runs on The Odds API
 * fallback (when ODDS_API_KEY is set) for this long, then re-tries pinnapi. */
const PINNAPI_AUTH_FALLBACK_SECONDS = 30 * 60;
/** pinnacle_fetch_log.sport_key prefix for failed pinnapi requests; these
 * rows drive the backoff and are NOT counted toward the fetch caps. */
const PINNAPI_FAIL_KEY_PREFIX = "pinnapi-fail:";
const ODDSPAPI_FAIL_KEY_PREFIX = "oddspapi-fail:";
/** OddsPapi 429 = monthly quota exhausted (resets on the 1st): retrying
 * every 10 minutes is pointless, so back off for much longer. */
const ODDSPAPI_QUOTA_BACKOFF_SECONDS = 6 * 3600;
const FAIL_KEY_PREFIXES: Array<[string, PinnacleProvider]> = [
	[PINNAPI_FAIL_KEY_PREFIX, "pinnapi"],
	[ODDSPAPI_FAIL_KEY_PREFIX, "oddspapi"],
];
/** pinnacle_fetch_log rows that are NOT spend: `<provider>-fail:<status>`. */
function parseFailKey(
	key: string,
): { provider: PinnacleProvider; status: number } | null {
	for (const [prefix, provider] of FAIL_KEY_PREFIXES) {
		if (key.startsWith(prefix)) {
			return {
				provider,
				status: Number.parseInt(key.slice(prefix.length), 10),
			};
		}
	}
	return null;
}
/** Which provider a spend row belongs to (fetch-log key namespace). */
function providerOfLogKey(key: string): PinnacleProvider {
	if (key.startsWith("oddspapi:")) return "oddspapi";
	if (key.startsWith("pinnapi:")) return "pinnapi";
	return "odds-api";
}

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

// ---- OddsPapi feed shape (subset we read) -------------------------------
interface OddspapiPlayerOdds {
	active?: boolean | null;
	bookmakerOutcomeId?: string | null;
	/** Decimal. */
	price?: number | null;
}
export interface OddspapiMarket {
	marketActive?: boolean | null;
	outcomes?: Record<string, { players?: Record<string, OddspapiPlayerOdds> }>;
}
export interface OddspapiFixture {
	fixtureId: string;
	sportId: number;
	tournamentId: number;
	startTime: string;
	hasOdds?: boolean;
	participant1Name?: string | null;
	participant2Name?: string | null;
	/** Keyed by bookmaker slug; markets keyed by OddsPapi market id. */
	bookmakerOdds?: Record<
		string,
		{ suspended?: boolean | null; markets?: Record<string, OddspapiMarket> }
	>;
}
export interface OddspapiTournament {
	tournamentId: number;
	tournamentName: string;
	categoryName: string;
	futureFixtures?: number;
	upcomingFixtures?: number;
	liveFixtures?: number;
}

/** "Svrcina, Dalibor" → "Dalibor Svrcina": OddsPapi lists tennis players
 * surname-first, Polymarket titles given-name-first. Pure — exported for
 * tests. */
export function flipCommaName(name: string): string {
	const i = name.indexOf(", ");
	if (i <= 0) return name.trim();
	return `${name.slice(i + 2).trim()} ${name.slice(0, i).trim()}`;
}

const ODDSPAPI_TOTAL_OUTCOME_RE = /^(-?\d+(?:\.\d+)?)\/(over|under)$/;

/**
 * Converts an OddsPapi fixture (Pinnacle book only) into the provider-
 * agnostic feed shape: the sport's winner market (soccer 1X2 incl. draw)
 * and EVERY full-game total on the ladder. Market SELECTION goes through
 * the OddsPapi catalog (oddspapi-markets.ts) — OddsPapi merges corners,
 * bookings, team totals, sets and period markets into the same fixture
 * with Pinnacle-native ids that look identical, so the Pinnacle
 * `bookmakerMarketId` alone cannot be trusted. Side and line come from
 * Pinnacle's `bookmakerOutcomeId` ("8.5/over", "home"), cross-checked
 * against the catalog line. Inactive outcomes/markets are dropped.
 * Null when the fixture carries no usable Pinnacle prices. Pure —
 * exported for tests.
 */
export function oddspapiToOddsApiEvent(
	f: OddspapiFixture,
): OddsApiEvent | null {
	const pin = f.bookmakerOdds?.pinnacle;
	const home = f.participant1Name ? flipCommaName(f.participant1Name) : "";
	const away = f.participant2Name ? flipCommaName(f.participant2Name) : "";
	if (!pin?.markets || pin.suspended || !home || !away || !f.startTime)
		return null;
	const outcomesOf = (
		m: OddspapiMarket | undefined,
	): Array<{ id: string; price: number }> => {
		if (!m || m.marketActive === false || !m.outcomes) return [];
		const out: Array<{ id: string; price: number }> = [];
		for (const o of Object.values(m.outcomes)) {
			const p = o.players ? Object.values(o.players)[0] : undefined;
			if (!p || p.active === false || typeof p.price !== "number") continue;
			const price = decimalToAmerican(p.price);
			if (price === null || !p.bookmakerOutcomeId) continue;
			out.push({ id: p.bookmakerOutcomeId.toLowerCase(), price });
		}
		return out;
	};
	const markets: OddsApiEvent["bookmakers"][number]["markets"] = [];
	const h2hId = ODDSPAPI_H2H_MARKET[f.sportId];
	if (h2hId !== undefined) {
		const outs = outcomesOf(pin.markets[String(h2hId)]);
		const h = outs.find((o) => o.id === "home");
		const a = outs.find((o) => o.id === "away");
		const d = outs.find((o) => o.id === "draw");
		if (h && a) {
			const outcomes: OddsApiOutcome[] = [
				{ name: home, price: h.price },
				{ name: away, price: a.price },
			];
			if (d) outcomes.push({ name: "Draw", price: d.price });
			markets.push({ key: "h2h", outcomes });
		}
	}
	const byLine = new Map<number, { over?: number; under?: number }>();
	for (const [mid, m] of Object.entries(pin.markets)) {
		const catalog = ODDSPAPI_TOTALS_MARKET[Number(mid)];
		if (!catalog || catalog[0] !== f.sportId) continue;
		for (const o of outcomesOf(m)) {
			const match = ODDSPAPI_TOTAL_OUTCOME_RE.exec(o.id);
			if (!match) continue;
			if (Math.abs(Number.parseFloat(match[1]) - catalog[1]) > 0.01) continue;
			const slot = byLine.get(catalog[1]) ?? {};
			if (match[2] === "over") slot.over = o.price;
			else slot.under = o.price;
			byLine.set(catalog[1], slot);
		}
	}
	const lines = [...byLine.entries()]
		.filter(([, s]) => s.over !== undefined && s.under !== undefined)
		.sort((x, y) => x[0] - y[0]);
	if (lines.length > 0) {
		markets.push({
			key: "totals",
			outcomes: lines.flatMap(([line, s]) => [
				{ name: "Over", price: s.over as number, point: line },
				{ name: "Under", price: s.under as number, point: line },
			]),
		});
	}
	if (markets.length === 0) return null;
	return {
		id: f.fixtureId,
		commence_time: f.startTime,
		home_team: home,
		away_team: away,
		bookmakers: [{ key: "pinnacle", markets }],
	};
}

/**
 * Picks the tennis tournaments worth one fetch slot: ATP/WTA singles
 * (main draws include qualifying) with fixtures listed, Grand Slams
 * first, then by fixture count, up to `max` (the per-call id limit).
 * Pure — exported for tests.
 */
export function selectOddspapiTennisTournaments(
	list: OddspapiTournament[],
	max = ODDSPAPI_MAX_TOURNAMENTS_PER_CALL,
): Array<{ id: number; tag: string; name: string }> {
	const scored: Array<{
		id: number;
		tag: string;
		name: string;
		preferred: number;
		n: number;
	}> = [];
	for (const t of list) {
		const tag =
			t.categoryName === "ATP"
				? "atp"
				: t.categoryName === "WTA"
					? "wta"
					: null;
		if (!tag) continue;
		if (!/singles$/i.test(t.tournamentName)) continue;
		if (/doubles|mixed/i.test(t.tournamentName)) continue;
		const n =
			(t.futureFixtures ?? 0) +
			(t.upcomingFixtures ?? 0) +
			(t.liveFixtures ?? 0);
		if (n <= 0) continue;
		const preferred = ODDSPAPI_TENNIS_PREFERRED.some((re) =>
			re.test(t.tournamentName),
		)
			? 1
			: 0;
		scored.push({
			id: t.tournamentId,
			tag,
			name: t.tournamentName,
			preferred,
			n,
		});
	}
	scored.sort((x, y) => y.preferred - x.preferred || y.n - x.n || x.id - y.id);
	return scored.slice(0, max).map(({ id, tag, name }) => ({ id, tag, name }));
}

function normalizeTeamName(name: string): string {
	return name.toLowerCase().replace(/[.']/g, "").replace(/\s+/g, " ").trim();
}

export function teamNamesMatch(a: string, b: string): boolean {
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
): Promise<{ events: PinnapiEvent[] } | { failed: number }> {
	const url = `https://pinnapi.com/kit/v1/prematch/fixtures?sport_id=${sportId}`;
	try {
		const res = await fetch(url, { headers: { "x-portal-apikey": apiKey } });
		if (!res.ok) {
			const body = (await res.text().catch(() => "")).slice(0, 120);
			console.warn(
				`[pinnacle-odds] pinnapi returned ${res.status} for sport ${sportId}: ${body}${res.status === 429 ? " (RATE LIMITED — cap breached?)" : ""}`,
			);
			return { failed: res.status };
		}
		const body = (await res.json()) as { events?: PinnapiEvent[] };
		return { events: Array.isArray(body.events) ? body.events : [] };
	} catch (err) {
		console.warn(
			`[pinnacle-odds] pinnapi fetch failed for sport ${sportId}:`,
			err instanceof Error ? err.message : err,
		);
		return { failed: 0 };
	}
}

/** One OddsPapi GET. The key never appears in logs (path only). */
async function oddspapiGet<T>(
	apiKey: string,
	path: string,
	query: Record<string, string>,
	transport?: OddspapiTransport,
): Promise<{ data: T } | { failed: number; body: string }> {
	const params = new URLSearchParams({ ...query, apiKey });
	const baseUrl = transport?.baseUrl ?? ODDSPAPI_BASE_URL;
	try {
		const res = await fetch(`${baseUrl}${path}?${params}`, {
			headers: { Accept: "application/json", ...(transport?.headers ?? {}) },
		});
		if (!res.ok) {
			const body = (await res.text().catch(() => "")).slice(0, 120);
			console.warn(
				`[pinnacle-odds] oddspapi returned ${res.status} for ${path}: ${body}${res.status === 429 ? " (MONTHLY QUOTA EXHAUSTED?)" : ""}`,
			);
			return { failed: res.status, body: `${path} ${res.status}: ${body}` };
		}
		return { data: (await res.json()) as T };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[pinnacle-odds] oddspapi fetch failed for ${path}:`, message);
		return { failed: 0, body: `${path} network: ${message}` };
	}
}

/** One OddsPapi request: every upcoming Pinnacle-priced fixture in up to
 * five tournaments (verbosity 3 = participant names included). */
async function fetchOddspapiTournaments(
	apiKey: string,
	tournamentIds: number[],
	transport?: OddspapiTransport,
): Promise<{ fixtures: OddspapiFixture[] } | { failed: number; body: string }> {
	const result = await oddspapiGet<OddspapiFixture[]>(
		apiKey,
		"/odds-by-tournaments",
		{
			tournamentIds: tournamentIds
				.slice(0, ODDSPAPI_MAX_TOURNAMENTS_PER_CALL)
				.join(","),
			bookmakers: "pinnacle",
			verbosity: "3",
		},
		transport,
	);
	if ("failed" in result) return result;
	return { fixtures: Array.isArray(result.data) ? result.data : [] };
}

/** Requests left this month from the unmetered /v4/account; null when
 * unreadable (the floors then don't apply — the rolling caps still do). */
async function fetchOddspapiCredits(
	apiKey: string,
	transport?: OddspapiTransport,
): Promise<number | null> {
	const result = await oddspapiGet<{
		subscriptions?: Array<{
			is_active?: boolean;
			request_limit?: number | null;
			request_count?: number | null;
		}>;
	}>(apiKey, "/account", {}, transport);
	if ("failed" in result) return null;
	const subs = result.data.subscriptions ?? [];
	const sub = subs.find((s) => s.is_active) ?? subs[0];
	if (
		!sub ||
		typeof sub.request_limit !== "number" ||
		typeof sub.request_count !== "number"
	)
		return null;
	return sub.request_limit - sub.request_count;
}

interface TennisIndexMember {
	id: number;
	tag: string;
	name: string;
}

async function readTennisIndex(
	db: Db,
): Promise<{ fetchedAt: number; members: TennisIndexMember[] } | null> {
	const row = await first<FeedCacheRow>(
		db,
		`SELECT fetched_at, events_json FROM pinnacle_feed_cache WHERE sport_tag = ?`,
		ODDSPAPI_TENNIS_INDEX_TAG,
	);
	if (!row) return null;
	try {
		const members = JSON.parse(row.events_json) as TennisIndexMember[];
		return Array.isArray(members)
			? { fetchedAt: row.fetched_at, members }
			: null;
	} catch {
		return null;
	}
}

async function writeTennisIndex(
	db: Db,
	fetchedAt: number,
	members: TennisIndexMember[],
): Promise<void> {
	await run(
		db,
		`INSERT INTO pinnacle_feed_cache (sport_tag, fetched_at, events_json, credits_remaining)
		 VALUES (?, ?, ?, NULL)
		 ON CONFLICT(sport_tag) DO UPDATE SET
		   fetched_at = excluded.fetched_at, events_json = excluded.events_json`,
		ODDSPAPI_TENNIS_INDEX_TAG,
		fetchedAt,
		JSON.stringify(members),
	);
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

export type PinnacleProvider = "oddspapi" | "pinnapi" | "odds-api";

/** Provider precedence: oddspapi → pinnapi → The Odds API (first key set
 * is primary; an auth failure on the primary falls through to the next). */
/** Where OddsPapi calls go. oddspapi.io blocks Cloudflare Workers egress
 * IPs (403 RESTRICTED_ACCESS, 2026-08-28), so production routes through
 * the bot VPS control agent's /oddspapi relay (BOT_CONTROL_URL + control
 * auth headers); `baseUrl` replaces "https://api.oddspapi.io/v4". */
export interface OddspapiTransport {
	baseUrl: string;
	headers?: Record<string, string>;
}

export interface PinnacleKeys {
	oddspapiKey?: string;
	oddspapiTransport?: OddspapiTransport;
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
	const chain: PinnacleProvider[] = [];
	if (resolved.oddspapiKey) chain.push("oddspapi");
	if (resolved.pinnapiKey) chain.push("pinnapi");
	if (resolved.oddsApiKey) chain.push("odds-api");
	let provider: PinnacleProvider | null = chain[0] ?? null;
	if (provider === null) return empty;
	const tracked = (tag: string): boolean =>
		provider === "oddspapi"
			? ODDSPAPI_GROUP_OF[tag] !== undefined
			: provider === "pinnapi"
				? PINNAPI_SPORT_IDS[tag] !== undefined
				: !!(ODDS_API_SPORT_KEYS[tag] || TENNIS_TOUR_PREFIXES[tag]);
	// Fetch-log key per tag: oddspapi spends per GROUP, pinnapi per SPORT
	// (one fetch serves every tag of it), The Odds API per league key.
	const sportLogKey = (tag: string): string =>
		provider === "oddspapi"
			? `oddspapi:${ODDSPAPI_GROUP_OF[tag]}`
			: provider === "pinnapi"
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
	const windowRows = await all<{
		sport_key: string;
		n: number;
		last_at: number;
	}>(
		db,
		`SELECT sport_key, COUNT(*) AS n, MAX(fetched_at) AS last_at
		 FROM pinnacle_fetch_log WHERE fetched_at > ? GROUP BY sport_key`,
		windowStart,
	);
	// Latest failure per provider (fail rows are not spend) and the spend
	// rows, attributed to the provider whose key namespace they carry.
	const lastFail = new Map<PinnacleProvider, { at: number; status: number }>();
	const spendRows: Array<{
		provider: PinnacleProvider;
		key: string;
		n: number;
	}> = [];
	for (const r of windowRows) {
		const fail = parseFailKey(r.sport_key);
		if (fail) {
			const prev = lastFail.get(fail.provider);
			if (!prev || r.last_at > prev.at)
				lastFail.set(fail.provider, { at: r.last_at, status: fail.status });
			continue;
		}
		spendRows.push({
			provider: providerOfLogKey(r.sport_key),
			key: r.sport_key,
			n: r.n,
		});
	}
	// Auth failure on the primary → next provider in the chain for a while.
	const primaryFail = lastFail.get(provider);
	if (
		primaryFail &&
		(primaryFail.status === 401 || primaryFail.status === 403) &&
		now - primaryFail.at < PINNAPI_AUTH_FALLBACK_SECONDS &&
		chain.length > 1
	) {
		console.warn(
			`[pinnacle-odds] ${provider} auth failed ${primaryFail.status} at ${primaryFail.at}; using ${chain[1]} fallback this sweep`,
		);
		provider = chain[1];
	}
	// Caps count ONLY the active provider's spend. Counting every row let
	// the day's pinnapi successes exhaust the Odds API caps the moment the
	// 8/27 auth failure switched providers — the fallback never fetched.
	const perSport = new Map<string, number>();
	let fetchesInWindow = 0;
	for (const r of spendRows) {
		if (r.provider !== provider) continue;
		perSport.set(r.key, r.n);
		fetchesInWindow += r.n;
	}
	const providerFail = lastFail.get(provider);
	let providerBackoff =
		providerFail !== undefined &&
		now - providerFail.at <
			(provider === "oddspapi" && providerFail.status === 429
				? ODDSPAPI_QUOTA_BACKOFF_SECONDS
				: PINNAPI_FAIL_BACKOFF_SECONDS);
	const apiKey = (
		provider === "oddspapi"
			? resolved.oddspapiKey
			: provider === "pinnapi"
				? resolved.pinnapiKey
				: resolved.oddsApiKey
	) as string;
	const caps =
		provider === "oddspapi"
			? ODDSPAPI_CAPS
			: provider === "pinnapi"
				? PINNAPI_CAPS
				: ODDS_API_CAPS;
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
		if (providerBackoff) return false;
		const spent = perSport.get(sportLogKey(tag)) ?? 0;
		if (
			fetchesInWindow >= cap &&
			!(
				provider === "oddspapi" &&
				(starvedGroupMayFetch(spent, fetchesInWindow, caps) ||
					(sportLogKey(tag) === "oddspapi:tennis" &&
						tennisBoostMayFetch(now, spent, fetchesInWindow, caps)))
			)
		)
			return false;
		return spent < caps.perSport;
	};

	// Failed pinnapi/oddspapi request: recorded for the backoff, not spend.
	const logProviderFailure = async (
		status: number,
		body?: string,
	): Promise<void> => {
		providerBackoff = true;
		await run(
			db,
			`INSERT INTO pinnacle_fetch_log (fetched_at, sport_key, credits_remaining)
			 VALUES (?, ?, NULL)`,
			now,
			`${provider === "oddspapi" ? ODDSPAPI_FAIL_KEY_PREFIX : PINNAPI_FAIL_KEY_PREFIX}${status}`,
		);
		// Last error body, durable: the sweep runs inside the sync DO where
		// console output is not reliably observable from `wrangler tail`.
		if (body) {
			await run(
				db,
				`INSERT INTO pinnacle_feed_cache (sport_tag, fetched_at, events_json, credits_remaining)
				 VALUES (?, ?, ?, NULL)
				 ON CONFLICT(sport_tag) DO UPDATE SET
				   fetched_at = excluded.fetched_at, events_json = excluded.events_json`,
				ODDSPAPI_LAST_ERROR_TAG,
				now,
				JSON.stringify(body.slice(0, 2000)),
			);
		}
	};
	// OddsPapi documents a 1 s per-endpoint cooldown; pace every call.
	let lastOddspapiAt = 0;
	const oddspapiPace = async (): Promise<void> => {
		const wait = lastOddspapiAt + ODDSPAPI_REQUEST_GAP_MS - Date.now();
		if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
		lastOddspapiAt = Date.now();
	};
	let oddspapiCreditsChecked = false;

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
	// oddspapi: raw per-GROUP feeds fetched this sweep (null = failed).
	const oddspapiGroupFeeds = new Map<string, OddspapiFixture[] | null>();

	// Tennis tournament ids for the oddspapi "tennis" group: cached daily
	// (the /v4/tournaments index is a billable request, logged under the
	// group so the per-group cap covers it). Null = unresolvable this sweep.
	const resolveOddspapiTennis = async (): Promise<
		TennisIndexMember[] | null
	> => {
		const cached = await readTennisIndex(db);
		if (
			cached &&
			now - cached.fetchedAt <= ODDSPAPI_TENNIS_INDEX_MAX_AGE_SECONDS
		)
			return cached.members;
		await oddspapiPace();
		const result = await oddspapiGet<OddspapiTournament[]>(
			apiKey,
			"/tournaments",
			{ sportId: String(ODDSPAPI_TENNIS_SPORT_ID) },
			resolved.oddspapiTransport,
		);
		if ("failed" in result) {
			await logProviderFailure(result.failed, result.body);
			return cached?.members ?? null;
		}
		await logFetch("oddspapi:tennis");
		const members = selectOddspapiTennisTournaments(
			Array.isArray(result.data) ? result.data : [],
		);
		await writeTennisIndex(db, now, members);
		console.log(
			`[pinnacle-odds] oddspapi tennis index: ${members.map((m) => `${m.tag}:${m.id} ${m.name}`).join(" | ") || "none active"}`,
		);
		return members;
	};

	// Fresh fetch for a tag. pinnapi: one request per SPORT, then every tag
	// of that sport is filtered/converted, marked fresh and cached at once.
	// Odds API: one request for static keys; for tennis, the active
	// tournament keys for the tour (capped, Grand Slam preferred).
	// Null = fetch failed (rows retry next sweep). Empty array = feed
	// answered with no listing (rows stamp).
	const fetchFresh = async (tag: string): Promise<OddsApiEvent[] | null> => {
		if (provider === "oddspapi") {
			const group = ODDSPAPI_GROUP_OF[tag];
			let raw = oddspapiGroupFeeds.get(group);
			let members: TennisIndexMember[] | null = null;
			if (raw === undefined) {
				members =
					group === "tennis"
						? await resolveOddspapiTennis()
						: ODDSPAPI_GROUPS[group].map((t) => ({
								id: ODDSPAPI_TOURNAMENT_IDS[t],
								tag: t,
								name: t,
							}));
				if (members === null) {
					raw = null;
				} else if (members.length === 0) {
					raw = [];
				} else {
					await oddspapiPace();
					const result = await fetchOddspapiTournaments(
						apiKey,
						members.map((m) => m.id),
						resolved.oddspapiTransport,
					);
					if ("failed" in result) {
						await logProviderFailure(result.failed, result.body);
						raw = null;
					} else {
						await logFetch(`oddspapi:${group}`);
						raw = result.fixtures;
					}
				}
				oddspapiGroupFeeds.set(group, raw);
				if (raw !== null) {
					const tagOf = new Map(members?.map((m) => [m.id, m.tag]) ?? []);
					const byTag = new Map<string, OddsApiEvent[]>(
						ODDSPAPI_GROUPS[group].map((t) => [t, []]),
					);
					for (const f of raw) {
						const t = tagOf.get(f.tournamentId);
						if (!t) continue;
						const converted = oddspapiToOddsApiEvent(f);
						if (converted) byTag.get(t)?.push(converted);
					}
					for (const [t, events] of byTag) {
						fresh.set(t, events);
						await writeFeedCache(db, t, now, events, credits.remaining);
					}
					console.log(
						`[pinnacle-odds] oddspapi ${group}: ${raw.length} fixtures, ${[...byTag].map(([t, e]) => `${t}=${e.length}`).join(" ")}`,
					);
				}
			}
			if (raw === null) {
				fresh.set(tag, null);
				return null;
			}
			return fresh.get(tag) ?? [];
		}
		if (provider === "pinnapi") {
			const sportId = PINNAPI_SPORT_IDS[tag];
			let raw = pinnapiSportFeeds.get(sportId);
			if (raw === undefined) {
				const result = await fetchPinnapiSport(apiKey, sportId);
				if ("failed" in result) {
					await logProviderFailure(result.failed);
					raw = null;
				} else {
					await logFetch(`pinnapi:${sportId}`);
					raw = result.events;
				}
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
		// About to spend on oddspapi: read the monthly balance once per
		// sweep (unmetered) so the credit floors in canSpend apply.
		if (provider === "oddspapi" && !oddspapiCreditsChecked) {
			oddspapiCreditsChecked = true;
			await oddspapiPace();
			credits.remaining = await fetchOddspapiCredits(
				apiKey,
				resolved.oddspapiTransport,
			);
			if (credits.remaining !== null && credits.remaining < 30) {
				console.warn(
					`[pinnacle-odds] oddspapi requests low: ${credits.remaining} left this month`,
				);
			}
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
