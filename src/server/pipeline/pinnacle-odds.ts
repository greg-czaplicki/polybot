/**
 * Pinnacle benchmark capture via The Odds API (the-odds-api.com).
 *
 * Why Pinnacle: it is the sharp-book reference — beating Polymarket's own
 * close only proves we beat THIS market's price discovery; beating the
 * de-vigged Pinnacle close is the strongest available evidence of real
 * edge. DraftKings (via ESPN pickcenter, book-odds.ts) stays as the soft-
 * book anchor; FanDuel adds no information beyond DK and is skipped.
 *
 * Runs inside the scheduled cron (env-gated on ODDS_API_KEY — absent key
 * means the sweep is a no-op). Two capture kinds per pick, both from the
 * same per-sport odds fetch:
 *   - anchor (pin_*): first sweep after pick creation (≤ ~2-4 min lag).
 *   - close (pin_close_*): first sweep inside the close window, which
 *     opens CLOSE_WINDOW_BEFORE_SECONDS before event_time. This is a
 *     close PROXY (Pinnacle ~10 min pre-start), not a frozen closing
 *     line — The Odds API's historical endpoint (true closes) is a paid
 *     tier we can add later if the proxy proves noisy.
 *
 * De-vig and line-match semantics mirror book-odds.ts: two-way
 * multiplicative; totals fair prob only when Pinnacle prices the SAME
 * total line as the pick's market. pin_clv = pin_close_fair_prob − pick
 * price (same sign convention as clv/book_clv).
 *
 * Credit budget: cost = 2 credits per sport fetch (h2h+totals, one
 * bookmaker region). Fetches happen only when a sweep finds eligible
 * picks, so daily cost ≈ 2 × (picks × 2 captures) worst case, typically
 * well under the free 500/month at current pick volume; the $30 tier
 * (20K) removes the ceiling for football season.
 */

import type { Db } from "../db/client";
import { all, run } from "../db/client";
import { nowUnixSeconds } from "../env";
import { devigTwoWay, parseMarketTotalLine } from "./book-odds";

// The Odds API sport keys for our canonical sport tags. Soccer is absent
// deliberately: soccer picks carry no game linkage (KNOWN-ISSUES).
const ODDS_API_SPORT_KEYS: Record<string, string> = {
	mlb: "baseball_mlb",
	nba: "basketball_nba",
	nfl: "americanfootball_nfl",
	ncaaf: "americanfootball_ncaaf",
	ncaab: "basketball_ncaab",
	nhl: "icehockey_nhl",
};

