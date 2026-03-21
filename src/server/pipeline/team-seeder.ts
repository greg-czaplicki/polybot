/**
 * Team seeding and resolution for canonical team identity.
 *
 * Provides:
 * - TEAM_SEEDS: canonical team data for NFL, NBA, MLB
 * - seedTeamsForSport(): upserts all teams for a sport
 * - resolveTeamFromMarketTitle(): parses team names from market titles
 *   and resolves to canonical team IDs via alias lookup
 */

import type { Db } from "../db/client";
import type { UpsertTeamInput } from "../repositories/teams";
import {
	findTeamByAlias,
	listTeamsBySport,
	upsertTeam,
} from "../repositories/teams";
import type { Team } from "../types/canonical";

// ---------------------------------------------------------------------------
// Seed data — NFL, NBA, MLB
// ---------------------------------------------------------------------------

const NFL_TEAMS: UpsertTeamInput[] = [
	{
		name: "Arizona Cardinals",
		shortName: "Cardinals",
		abbreviation: "ARI",
		sportTag: "nfl",
		aliases: ["Cardinals", "Arizona", "ARI"],
	},
	{
		name: "Atlanta Falcons",
		shortName: "Falcons",
		abbreviation: "ATL",
		sportTag: "nfl",
		aliases: ["Falcons", "Atlanta", "ATL"],
	},
	{
		name: "Baltimore Ravens",
		shortName: "Ravens",
		abbreviation: "BAL",
		sportTag: "nfl",
		aliases: ["Ravens", "Baltimore", "BAL"],
	},
	{
		name: "Buffalo Bills",
		shortName: "Bills",
		abbreviation: "BUF",
		sportTag: "nfl",
		aliases: ["Bills", "Buffalo", "BUF"],
	},
	{
		name: "Carolina Panthers",
		shortName: "Panthers",
		abbreviation: "CAR",
		sportTag: "nfl",
		aliases: ["Panthers", "Carolina", "CAR"],
	},
	{
		name: "Chicago Bears",
		shortName: "Bears",
		abbreviation: "CHI",
		sportTag: "nfl",
		aliases: ["Bears", "Chicago", "CHI"],
	},
	{
		name: "Cincinnati Bengals",
		shortName: "Bengals",
		abbreviation: "CIN",
		sportTag: "nfl",
		aliases: ["Bengals", "Cincinnati", "CIN"],
	},
	{
		name: "Cleveland Browns",
		shortName: "Browns",
		abbreviation: "CLE",
		sportTag: "nfl",
		aliases: ["Browns", "Cleveland", "CLE"],
	},
	{
		name: "Dallas Cowboys",
		shortName: "Cowboys",
		abbreviation: "DAL",
		sportTag: "nfl",
		aliases: ["Cowboys", "Dallas", "DAL"],
	},
	{
		name: "Denver Broncos",
		shortName: "Broncos",
		abbreviation: "DEN",
		sportTag: "nfl",
		aliases: ["Broncos", "Denver", "DEN"],
	},
	{
		name: "Detroit Lions",
		shortName: "Lions",
		abbreviation: "DET",
		sportTag: "nfl",
		aliases: ["Lions", "Detroit", "DET"],
	},
	{
		name: "Green Bay Packers",
		shortName: "Packers",
		abbreviation: "GB",
		sportTag: "nfl",
		aliases: ["Packers", "Green Bay", "GB"],
	},
	{
		name: "Houston Texans",
		shortName: "Texans",
		abbreviation: "HOU",
		sportTag: "nfl",
		aliases: ["Texans", "Houston", "HOU"],
	},
	{
		name: "Indianapolis Colts",
		shortName: "Colts",
		abbreviation: "IND",
		sportTag: "nfl",
		aliases: ["Colts", "Indianapolis", "IND"],
	},
	{
		name: "Jacksonville Jaguars",
		shortName: "Jaguars",
		abbreviation: "JAX",
		sportTag: "nfl",
		aliases: ["Jaguars", "Jacksonville", "JAX"],
	},
	{
		name: "Kansas City Chiefs",
		shortName: "Chiefs",
		abbreviation: "KC",
		sportTag: "nfl",
		aliases: ["Chiefs", "Kansas City", "KC"],
	},
	{
		name: "Las Vegas Raiders",
		shortName: "Raiders",
		abbreviation: "LV",
		sportTag: "nfl",
		aliases: [
			"Raiders",
			"Las Vegas",
			"LV",
			"Las Vegas Raiders",
			"Oakland Raiders",
		],
	},
	{
		name: "Los Angeles Chargers",
		shortName: "Chargers",
		abbreviation: "LAC",
		sportTag: "nfl",
		aliases: ["Chargers", "LA Chargers", "LAC"],
	},
	{
		name: "Los Angeles Rams",
		shortName: "Rams",
		abbreviation: "LAR",
		sportTag: "nfl",
		aliases: ["Rams", "LA Rams", "LAR"],
	},
	{
		name: "Miami Dolphins",
		shortName: "Dolphins",
		abbreviation: "MIA",
		sportTag: "nfl",
		aliases: ["Dolphins", "Miami", "MIA"],
	},
	{
		name: "Minnesota Vikings",
		shortName: "Vikings",
		abbreviation: "MIN",
		sportTag: "nfl",
		aliases: ["Vikings", "Minnesota", "MIN"],
	},
	{
		name: "New England Patriots",
		shortName: "Patriots",
		abbreviation: "NE",
		sportTag: "nfl",
		aliases: ["Patriots", "New England", "NE"],
	},
	{
		name: "New Orleans Saints",
		shortName: "Saints",
		abbreviation: "NO",
		sportTag: "nfl",
		aliases: ["Saints", "New Orleans", "NO"],
	},
	{
		name: "New York Giants",
		shortName: "Giants",
		abbreviation: "NYG",
		sportTag: "nfl",
		aliases: ["Giants", "NY Giants", "NYG"],
	},
	{
		name: "New York Jets",
		shortName: "Jets",
		abbreviation: "NYJ",
		sportTag: "nfl",
		aliases: ["Jets", "NY Jets", "NYJ"],
	},
	{
		name: "Philadelphia Eagles",
		shortName: "Eagles",
		abbreviation: "PHI",
		sportTag: "nfl",
		aliases: ["Eagles", "Philadelphia", "PHI", "Philly"],
	},
	{
		name: "Pittsburgh Steelers",
		shortName: "Steelers",
		abbreviation: "PIT",
		sportTag: "nfl",
		aliases: ["Steelers", "Pittsburgh", "PIT"],
	},
	{
		name: "San Francisco 49ers",
		shortName: "49ers",
		abbreviation: "SF",
		sportTag: "nfl",
		aliases: ["49ers", "San Francisco", "SF", "Niners"],
	},
	{
		name: "Seattle Seahawks",
		shortName: "Seahawks",
		abbreviation: "SEA",
		sportTag: "nfl",
		aliases: ["Seahawks", "Seattle", "SEA"],
	},
	{
		name: "Tampa Bay Buccaneers",
		shortName: "Buccaneers",
		abbreviation: "TB",
		sportTag: "nfl",
		aliases: ["Buccaneers", "Tampa Bay", "TB", "Bucs"],
	},
	{
		name: "Tennessee Titans",
		shortName: "Titans",
		abbreviation: "TEN",
		sportTag: "nfl",
		aliases: ["Titans", "Tennessee", "TEN"],
	},
	{
		name: "Washington Commanders",
		shortName: "Commanders",
		abbreviation: "WAS",
		sportTag: "nfl",
		aliases: ["Commanders", "Washington", "WAS"],
	},
];

