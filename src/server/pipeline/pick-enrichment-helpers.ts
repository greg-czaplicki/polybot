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

	// Strategy 2: Direct match by teams + time window. Accept either team
	// orientation (title parses have historically swapped home/away — soccer
	// titles are home-first), prefer the ESPN-linked row when a same-time
	// doubleheader ties on time, then nearest-by-time, then oldest row for
	// determinism.
	if (opts.homeTeamId && opts.awayTeamId && opts.eventTime && opts.sportTag) {
		const windowSeconds = 6 * 60 * 60; // 6 hours
		const row = await first<{ id: string }>(
			db,
			`SELECT id FROM games
			 WHERE sport_tag = ?
			   AND ((home_team_id = ? AND away_team_id = ?)
			     OR (home_team_id = ? AND away_team_id = ?))
			   AND game_time BETWEEN ? AND ?
			 ORDER BY (espn_event_id IS NOT NULL) DESC,
			          ABS(game_time - ?) ASC,
			          created_at ASC
			 LIMIT 1`,
			opts.sportTag,
			opts.homeTeamId,
			opts.awayTeamId,
			opts.awayTeamId,
			opts.homeTeamId,
			opts.eventTime - windowSeconds,
			opts.eventTime + windowSeconds,
			opts.eventTime,
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
 * Side-to-venue conventions differ by market type (verified against live
 * cache rows, 2026-07-23 recon): moneyline titles are "Away vs Home" and
 * side A is the first-listed (away) team, but spread markets set side A to
 * the team NAMED in the title (no venue guarantee), and totals sides are
 * Over/Under — not teams at all. So:
 *
 * 1. Totals (and props) get no team side — callers keep team linkage null.
 * 2. Name matching runs first: a picked label, or the cached label behind a
 *    literal 'a'/'b' side, is substring-matched against the resolved team
 *    names (unambiguous matches only).
 * 3. The positional A→away / B→home fallback applies ONLY to moneyline
 *    markets, where that ordering is empirically verified.
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
	betType?: string | null;
}): {
	teamId: string;
	opponentId: string;
	venueRole: VenueRole;
	isHomeTeam: boolean;
} | null {
	const { pickedLabel, sideALabel, sideBLabel, betType } = opts;

	// Over/Under and prop sides are not teams; fabricating a team link here
	// poisoned venue/fav-dog analytics for every totals pick.
	if (betType === "total" || betType === "prop") return null;

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

	const asHome = {
		teamId: opts.homeTeamId,
		opponentId: opts.awayTeamId,
		venueRole: "home" as VenueRole,
		isHomeTeam: true,
	};
	const asAway = {
		teamId: opts.awayTeamId,
		opponentId: opts.homeTeamId,
		venueRole: "away" as VenueRole,
		isHomeTeam: false,
	};

	// Unambiguous substring match of a label against the two team names.
	const matchByName = (label: string) => {
		const matchesHome = normHome.includes(label) || label.includes(normHome);
		const matchesAway = normAway.includes(label) || label.includes(normAway);
		if (matchesHome && !matchesAway) return asHome;
		if (matchesAway && !matchesHome) return asAway;
		return null;
	};

	// A→away/B→home holds for moneyline title ordering only. betType == null
	// means the caller didn't classify; keep legacy behavior there.
	const positionalAllowed = betType == null || betType === "moneyline";

	for (const normalizedPick of candidateLabels) {
		// Literal stored side: resolve through the cached side label by name,
		// falling back to position only where the ordering is verified.
		if (normalizedPick === "a" || normalizedPick === "b") {
			const sideLabel = normalizedPick === "a" ? normA : normB;
			if (sideLabel) {
				const viaName = matchByName(sideLabel);
				if (viaName) return viaName;
			}
			if (positionalAllowed) {
				return normalizedPick === "a" ? asAway : asHome;
			}
			continue;
		}

		// Direct name match of the picked label itself.
		const viaName = matchByName(normalizedPick);
		if (viaName) return viaName;

		// Label equals a cached side label that couldn't be name-matched
		// (abbreviations etc.): positional mapping only where verified.
		if (positionalAllowed && normA && normB) {
			if (normalizedPick === normA) return asAway;
			if (normalizedPick === normB) return asHome;
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