/** Close window opens this long before event_time. */
const CLOSE_WINDOW_BEFORE_SECONDS = 600;
/** Close capture gives up this long after event_time (event leaves the feed). */
const CLOSE_WINDOW_AFTER_SECONDS = 1800;
/** Anchor capture only for picks created within this window. */
const ANCHOR_MAX_AGE_SECONDS = 2 * 3600;

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
	game: { homeName: string; awayName: string; eventTime: number },
): OddsApiEvent | null {
	let best: OddsApiEvent | null = null;
	let bestGap = Number.POSITIVE_INFINITY;
	for (const event of events) {
		const commence = Math.floor(Date.parse(event.commence_time) / 1000);
		if (!Number.isFinite(commence)) continue;
		const gap = Math.abs(commence - game.eventTime);
		if (gap > 45 * 60) continue;
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
		const over = totals.outcomes.find((o) => o.name.toLowerCase() === "over");
		const under = totals.outcomes.find((o) => o.name.toLowerCase() === "under");
		out.totalLine = over?.point ?? under?.point ?? null;
		out.overOdds = over?.price ?? null;
		out.underOdds = under?.price ?? null;
	}

	if (pick.betType === "moneyline" && h2h) {
		if (pick.venueRole !== "home" && pick.venueRole !== "away") return out;
		const home = h2h.outcomes.find((o) =>
			teamNamesMatch(o.name, event.home_team),
		);
		const away = h2h.outcomes.find((o) =>
			teamNamesMatch(o.name, event.away_team),
		);
		const side = pick.venueRole === "home" ? home : away;
		const opp = pick.venueRole === "home" ? away : home;
		if (side && opp && side.price !== 0 && opp.price !== 0) {
			out.mlSide = side.price;
			out.mlOpp = opp.price;
			out.fairProb = devigTwoWay(side.price, opp.price);
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

async function fetchOddsApiEvents(
	apiKey: string,
	sportKey: string,
): Promise<OddsApiEvent[] | null> {
	const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${apiKey}&bookmakers=pinnacle&markets=h2h,totals&oddsFormat=american`;
	try {
		const res = await fetch(url);
		if (!res.ok) {
			console.warn(
				`[pinnacle-odds] Odds API returned ${res.status} for ${sportKey}`,
			);
			return null;
		}
		const remaining = res.headers.get("x-requests-remaining");
		if (remaining !== null && Number.parseFloat(remaining) < 50) {
			console.warn(
				`[pinnacle-odds] Odds API credits low: ${remaining} remaining`,
			);
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
 * Extracts the two team names from a Polymarket game-market title
 * ("Colorado Rockies vs. Arizona Diamondbacks: O/U 9.5" → both teams).
 * Orientation doesn't matter — matchOddsApiEvent checks both. Pure —
 * exported for tests.
 */
export function parseTitleTeams(
	marketTitle: string,
): { teamA: string; teamB: string } | null {
	// The matchup can sit on either side of a colon: "A vs. B: O/U 9.5"
	// (totals suffix) or "Will ...?: A vs. B" (prop-style prefix).
	const colonIdx = marketTitle.indexOf(":");
	let matchup = marketTitle;
	if (colonIdx > 0) {
		const before = marketTitle.slice(0, colonIdx);
		const after = marketTitle.slice(colonIdx + 1);
		if (before.includes(" vs. ")) matchup = before;
		else if (after.includes(" vs. ")) matchup = after;
	}
	const parts = matchup.split(" vs. ");
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

export async function capturePinnacleOddsForPicks(
	db: Db,
	apiKey: string | undefined,
	options?: { limit?: number },
): Promise<{
	checked: number;
	anchors: number;
	closes: number;
	shadowCloses: number;
}> {
	if (!apiKey)
		return { checked: 0, anchors: 0, closes: 0, shadowCloses: 0 };
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

	// Shadow candidates: close proxy only (no anchors — shadows are created
	// all day and anchor captures would fetch on every scan tick).
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

	if (rows.length === 0 && shadowRows.length === 0)
		return { checked: 0, anchors: 0, closes: 0, shadowCloses: 0 };

	// One fetch per sport, shared by every eligible pick AND shadow of that
	// sport in this sweep.
	const eventsBySport = new Map<string, OddsApiEvent[] | null>();
	let anchors = 0;
	let closes = 0;
	let shadowCloses = 0;

	for (const row of rows) {
		const sportKey = ODDS_API_SPORT_KEYS[row.sport_tag];
		if (!sportKey) continue;

		const wantsAnchor = row.pin_captured_at === null && row.event_time > now;
		const inCloseWindow =
			row.pin_close_captured_at === null &&
			now >= row.event_time - CLOSE_WINDOW_BEFORE_SECONDS &&
			now <= row.event_time + CLOSE_WINDOW_AFTER_SECONDS;
		const closeExpired =
			row.pin_close_captured_at === null &&
			now > row.event_time + CLOSE_WINDOW_AFTER_SECONDS;

		// Window passed without a capture (outage, event never matched):
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

		if (!eventsBySport.has(row.sport_tag)) {
			eventsBySport.set(
				row.sport_tag,
				await fetchOddsApiEvents(apiKey, sportKey),
			);
		}
		const events = eventsBySport.get(row.sport_tag);
		// Fetch failure: leave untouched, next sweep retries.
		if (!events) continue;

		const event = matchOddsApiEvent(events, {
			homeName: row.home_name,
			awayName: row.away_name,
			eventTime: row.event_time,
		});
		if (!event) {
			// No Pinnacle listing for this game — stamp whichever capture was
			// due so we don't refetch for it every 2 minutes.
			if (wantsAnchor) {
				await run(
					db,
					`UPDATE manual_picks SET pin_captured_at = ? WHERE id = ?`,
					now,
					row.id,
				);
			} else {
				await run(
					db,
					`UPDATE manual_picks SET pin_close_captured_at = ? WHERE id = ?`,
					now,
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
					pin_captured_at = ?, pin_ml_side = ?, pin_ml_opp = ?,
					pin_total_line = ?, pin_total_over_odds = ?,
					pin_total_under_odds = ?, pin_fair_prob = ?, pin_ev = ?
				 WHERE id = ?`,
				now,
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
					pin_close_captured_at = ?, pin_close_ml_side = ?,
					pin_close_ml_opp = ?, pin_close_total_line = ?,
					pin_close_total_over_odds = ?, pin_close_total_under_odds = ?,
					pin_close_fair_prob = ?, pin_clv = ?
				 WHERE id = ?`,
				now,
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

	for (const row of shadowRows) {
		const tag = row.sport_tag;
		const sportKey = tag ? ODDS_API_SPORT_KEYS[tag] : undefined;
		if (!tag || !sportKey) {
			// Untracked sport (e.g. soccer): stamp so the row stops occupying
			// the sweep; fair prob stays NULL.
			await run(
				db,
				`UPDATE shadow_candidates SET pin_close_captured_at = ? WHERE id = ?`,
				now,
				row.id,
			);
			continue;
		}
		if (!eventsBySport.has(tag)) {
			eventsBySport.set(tag, await fetchOddsApiEvents(apiKey, sportKey));
		}
		const events = eventsBySport.get(tag);
		// Fetch failure: leave untouched, next sweep retries inside the window.
		if (!events) continue;

		const teams = parseTitleTeams(row.market_title);
		const event = teams
			? matchOddsApiEvent(events, {
					homeName: teams.teamA,
					awayName: teams.teamB,
					eventTime: row.event_time,
				})
			: null;
		if (!event) {
			// Unparseable title or no Pinnacle listing — stamp so we don't
			// refetch for this row every 2 minutes.
			await run(
				db,
				`UPDATE shadow_candidates SET pin_close_captured_at = ? WHERE id = ?`,
				now,
				row.id,
			);
			continue;
		}

		// ML venue role isn't stored on shadow rows; derive it from which
		// feed side the sharp label matches.
		let venueRole: string | null = null;
		if (row.market_type === "moneyline" && row.sharp_side_label) {
			if (teamNamesMatch(row.sharp_side_label, event.home_team)) {
				venueRole = "home";
			} else if (teamNamesMatch(row.sharp_side_label, event.away_team)) {
				venueRole = "away";
			}
		}
		const prices = extractPinnaclePrices(event, {
			betType: row.market_type,
			venueRole,
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
			 SET pin_close_captured_at = ?, pin_close_total_line = ?,
			     pin_close_fair_prob = ?, pin_clv = ?
			 WHERE id = ?`,
			now,
			prices.totalLine,
			prices.fairProb,
			pinClv,
			row.id,
		);
		shadowCloses += 1;
	}

	return { checked: rows.length + shadowRows.length, anchors, closes, shadowCloses };
}
