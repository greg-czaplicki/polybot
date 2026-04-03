/**
 * Shared enrichment helpers for pick backfill and inline enrichment.
 *
 * These functions are used by both:
 * - pick-backfill.ts (batch backfill of unlinked picks)
 * - manual-picks.ts (inline enrichment on pick creation)
 *
 * Single source of truth for: game matching, line lookups, fact lookups,
 * side label resolution, fav/dog derivation, and picked side resolution.
 */

import type { Db } from "../db/client";
import { first } from "../db/client";
import type { FavDogRole, VenueRole } from "../types/canonical";

// ---------------------------------------------------------------------------
// Game matching
// ---------------------------------------------------------------------------

/**
 * Finds a canonical game matching teams + event time within a 6-hour window.
 */
export async function findGameForPick(
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

// ---------------------------------------------------------------------------
// Line lookups
// ---------------------------------------------------------------------------

/**
 * Looks up spread and total from game_lines (prefers close, falls back to open).
 */
export async function getLineValues(
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

// ---------------------------------------------------------------------------
// Fact lookups
// ---------------------------------------------------------------------------

/**
 * Looks up actual_margin and actual_total from team_game_facts for a given team + game.
 */
export async function getFactValues(
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

// ---------------------------------------------------------------------------
// Side label resolution
// ---------------------------------------------------------------------------

/**
 * Gets side_a_label and side_b_label from sharp_money_cache for a condition.
 * These labels (e.g., "Hornets", "76ers") let us map the picked side to a team.
 */
export async function getSideLabels(
	db: Db,
	conditionId: string,
): Promise<{ sideALabel: string | null; sideBLabel: string | null }> {
	const row = await first<{
		side_a_label: string | null;
		side_b_label: string | null;
	}>(
		db,
		`SELECT side_a_label, side_b_label FROM sharp_money_cache WHERE condition_id = ? LIMIT 1`,
		conditionId,
	);
	return {
		sideALabel: row?.side_a_label ?? null,
		sideBLabel: row?.side_b_label ?? null,
	};
}

// ---------------------------------------------------------------------------
// Pure logic helpers
// ---------------------------------------------------------------------------

/**
 * Derives fav_dog_role from a spread value.
 * Negative home spread = home favorite; positive = home is dog.
 */
export function deriveFavDogRole(
	homeSpread: number | null,
	isHomeTeam: boolean,
): FavDogRole | null {
	if (homeSpread === null) return null;
	if (homeSpread === 0) return "pickem";
	const homeFav = homeSpread < 0;
	if (isHomeTeam) return homeFav ? "favorite" : "dog";
	return homeFav ? "dog" : "favorite";
}

/**
 * Extract the named side from spread titles like:
 * - "PHI vs CHA: Spread: Hornets (-6.5)"
 * - "OAK vs TOR: Spread: Toronto Blue Jays (-1.5)"
 *
 * Returns the team label portion only, or null if not present.
 */
export function extractSpreadPickedLabel(
	marketTitle: string | null,
): string | null {
	if (!marketTitle) return null;

	const match = marketTitle.match(
		/(?:^|:\s*)spread:\s*(.+?)\s*\([-+]?\d+(?:\.\d+)?\)/i,
	);
	if (!match) return null;

	const label = match[1]?.trim();
	return label ? label : null;
}

/**
 * Resolves which team was picked based on the sharp_side label.
 *
 * Strategy:
 * 1. Match picked side / label against side labels from cache
 *    (for these sports markets, side_a tracks the named market side and maps to
 *    the home team in our "Away vs Home" title convention)
 * 2. Substring match against team names (only if unambiguous)
 *
 * Returns null when confidence is insufficient rather than guessing.
 */
export function resolvePickedSide(opts: {
	pickedLabel: string | null;
	marketTitle?: string | null;
	sideALabel: string | null;
	sideBLabel: string | null;
	homeTeamName: string;
	awayTeamName: string;
	homeTeamId: string;
	awayTeamId: string;
}): {
	teamId: string;
	opponentId: string;
	venueRole: VenueRole;
	isHomeTeam: boolean;
} | null {
	const { pickedLabel, sideALabel, sideBLabel } = opts;

	const parsedSpreadLabel = extractSpreadPickedLabel(opts.marketTitle ?? null);
	const candidateLabels = [parsedSpreadLabel, pickedLabel]
		.map((label) => label?.trim().toLowerCase() ?? "")
		.filter(
			(label, index, all) => label.length > 0 && all.indexOf(label) === index,
		);
	if (candidateLabels.length === 0) return null;

	const normHome = opts.homeTeamName.trim().toLowerCase();
	const normAway = opts.awayTeamName.trim().toLowerCase();
	const normA = sideALabel?.trim().toLowerCase() ?? null;
	const normB = sideBLabel?.trim().toLowerCase() ?? null;

	for (const normalizedPick of candidateLabels) {
		// Strategy 1: Directly interpret stored sharp sides.
		if (normalizedPick === "a") {
			return {
				teamId: opts.awayTeamId,
				opponentId: opts.homeTeamId,
				venueRole: "away",
				isHomeTeam: false,
			};
		}
		if (normalizedPick === "b") {
			return {
				teamId: opts.homeTeamId,
				opponentId: opts.awayTeamId,
				venueRole: "home",
				isHomeTeam: true,
			};
		}

		// Strategy 2: Match picked label against side labels from cache.
		if (normA && normB) {
			if (normalizedPick === normA) {
				return {
					teamId: opts.awayTeamId,
					opponentId: opts.homeTeamId,
					venueRole: "away",
					isHomeTeam: false,
				};
			}
			if (normalizedPick === normB) {
				return {
					teamId: opts.homeTeamId,
					opponentId: opts.awayTeamId,
					venueRole: "home",
					isHomeTeam: true,
				};
			}
		}

		// Strategy 3: Direct substring match of picked label against team names.
		// Only assign if exactly one team matches (avoid ambiguity).
		const matchesHome =
			normHome.includes(normalizedPick) || normalizedPick.includes(normHome);
		const matchesAway =
			normAway.includes(normalizedPick) || normalizedPick.includes(normAway);

		if (matchesHome && !matchesAway) {
			return {
				teamId: opts.homeTeamId,
				opponentId: opts.awayTeamId,
				venueRole: "home",
				isHomeTeam: true,
			};
		}
		if (matchesAway && !matchesHome) {
			return {
				teamId: opts.awayTeamId,
				opponentId: opts.homeTeamId,
				venueRole: "away",
				isHomeTeam: false,
			};
		}
	}

	// Ambiguous or no match → skip to avoid poisoning data
	return null;
}

/**
 * Maps a resolved picked team ID back to the home/away side of a known matchup.
 */
export function mapPickedTeamToSide(opts: {
	pickedTeamId: string | null;
	homeTeamId: string;
	awayTeamId: string;
}): {
	teamId: string;
	opponentId: string;
	venueRole: VenueRole;
	isHomeTeam: boolean;
} | null {
	if (!opts.pickedTeamId) return null;
	if (opts.pickedTeamId === opts.homeTeamId) {
		return {
			teamId: opts.homeTeamId,
			opponentId: opts.awayTeamId,
			venueRole: "home",
			isHomeTeam: true,
		};
	}
	if (opts.pickedTeamId === opts.awayTeamId) {
		return {
			teamId: opts.awayTeamId,
			opponentId: opts.homeTeamId,
			venueRole: "away",
			isHomeTeam: false,
		};
	}
	return null;
}
