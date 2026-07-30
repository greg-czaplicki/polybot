/**
 * Canonical entity types for team/game/trend analytics.
 *
 * These types map directly to the Phase 2 database tables defined in
 * migrations/0012_add_canonical_entities.sql:
 * - teams: stable team identity + alias normalization
 * - games: schedule, participants, neutral site, final score, season context
 * - game_lines: pregame and closing spread / total / moneyline snapshots
 * - team_game_facts: per-team SU / ATS / OU results and contextual flags
 * - team_trend_snapshots: precomputed rolling splits (last N home fav ATS, etc.)
 */

// ---------------------------------------------------------------------------
// Enums / union types
// ---------------------------------------------------------------------------

/** Venue role for a team in a game */
export type VenueRole = "home" | "away" | "neutral";

/** Favorite / underdog / pick'em classification */
export type FavDogRole = "favorite" | "dog" | "pickem";

/** Bet type classification */
export type BetType = "moneyline" | "spread" | "total" | "future" | "prop";

/** Pick result */
export type PickResult = "win" | "loss" | "push";

/** ATS result */
export type AtsResult = "cover" | "no_cover" | "push";

/** OU result */
export type OuResult = "over" | "under" | "push";

/** Line snapshot timing (game_lines.snapshot_type) */
export type SnapshotType = "open" | "close";

/** Valid snapshot_type values for team_trend_snapshots */
export type TrendSnapshotType =
	| "overall"
	| "home"
	| "away"
	| "favorite"
	| "dog"
	| "home_favorite"
	| "home_dog"
	| "away_favorite"
	| "away_dog";

/** All valid trend snapshot types as a readonly array (useful for validation) */
export const TREND_SNAPSHOT_TYPES: readonly TrendSnapshotType[] = [
	"overall",
	"home",
	"away",
	"favorite",
	"dog",
	"home_favorite",
	"home_dog",
	"away_favorite",
	"away_dog",
] as const;

/** All valid line snapshot types as a readonly array (useful for validation) */
export const SNAPSHOT_TYPES: readonly SnapshotType[] = [
	"open",
	"close",
] as const;

// ---------------------------------------------------------------------------
// teams
// ---------------------------------------------------------------------------

/** Database row for the `teams` table */
export interface TeamRow {
	id: string;
	name: string;
	short_name: string | null;
	abbreviation: string | null;
	sport_tag: string;
	aliases_json: string | null;
	created_at: number;
	updated_at: number;
}

/** Parsed team entity for application use */
export interface Team {
	id: string;
	name: string;
	shortName?: string;
	abbreviation?: string;
	sportTag: string;
	aliases: string[];
	createdAt: number;
	updatedAt: number;
}

// ---------------------------------------------------------------------------
// games
// ---------------------------------------------------------------------------

/** Database row for the `games` table */
export interface GameRow {
	id: string;
	sport_tag: string;
	season: string | null;
	season_type: string | null;
	week: string | null;
	game_time: number | null;
	home_team_id: string;
	away_team_id: string;
	neutral_site: number;
	home_score: number | null;
	away_score: number | null;
	total_score: number | null;
	is_final: number;
	went_to_ot: number;
	created_at: number;
	updated_at: number;
}

/** Parsed game entity for application use */
export interface Game {
	id: string;
	sportTag: string;
	season?: string;
	seasonType?: string;
	week?: string;
	gameTime?: number;
	homeTeamId: string;
	awayTeamId: string;
	neutralSite: boolean;
	homeScore?: number;
	awayScore?: number;
	totalScore?: number;
	isFinal: boolean;
	wentToOt: boolean;
	createdAt: number;
	updatedAt: number;
}

// ---------------------------------------------------------------------------
// game_lines
// ---------------------------------------------------------------------------

/** Database row for the `game_lines` table */
export interface GameLineRow {
	id: string;
	game_id: string;
	source: string;
	snapshot_type: string;
	home_spread: number | null;
	away_spread: number | null;
	total_line: number | null;
	home_moneyline: number | null;
	away_moneyline: number | null;
	recorded_at: number;
	created_at: number;
}

/** Parsed game line entity for application use */
export interface GameLine {
	id: string;
	gameId: string;
	source: string;
	snapshotType: SnapshotType;
	homeSpread?: number;
	awaySpread?: number;
	totalLine?: number;
	homeMoneyline?: number;
	awayMoneyline?: number;
	recordedAt: number;
	createdAt: number;
}