const NBA_TEAMS: UpsertTeamInput[] = [
	{
		name: "Atlanta Hawks",
		shortName: "Hawks",
		abbreviation: "ATL",
		sportTag: "nba",
		aliases: ["Hawks", "Atlanta Hawks", "ATL"],
	},
	{
		name: "Boston Celtics",
		shortName: "Celtics",
		abbreviation: "BOS",
		sportTag: "nba",
		aliases: ["Celtics", "Boston Celtics", "BOS"],
	},
	{
		name: "Brooklyn Nets",
		shortName: "Nets",
		abbreviation: "BKN",
		sportTag: "nba",
		aliases: ["Nets", "Brooklyn Nets", "BKN", "Brooklyn"],
	},
	{
		name: "Charlotte Hornets",
		shortName: "Hornets",
		abbreviation: "CHA",
		sportTag: "nba",
		aliases: ["Hornets", "Charlotte Hornets", "CHA", "Charlotte"],
	},
	{
		name: "Chicago Bulls",
		shortName: "Bulls",
		abbreviation: "CHI",
		sportTag: "nba",
		aliases: ["Bulls", "Chicago Bulls", "CHI"],
	},
	{
		name: "Cleveland Cavaliers",
		shortName: "Cavaliers",
		abbreviation: "CLE",
		sportTag: "nba",
		aliases: ["Cavaliers", "Cleveland Cavaliers", "CLE", "Cavs"],
	},
	{
		name: "Dallas Mavericks",
		shortName: "Mavericks",
		abbreviation: "DAL",
		sportTag: "nba",
		aliases: ["Mavericks", "Dallas Mavericks", "DAL", "Mavs"],
	},
	{
		name: "Denver Nuggets",
		shortName: "Nuggets",
		abbreviation: "DEN",
		sportTag: "nba",
		aliases: ["Nuggets", "Denver Nuggets", "DEN"],
	},
	{
		name: "Detroit Pistons",
		shortName: "Pistons",
		abbreviation: "DET",
		sportTag: "nba",
		aliases: ["Pistons", "Detroit Pistons", "DET"],
	},
	{
		name: "Golden State Warriors",
		shortName: "Warriors",
		abbreviation: "GSW",
		sportTag: "nba",
		aliases: ["Warriors", "Golden State Warriors", "GSW", "Golden State"],
	},
	{
		name: "Houston Rockets",
		shortName: "Rockets",
		abbreviation: "HOU",
		sportTag: "nba",
		aliases: ["Rockets", "Houston Rockets", "HOU"],
	},
	{
		name: "Indiana Pacers",
		shortName: "Pacers",
		abbreviation: "IND",
		sportTag: "nba",
		aliases: ["Pacers", "Indiana Pacers", "IND"],
	},
	{
		name: "Los Angeles Clippers",
		shortName: "Clippers",
		abbreviation: "LAC",
		sportTag: "nba",
		aliases: ["Clippers", "LA Clippers", "LAC"],
	},
	{
		name: "Los Angeles Lakers",
		shortName: "Lakers",
		abbreviation: "LAL",
		sportTag: "nba",
		aliases: ["Lakers", "LA Lakers", "LAL"],
	},
	{
		name: "Memphis Grizzlies",
		shortName: "Grizzlies",
		abbreviation: "MEM",
		sportTag: "nba",
		aliases: ["Grizzlies", "Memphis Grizzlies", "MEM"],
	},
	{
		name: "Miami Heat",
		shortName: "Heat",
		abbreviation: "MIA",
		sportTag: "nba",
		aliases: ["Heat", "Miami Heat", "MIA"],
	},
	{
		name: "Milwaukee Bucks",
		shortName: "Bucks",
		abbreviation: "MIL",
		sportTag: "nba",
		aliases: ["Bucks", "Milwaukee Bucks", "MIL"],
	},
	{
		name: "Minnesota Timberwolves",
		shortName: "Timberwolves",
		abbreviation: "MIN",
		sportTag: "nba",
		aliases: ["Timberwolves", "Minnesota Timberwolves", "MIN", "Wolves"],
	},
	{
		name: "New Orleans Pelicans",
		shortName: "Pelicans",
		abbreviation: "NOP",
		sportTag: "nba",
		aliases: ["Pelicans", "New Orleans Pelicans", "NOP", "New Orleans"],
	},
	{
		name: "New York Knicks",
		shortName: "Knicks",
		abbreviation: "NYK",
		sportTag: "nba",
		aliases: ["Knicks", "New York Knicks", "NYK"],
	},
	{
		name: "Oklahoma City Thunder",
		shortName: "Thunder",
		abbreviation: "OKC",
		sportTag: "nba",
		aliases: ["Thunder", "Oklahoma City Thunder", "OKC", "Oklahoma City"],
	},
	{
		name: "Orlando Magic",
		shortName: "Magic",
		abbreviation: "ORL",
		sportTag: "nba",
		aliases: ["Magic", "Orlando Magic", "ORL"],
	},
	{
		name: "Philadelphia 76ers",
		shortName: "76ers",
		abbreviation: "PHI",
		sportTag: "nba",
		aliases: ["76ers", "Philadelphia 76ers", "PHI", "Sixers"],
	},
	{
		name: "Phoenix Suns",
		shortName: "Suns",
		abbreviation: "PHX",
		sportTag: "nba",
		aliases: ["Suns", "Phoenix Suns", "PHX"],
	},
	{
		name: "Portland Trail Blazers",
		shortName: "Trail Blazers",
		abbreviation: "POR",
		sportTag: "nba",
		aliases: ["Trail Blazers", "Portland Trail Blazers", "POR", "Blazers"],
	},
	{
		name: "Sacramento Kings",
		shortName: "Kings",
		abbreviation: "SAC",
		sportTag: "nba",
		aliases: ["Kings", "Sacramento Kings", "SAC"],
	},
	{
		name: "San Antonio Spurs",
		shortName: "Spurs",
		abbreviation: "SAS",
		sportTag: "nba",
		aliases: ["Spurs", "San Antonio Spurs", "SAS"],
	},
	{
		name: "Toronto Raptors",
		shortName: "Raptors",
		abbreviation: "TOR",
		sportTag: "nba",
		aliases: ["Raptors", "Toronto Raptors", "TOR"],
	},
	{
		name: "Utah Jazz",
		shortName: "Jazz",
		abbreviation: "UTA",
		sportTag: "nba",
		aliases: ["Jazz", "Utah Jazz", "UTA"],
	},
	{
		name: "Washington Wizards",
		shortName: "Wizards",
		abbreviation: "WAS",
		sportTag: "nba",
		aliases: ["Wizards", "Washington Wizards", "WAS"],
	},
];

