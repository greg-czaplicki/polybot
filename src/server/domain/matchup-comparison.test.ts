import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

import type { Game, Team } from "../types/canonical";
import type {
	ComparisonEdge,
	MatchupComparison,
	MatchupSplitComparison,
	MetricComparison,
} from "./matchup-comparison";
import {
	buildMatchupComparison,
	buildMatchupComparisonByNames,
	buildMatchupComparisonFromGame,
} from "./matchup-comparison";

// ---------------------------------------------------------------------------
// Mock the repository + domain layer
// ---------------------------------------------------------------------------

vi.mock("../repositories/teams", () => ({
	getTeamById: vi.fn(),
	findTeamByAlias: vi.fn(),
}));

vi.mock("../repositories/games", () => ({
	getGameById: vi.fn(),
}));

vi.mock("../repositories/team-trend-snapshots", () => ({
	getLatestTeamTrendSnapshot: vi.fn(),
	getTeamTrendSnapshotAsOf: vi.fn(),
}));

vi.mock("../repositories/team-game-facts", () => ({
	getTeamRecord: vi.fn(),
	getTeamStreak: vi.fn(),
	listTeamGameFacts: vi.fn(),
}));

import { getTeamRecord, getTeamStreak, listTeamGameFacts } from "../repositories/team-game-facts";
import { getLatestTeamTrendSnapshot } from "../repositories/team-trend-snapshots";
import { getGameById } from "../repositories/games";
import { findTeamByAlias, getTeamById } from "../repositories/teams";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const teamA: Team = {
	id: "team_a",
	name: "Michigan",
	sportTag: "ncaaf",
	aliases: ["Michigan", "Wolverines"],
	createdAt: 1700000000,
	updatedAt: 1700000000,
};

const teamB: Team = {
	id: "team_b",
	name: "Ohio State",
	sportTag: "ncaaf",
	aliases: ["Ohio State", "Buckeyes"],
	createdAt: 1700000000,
	updatedAt: 1700000000,
};

const mockGame: Game = {
	id: "game_1",
	sportTag: "ncaaf",
	homeTeamId: "team_a",
	awayTeamId: "team_b",
	neutralSite: false,
	isFinal: true,
	wentToOt: false,
	gameTime: 1700000000,
	createdAt: 1700000000,
	updatedAt: 1700000000,
};

const mockDb = {} as any;

/** Set up mocks so builders return a predictable summary shape */
function setupLiveSummaryMocks(
	record: { wins: number; losses: number; pushes: number; winPct: number | null },
	streak: { type: "W" | "L"; length: number } | null = null,
) {
	(getTeamRecord as Mock).mockResolvedValue(record);
	(getTeamStreak as Mock).mockResolvedValue(streak);
	(listTeamGameFacts as Mock).mockResolvedValue([
		{
			gameTime: 1700000000,
			coverMargin: 3.0,
			actualTotal: 50,
			totalLine: 45,
		},
	]);
}

// ---------------------------------------------------------------------------
// Type structure validation (preserved from original)
// ---------------------------------------------------------------------------

describe("MatchupComparison type contracts", () => {
	it("MetricComparison shape is valid", () => {
		const comparison: MetricComparison = {
			metric: "ats",
			team: { record: "7-3", winPct: 0.7, streak: "W3" },
			opponent: { record: "5-5", winPct: 0.5, streak: "L2" },
			edge: "team",
		};
		expect(comparison.metric).toBe("ats");
		expect(comparison.edge).toBe("team");
		expect(comparison.team.record).toBe("7-3");
	});

	it("ComparisonEdge covers all values", () => {
		const edges: ComparisonEdge[] = ["team", "opponent", "even"];
		expect(edges).toHaveLength(3);
	});

	it("MatchupSplitComparison shape includes team and opponent splits", () => {
		const split: MatchupSplitComparison = {
			teamSplit: {
				snapshotType: "home_favorite",
				label: "Home Favorite",
				summary: null,
			},
			opponentSplit: {
				snapshotType: "away_dog",
				label: "Away Underdog",
				summary: null,
			},
			metrics: [],
		};
		expect(split.teamSplit.snapshotType).toBe("home_favorite");
		expect(split.opponentSplit.snapshotType).toBe("away_dog");
	});

	it("MatchupComparison shape includes headline and splits", () => {
		const comparison: MatchupComparison = {
			team: { id: "t1", name: "Team A", sportTag: "nfl" },
			opponent: { id: "t2", name: "Team B", sportTag: "nfl" },
			splits: [],
			headline: "Team A vs Team B",
		};
		expect(comparison.headline).toBe("Team A vs Team B");
		expect(comparison.splits).toHaveLength(0);
		expect(comparison.game).toBeUndefined();
	});

	it("MatchupComparison can include game context", () => {
		const comparison: MatchupComparison = {
			team: { id: "t1", name: "Team A", sportTag: "nfl" },
			opponent: { id: "t2", name: "Team B", sportTag: "nfl" },
			game: { id: "g1", gameTime: 1700000000, venueInfo: "Team A home" },
			splits: [],
			headline: "Team A vs Team B",
		};
		expect(comparison.game?.id).toBe("g1");
		expect(comparison.game?.venueInfo).toBe("Team A home");
	});
});

