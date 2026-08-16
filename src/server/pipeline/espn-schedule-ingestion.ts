/**
 * ESPN Schedule Ingestion — full-schedule game creation from ESPN scoreboard.
 *
 * Unlike game-ingestion.ts (which only creates games from Polymarket markets),
 * this module fetches ALL games from ESPN's public scoreboard API for a rolling
 * window of dates. This ensures trend data covers every game a team plays,
 * not just games that appear on Polymarket.
 *
 * Games created here get finalized with scores immediately if ESPN reports
 * them as completed, so result-ingestion.ts only needs to handle stragglers.
 *
 * After game creation, fetches DraftKings odds from ESPN's summary endpoint
 * for games missing closing lines (spread + total).
 *
 * ESPN endpoints:
 *   Scoreboard: /apis/site/v2/sports/{sport}/{league}/scoreboard?dates={YYYYMMDD}
 *   Summary:    /apis/site/v2/sports/{sport}/{league}/summary?event={eventId}
 */

import type { Db } from "../db/client";
import { all, first, run } from "../db/client";
import { toCanonicalSportTag } from "@/lib/sports";
import { upsertGameLine } from "../repositories/game-lines";
import { createGame, updateGameResult } from "../repositories/games";
import type { TeamRow } from "../types/canonical";

/**
 * ESPN's WAF started rejecting requests without a User-Agent around
 * 2026-08-06 (403 on every call — the outage that froze game finalization
 * and book closes for six days). Workers' fetch sends no UA by default.
 * Live-verified 2026-08-11: plain HTTP-client UAs (curl/*, python-requests/*,
 * okhttp/*) pass; empty, partial ("Mozilla/5.0", "node"), and
 * browser-imitation UAs without full browser headers are rejected.
 */
export const ESPN_FETCH_HEADERS = { "User-Agent": "curl/8.5.0" } as const;

// ---------------------------------------------------------------------------
// ESPN API types (subset of scoreboard response)
// ---------------------------------------------------------------------------

interface EspnCompetitor {
	homeAway: "home" | "away";
	score: string;
	team: {
		abbreviation: string;
		displayName: string;
		shortDisplayName: string;
	};
}

interface EspnCompetition {
	competitors: EspnCompetitor[];
	startDate: string;
	neutralSite?: boolean;
	status: {
		type: {
			completed: boolean;
		};
	};
}

interface EspnEvent {
	id: string;
	season: { year: number; type: number };
	week?: { number: number };
	competitions: EspnCompetition[];
}

interface EspnScoreboardResponse {
	events: EspnEvent[];
}

// ---------------------------------------------------------------------------
// ESPN Summary types (for odds/pickcenter)
// ---------------------------------------------------------------------------

export interface EspnPickcenterEntry {
	provider: { id: string; name: string; priority: number };
	spread: number;
	overUnder: number;
	/** American prices on the total (present on MLB at least; verified live 2026-08-11) */
	overOdds?: number;
	underOdds?: number;
	homeTeamOdds?: {
		favorite: boolean;
		moneyLine: number;
		spreadOdds: number;
	};
	awayTeamOdds?: {
		favorite: boolean;
		moneyLine: number;
		spreadOdds: number;
	};
}

export interface EspnSummaryResponse {
	pickcenter?: EspnPickcenterEntry[];
}

/** Prefer DraftKings, fall back to the first pickcenter provider. */
export function selectPickcenterEntry(
	summary: EspnSummaryResponse,
): EspnPickcenterEntry | null {
	if (!summary.pickcenter?.length) return null;
	const dk = summary.pickcenter.find((p) => {
		const name = p.provider?.name?.toLowerCase() ?? "";
		return name.includes("draft kings") || name.includes("draftkings");
	});
	return dk ?? summary.pickcenter[0] ?? null;
}

// ---------------------------------------------------------------------------
// Sport → ESPN path mapping
// ---------------------------------------------------------------------------

const SPORT_ESPN_MAP: Record<string, { sport: string; league: string }> = {
	nfl: { sport: "football", league: "nfl" },
	nba: { sport: "basketball", league: "nba" },
	mlb: { sport: "baseball", league: "mlb" },
	ncaab: { sport: "basketball", league: "mens-college-basketball" },
	ncaaf: { sport: "football", league: "college-football" },
	// Both leagues store under canonical sport_tag "soccer" (see
	// toCanonicalSportTag); the per-league keys only select the ESPN feed.
	epl: { sport: "soccer", league: "eng.1" },
	mls: { sport: "soccer", league: "usa.1" },
};

