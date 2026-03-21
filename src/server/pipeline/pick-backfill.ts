/**
 * Pick backfill — populates manual_picks linkage columns from canonical entities.
 *
 * For each manual_pick, attempts to:
 * 1. Detect bet_type from market title
 * 2. Detect sport_tag from market title / decision_snapshot
 * 3. Resolve team_id / opponent_id from canonical teams via alias lookup
 * 4. Match game_id from canonical games by teams + event_time
 * 5. Copy spread_line / total_line from game_lines
 * 6. Derive venue_role and fav_dog_role from canonical context
 * 7. Copy actual_margin / actual_total from team_game_facts (when available)
 *
 * Assumptions:
 * - decision_snapshot_json may contain eventSlug, marketTitle, eventTime
 * - Side labels from sharp_money_cache are used for team resolution
 * - actual_margin / actual_total will be null for most picks until a score
 *   feed is integrated (known limitation)
 * - The "Away vs Home" convention means side_a = away, side_b = home
 *   for moneyline/spread markets (totals use Over/Under labels)
 */

import type { Db } from "../db/client";
import { all, first, run } from "../db/client";
import { detectBetType } from "@/lib/markets";
import { detectSportTag } from "@/lib/sports";
import { resolveSingleTeam, parseTeamsFromTitle } from "./team-seeder";
import type { FavDogRole, VenueRole } from "../types/canonical";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw manual_picks row (subset of columns needed for backfill). */
interface ManualPickRow {
	id: string;
	condition_id: string;
	market_title: string | null;
	event_time: string | null;
	decision_snapshot_json: string | null;
	game_id: string | null;
	team_id: string | null;
	bet_type: string | null;
	sport_tag: string | null;
}

/** Parsed decision snapshot fields we care about. */
interface DecisionSnapshotFields {
	eventSlug?: string;
	marketTitle?: string;
	eventTime?: string;
	sportSeriesId?: number;
}