// ---------------------------------------------------------------------------
// buildMatchupComparison — behavioral tests
// ---------------------------------------------------------------------------

describe("buildMatchupComparison", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(getLatestTeamTrendSnapshot as Mock).mockResolvedValue(null);
	});

	it("returns null when team is not found", async () => {
		(getTeamById as Mock).mockResolvedValueOnce(null);
		(getTeamById as Mock).mockResolvedValueOnce(teamB);

		const result = await buildMatchupComparison(
			mockDb,
			"nonexistent",
			"team_b",
		);
		expect(result).toBeNull();
	});

	it("returns null when opponent is not found", async () => {
		(getTeamById as Mock).mockResolvedValueOnce(teamA);
		(getTeamById as Mock).mockResolvedValueOnce(null);

		const result = await buildMatchupComparison(
			mockDb,
			"team_a",
			"nonexistent",
		);
		expect(result).toBeNull();
	});

	it("produces overall split comparison by default", async () => {
		(getTeamById as Mock).mockImplementation((_db: any, id: string) =>
			id === "team_a" ? teamA : id === "team_b" ? teamB : null,
		);
		setupLiveSummaryMocks({ wins: 7, losses: 3, pushes: 0, winPct: 0.7 });

		const result = await buildMatchupComparison(
			mockDb,
			"team_a",
			"team_b",
			{ sportTag: "ncaaf" },
		);

		expect(result).not.toBeNull();
		expect(result!.team.name).toBe("Michigan");
		expect(result!.opponent.name).toBe("Ohio State");
		expect(result!.splits.length).toBeGreaterThanOrEqual(1);

		// Should always include overall
		const overallSplit = result!.splits.find(
			(s) => s.teamSplit.snapshotType === "overall",
		);
		expect(overallSplit).toBeDefined();
		expect(overallSplit!.opponentSplit.snapshotType).toBe("overall");
	});

	it("includes correct metric comparisons in each split", async () => {
		(getTeamById as Mock).mockImplementation((_db: any, id: string) =>
			id === "team_a" ? teamA : id === "team_b" ? teamB : null,
		);
		setupLiveSummaryMocks({ wins: 7, losses: 3, pushes: 0, winPct: 0.7 });

		const result = (await buildMatchupComparison(
			mockDb,
			"team_a",
			"team_b",
			{ sportTag: "ncaaf" },
		))!;

		const overallSplit = result.splits.find(
			(s) => s.teamSplit.snapshotType === "overall",
		)!;
		expect(overallSplit.metrics).toHaveLength(3);
		const metricNames = overallSplit.metrics.map((m) => m.metric);
		expect(metricNames).toEqual(["su", "ats", "ou"]);
	});

	it("generates ATS headline from overall split", async () => {
		(getTeamById as Mock).mockImplementation((_db: any, id: string) =>
			id === "team_a" ? teamA : id === "team_b" ? teamB : null,
		);
		setupLiveSummaryMocks({ wins: 7, losses: 3, pushes: 0, winPct: 0.7 });

		const result = (await buildMatchupComparison(
			mockDb,
			"team_a",
			"team_b",
			{ sportTag: "ncaaf" },
		))!;

		expect(result.headline).toContain("Michigan");
		expect(result.headline).toContain("Ohio State");
		expect(result.headline).toContain("ATS");
	});

	it("adds venue-specific splits when teamVenueRole is home", async () => {
		(getTeamById as Mock).mockImplementation((_db: any, id: string) =>
			id === "team_a" ? teamA : id === "team_b" ? teamB : null,
		);
		setupLiveSummaryMocks({ wins: 5, losses: 5, pushes: 0, winPct: 0.5 });

		const result = (await buildMatchupComparison(
			mockDb,
			"team_a",
			"team_b",
			{ sportTag: "ncaaf", teamVenueRole: "home" },
		))!;

		const splitTypes = result.splits.map((s) => s.teamSplit.snapshotType);
		expect(splitTypes).toContain("overall");
		expect(splitTypes).toContain("home");

		// Opponent should get the mirrored split
		const homeSplit = result.splits.find(
			(s) => s.teamSplit.snapshotType === "home",
		)!;
		expect(homeSplit.opponentSplit.snapshotType).toBe("away");
	});

	it("adds combined venue+favdog splits when both are known", async () => {
		(getTeamById as Mock).mockImplementation((_db: any, id: string) =>
			id === "team_a" ? teamA : id === "team_b" ? teamB : null,
		);
		setupLiveSummaryMocks({ wins: 5, losses: 5, pushes: 0, winPct: 0.5 });

		const result = (await buildMatchupComparison(
			mockDb,
			"team_a",
			"team_b",
			{
				sportTag: "ncaaf",
				teamVenueRole: "home",
				teamFavDogRole: "favorite",
			},
		))!;

		const splitTypes = result.splits.map((s) => s.teamSplit.snapshotType);
		expect(splitTypes).toContain("home_favorite");

		const combinedSplit = result.splits.find(
			(s) => s.teamSplit.snapshotType === "home_favorite",
		)!;
		expect(combinedSplit.opponentSplit.snapshotType).toBe("away_dog");
	});

	it("resolves game context for venue roles from gameId", async () => {
		(getTeamById as Mock).mockImplementation((_db: any, id: string) =>
			id === "team_a" ? teamA : id === "team_b" ? teamB : null,
		);
		(getGameById as Mock).mockResolvedValue(mockGame);
		setupLiveSummaryMocks({ wins: 5, losses: 5, pushes: 0, winPct: 0.5 });

		const result = (await buildMatchupComparison(
			mockDb,
			"team_a",
			"team_b",
			{ sportTag: "ncaaf", gameId: "game_1" },
		))!;

		// Should resolve team_a as home since mockGame.homeTeamId === "team_a"
		const splitTypes = result.splits.map((s) => s.teamSplit.snapshotType);
		expect(splitTypes).toContain("home");
		expect(result.game).toBeDefined();
		expect(result.game!.id).toBe("game_1");
	});

	it("metric edge is 'even' when win pcts match", async () => {
		(getTeamById as Mock).mockImplementation((_db: any, id: string) =>
			id === "team_a" ? teamA : id === "team_b" ? teamB : null,
		);
		setupLiveSummaryMocks({ wins: 5, losses: 5, pushes: 0, winPct: 0.5 });

		const result = (await buildMatchupComparison(
			mockDb,
			"team_a",
			"team_b",
			{ sportTag: "ncaaf" },
		))!;

		const overallSplit = result.splits.find(
			(s) => s.teamSplit.snapshotType === "overall",
		)!;
		// Both teams return same mocked record, so edges should be "even"
		for (const metric of overallSplit.metrics) {
			expect(metric.edge).toBe("even");
		}
	});
});