// ---------------------------------------------------------------------------
// team_game_facts
// ---------------------------------------------------------------------------

/** Database row for the `team_game_facts` table */
export interface TeamGameFactRow {
	id: string;
	game_id: string;
	team_id: string;
	opponent_id: string;
	venue_role: string;
	fav_dog_role: string | null;
	team_score: number | null;
	opponent_score: number | null;
	actual_margin: number | null;
	su_result: string | null;
	spread_line: number | null;
	cover_margin: number | null;
	ats_result: string | null;
	total_line: number | null;
	actual_total: number | null;
	ou_result: string | null;
	game_time: number;
	sport_tag: string;
	season: string | null;
	created_at: number;
}

/** Parsed team game fact entity for application use */
export interface TeamGameFact {
	id: string;
	gameId: string;
	teamId: string;
	opponentId: string;
	venueRole: VenueRole;
	favDogRole?: FavDogRole;
	teamScore?: number;
	opponentScore?: number;
	actualMargin?: number;
	suResult?: PickResult;
	spreadLine?: number;
	coverMargin?: number;
	atsResult?: AtsResult;
	totalLine?: number;
	actualTotal?: number;
	ouResult?: OuResult;
	gameTime: number;
	sportTag: string;
	season?: string;
	createdAt: number;
}

// ---------------------------------------------------------------------------
// team_trend_snapshots
// ---------------------------------------------------------------------------

/** Database row for the `team_trend_snapshots` table */
export interface TeamTrendSnapshotRow {
	id: string;
	team_id: string;
	as_of_game_id: string;
	as_of_time: number;
	sport_tag: string;
	snapshot_type: string;
	window_size: number;
	su_wins: number;
	su_losses: number;
	su_pushes: number;
	su_win_pct: number | null;
	ats_wins: number;
	ats_losses: number;
	ats_pushes: number;
	ats_win_pct: number | null;
	ou_overs: number;
	ou_unders: number;
	ou_pushes: number;
	ou_over_pct: number | null;
	ats_streak_type: string | null;
	ats_streak_length: number;
	ou_streak_type: string | null;
	ou_streak_length: number;
	su_streak_type: string | null;
	su_streak_length: number;
	avg_cover_margin: number | null;
	avg_total_margin: number | null;
	created_at: number;
}

/** Parsed team trend snapshot entity for application use */
export interface TeamTrendSnapshot {
	id: string;
	teamId: string;
	asOfGameId: string;
	asOfTime: number;
	sportTag: string;
	snapshotType: TrendSnapshotType;
	windowSize: number;
	suWins: number;
	suLosses: number;
	suPushes: number;
	suWinPct?: number;
	atsWins: number;
	atsLosses: number;
	atsPushes: number;
	atsWinPct?: number;
	ouOvers: number;
	ouUnders: number;
	ouPushes: number;
	ouOverPct?: number;
	atsStreakType?: "W" | "L";
	atsStreakLength: number;
	ouStreakType?: "W" | "L";
	ouStreakLength: number;
	suStreakType?: "W" | "L";
	suStreakLength: number;
	avgCoverMargin?: number;
	avgTotalMargin?: number;
	createdAt: number;
}

// ---------------------------------------------------------------------------
// Query filter types for repository access patterns
// ---------------------------------------------------------------------------

/** Filter for querying team game facts */
export interface TeamGameFactFilter {
	teamId: string;
	sportTag?: string;
	season?: string;
	venueRole?: VenueRole;
	favDogRole?: FavDogRole;
	limit?: number;
	beforeGameTime?: number;
}

/** Filter for querying team trend snapshots */
export interface TeamTrendSnapshotFilter {
	teamId: string;
	sportTag?: string;
	snapshotType?: TrendSnapshotType;
	windowSize?: number;
	/**
	 * Maximum snapshot age in seconds for "latest" lookups. Defaults to 45
	 * days, which spans any in-season gap (all-star breaks, byes) but not an
	 * off-season — without it, week 1 of a new season scores on last season's
	 * final snapshot presented as current. Pass null to disable.
	 */
	maxAgeSeconds?: number | null;
}