/** Result stats for the backfill run. */
export interface BackfillResult {
	total: number;
	updated: number;
	skipped: number;
	errors: number;
	details: Array<{
		pickId: string;
		status: "updated" | "skipped" | "error";
		reason?: string;
		fieldsSet: string[];
	}>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDecisionSnapshot(
	raw: string | null,
): DecisionSnapshotFields | null {
	if (!raw) return null;
	try {
		const obj = JSON.parse(raw) as Record<string, unknown>;
		return {
			eventSlug:
				typeof obj.eventSlug === "string" ? obj.eventSlug : undefined,
			marketTitle:
				typeof obj.marketTitle === "string" ? obj.marketTitle : undefined,
			eventTime:
				typeof obj.eventTime === "string" ? obj.eventTime : undefined,
			sportSeriesId:
				typeof obj.sportSeriesId === "number"
					? obj.sportSeriesId
					: undefined,
		};
	} catch {
		return null;
	}
}

/**
 * Attempts to match a canonical game by event_slug (best) or teams + time (fallback).
 */
async function findGameForPick(
	db: Db,
	opts: {
		eventSlug?: string;
		homeTeamId?: string;
		awayTeamId?: string;
		eventTime?: number;
		sportTag?: string;
	},
): Promise<string | null> {
	// Strategy 1: Match via event_slug in sharp_money_cache → find game by same teams + time
	// (event_slug groups markets for the same game, but games table doesn't store it directly)

	// Strategy 2: Direct match by teams + time window
	if (opts.homeTeamId && opts.awayTeamId && opts.eventTime && opts.sportTag) {
		const windowSeconds = 6 * 60 * 60; // 6 hours
		const row = await first<{ id: string }>(
			db,
			`SELECT id FROM games
			 WHERE sport_tag = ?
			   AND home_team_id = ?
			   AND away_team_id = ?
			   AND game_time BETWEEN ? AND ?
			 LIMIT 1`,
			opts.sportTag,
			opts.homeTeamId,
			opts.awayTeamId,
			opts.eventTime - windowSeconds,
			opts.eventTime + windowSeconds,
		);
		return row?.id ?? null;
	}

	return null;
}

/**
 * Looks up spread and total from game_lines (prefers close, falls back to open).
 */
async function getLineValues(
	db: Db,
	gameId: string,
): Promise<{
	spreadLine: number | null;
	totalLine: number | null;
	homeSpread: number | null;
}> {
	const row = await first<{
		home_spread: number | null;
		total_line: number | null;
	}>(
		db,
		`SELECT home_spread, total_line FROM game_lines
		 WHERE game_id = ?
		 ORDER BY CASE snapshot_type WHEN 'close' THEN 0 ELSE 1 END
		 LIMIT 1`,
		gameId,
	);
	return {
		spreadLine: row?.home_spread ?? null,
		totalLine: row?.total_line ?? null,
		homeSpread: row?.home_spread ?? null,
	};
}

/**
 * Looks up actual_margin and actual_total from team_game_facts for a given team + game.
 */
async function getFactValues(
	db: Db,
	gameId: string,
	teamId: string,
): Promise<{
	actualMargin: number | null;
	actualTotal: number | null;
	venueRole: VenueRole | null;
	favDogRole: FavDogRole | null;
}> {
	const row = await first<{
		actual_margin: number | null;
		actual_total: number | null;
		venue_role: string | null;
		fav_dog_role: string | null;
	}>(
		db,
		`SELECT actual_margin, actual_total, venue_role, fav_dog_role
		 FROM team_game_facts
		 WHERE game_id = ? AND team_id = ?
		 LIMIT 1`,
		gameId,
		teamId,
	);
	return {
		actualMargin: row?.actual_margin ?? null,
		actualTotal: row?.actual_total ?? null,
		venueRole: (row?.venue_role as VenueRole) ?? null,
		favDogRole: (row?.fav_dog_role as FavDogRole) ?? null,
	};
}

/**
 * Derives fav_dog_role from a spread value.
 * Negative home spread = home favorite; positive = home is dog.
 */
function deriveFavDogRole(
	homeSpread: number | null,
	isHomeTeam: boolean,
): FavDogRole | null {
	if (homeSpread === null) return null;
	if (homeSpread === 0) return "pickem";
	const homeFav = homeSpread < 0;
	if (isHomeTeam) return homeFav ? "favorite" : "dog";
	return homeFav ? "dog" : "favorite";
}

// ---------------------------------------------------------------------------
// Main backfill
// ---------------------------------------------------------------------------

/**
 * Backfills linkage columns on manual_picks from canonical entities.
 *
 * Iterates all picks that are missing at least one linkage field and
 * attempts to populate from canonical teams, games, game_lines, and facts.
 */
export async function backfillManualPicks(db: Db): Promise<BackfillResult> {
	const result: BackfillResult = {
		total: 0,
		updated: 0,
		skipped: 0,
		errors: 0,
		details: [],
	};

	// Fetch picks that need backfill (missing bet_type or sport_tag or team_id)
	const picks = await all<ManualPickRow>(
		db,
		`SELECT id, condition_id, market_title, event_time,
		        decision_snapshot_json, game_id, team_id, bet_type, sport_tag
		 FROM manual_picks
		 WHERE bet_type IS NULL
		    OR sport_tag IS NULL
		    OR team_id IS NULL
		 ORDER BY picked_at DESC`,
	);

	result.total = picks.length;

	for (const pick of picks) {
		try {
			const fieldsSet: string[] = [];
			const snapshot = parseDecisionSnapshot(pick.decision_snapshot_json);
			const title =
				pick.market_title ?? snapshot?.marketTitle ?? "";

			if (!title) {
				result.skipped++;
				result.details.push({
					pickId: pick.id,
					status: "skipped",
					reason: "No market title available",
					fieldsSet: [],
				});
				continue;
			}

			// 1. Detect bet_type
			const betType =
				pick.bet_type ??
				detectBetType({ title }) ??
				null;

			// 2. Detect sport_tag
			const sportTag =
				pick.sport_tag ??
				detectSportTag({ title }) ??
				null;

			// 3. Parse team names and resolve IDs
			let teamId = pick.team_id ?? null;
			let opponentId: string | null = null;
			let venueRole: VenueRole | null = null;
			let isHomeTeam = false;

			if (!teamId && sportTag) {
				const parsed = parseTeamsFromTitle(title);
				if (parsed) {
					const homeTeam = await resolveSingleTeam(
						db,
						sportTag,
						parsed.home,
					);
					const awayTeam = await resolveSingleTeam(
						db,
						sportTag,
						parsed.away,
					);

					if (homeTeam && awayTeam) {
						// For spread/ML, the picked team is typically the one with the line
						// For simplicity, default to away team (first listed)
						// unless the title clearly indicates the home team was picked
						teamId = awayTeam.id;
						opponentId = homeTeam.id;
						venueRole = "away";
						isHomeTeam = false;
					}
				}
			}

			// 4. Match game_id
			let gameId = pick.game_id ?? null;
			let eventTimeUnix: number | null = null;

			if (pick.event_time) {
				const parsed = new Date(pick.event_time).getTime();
				if (Number.isFinite(parsed)) {
					eventTimeUnix = Math.floor(parsed / 1000);
				}
			} else if (snapshot?.eventTime) {
				const parsed = new Date(snapshot.eventTime).getTime();
				if (Number.isFinite(parsed)) {
					eventTimeUnix = Math.floor(parsed / 1000);
				}
			}

			if (!gameId && teamId && opponentId && eventTimeUnix && sportTag) {
				// We need home/away IDs for game lookup
				// Default assignment: teamId=away, opponentId=home
				// venueRole may be updated later from facts, but for lookup we use initial assignment
				const homeId = opponentId;
				const awayId = teamId;
				gameId = await findGameForPick(db, {
					eventSlug: snapshot?.eventSlug,
					homeTeamId: homeId,
					awayTeamId: awayId,
					eventTime: eventTimeUnix,
					sportTag,
				});
			}

			// 5. Get line values from game_lines
			let spreadLine: number | null = null;
			let totalLine: number | null = null;
			let homeSpread: number | null = null;

			if (gameId) {
				const lines = await getLineValues(db, gameId);
				spreadLine = lines.spreadLine;
				totalLine = lines.totalLine;
				homeSpread = lines.homeSpread;
			}

			// 6. Get facts (fav_dog_role, venue_role, actual_margin, actual_total)
			let favDogRole: FavDogRole | null = null;
			let actualMargin: number | null = null;
			let actualTotal: number | null = null;
			if (gameId && teamId) {
				const facts = await getFactValues(db, gameId, teamId);
				if (facts.favDogRole) {
					favDogRole = facts.favDogRole;
				}
				if (facts.venueRole) {
					venueRole = facts.venueRole;
					isHomeTeam = venueRole === "home";
				}
				actualMargin = facts.actualMargin;
				actualTotal = facts.actualTotal;
			}
			if (!favDogRole && homeSpread !== null) {
				favDogRole = deriveFavDogRole(homeSpread, isHomeTeam);
			}

			// Build UPDATE SET clauses for non-null values
			const updates: string[] = [];
			const params: unknown[] = [];

			function addField(column: string, value: unknown, label: string) {
				if (value !== null && value !== undefined) {
					updates.push(`${column} = ?`);
					params.push(value);
					fieldsSet.push(label);
				}
			}

			addField("bet_type", betType, "bet_type");
			addField("sport_tag", sportTag, "sport_tag");
			addField("team_id", teamId, "team_id");
			addField("opponent_id", opponentId, "opponent_id");
			addField("game_id", gameId, "game_id");
			addField("venue_role", venueRole, "venue_role");
			addField("fav_dog_role", favDogRole, "fav_dog_role");
			addField("spread_line", spreadLine, "spread_line");
			addField("total_line", totalLine, "total_line");
			addField("actual_margin", actualMargin, "actual_margin");
			addField("actual_total", actualTotal, "actual_total");

			if (updates.length === 0) {
				result.skipped++;
				result.details.push({
					pickId: pick.id,
					status: "skipped",
					reason: "No fields could be derived",
					fieldsSet: [],
				});
				continue;
			}

			params.push(pick.id);
			await run(
				db,
				`UPDATE manual_picks SET ${updates.join(", ")} WHERE id = ?`,
				...params,
			);

			result.updated++;
			result.details.push({
				pickId: pick.id,
				status: "updated",
				fieldsSet,
			});
		} catch (err) {
			result.errors++;
			result.details.push({
				pickId: pick.id,
				status: "error",
				reason: err instanceof Error ? err.message : String(err),
				fieldsSet: [],
			});
		}
	}

	return result;
}