/**
 * Default lookback: 3 days back + 1 ahead keeps us under Cloudflare's
 * subrequest limit while still catching games promptly.
 */
const DEFAULT_LOOKBACK_DAYS = 3;
const DEFAULT_LOOKAHEAD_DAYS = 1;

/** Max summary fetches per sync to stay within subrequest limits. */
const MAX_ODDS_FETCHES = 50;

// ---------------------------------------------------------------------------
// Types — results
// ---------------------------------------------------------------------------

export interface EspnScheduleIngestionResult {
	created: number;
	matched: number;
	finalized: number;
	linesIngested: number;
	skipped: number;
	errors: number;
	espnFetches: number;
}

export interface EspnScheduleOptions {
	/** Override lookback days (default: 3) */
	lookbackDays?: number;
	/** Override lookahead days (default: 1) */
	lookaheadDays?: number;
}

// ---------------------------------------------------------------------------
// ESPN API helpers
// ---------------------------------------------------------------------------

async function fetchEspnScoreboard(
	sportTag: string,
	dateStr: string,
): Promise<EspnScoreboardResponse | null> {
	const mapping = SPORT_ESPN_MAP[sportTag];
	if (!mapping) return null;

	// Without an explicit limit ESPN truncates busy slates (NCAAB weekdays run
	// 300+ games) with no error or cursor — but limit>500 silently flips
	// college scoreboards to the curated Top-25 view (live-verified
	// 2026-08-05: CFB dates=20250830 returns 62 events at limit=500, only 25
	// at limit=1000). Keep the limit at 500 and pass the all-games groups
	// param for college feeds (FBS=80, D1 hoops=50, which is also the only
	// way NCAAB returns the full slate).
	const groups =
		mapping.league === "college-football"
			? "&groups=80"
			: mapping.league === "mens-college-basketball"
				? "&groups=50"
				: "";
	const url = `https://site.api.espn.com/apis/site/v2/sports/${mapping.sport}/${mapping.league}/scoreboard?dates=${dateStr}&limit=500${groups}`;

	try {
		const res = await fetch(url, { headers: ESPN_FETCH_HEADERS });
		if (!res.ok) {
			console.warn(
				`[espn-schedule] ESPN API returned ${res.status} for ${sportTag} on ${dateStr}`,
			);
			return null;
		}
		return (await res.json()) as EspnScoreboardResponse;
	} catch (err) {
		console.warn(
			`[espn-schedule] ESPN fetch failed for ${sportTag} on ${dateStr}:`,
			err instanceof Error ? err.message : err,
		);
		return null;
	}
}

export async function fetchEspnSummary(
	sportTag: string,
	eventId: string,
): Promise<EspnSummaryResponse | null> {
	const mapping = SPORT_ESPN_MAP[sportTag];
	if (!mapping) return null;

	const url = `https://site.api.espn.com/apis/site/v2/sports/${mapping.sport}/${mapping.league}/summary?event=${eventId}`;

	try {
		const res = await fetch(url, { headers: ESPN_FETCH_HEADERS });
		if (!res.ok) {
			console.warn(
				`[espn-schedule] ESPN summary returned ${res.status} for ${sportTag} event ${eventId}`,
			);
			return null;
		}
		return (await res.json()) as EspnSummaryResponse;
	} catch (err) {
		console.warn(
			`[espn-schedule] ESPN summary fetch failed for ${sportTag} event ${eventId}:`,
			err instanceof Error ? err.message : err,
		);
		return null;
	}
}

function formatDateUTC(date: Date): string {
	const yyyy = date.getUTCFullYear();
	const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(date.getUTCDate()).padStart(2, "0");
	return `${yyyy}${mm}${dd}`;
}

function getDateRange(lookback: number, lookahead: number): string[] {
	const dates: string[] = [];
	const now = new Date();

	for (let i = -lookback; i <= lookahead; i++) {
		const d = new Date(now);
		d.setUTCDate(d.getUTCDate() + i);
		dates.push(formatDateUTC(d));
	}

	return dates;
}

// ---------------------------------------------------------------------------
// In-memory team lookup cache — avoids repeated DB queries per competitor
// ---------------------------------------------------------------------------

interface TeamLookup {
	id: string;
	name: string;
	shortName?: string;
	abbreviation?: string;
	aliases: string[];
}

/**
 * Loads all teams for a sport into memory and builds lookup maps.
 * This replaces per-competitor DB queries with a single bulk load.
 */