const MLB_TEAMS: UpsertTeamInput[] = [
	{
		name: "Arizona Diamondbacks",
		shortName: "Diamondbacks",
		abbreviation: "ARI",
		sportTag: "mlb",
		aliases: ["Diamondbacks", "Arizona Diamondbacks", "ARI", "D-backs"],
	},
	{
		name: "Atlanta Braves",
		shortName: "Braves",
		abbreviation: "ATL",
		sportTag: "mlb",
		aliases: ["Braves", "Atlanta Braves", "ATL"],
	},
	{
		name: "Baltimore Orioles",
		shortName: "Orioles",
		abbreviation: "BAL",
		sportTag: "mlb",
		aliases: ["Orioles", "Baltimore Orioles", "BAL", "O's"],
	},
	{
		name: "Boston Red Sox",
		shortName: "Red Sox",
		abbreviation: "BOS",
		sportTag: "mlb",
		aliases: ["Red Sox", "Boston Red Sox", "BOS"],
	},
	{
		name: "Chicago Cubs",
		shortName: "Cubs",
		abbreviation: "CHC",
		sportTag: "mlb",
		aliases: ["Cubs", "Chicago Cubs", "CHC"],
	},
	{
		name: "Chicago White Sox",
		shortName: "White Sox",
		abbreviation: "CWS",
		sportTag: "mlb",
		aliases: ["White Sox", "Chicago White Sox", "CWS"],
	},
	{
		name: "Cincinnati Reds",
		shortName: "Reds",
		abbreviation: "CIN",
		sportTag: "mlb",
		aliases: ["Reds", "Cincinnati Reds", "CIN"],
	},
	{
		name: "Cleveland Guardians",
		shortName: "Guardians",
		abbreviation: "CLE",
		sportTag: "mlb",
		aliases: ["Guardians", "Cleveland Guardians", "CLE"],
	},
	{
		name: "Colorado Rockies",
		shortName: "Rockies",
		abbreviation: "COL",
		sportTag: "mlb",
		aliases: ["Rockies", "Colorado Rockies", "COL"],
	},
	{
		name: "Detroit Tigers",
		shortName: "Tigers",
		abbreviation: "DET",
		sportTag: "mlb",
		aliases: ["Tigers", "Detroit Tigers", "DET"],
	},
	{
		name: "Houston Astros",
		shortName: "Astros",
		abbreviation: "HOU",
		sportTag: "mlb",
		aliases: ["Astros", "Houston Astros", "HOU"],
	},
	{
		name: "Kansas City Royals",
		shortName: "Royals",
		abbreviation: "KC",
		sportTag: "mlb",
		aliases: ["Royals", "Kansas City Royals", "KC"],
	},
	{
		name: "Los Angeles Angels",
		shortName: "Angels",
		abbreviation: "LAA",
		sportTag: "mlb",
		aliases: ["Angels", "Los Angeles Angels", "LAA", "LA Angels"],
	},
	{
		name: "Los Angeles Dodgers",
		shortName: "Dodgers",
		abbreviation: "LAD",
		sportTag: "mlb",
		aliases: ["Dodgers", "Los Angeles Dodgers", "LAD", "LA Dodgers"],
	},
	{
		name: "Miami Marlins",
		shortName: "Marlins",
		abbreviation: "MIA",
		sportTag: "mlb",
		aliases: ["Marlins", "Miami Marlins", "MIA"],
	},
	{
		name: "Milwaukee Brewers",
		shortName: "Brewers",
		abbreviation: "MIL",
		sportTag: "mlb",
		aliases: ["Brewers", "Milwaukee Brewers", "MIL"],
	},
	{
		name: "Minnesota Twins",
		shortName: "Twins",
		abbreviation: "MIN",
		sportTag: "mlb",
		aliases: ["Twins", "Minnesota Twins", "MIN"],
	},
	{
		name: "New York Mets",
		shortName: "Mets",
		abbreviation: "NYM",
		sportTag: "mlb",
		aliases: ["Mets", "New York Mets", "NYM", "NY Mets"],
	},
	{
		name: "New York Yankees",
		shortName: "Yankees",
		abbreviation: "NYY",
		sportTag: "mlb",
		aliases: ["Yankees", "New York Yankees", "NYY", "NY Yankees"],
	},
	{
		name: "Oakland Athletics",
		shortName: "Athletics",
		abbreviation: "OAK",
		sportTag: "mlb",
		aliases: ["Athletics", "Oakland Athletics", "OAK", "A's", "Oakland A's"],
	},
	{
		name: "Philadelphia Phillies",
		shortName: "Phillies",
		abbreviation: "PHI",
		sportTag: "mlb",
		aliases: ["Phillies", "Philadelphia Phillies", "PHI"],
	},
	{
		name: "Pittsburgh Pirates",
		shortName: "Pirates",
		abbreviation: "PIT",
		sportTag: "mlb",
		aliases: ["Pirates", "Pittsburgh Pirates", "PIT"],
	},
	{
		name: "San Diego Padres",
		shortName: "Padres",
		abbreviation: "SD",
		sportTag: "mlb",
		aliases: ["Padres", "San Diego Padres", "SD"],
	},
	{
		name: "San Francisco Giants",
		shortName: "Giants",
		abbreviation: "SF",
		sportTag: "mlb",
		aliases: ["Giants", "San Francisco Giants", "SF", "SF Giants"],
	},
	{
		name: "Seattle Mariners",
		shortName: "Mariners",
		abbreviation: "SEA",
		sportTag: "mlb",
		aliases: ["Mariners", "Seattle Mariners", "SEA"],
	},
	{
		name: "St. Louis Cardinals",
		shortName: "Cardinals",
		abbreviation: "STL",
		sportTag: "mlb",
		aliases: [
			"Cardinals",
			"St. Louis Cardinals",
			"STL",
			"Saint Louis Cardinals",
			"St Louis Cardinals",
		],
	},
	{
		name: "Tampa Bay Rays",
		shortName: "Rays",
		abbreviation: "TB",
		sportTag: "mlb",
		aliases: ["Rays", "Tampa Bay Rays", "TB"],
	},
	{
		name: "Texas Rangers",
		shortName: "Rangers",
		abbreviation: "TEX",
		sportTag: "mlb",
		aliases: ["Rangers", "Texas Rangers", "TEX"],
	},
	{
		name: "Toronto Blue Jays",
		shortName: "Blue Jays",
		abbreviation: "TOR",
		sportTag: "mlb",
		aliases: ["Blue Jays", "Toronto Blue Jays", "TOR"],
	},
	{
		name: "Washington Nationals",
		shortName: "Nationals",
		abbreviation: "WSH",
		sportTag: "mlb",
		aliases: ["Nationals", "Washington Nationals", "WSH", "Nats"],
	},
];