// ---------------------------------------------------------------------------
// buildMatchupComparisonByNames
// ---------------------------------------------------------------------------

describe("buildMatchupComparisonByNames", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(getLatestTeamTrendSnapshot as Mock).mockResolvedValue(null);
	});

	it("returns null when team alias not found", async () => {
		(findTeamByAlias as Mock).mockResolvedValueOnce(null);
		(findTeamByAlias as Mock).mockResolvedValueOnce(teamB);

		const result = await buildMatchupComparisonByNames(
			mockDb,
			"Nonexistent",
			"Ohio State",
			"ncaaf",
		);
		expect(result).toBeNull();
	});

	it("returns null when opponent alias not found", async () => {
		(findTeamByAlias as Mock).mockResolvedValueOnce(teamA);
		(findTeamByAlias as Mock).mockResolvedValueOnce(null);

		const result = await buildMatchupComparisonByNames(
			mockDb,
			"Michigan",
			"Nonexistent",
			"ncaaf",
		);
		expect(result).toBeNull();
	});

	it("resolves both aliases and builds comparison", async () => {
		(findTeamByAlias as Mock).mockImplementation(
			(_db: any, _sport: string, name: string) =>
				name === "Wolverines" ? teamA : name === "Buckeyes" ? teamB : null,
		);
		(getTeamById as Mock).mockImplementation((_db: any, id: string) =>
			id === "team_a" ? teamA : id === "team_b" ? teamB : null,
		);
		setupLiveSummaryMocks({ wins: 5, losses: 5, pushes: 0, winPct: 0.5 });

		const result = await buildMatchupComparisonByNames(
			mockDb,
			"Wolverines",
			"Buckeyes",
			"ncaaf",
		);

		expect(result).not.toBeNull();
		expect(result!.team.name).toBe("Michigan");
		expect(result!.opponent.name).toBe("Ohio State");
	});
});

// ---------------------------------------------------------------------------
// buildMatchupComparisonFromGame
// ---------------------------------------------------------------------------

describe("buildMatchupComparisonFromGame", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(getLatestTeamTrendSnapshot as Mock).mockResolvedValue(null);
	});

	it("returns null when game is not found", async () => {
		(getGameById as Mock).mockResolvedValue(null);

		const result = await buildMatchupComparisonFromGame(
			mockDb,
			"nonexistent_game",
		);
		expect(result).toBeNull();
	});

	it("builds comparison from game with home team as team", async () => {
		(getGameById as Mock).mockResolvedValue(mockGame);
		(getTeamById as Mock).mockImplementation((_db: any, id: string) =>
			id === "team_a" ? teamA : id === "team_b" ? teamB : null,
		);
		setupLiveSummaryMocks({ wins: 5, losses: 5, pushes: 0, winPct: 0.5 });

		const result = (await buildMatchupComparisonFromGame(
			mockDb,
			"game_1",
		))!;

		expect(result.team.id).toBe("team_a");
		expect(result.opponent.id).toBe("team_b");
		// Home team should get home splits
		const splitTypes = result.splits.map((s) => s.teamSplit.snapshotType);
		expect(splitTypes).toContain("home");
	});
});