async function loadTeamCache(
	db: Db,
	sportTag: string,
): Promise<Map<string, string>> {
	const rows = await all<TeamRow>(
		db,
		`SELECT * FROM teams WHERE sport_tag = ?`,
		sportTag,
	);

	// Map: normalized lookup key → team ID
	const cache = new Map<string, string>();
	const ambiguous = new Set<string>();

	for (const row of rows) {
		const team: TeamLookup = {
			id: row.id,
			name: row.name,
			shortName: row.short_name ?? undefined,
			abbreviation: row.abbreviation ?? undefined,
			aliases: row.aliases_json ? (JSON.parse(row.aliases_json) as string[]) : [],
		};

		// Index by every possible identifier (all lowercased)
		const keys = [
			team.name,
			team.shortName,
			team.abbreviation,
			...team.aliases,
		].filter(Boolean) as string[];

		for (const key of keys) {
			const normalized = key.toLowerCase();
			const existing = cache.get(normalized);
			if (existing !== undefined && existing !== team.id) {
				// Shared identifier (e.g. the bare nickname "Tigers" in NCAAF).
				// Last-write-wins would silently resolve games to the wrong
				// team; mark ambiguous so resolution skips instead.
				ambiguous.add(normalized);
				continue;
			}
			cache.set(normalized, team.id);
		}
	}

	for (const key of ambiguous) {
		cache.delete(key);
	}

	return cache;
}

/**
 * Resolves an ESPN competitor to a team ID using the in-memory cache.
 */
function resolveCompetitorFromCache(
	cache: Map<string, string>,
	competitor: EspnCompetitor,
): string | null {
	// Try abbreviation, short name, full name — all lowercased
	return (
		cache.get(competitor.team.abbreviation.toLowerCase()) ??
		cache.get(competitor.team.shortDisplayName.toLowerCase()) ??
		cache.get(competitor.team.displayName.toLowerCase()) ??
		null
	);
}

// ---------------------------------------------------------------------------
// Game dedup
// ---------------------------------------------------------------------------

const GAME_TIME_MATCH_WINDOW_SECONDS = 6 * 60 * 60;

async function findExistingGame(
	db: Db,
	homeTeamId: string,
	awayTeamId: string,
	eventTime: number,
	sportTag: string,
	espnEventId: string,
): Promise<{
	id: string;
	is_final: number;
	espn_event_id: string | null;
	season: string | null;
} | null> {
	const windowStart = eventTime - GAME_TIME_MATCH_WINDOW_SECONDS;
	const windowEnd = eventTime + GAME_TIME_MATCH_WINDOW_SECONDS;

	// Preference order matters for doubleheaders, whose two games can carry
	// the SAME listed start time (2026-07-22 BAL@BOS): (1) the row already
	// stamped with THIS event's id — without this, game 2's event keeps
	// matching game 1's row and the claimedByOtherEvent branch creates a
	// fresh duplicate every cycle (the 848-row incident); (2) an unclaimed
	// row (espn_event_id NULL) we can stamp; (3) nearest by time.
	return first<{
		id: string;
		is_final: number;
		espn_event_id: string | null;
		season: string | null;
	}>(
		db,
		`SELECT id, is_final, espn_event_id, season FROM games
		 WHERE sport_tag = ?
		   AND home_team_id = ?
		   AND away_team_id = ?
		   AND game_time BETWEEN ? AND ?
		 ORDER BY IFNULL(espn_event_id = ?, 0) DESC,
		          (espn_event_id IS NULL) DESC,
		          ABS(game_time - ?) ASC
		 LIMIT 1`,
		sportTag,
		homeTeamId,
		awayTeamId,
		windowStart,
		windowEnd,
		espnEventId,
		eventTime,
	);
}

// ---------------------------------------------------------------------------
// Odds ingestion from ESPN summary
// ---------------------------------------------------------------------------

/**
 * For games missing closing lines, fetch DraftKings odds from ESPN's
 * summary endpoint and store as closing lines.
 */