/** Seed data for canonical teams, keyed by sport_tag. */
export const TEAM_SEEDS: Record<string, UpsertTeamInput[]> = {
	nfl: NFL_TEAMS,
	nba: NBA_TEAMS,
	mlb: MLB_TEAMS,
};

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export interface SeedResult {
	sportTag: string;
	seeded: number;
	total: number;
}

/**
 * Upserts all canonical teams for a given sport.
 * Safe to call repeatedly — uses ON CONFLICT upsert under the hood.
 */
export async function seedTeamsForSport(
	db: Db,
	sportTag: string,
): Promise<SeedResult> {
	const seeds = TEAM_SEEDS[sportTag];
	if (!seeds) {
		return { sportTag, seeded: 0, total: 0 };
	}

	let seeded = 0;
	for (const seed of seeds) {
		await upsertTeam(db, seed);
		seeded++;
	}

	return { sportTag, seeded, total: seeds.length };
}

/**
 * Seeds all sports that have seed data defined.
 */
export async function seedAllTeams(db: Db): Promise<SeedResult[]> {
	const results: SeedResult[] = [];
	for (const sportTag of Object.keys(TEAM_SEEDS)) {
		const result = await seedTeamsForSport(db, sportTag);
		results.push(result);
	}
	return results;
}

// ---------------------------------------------------------------------------
// Market title parsing → team resolution
// ---------------------------------------------------------------------------

