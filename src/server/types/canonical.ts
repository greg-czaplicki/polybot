/**
 * Canonical entity types for team/game/trend analytics.
 *
 * These types map directly to the Phase 2 database tables:
 * - teams: stable team identity + alias normalization
 * - games: schedule, participants, venue, final score, season context
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

/** Game status lifecycle */
export type GameStatus =
	| "scheduled"
	| "in_progress"
	| "final"
	| "cancelled"
	| "postponed";

/** Pick result */
export type PickResult = "win" | "loss" | "push";

/** ATS result */
export type AtsResult = "cover" | "no_cover" | "push";

/** OU result */
export type OuResult = "over" | "under" | "push";

/** Line type for game_lines */
export type LineType = "spread" | "total" | "moneyline";

/** Line snapshot timing */
export type LineSnapshot = "open" | "close";

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
	external_id: string | null;
	sport_tag: string;
	season: string | null;
	game_date: string;
	home_team_id: string;
	away_team_id: string;
	venue: string | null;
	is_neutral_site: number;
	status: string;
	home_score: number | null;
	away_score: number | null;
	total_score: number | null;
	is_overtime: number;
	created_at: number;
	updated_at: number;
}

/** Parsed game entity for application use */
export interface Game {
	id: string;
	externalId?: string;
	sportTag: string;
	season?: string;
	gameDate: string;
	homeTeamId: string;
	awayTeamId: string;
	venue?: string;
	isNeutralSite: boolean;
	status: GameStatus;
	homeScore?: number;
	awayScore?: number;
	totalScore?: number;
	isOvertime: boolean;
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
	line_type: string;
	snapshot: string;
	home_value: number | null;
	away_value: number | null;
	total_value: number | null;
	source: string | null;
	recorded_at: number;
	created_at: number;
}

/** Parsed game line entity for application use */
export interface GameLine {
	id: string;
	gameId: string;
	lineType: LineType;
	snapshot: LineSnapshot;
	homeValue?: number;
	awayValue?: number;
	totalValue?: number;
	source?: string;
	recordedAt: number;
	createdAt: number;
}

// ---------------------------------------------------------------------------
// team_game_facts
// ---------------------------------------------------------------------------

/** Database row for the `team_game_facts` table */
export interface TeamGameFactRow {
	id: string;
	team_id: string;
	game_id: string;
	opponent_id: string;
	venue_role: string | null;
	fav_dog_role: string | null;
	su_result: string | null;
	ats_result: string | null;
	ou_result: string | null;
	spread_line: number | null;
	total_line: number | null;
	actual_margin: number | null;
	cover_margin: number | null;
	total_margin: number | null;
	team_score: number | null;
	opponent_score: number | null;
	game_date: string;
	sport_tag: string;
	season: string | null;
	created_at: number;
	updated_at: number;
}

/** Parsed team game fact entity for application use */
export interface TeamGameFact {
	id: string;
	teamId: string;
	gameId: string;
	opponentId: string;
	venueRole?: VenueRole;
	favDogRole?: FavDogRole;
	suResult?: PickResult;
	atsResult?: AtsResult;
	ouResult?: OuResult;
	spreadLine?: number;
	totalLine?: number;
	actualMargin?: number;
	coverMargin?: number;
	totalMargin?: number;
	teamScore?: number;
	opponentScore?: number;
	gameDate: string;
	sportTag: string;
	season?: string;
	createdAt: number;
	updatedAt: number;
}

// ---------------------------------------------------------------------------
// team_trend_snapshots
// ---------------------------------------------------------------------------

/** Database row for the `team_trend_snapshots` table */
export interface TeamTrendSnapshotRow {
	id: string;
	team_id: string;
	sport_tag: string;
	season: string | null;
	window_size: number;
	scope: string;
	venue_filter: string | null;
	fav_dog_filter: string | null;
	su_wins: number;
	su_losses: number;
	su_pushes: number;
	su_win_pct: number | null;
	ats_wins: number;
	ats_losses: number;
	ats_pushes: number;
	ats_win_pct: number | null;
	ou_wins: number;
	ou_losses: number;
	ou_pushes: number;
	ou_win_pct: number | null;
	ats_streak_type: string | null;
	ats_streak_length: number;
	ou_streak_type: string | null;
	ou_streak_length: number;
	su_streak_type: string | null;
	su_streak_length: number;
	computed_at: number;
	game_ids_json: string | null;
	created_at: number;
	updated_at: number;
}

/** Parsed team trend snapshot entity for application use */
export interface TeamTrendSnapshot {
	id: string;
	teamId: string;
	sportTag: string;
	season?: string;
	windowSize: number;
	scope: string;
	venueFilter?: VenueRole;
	favDogFilter?: FavDogRole;
	suWins: number;
	suLosses: number;
	suPushes: number;
	suWinPct?: number;
	atsWins: number;
	atsLosses: number;
	atsPushes: number;
	atsWinPct?: number;
	ouWins: number;
	ouLosses: number;
	ouPushes: number;
	ouWinPct?: number;
	atsStreakType?: "W" | "L";
	atsStreakLength: number;
	ouStreakType?: "W" | "L";
	ouStreakLength: number;
	suStreakType?: "W" | "L";
	suStreakLength: number;
	computedAt: number;
	gameIds: string[];
	createdAt: number;
	updatedAt: number;
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
	beforeDate?: string;
}

/** Filter for querying team trend snapshots */
export interface TeamTrendSnapshotFilter {
	teamId: string;
	sportTag?: string;
	season?: string;
	windowSize?: number;
	venueFilter?: VenueRole;
	favDogFilter?: FavDogRole;
}