async function ingestOddsForGames(
	db: Db,
	pending: Array<{
		gameId: string;
		espnEventId: string;
		sportTag: string;
		gameTime: number;
	}>,
	result: EspnScheduleIngestionResult,
): Promise<void> {
	if (pending.length === 0) return;

	// Check which games already have closing lines (batched to stay under D1's 999-variable limit)
	const gameIds = pending.map((p) => p.gameId);
	const BATCH_SIZE = 80; // D1 allows max 100 bind params per query
	const closeRecordedAt = new Map<string, number>();
	for (let i = 0; i < gameIds.length; i += BATCH_SIZE) {
		const batch = gameIds.slice(i, i + BATCH_SIZE);
		const placeholders = batch.map(() => "?").join(",");
		const rows = await all<{ game_id: string; recorded_at: number }>(
			db,
			`SELECT game_id, recorded_at FROM game_lines
			 WHERE game_id IN (${placeholders}) AND snapshot_type = 'close'`,
			...batch,
		);
		for (const r of rows) closeRecordedAt.set(r.game_id, r.recorded_at);
	}

	// Fetch when a game has no close row yet, OR once after kickoff when the
	// existing row predates kickoff: ESPN's pickcenter freezes at the closing
	// line once a game starts, so that single refresh replaces the
	// first-observed line (possibly days old) with the true close. The
	// refreshed row gets recorded_at > game_time, so it is never re-fetched.
	// Prioritize by proximity to kickoff rather than sport-loop order:
	// pending is pushed in DEFAULT_SPORT_TAGS order (ncaaf last), so on a
	// ~130-game CFB Saturday the budget would otherwise be consumed by
	// earlier sports and dead retries.
	const nowSec = Math.floor(Date.now() / 1000);
	const needLines = pending
		.filter((p) => {
			const recordedAt = closeRecordedAt.get(p.gameId);
			if (recordedAt === undefined) return true;
			return p.gameTime <= nowSec && recordedAt < p.gameTime;
		})
		.sort(
			(a, b) => Math.abs(a.gameTime - nowSec) - Math.abs(b.gameTime - nowSec),
		)
		.slice(0, MAX_ODDS_FETCHES);

	for (const { gameId, espnEventId, sportTag } of needLines) {
		try {
			const summary = await fetchEspnSummary(sportTag, espnEventId);
			result.espnFetches++;

			const entry = summary ? selectPickcenterEntry(summary) : null;
			if (!entry) continue;

			const homeSpread = entry.spread;
			const totalLine = entry.overUnder;

			// Need at least a spread or total to be useful
			if (homeSpread == null && totalLine == null) continue;

			await upsertGameLine(db, {
				gameId,
				snapshotType: "close",
				source: "espn_draftkings",
				homeSpread: Number.isFinite(homeSpread) ? homeSpread : undefined,
				awaySpread: Number.isFinite(homeSpread) ? -homeSpread : undefined,
				totalLine: Number.isFinite(totalLine) ? totalLine : undefined,
				homeMoneyline: entry.homeTeamOdds?.moneyLine,
				awayMoneyline: entry.awayTeamOdds?.moneyLine,
			});

			result.linesIngested++;
		} catch (err) {
			result.errors++;
			console.warn(
				`[espn-schedule] Error fetching odds for event ${espnEventId}:`,
				err instanceof Error ? err.message : err,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Fetches ESPN scoreboards for a rolling date window across all sport tags
 * and creates/updates canonical games for every event found.
 *
 * After processing all events, fetches DraftKings odds from ESPN's summary
 * endpoint for games missing closing lines.
 *
 * Uses an in-memory team cache to minimize DB queries and stay well within
 * Cloudflare's 1000 subrequest limit.
 */
export async function ingestEspnSchedule(
	db: Db,
	sportTags: string[],
	options?: EspnScheduleOptions,
): Promise<EspnScheduleIngestionResult> {
	const result: EspnScheduleIngestionResult = {
		created: 0,
		matched: 0,
		finalized: 0,
		linesIngested: 0,
		skipped: 0,
		errors: 0,
		espnFetches: 0,
	};

	const lookback = options?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
	const lookahead = options?.lookaheadDays ?? DEFAULT_LOOKAHEAD_DAYS;
	const dates = getDateRange(lookback, lookahead);

	// Pre-load team caches per CANONICAL sport (1 DB query per sport instead
	// of N per event; epl+mls share the "soccer" cache).
	const teamCaches = new Map<string, Map<string, string>>();
	for (const sportTag of sportTags) {
		if (!SPORT_ESPN_MAP[sportTag]) continue;
		const canonicalTag = toCanonicalSportTag(sportTag);
		if (!teamCaches.has(canonicalTag)) {
			teamCaches.set(canonicalTag, await loadTeamCache(db, canonicalTag));
		}
	}

	// Track games that may need odds fetched
	const pendingOdds: Array<{
		gameId: string;
		espnEventId: string;
		sportTag: string;
		gameTime: number;
	}> = [];

	for (const sportTag of sportTags) {
		if (!SPORT_ESPN_MAP[sportTag]) continue;
		const canonicalTag = toCanonicalSportTag(sportTag);
		const cache = teamCaches.get(canonicalTag);
		if (!cache) continue;

		for (const dateStr of dates) {
			const scoreboard = await fetchEspnScoreboard(sportTag, dateStr);
			result.espnFetches++;

			// null = fetch/HTTP failure — count it so an ESPN-side outage shows
			// up in sync-run counts instead of reporting success with zeros
			// (the 2026-08-06 403 outage ran silent for six days this way).
			if (!scoreboard) {
				result.errors++;
				continue;
			}
			if (!scoreboard.events) continue;

			for (const event of scoreboard.events) {
				// ESPN can emit null placeholder entries in the events array
				// (seen 2026-08-15); this loop prefix runs before the per-event
				// try/catch, so an unguarded read here kills the whole step.
				if (!event) continue;
				// Skip preseason/exhibition games (type 1 = preseason, 2 = regular, 3 = postseason)
				if (event.season?.type === 1) continue;

				const comp = event.competitions?.[0];
				if (!comp) continue;

				const espnHome = comp.competitors.find((c) => c.homeAway === "home");
				const espnAway = comp.competitors.find((c) => c.homeAway === "away");
				if (!espnHome || !espnAway) continue;

				try {
					// Resolve teams from cache (no DB queries)
					const homeTeamId = resolveCompetitorFromCache(cache, espnHome);
					const awayTeamId = resolveCompetitorFromCache(cache, espnAway);

					if (!homeTeamId || !awayTeamId) {
						result.skipped++;
						continue;
					}

					// Parse event time
					const eventTimeMs = new Date(comp.startDate).getTime();
					if (!Number.isFinite(eventTimeMs)) {
						result.skipped++;
						continue;
					}
					const eventTime = Math.floor(eventTimeMs / 1000);

					// Check for existing game (1 DB query)
					const existing = await findExistingGame(
						db,
						homeTeamId,
						awayTeamId,
						eventTime,
						canonicalTag,
						event.id,
					);

					let gameId: string;
					let alreadyFinal = false;

					// A nearest game already claimed by a DIFFERENT ESPN event is the
					// other half of a doubleheader — create a separate game row
					// instead of collapsing both events onto one.
					const claimedByOtherEvent =
						existing?.espn_event_id != null &&
						existing.espn_event_id !== event.id;

					const season =
						event.season?.year != null ? String(event.season.year) : undefined;
					const seasonType =
						event.season?.type != null ? String(event.season.type) : undefined;
					const week =
						event.week?.number != null ? String(event.week.number) : undefined;

					if (existing && !claimedByOtherEvent) {
						gameId = existing.id;
						alreadyFinal = existing.is_final === 1;
						result.matched++;
						if (!existing.espn_event_id) {
							await run(
								db,
								`UPDATE games SET espn_event_id = ? WHERE id = ?`,
								event.id,
								gameId,
							);
						}
						// Backfill season metadata on rows created before it was
						// stamped (or created by the Polymarket ingestion path).
						if (existing.season == null && season) {
							await run(
								db,
								`UPDATE games SET season = ?, season_type = ?, week = ? WHERE id = ? AND season IS NULL`,
								season,
								seasonType ?? null,
								week ?? null,
								gameId,
							);
						}
					} else {
						const game = await createGame(db, {
							sportTag: canonicalTag,
							season,
							seasonType,
							week,
							gameTime: eventTime,
							homeTeamId,
							awayTeamId,
							neutralSite: comp.neutralSite ?? false,
						});
						gameId = game.id;
						result.created++;
						await run(
							db,
							`UPDATE games SET espn_event_id = ? WHERE id = ?`,
							event.id,
							gameId,
						);
					}

					// Finalize with scores if completed and not already final
					if (comp.status.type.completed && !alreadyFinal) {
						const homeScore = Number.parseInt(espnHome.score, 10);
						const awayScore = Number.parseInt(espnAway.score, 10);

						if (Number.isFinite(homeScore) && Number.isFinite(awayScore)) {
							await updateGameResult(db, gameId, {
								homeScore,
								awayScore,
								wentToOt: false,
							});
							result.finalized++;
						}
					}

					// Track for odds fetching
					pendingOdds.push({
						gameId,
						espnEventId: event.id,
						sportTag,
						gameTime: eventTime,
					});
				} catch (err) {
					result.errors++;
					console.warn(
						`[espn-schedule] Error processing event for ${sportTag} on ${dateStr}:`,
						err instanceof Error ? err.message : err,
					);
				}
			}
		}
	}

	// Second pass: fetch odds for games missing closing lines
	await ingestOddsForGames(db, pendingOdds, result);

	return result;
}