/**
 * Common patterns for extracting team names from Polymarket titles:
 *   "Chiefs -3.5 vs Broncos"
 *   "Lions at Bears"
 *   "Ravens vs. Steelers: Over 47.5"
 *   "Will the Lakers beat the Celtics?"
 */

/** Strips spread/total numbers and common suffixes from a team name fragment. */
function cleanTeamFragment(raw: string): string {
	return raw
		.replace(/[-+]?\d+(\.\d+)?/g, "") // strip numeric values (-3.5, +7, 47.5)
		.replace(/\b(over|under|o\/u|moneyline|ml|spread|pts)\b/gi, "")
		.replace(/[?!:]/g, "")
		.replace(/\bwill\s+the\b/gi, "")
		.replace(/\bbeat\b/gi, "")
		.replace(/\bwin\b/gi, "")
		.trim();
}

/**
 * Parses team name candidates from a market title string.
 * Returns [awayCandidate, homeCandidate] following "Away @ Home" convention.
 * Returns null if the title cannot be parsed into two team candidates.
 */
export function parseTeamsFromTitle(
	title: string,
): { away: string; home: string } | null {
	// Try "Team A at/@ Team B" (away @ home)
	const atMatch = title.match(/^(.+?)\s+(?:at|@)\s+(.+)/i);
	if (atMatch) {
		const away = cleanTeamFragment(atMatch[1]);
		const home = cleanTeamFragment(atMatch[2]);
		if (away && home) return { away, home };
	}

	// Try "Team A vs.? Team B"
	const vsMatch = title.match(/^(.+?)\s+vs\.?\s+(.+)/i);
	if (vsMatch) {
		const teamA = cleanTeamFragment(vsMatch[1]);
		const teamB = cleanTeamFragment(vsMatch[2]);
		if (teamA && teamB) {
			// "vs" convention: first listed is away, second is home
			// (Polymarket typically lists "Away vs Home")
			return { away: teamA, home: teamB };
		}
	}

	return null;
}

