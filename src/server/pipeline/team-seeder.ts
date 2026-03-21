/**
 * Team seeding and resolution for canonical team identity.
 *
 * Provides:
 * - TEAM_SEEDS: canonical team data for NFL, NBA, MLB, NCAAB, NCAAF
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
// Seed data — NFL, NBA, MLB (professional leagues)
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

// ---------------------------------------------------------------------------
// Seed data — NCAAB (college basketball)
// ---------------------------------------------------------------------------

const NCAAB_TEAMS: UpsertTeamInput[] = [
	// ACC
	{
		name: "Duke Blue Devils",
		shortName: "Duke",
		abbreviation: "DUKE",
		sportTag: "ncaab",
		aliases: ["Duke", "Blue Devils", "DUKE"],
	},
	{
		name: "North Carolina Tar Heels",
		shortName: "UNC",
		abbreviation: "UNC",
		sportTag: "ncaab",
		aliases: ["UNC", "North Carolina", "Tar Heels", "Carolina"],
	},
	{
		name: "Virginia Cavaliers",
		shortName: "Virginia",
		abbreviation: "UVA",
		sportTag: "ncaab",
		aliases: ["Virginia", "Cavaliers", "UVA"],
	},
	{
		name: "Louisville Cardinals",
		shortName: "Louisville",
		abbreviation: "LOU",
		sportTag: "ncaab",
		aliases: ["Louisville", "Cardinals", "LOU"],
	},
	{
		name: "Syracuse Orange",
		shortName: "Syracuse",
		abbreviation: "SYR",
		sportTag: "ncaab",
		aliases: ["Syracuse", "Orange", "SYR", "Cuse"],
	},
	{
		name: "Miami Hurricanes",
		shortName: "Miami",
		abbreviation: "MIA",
		sportTag: "ncaab",
		aliases: ["Miami", "Hurricanes", "MIA", "Miami FL"],
	},
	{
		name: "Florida State Seminoles",
		shortName: "Florida State",
		abbreviation: "FSU",
		sportTag: "ncaab",
		aliases: ["Florida State", "Seminoles", "FSU", "Florida St"],
	},
	{
		name: "Clemson Tigers",
		shortName: "Clemson",
		abbreviation: "CLEM",
		sportTag: "ncaab",
		aliases: ["Clemson", "Tigers", "CLEM"],
	},
	{
		name: "NC State Wolfpack",
		shortName: "NC State",
		abbreviation: "NCST",
		sportTag: "ncaab",
		aliases: ["NC State", "Wolfpack", "NCST", "N.C. State"],
	},
	{
		name: "Wake Forest Demon Deacons",
		shortName: "Wake Forest",
		abbreviation: "WAKE",
		sportTag: "ncaab",
		aliases: ["Wake Forest", "Demon Deacons", "WAKE"],
	},
	{
		name: "Pittsburgh Panthers",
		shortName: "Pitt",
		abbreviation: "PITT",
		sportTag: "ncaab",
		aliases: ["Pitt", "Pittsburgh", "Panthers", "PITT"],
	},
	{
		name: "Notre Dame Fighting Irish",
		shortName: "Notre Dame",
		abbreviation: "ND",
		sportTag: "ncaab",
		aliases: ["Notre Dame", "Fighting Irish", "ND"],
	},
	{
		name: "Virginia Tech Hokies",
		shortName: "Virginia Tech",
		abbreviation: "VT",
		sportTag: "ncaab",
		aliases: ["Virginia Tech", "Hokies", "VT", "Va Tech"],
	},
	{
		name: "Georgia Tech Yellow Jackets",
		shortName: "Georgia Tech",
		abbreviation: "GT",
		sportTag: "ncaab",
		aliases: ["Georgia Tech", "Yellow Jackets", "GT", "Ga Tech"],
	},
	{
		name: "Boston College Eagles",
		shortName: "Boston College",
		abbreviation: "BC",
		sportTag: "ncaab",
		aliases: ["Boston College", "Eagles", "BC"],
	},
	{
		name: "SMU Mustangs",
		shortName: "SMU",
		abbreviation: "SMU",
		sportTag: "ncaab",
		aliases: ["SMU", "Mustangs"],
	},
	{
		name: "California Golden Bears",
		shortName: "Cal",
		abbreviation: "CAL",
		sportTag: "ncaab",
		aliases: ["Cal", "California", "Golden Bears", "CAL"],
	},
	{
		name: "Stanford Cardinal",
		shortName: "Stanford",
		abbreviation: "STAN",
		sportTag: "ncaab",
		aliases: ["Stanford", "Cardinal", "STAN"],
	},
	// Big Ten
	{
		name: "Michigan State Spartans",
		shortName: "Michigan State",
		abbreviation: "MSU",
		sportTag: "ncaab",
		aliases: ["Michigan State", "Spartans", "MSU", "Mich St"],
	},
	{
		name: "Michigan Wolverines",
		shortName: "Michigan",
		abbreviation: "MICH",
		sportTag: "ncaab",
		aliases: ["Michigan", "Wolverines", "MICH"],
	},
	{
		name: "Purdue Boilermakers",
		shortName: "Purdue",
		abbreviation: "PUR",
		sportTag: "ncaab",
		aliases: ["Purdue", "Boilermakers", "PUR"],
	},
	{
		name: "Indiana Hoosiers",
		shortName: "Indiana",
		abbreviation: "IND",
		sportTag: "ncaab",
		aliases: ["Indiana", "Hoosiers", "IND"],
	},
	{
		name: "Illinois Fighting Illini",
		shortName: "Illinois",
		abbreviation: "ILL",
		sportTag: "ncaab",
		aliases: ["Illinois", "Fighting Illini", "ILL", "Illini"],
	},
	{
		name: "Iowa Hawkeyes",
		shortName: "Iowa",
		abbreviation: "IOWA",
		sportTag: "ncaab",
		aliases: ["Iowa", "Hawkeyes", "IOWA"],
	},
	{
		name: "Ohio State Buckeyes",
		shortName: "Ohio State",
		abbreviation: "OSU",
		sportTag: "ncaab",
		aliases: ["Ohio State", "Buckeyes", "OSU", "Ohio St"],
	},
	{
		name: "Wisconsin Badgers",
		shortName: "Wisconsin",
		abbreviation: "WIS",
		sportTag: "ncaab",
		aliases: ["Wisconsin", "Badgers", "WIS"],
	},
	{
		name: "Maryland Terrapins",
		shortName: "Maryland",
		abbreviation: "MD",
		sportTag: "ncaab",
		aliases: ["Maryland", "Terrapins", "MD", "Terps"],
	},
	{
		name: "Rutgers Scarlet Knights",
		shortName: "Rutgers",
		abbreviation: "RUT",
		sportTag: "ncaab",
		aliases: ["Rutgers", "Scarlet Knights", "RUT"],
	},
	{
		name: "Penn State Nittany Lions",
		shortName: "Penn State",
		abbreviation: "PSU",
		sportTag: "ncaab",
		aliases: ["Penn State", "Nittany Lions", "PSU", "Penn St"],
	},
	{
		name: "Minnesota Golden Gophers",
		shortName: "Minnesota",
		abbreviation: "MINN",
		sportTag: "ncaab",
		aliases: ["Minnesota", "Golden Gophers", "MINN", "Gophers"],
	},
	{
		name: "Northwestern Wildcats",
		shortName: "Northwestern",
		abbreviation: "NW",
		sportTag: "ncaab",
		aliases: ["Northwestern", "Wildcats", "NW"],
	},
	{
		name: "Nebraska Cornhuskers",
		shortName: "Nebraska",
		abbreviation: "NEB",
		sportTag: "ncaab",
		aliases: ["Nebraska", "Cornhuskers", "NEB"],
	},
	{
		name: "UCLA Bruins",
		shortName: "UCLA",
		abbreviation: "UCLA",
		sportTag: "ncaab",
		aliases: ["UCLA", "Bruins"],
	},
	{
		name: "USC Trojans",
		shortName: "USC",
		abbreviation: "USC",
		sportTag: "ncaab",
		aliases: ["USC", "Trojans", "Southern Cal"],
	},
	{
		name: "Oregon Ducks",
		shortName: "Oregon",
		abbreviation: "ORE",
		sportTag: "ncaab",
		aliases: ["Oregon", "Ducks", "ORE"],
	},
	{
		name: "Washington Huskies",
		shortName: "Washington",
		abbreviation: "WASH",
		sportTag: "ncaab",
		aliases: ["Washington", "Huskies", "WASH", "UW"],
	},
	// Big 12
	{
		name: "Kansas Jayhawks",
		shortName: "Kansas",
		abbreviation: "KU",
		sportTag: "ncaab",
		aliases: ["Kansas", "Jayhawks", "KU", "KAN"],
	},
	{
		name: "Baylor Bears",
		shortName: "Baylor",
		abbreviation: "BAY",
		sportTag: "ncaab",
		aliases: ["Baylor", "Bears", "BAY"],
	},
	{
		name: "Texas Tech Red Raiders",
		shortName: "Texas Tech",
		abbreviation: "TTU",
		sportTag: "ncaab",
		aliases: ["Texas Tech", "Red Raiders", "TTU"],
	},
	{
		name: "Iowa State Cyclones",
		shortName: "Iowa State",
		abbreviation: "ISU",
		sportTag: "ncaab",
		aliases: ["Iowa State", "Cyclones", "ISU", "Iowa St"],
	},
	{
		name: "TCU Horned Frogs",
		shortName: "TCU",
		abbreviation: "TCU",
		sportTag: "ncaab",
		aliases: ["TCU", "Horned Frogs"],
	},
	{
		name: "Kansas State Wildcats",
		shortName: "Kansas State",
		abbreviation: "KSU",
		sportTag: "ncaab",
		aliases: ["Kansas State", "Wildcats", "KSU", "K-State"],
	},
	{
		name: "West Virginia Mountaineers",
		shortName: "West Virginia",
		abbreviation: "WVU",
		sportTag: "ncaab",
		aliases: ["West Virginia", "Mountaineers", "WVU"],
	},
	{
		name: "Oklahoma State Cowboys",
		shortName: "Oklahoma State",
		abbreviation: "OKST",
		sportTag: "ncaab",
		aliases: ["Oklahoma State", "Cowboys", "OKST", "Ok State"],
	},
	{
		name: "BYU Cougars",
		shortName: "BYU",
		abbreviation: "BYU",
		sportTag: "ncaab",
		aliases: ["BYU", "Cougars", "Brigham Young"],
	},
	{
		name: "Cincinnati Bearcats",
		shortName: "Cincinnati",
		abbreviation: "CIN",
		sportTag: "ncaab",
		aliases: ["Cincinnati", "Bearcats", "CIN"],
	},
	{
		name: "Houston Cougars",
		shortName: "Houston",
		abbreviation: "HOU",
		sportTag: "ncaab",
		aliases: ["Houston", "Cougars", "HOU"],
	},
	{
		name: "UCF Knights",
		shortName: "UCF",
		abbreviation: "UCF",
		sportTag: "ncaab",
		aliases: ["UCF", "Knights", "Central Florida"],
	},
	{
		name: "Arizona Wildcats",
		shortName: "Arizona",
		abbreviation: "ARIZ",
		sportTag: "ncaab",
		aliases: ["Arizona", "Wildcats", "ARIZ"],
	},
	{
		name: "Arizona State Sun Devils",
		shortName: "Arizona State",
		abbreviation: "ASU",
		sportTag: "ncaab",
		aliases: ["Arizona State", "Sun Devils", "ASU"],
	},
	{
		name: "Colorado Buffaloes",
		shortName: "Colorado",
		abbreviation: "COLO",
		sportTag: "ncaab",
		aliases: ["Colorado", "Buffaloes", "COLO", "Buffs"],
	},
	{
		name: "Utah Utes",
		shortName: "Utah",
		abbreviation: "UTAH",
		sportTag: "ncaab",
		aliases: ["Utah", "Utes", "UTAH"],
	},
	// SEC
	{
		name: "Kentucky Wildcats",
		shortName: "Kentucky",
		abbreviation: "UK",
		sportTag: "ncaab",
		aliases: ["Kentucky", "Wildcats", "UK"],
	},
	{
		name: "Tennessee Volunteers",
		shortName: "Tennessee",
		abbreviation: "TENN",
		sportTag: "ncaab",
		aliases: ["Tennessee", "Volunteers", "TENN", "Vols"],
	},
	{
		name: "Auburn Tigers",
		shortName: "Auburn",
		abbreviation: "AUB",
		sportTag: "ncaab",
		aliases: ["Auburn", "Tigers", "AUB"],
	},
	{
		name: "Alabama Crimson Tide",
		shortName: "Alabama",
		abbreviation: "BAMA",
		sportTag: "ncaab",
		aliases: ["Alabama", "Crimson Tide", "BAMA", "Bama"],
	},
	{
		name: "Arkansas Razorbacks",
		shortName: "Arkansas",
		abbreviation: "ARK",
		sportTag: "ncaab",
		aliases: ["Arkansas", "Razorbacks", "ARK"],
	},
	{
		name: "LSU Tigers",
		shortName: "LSU",
		abbreviation: "LSU",
		sportTag: "ncaab",
		aliases: ["LSU", "Tigers"],
	},
	{
		name: "Florida Gators",
		shortName: "Florida",
		abbreviation: "FLA",
		sportTag: "ncaab",
		aliases: ["Florida", "Gators", "FLA"],
	},
	{
		name: "Georgia Bulldogs",
		shortName: "Georgia",
		abbreviation: "UGA",
		sportTag: "ncaab",
		aliases: ["Georgia", "Bulldogs", "UGA"],
	},
	{
		name: "Mississippi State Bulldogs",
		shortName: "Mississippi State",
		abbreviation: "MSST",
		sportTag: "ncaab",
		aliases: ["Mississippi State", "Bulldogs", "MSST", "Miss St"],
	},
	{
		name: "Ole Miss Rebels",
		shortName: "Ole Miss",
		abbreviation: "MISS",
		sportTag: "ncaab",
		aliases: ["Ole Miss", "Rebels", "MISS", "Mississippi"],
	},
	{
		name: "Missouri Tigers",
		shortName: "Missouri",
		abbreviation: "MIZ",
		sportTag: "ncaab",
		aliases: ["Missouri", "Tigers", "MIZ", "Mizzou"],
	},
	{
		name: "South Carolina Gamecocks",
		shortName: "South Carolina",
		abbreviation: "SC",
		sportTag: "ncaab",
		aliases: ["South Carolina", "Gamecocks", "SC"],
	},
	{
		name: "Vanderbilt Commodores",
		shortName: "Vanderbilt",
		abbreviation: "VAN",
		sportTag: "ncaab",
		aliases: ["Vanderbilt", "Commodores", "VAN", "Vandy"],
	},
	{
		name: "Texas A&M Aggies",
		shortName: "Texas A&M",
		abbreviation: "TAMU",
		sportTag: "ncaab",
		aliases: ["Texas A&M", "Aggies", "TAMU"],
	},
	{
		name: "Texas Longhorns",
		shortName: "Texas",
		abbreviation: "TEX",
		sportTag: "ncaab",
		aliases: ["Texas", "Longhorns", "TEX"],
	},
	{
		name: "Oklahoma Sooners",
		shortName: "Oklahoma",
		abbreviation: "OU",
		sportTag: "ncaab",
		aliases: ["Oklahoma", "Sooners", "OU"],
	},
	// Notable non-Power 4
	{
		name: "Gonzaga Bulldogs",
		shortName: "Gonzaga",
		abbreviation: "GONZ",
		sportTag: "ncaab",
		aliases: ["Gonzaga", "Bulldogs", "GONZ", "Zags"],
	},
	{
		name: "UConn Huskies",
		shortName: "UConn",
		abbreviation: "CONN",
		sportTag: "ncaab",
		aliases: ["UConn", "Huskies", "CONN", "Connecticut"],
	},
	{
		name: "Creighton Bluejays",
		shortName: "Creighton",
		abbreviation: "CREI",
		sportTag: "ncaab",
		aliases: ["Creighton", "Bluejays", "CREI"],
	},
	{
		name: "Villanova Wildcats",
		shortName: "Villanova",
		abbreviation: "VILL",
		sportTag: "ncaab",
		aliases: ["Villanova", "Wildcats", "VILL", "Nova"],
	},
	{
		name: "Marquette Golden Eagles",
		shortName: "Marquette",
		abbreviation: "MARQ",
		sportTag: "ncaab",
		aliases: ["Marquette", "Golden Eagles", "MARQ"],
	},
	{
		name: "Xavier Musketeers",
		shortName: "Xavier",
		abbreviation: "XAV",
		sportTag: "ncaab",
		aliases: ["Xavier", "Musketeers", "XAV"],
	},
	{
		name: "St. John's Red Storm",
		shortName: "St. John's",
		abbreviation: "SJU",
		sportTag: "ncaab",
		aliases: ["St. John's", "Red Storm", "SJU", "Saint John's"],
	},
	{
		name: "Memphis Tigers",
		shortName: "Memphis",
		abbreviation: "MEM",
		sportTag: "ncaab",
		aliases: ["Memphis", "Tigers", "MEM"],
	},
	{
		name: "San Diego State Aztecs",
		shortName: "San Diego State",
		abbreviation: "SDSU",
		sportTag: "ncaab",
		aliases: ["San Diego State", "Aztecs", "SDSU"],
	},
];

// ---------------------------------------------------------------------------
// Seed data — NCAAF / CFB (college football)
// ---------------------------------------------------------------------------

const NCAAF_TEAMS: UpsertTeamInput[] = [
	// ACC
	{
		name: "Duke Blue Devils",
		shortName: "Duke",
		abbreviation: "DUKE",
		sportTag: "ncaaf",
		aliases: ["Duke", "Blue Devils", "DUKE"],
	},
	{
		name: "North Carolina Tar Heels",
		shortName: "UNC",
		abbreviation: "UNC",
		sportTag: "ncaaf",
		aliases: ["UNC", "North Carolina", "Tar Heels", "Carolina"],
	},
	{
		name: "Clemson Tigers",
		shortName: "Clemson",
		abbreviation: "CLEM",
		sportTag: "ncaaf",
		aliases: ["Clemson", "Tigers", "CLEM"],
	},
	{
		name: "Florida State Seminoles",
		shortName: "Florida State",
		abbreviation: "FSU",
		sportTag: "ncaaf",
		aliases: ["Florida State", "Seminoles", "FSU", "Florida St"],
	},
	{
		name: "Miami Hurricanes",
		shortName: "Miami",
		abbreviation: "MIA",
		sportTag: "ncaaf",
		aliases: ["Miami", "Hurricanes", "MIA", "Miami FL", "The U"],
	},
	{
		name: "NC State Wolfpack",
		shortName: "NC State",
		abbreviation: "NCST",
		sportTag: "ncaaf",
		aliases: ["NC State", "Wolfpack", "NCST", "N.C. State"],
	},
	{
		name: "Louisville Cardinals",
		shortName: "Louisville",
		abbreviation: "LOU",
		sportTag: "ncaaf",
		aliases: ["Louisville", "Cardinals", "LOU"],
	},
	{
		name: "Syracuse Orange",
		shortName: "Syracuse",
		abbreviation: "SYR",
		sportTag: "ncaaf",
		aliases: ["Syracuse", "Orange", "SYR", "Cuse"],
	},
	{
		name: "Virginia Cavaliers",
		shortName: "Virginia",
		abbreviation: "UVA",
		sportTag: "ncaaf",
		aliases: ["Virginia", "Cavaliers", "UVA"],
	},
	{
		name: "Virginia Tech Hokies",
		shortName: "Virginia Tech",
		abbreviation: "VT",
		sportTag: "ncaaf",
		aliases: ["Virginia Tech", "Hokies", "VT", "Va Tech"],
	},
	{
		name: "Pittsburgh Panthers",
		shortName: "Pitt",
		abbreviation: "PITT",
		sportTag: "ncaaf",
		aliases: ["Pitt", "Pittsburgh", "Panthers", "PITT"],
	},
	{
		name: "Wake Forest Demon Deacons",
		shortName: "Wake Forest",
		abbreviation: "WAKE",
		sportTag: "ncaaf",
		aliases: ["Wake Forest", "Demon Deacons", "WAKE"],
	},
	{
		name: "Georgia Tech Yellow Jackets",
		shortName: "Georgia Tech",
		abbreviation: "GT",
		sportTag: "ncaaf",
		aliases: ["Georgia Tech", "Yellow Jackets", "GT", "Ga Tech"],
	},
	{
		name: "Boston College Eagles",
		shortName: "Boston College",
		abbreviation: "BC",
		sportTag: "ncaaf",
		aliases: ["Boston College", "Eagles", "BC"],
	},
	{
		name: "SMU Mustangs",
		shortName: "SMU",
		abbreviation: "SMU",
		sportTag: "ncaaf",
		aliases: ["SMU", "Mustangs"],
	},
	{
		name: "California Golden Bears",
		shortName: "Cal",
		abbreviation: "CAL",
		sportTag: "ncaaf",
		aliases: ["Cal", "California", "Golden Bears", "CAL"],
	},
	{
		name: "Stanford Cardinal",
		shortName: "Stanford",
		abbreviation: "STAN",
		sportTag: "ncaaf",
		aliases: ["Stanford", "Cardinal", "STAN"],
	},
	// Big Ten
	{
		name: "Ohio State Buckeyes",
		shortName: "Ohio State",
		abbreviation: "OSU",
		sportTag: "ncaaf",
		aliases: ["Ohio State", "Buckeyes", "OSU", "Ohio St"],
	},
	{
		name: "Michigan Wolverines",
		shortName: "Michigan",
		abbreviation: "MICH",
		sportTag: "ncaaf",
		aliases: ["Michigan", "Wolverines", "MICH"],
	},
	{
		name: "Michigan State Spartans",
		shortName: "Michigan State",
		abbreviation: "MSU",
		sportTag: "ncaaf",
		aliases: ["Michigan State", "Spartans", "MSU", "Mich St"],
	},
	{
		name: "Penn State Nittany Lions",
		shortName: "Penn State",
		abbreviation: "PSU",
		sportTag: "ncaaf",
		aliases: ["Penn State", "Nittany Lions", "PSU", "Penn St"],
	},
	{
		name: "Wisconsin Badgers",
		shortName: "Wisconsin",
		abbreviation: "WIS",
		sportTag: "ncaaf",
		aliases: ["Wisconsin", "Badgers", "WIS"],
	},
	{
		name: "Iowa Hawkeyes",
		shortName: "Iowa",
		abbreviation: "IOWA",
		sportTag: "ncaaf",
		aliases: ["Iowa", "Hawkeyes", "IOWA"],
	},
	{
		name: "Minnesota Golden Gophers",
		shortName: "Minnesota",
		abbreviation: "MINN",
		sportTag: "ncaaf",
		aliases: ["Minnesota", "Golden Gophers", "MINN", "Gophers"],
	},
	{
		name: "Nebraska Cornhuskers",
		shortName: "Nebraska",
		abbreviation: "NEB",
		sportTag: "ncaaf",
		aliases: ["Nebraska", "Cornhuskers", "NEB"],
	},
	{
		name: "Illinois Fighting Illini",
		shortName: "Illinois",
		abbreviation: "ILL",
		sportTag: "ncaaf",
		aliases: ["Illinois", "Fighting Illini", "ILL", "Illini"],
	},
	{
		name: "Purdue Boilermakers",
		shortName: "Purdue",
		abbreviation: "PUR",
		sportTag: "ncaaf",
		aliases: ["Purdue", "Boilermakers", "PUR"],
	},
	{
		name: "Indiana Hoosiers",
		shortName: "Indiana",
		abbreviation: "IND",
		sportTag: "ncaaf",
		aliases: ["Indiana", "Hoosiers", "IND"],
	},
	{
		name: "Rutgers Scarlet Knights",
		shortName: "Rutgers",
		abbreviation: "RUT",
		sportTag: "ncaaf",
		aliases: ["Rutgers", "Scarlet Knights", "RUT"],
	},
	{
		name: "Northwestern Wildcats",
		shortName: "Northwestern",
		abbreviation: "NW",
		sportTag: "ncaaf",
		aliases: ["Northwestern", "Wildcats", "NW"],
	},
	{
		name: "Maryland Terrapins",
		shortName: "Maryland",
		abbreviation: "MD",
		sportTag: "ncaaf",
		aliases: ["Maryland", "Terrapins", "MD", "Terps"],
	},
	{
		name: "UCLA Bruins",
		shortName: "UCLA",
		abbreviation: "UCLA",
		sportTag: "ncaaf",
		aliases: ["UCLA", "Bruins"],
	},
	{
		name: "USC Trojans",
		shortName: "USC",
		abbreviation: "USC",
		sportTag: "ncaaf",
		aliases: ["USC", "Trojans", "Southern Cal"],
	},
	{
		name: "Oregon Ducks",
		shortName: "Oregon",
		abbreviation: "ORE",
		sportTag: "ncaaf",
		aliases: ["Oregon", "Ducks", "ORE"],
	},
	{
		name: "Washington Huskies",
		shortName: "Washington",
		abbreviation: "WASH",
		sportTag: "ncaaf",
		aliases: ["Washington", "Huskies", "WASH", "UW"],
	},
	// Big 12
	{
		name: "Kansas Jayhawks",
		shortName: "Kansas",
		abbreviation: "KU",
		sportTag: "ncaaf",
		aliases: ["Kansas", "Jayhawks", "KU", "KAN"],
	},
	{
		name: "Kansas State Wildcats",
		shortName: "Kansas State",
		abbreviation: "KSU",
		sportTag: "ncaaf",
		aliases: ["Kansas State", "Wildcats", "KSU", "K-State"],
	},
	{
		name: "Iowa State Cyclones",
		shortName: "Iowa State",
		abbreviation: "ISU",
		sportTag: "ncaaf",
		aliases: ["Iowa State", "Cyclones", "ISU", "Iowa St"],
	},
	{
		name: "Baylor Bears",
		shortName: "Baylor",
		abbreviation: "BAY",
		sportTag: "ncaaf",
		aliases: ["Baylor", "Bears", "BAY"],
	},
	{
		name: "TCU Horned Frogs",
		shortName: "TCU",
		abbreviation: "TCU",
		sportTag: "ncaaf",
		aliases: ["TCU", "Horned Frogs"],
	},
	{
		name: "Texas Tech Red Raiders",
		shortName: "Texas Tech",
		abbreviation: "TTU",
		sportTag: "ncaaf",
		aliases: ["Texas Tech", "Red Raiders", "TTU"],
	},
	{
		name: "West Virginia Mountaineers",
		shortName: "West Virginia",
		abbreviation: "WVU",
		sportTag: "ncaaf",
		aliases: ["West Virginia", "Mountaineers", "WVU"],
	},
	{
		name: "Oklahoma State Cowboys",
		shortName: "Oklahoma State",
		abbreviation: "OKST",
		sportTag: "ncaaf",
		aliases: ["Oklahoma State", "Cowboys", "OKST", "Ok State"],
	},
	{
		name: "BYU Cougars",
		shortName: "BYU",
		abbreviation: "BYU",
		sportTag: "ncaaf",
		aliases: ["BYU", "Cougars", "Brigham Young"],
	},
	{
		name: "Cincinnati Bearcats",
		shortName: "Cincinnati",
		abbreviation: "CIN",
		sportTag: "ncaaf",
		aliases: ["Cincinnati", "Bearcats", "CIN"],
	},
	{
		name: "Houston Cougars",
		shortName: "Houston",
		abbreviation: "HOU",
		sportTag: "ncaaf",
		aliases: ["Houston", "Cougars", "HOU"],
	},
	{
		name: "UCF Knights",
		shortName: "UCF",
		abbreviation: "UCF",
		sportTag: "ncaaf",
		aliases: ["UCF", "Knights", "Central Florida"],
	},
	{
		name: "Arizona Wildcats",
		shortName: "Arizona",
		abbreviation: "ARIZ",
		sportTag: "ncaaf",
		aliases: ["Arizona", "Wildcats", "ARIZ"],
	},
	{
		name: "Arizona State Sun Devils",
		shortName: "Arizona State",
		abbreviation: "ASU",
		sportTag: "ncaaf",
		aliases: ["Arizona State", "Sun Devils", "ASU"],
	},
	{
		name: "Colorado Buffaloes",
		shortName: "Colorado",
		abbreviation: "COLO",
		sportTag: "ncaaf",
		aliases: ["Colorado", "Buffaloes", "COLO", "Buffs"],
	},
	{
		name: "Utah Utes",
		shortName: "Utah",
		abbreviation: "UTAH",
		sportTag: "ncaaf",
		aliases: ["Utah", "Utes", "UTAH"],
	},
	// SEC
	{
		name: "Alabama Crimson Tide",
		shortName: "Alabama",
		abbreviation: "BAMA",
		sportTag: "ncaaf",
		aliases: ["Alabama", "Crimson Tide", "BAMA", "Bama"],
	},
	{
		name: "Georgia Bulldogs",
		shortName: "Georgia",
		abbreviation: "UGA",
		sportTag: "ncaaf",
		aliases: ["Georgia", "Bulldogs", "UGA"],
	},
	{
		name: "LSU Tigers",
		shortName: "LSU",
		abbreviation: "LSU",
		sportTag: "ncaaf",
		aliases: ["LSU", "Tigers"],
	},
	{
		name: "Auburn Tigers",
		shortName: "Auburn",
		abbreviation: "AUB",
		sportTag: "ncaaf",
		aliases: ["Auburn", "Tigers", "AUB"],
	},
	{
		name: "Tennessee Volunteers",
		shortName: "Tennessee",
		abbreviation: "TENN",
		sportTag: "ncaaf",
		aliases: ["Tennessee", "Volunteers", "TENN", "Vols"],
	},
	{
		name: "Florida Gators",
		shortName: "Florida",
		abbreviation: "FLA",
		sportTag: "ncaaf",
		aliases: ["Florida", "Gators", "FLA"],
	},
	{
		name: "Texas A&M Aggies",
		shortName: "Texas A&M",
		abbreviation: "TAMU",
		sportTag: "ncaaf",
		aliases: ["Texas A&M", "Aggies", "TAMU"],
	},
	{
		name: "Texas Longhorns",
		shortName: "Texas",
		abbreviation: "TEX",
		sportTag: "ncaaf",
		aliases: ["Texas", "Longhorns", "TEX"],
	},
	{
		name: "Oklahoma Sooners",
		shortName: "Oklahoma",
		abbreviation: "OU",
		sportTag: "ncaaf",
		aliases: ["Oklahoma", "Sooners", "OU"],
	},
	{
		name: "Ole Miss Rebels",
		shortName: "Ole Miss",
		abbreviation: "MISS",
		sportTag: "ncaaf",
		aliases: ["Ole Miss", "Rebels", "MISS", "Mississippi"],
	},
	{
		name: "Mississippi State Bulldogs",
		shortName: "Mississippi State",
		abbreviation: "MSST",
		sportTag: "ncaaf",
		aliases: ["Mississippi State", "Bulldogs", "MSST", "Miss St"],
	},
	{
		name: "Arkansas Razorbacks",
		shortName: "Arkansas",
		abbreviation: "ARK",
		sportTag: "ncaaf",
		aliases: ["Arkansas", "Razorbacks", "ARK"],
	},
	{
		name: "South Carolina Gamecocks",
		shortName: "South Carolina",
		abbreviation: "SC",
		sportTag: "ncaaf",
		aliases: ["South Carolina", "Gamecocks", "SC"],
	},
	{
		name: "Missouri Tigers",
		shortName: "Missouri",
		abbreviation: "MIZ",
		sportTag: "ncaaf",
		aliases: ["Missouri", "Tigers", "MIZ", "Mizzou"],
	},
	{
		name: "Kentucky Wildcats",
		shortName: "Kentucky",
		abbreviation: "UK",
		sportTag: "ncaaf",
		aliases: ["Kentucky", "Wildcats", "UK"],
	},
	{
		name: "Vanderbilt Commodores",
		shortName: "Vanderbilt",
		abbreviation: "VAN",
		sportTag: "ncaaf",
		aliases: ["Vanderbilt", "Commodores", "VAN", "Vandy"],
	},
	// Notable independents / Group of 5
	{
		name: "Notre Dame Fighting Irish",
		shortName: "Notre Dame",
		abbreviation: "ND",
		sportTag: "ncaaf",
		aliases: ["Notre Dame", "Fighting Irish", "ND"],
	},
	{
		name: "Army Black Knights",
		shortName: "Army",
		abbreviation: "ARMY",
		sportTag: "ncaaf",
		aliases: ["Army", "Black Knights", "ARMY"],
	},
	{
		name: "Navy Midshipmen",
		shortName: "Navy",
		abbreviation: "NAVY",
		sportTag: "ncaaf",
		aliases: ["Navy", "Midshipmen", "NAVY"],
	},
	{
		name: "Boise State Broncos",
		shortName: "Boise State",
		abbreviation: "BSU",
		sportTag: "ncaaf",
		aliases: ["Boise State", "Broncos", "BSU", "Boise"],
	},
	{
		name: "Memphis Tigers",
		shortName: "Memphis",
		abbreviation: "MEM",
		sportTag: "ncaaf",
		aliases: ["Memphis", "Tigers", "MEM"],
	},
	{
		name: "San Diego State Aztecs",
		shortName: "San Diego State",
		abbreviation: "SDSU",
		sportTag: "ncaaf",
		aliases: ["San Diego State", "Aztecs", "SDSU"],
	},
	{
		name: "Liberty Flames",
		shortName: "Liberty",
		abbreviation: "LIB",
		sportTag: "ncaaf",
		aliases: ["Liberty", "Flames", "LIB"],
	},
];

/** Seed data for canonical teams, keyed by sport_tag. */
export const TEAM_SEEDS: Record<string, UpsertTeamInput[]> = {
	nfl: NFL_TEAMS,
	nba: NBA_TEAMS,
	mlb: MLB_TEAMS,
	ncaab: NCAAB_TEAMS,
	ncaaf: NCAAF_TEAMS,
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