export interface ResolvedTeams {
	homeTeam: Team;
	awayTeam: Team;
}

/**
 * Resolves canonical team entities from a market title.
 * Uses alias lookup to match team name fragments.
 *
 * Returns null if either team cannot be resolved.
 * Assumption: Polymarket titles use "Away vs/at Home" ordering.
 */
export async function resolveTeamFromMarketTitle(
	db: Db,
	sportTag: string,
	marketTitle: string,
): Promise<ResolvedTeams | null> {
	const parsed = parseTeamsFromTitle(marketTitle);
	if (!parsed) return null;

	// Try to resolve each candidate via alias matching
	const [awayTeam, homeTeam] = await Promise.all([
		findTeamByAlias(db, sportTag, parsed.away),
		findTeamByAlias(db, sportTag, parsed.home),
	]);

	if (!awayTeam || !homeTeam) return null;
	if (awayTeam.id === homeTeam.id) return null; // ambiguity — same team matched twice

	return { homeTeam, awayTeam };
}

/**
 * Attempts to resolve a single team name from a market title fragment.
 * Tries the full fragment first, then individual words as fallback.
 */
export async function resolveSingleTeam(
	db: Db,
	sportTag: string,
	nameFragment: string,
): Promise<Team | null> {
	// Try exact alias match first
	const exact = await findTeamByAlias(db, sportTag, nameFragment.trim());
	if (exact) return exact;

	// Try individual words (e.g., "Chiefs -3.5" → try "Chiefs")
	const cleaned = cleanTeamFragment(nameFragment);
	if (cleaned !== nameFragment.trim()) {
		const cleanMatch = await findTeamByAlias(db, sportTag, cleaned);
		if (cleanMatch) return cleanMatch;
	}

	// Try each word as a standalone lookup
	const words = cleaned.split(/\s+/).filter((w) => w.length > 2);
	for (const word of words) {
		const match = await findTeamByAlias(db, sportTag, word);
		if (match) return match;
	}

	return null;
}

/**
 * Lists all seeded teams for a sport (delegates to repository).
 */
export async function listSeededTeams(
	db: Db,
	sportTag: string,
): Promise<Team[]> {
	return listTeamsBySport(db, sportTag);
}
