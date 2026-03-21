import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	Team,
	TeamTrendSnapshot,
	TrendSnapshotType,
} from "../types/canonical";
import {
	buildTeamTrendSummary,
	buildTeamTrendSummaryByName,
	getRecentFactsForSplit,
	snapshotTypeLabel,
	splitFiltersForSnapshotType,
} from "./trend-summary";

// ---------------------------------------------------------------------------
// Mock the repository layer
// ---------------------------------------------------------------------------

vi.mock("../repositories/teams", () => ({
	getTeamById: vi.fn(),
	findTeamByAlias: vi.fn(),
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
import {
	getLatestTeamTrendSnapshot,
	getTeamTrendSnapshotAsOf,
} from "../repositories/team-trend-snapshots";
import { findTeamByAlias, getTeamById } from "../repositories/teams";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const mockTeam: Team = {
	id: "team_mich",
	name: "Michigan",
	sportTag: "ncaaf",
	aliases: ["Michigan", "Wolverines"],
	createdAt: 1700000000,
	updatedAt: 1700000000,
};

const mockSnapshot: TeamTrendSnapshot = {
	id: "snap_1",
	teamId: "team_mich",
	asOfGameId: "game_100",
	asOfTime: 1700000000,
	sportTag: "ncaaf",
	snapshotType: "home_favorite",
	windowSize: 10,
	suWins: 8,
	suLosses: 2,
	suPushes: 0,
	suWinPct: 0.8,
	atsWins: 7,
	atsLosses: 3,
	atsPushes: 0,
	atsWinPct: 0.7,
	ouOvers: 5,
	ouUnders: 4,
	ouPushes: 1,
	ouOverPct: 0.5,
	suStreakType: "W",
	suStreakLength: 5,
	atsStreakType: "W",
	atsStreakLength: 3,
	ouStreakType: "L",
	ouStreakLength: 2,
	avgCoverMargin: 4.5,
	avgTotalMargin: -1.2,
	createdAt: 1700000000,
};

const mockDb = {} as any;

// ---------------------------------------------------------------------------
// snapshotTypeLabel
// ---------------------------------------------------------------------------

describe("snapshotTypeLabel", () => {
	it("returns human-readable labels for all snapshot types", () => {
		expect(snapshotTypeLabel("overall")).toBe("Overall");
		expect(snapshotTypeLabel("home")).toBe("Home");
		expect(snapshotTypeLabel("away")).toBe("Away");
		expect(snapshotTypeLabel("favorite")).toBe("Favorite");
		expect(snapshotTypeLabel("dog")).toBe("Underdog");
		expect(snapshotTypeLabel("home_favorite")).toBe("Home Favorite");
		expect(snapshotTypeLabel("home_dog")).toBe("Home Underdog");
		expect(snapshotTypeLabel("away_favorite")).toBe("Away Favorite");
		expect(snapshotTypeLabel("away_dog")).toBe("Away Underdog");
	});
});

// ---------------------------------------------------------------------------
// splitFiltersForSnapshotType
// ---------------------------------------------------------------------------

describe("splitFiltersForSnapshotType", () => {
	it("returns empty filters for overall", () => {
		expect(splitFiltersForSnapshotType("overall")).toEqual({});
	});

	it("returns venueRole for home/away", () => {
		expect(splitFiltersForSnapshotType("home")).toEqual({
			venueRole: "home",
		});
		expect(splitFiltersForSnapshotType("away")).toEqual({
			venueRole: "away",
		});
	});

	it("returns favDogRole for favorite/dog", () => {
		expect(splitFiltersForSnapshotType("favorite")).toEqual({
			favDogRole: "favorite",
		});
		expect(splitFiltersForSnapshotType("dog")).toEqual({
			favDogRole: "dog",
		});
	});

	it("returns both venueRole and favDogRole for combined splits", () => {
		expect(splitFiltersForSnapshotType("home_favorite")).toEqual({
			venueRole: "home",
			favDogRole: "favorite",
		});
		expect(splitFiltersForSnapshotType("home_dog")).toEqual({
			venueRole: "home",
			favDogRole: "dog",
		});
		expect(splitFiltersForSnapshotType("away_favorite")).toEqual({
			venueRole: "away",
			favDogRole: "favorite",
		});
		expect(splitFiltersForSnapshotType("away_dog")).toEqual({
			venueRole: "away",
			favDogRole: "dog",
		});
	});

	it("covers all 9 snapshot types", () => {
		const allTypes: TrendSnapshotType[] = [
			"overall",
			"home",
			"away",
			"favorite",
			"dog",
			"home_favorite",
			"home_dog",
			"away_favorite",
			"away_dog",
		];
		for (const type of allTypes) {
			const result = splitFiltersForSnapshotType(type);
			expect(result).toBeDefined();
		}
	});
});

// ---------------------------------------------------------------------------
// buildTeamTrendSummary — precomputed snapshot path
// ---------------------------------------------------------------------------

describe("buildTeamTrendSummary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns null when team is not found", async () => {
		(getTeamById as Mock).mockResolvedValue(null);

		const result = await buildTeamTrendSummary(
			mockDb,
			"nonexistent",
			"overall",
		);
		expect(result).toBeNull();
	});

	describe("precomputed snapshot path", () => {
		it("builds summary from precomputed snapshot", async () => {
			(getTeamById as Mock).mockResolvedValue(mockTeam);
			(getLatestTeamTrendSnapshot as Mock).mockResolvedValue(mockSnapshot);

			const result = await buildTeamTrendSummary(
				mockDb,
				"team_mich",
				"home_favorite",
			);

			expect(result).not.toBeNull();
			const summary = result!;
			expect(summary.snapshotSource).toBe("precomputed");
			expect(summary.team.id).toBe("team_mich");
			expect(summary.team.name).toBe("Michigan");
			expect(summary.split.snapshotType).toBe("home_favorite");
			expect(summary.split.label).toBe("Home Favorite");
			expect(summary.split.venueRole).toBe("home");
			expect(summary.split.favDogRole).toBe("favorite");
			expect(summary.window).toBe(10);
		});

		it("formats SU record correctly from snapshot", async () => {
			(getTeamById as Mock).mockResolvedValue(mockTeam);
			(getLatestTeamTrendSnapshot as Mock).mockResolvedValue(mockSnapshot);

			const result = (await buildTeamTrendSummary(
				mockDb,
				"team_mich",
				"home_favorite",
			))!;

			expect(result.su.record.wins).toBe(8);
			expect(result.su.record.losses).toBe(2);
			expect(result.su.record.pushes).toBe(0);
			expect(result.su.record.winPct).toBe(0.8);
			expect(result.su.record.display).toBe("8-2");
		});

		it("formats ATS record and streak correctly", async () => {
			(getTeamById as Mock).mockResolvedValue(mockTeam);
			(getLatestTeamTrendSnapshot as Mock).mockResolvedValue(mockSnapshot);

			const result = (await buildTeamTrendSummary(
				mockDb,
				"team_mich",
				"home_favorite",
			))!;

			expect(result.ats.record.wins).toBe(7);
			expect(result.ats.record.losses).toBe(3);
			expect(result.ats.record.display).toBe("7-3");
			expect(result.ats.streak).toEqual({
				type: "W",
				length: 3,
				display: "W3",
			});
			expect(result.ats.avgCoverMargin).toBe(4.5);
		});

		it("formats OU record correctly", async () => {
			(getTeamById as Mock).mockResolvedValue(mockTeam);
			(getLatestTeamTrendSnapshot as Mock).mockResolvedValue(mockSnapshot);

			const result = (await buildTeamTrendSummary(
				mockDb,
				"team_mich",
				"home_favorite",
			))!;

			// OU uses overs/unders naming
			expect(result.ou.record.wins).toBe(5);
			expect(result.ou.record.losses).toBe(4);
			expect(result.ou.record.pushes).toBe(1);
			expect(result.ou.record.display).toBe("5-4-1");
			expect(result.ou.avgTotalMargin).toBe(-1.2);
		});

		it("display format omits pushes when zero", async () => {
			(getTeamById as Mock).mockResolvedValue(mockTeam);
			(getLatestTeamTrendSnapshot as Mock).mockResolvedValue(mockSnapshot);

			const result = (await buildTeamTrendSummary(
				mockDb,
				"team_mich",
				"home_favorite",
			))!;

			// SU has 0 pushes → "8-2" not "8-2-0"
			expect(result.su.record.display).toBe("8-2");
			// OU has 1 push → "5-4-1"
			expect(result.ou.record.display).toBe("5-4-1");
		});

		it("returns null streaks when snapshot has no streak data", async () => {
			const noStreakSnapshot: TeamTrendSnapshot = {
				...mockSnapshot,
				suStreakType: undefined,
				suStreakLength: 0,
				atsStreakType: undefined,
				atsStreakLength: 0,
				ouStreakType: undefined,
				ouStreakLength: 0,
			};
			(getTeamById as Mock).mockResolvedValue(mockTeam);
			(getLatestTeamTrendSnapshot as Mock).mockResolvedValue(noStreakSnapshot);

			const result = (await buildTeamTrendSummary(
				mockDb,
				"team_mich",
				"overall",
			))!;

			expect(result.su.streak).toBeNull();
			expect(result.ats.streak).toBeNull();
			expect(result.ou.streak).toBeNull();
		});

		it("uses asOfTime to fetch point-in-time snapshot", async () => {
			(getTeamById as Mock).mockResolvedValue(mockTeam);
			(getTeamTrendSnapshotAsOf as Mock).mockResolvedValue(mockSnapshot);

			await buildTeamTrendSummary(mockDb, "team_mich", "overall", {
				asOfTime: 1690000000,
			});

			expect(getTeamTrendSnapshotAsOf).toHaveBeenCalledWith(
				mockDb,
				"team_mich",
				"overall",
				1690000000,
			);
			expect(getLatestTeamTrendSnapshot).not.toHaveBeenCalled();
		});
	});

	describe("live computation fallback", () => {
		beforeEach(() => {
			(getTeamById as Mock).mockResolvedValue(mockTeam);
			(getLatestTeamTrendSnapshot as Mock).mockResolvedValue(null);
		});

		it("falls back to live computation when no snapshot exists", async () => {
			(getTeamRecord as Mock).mockResolvedValue({
				wins: 6,
				losses: 3,
				pushes: 1,
				winPct: 0.6,
			});
			(getTeamStreak as Mock).mockResolvedValue({
				type: "L",
				length: 2,
			});
			(listTeamGameFacts as Mock).mockResolvedValue([
				{
					gameTime: 1700000000,
					coverMargin: 3.5,
					actualTotal: 45,
					totalLine: 42.5,
				},
				{
					gameTime: 1699900000,
					coverMargin: -2,
					actualTotal: 50,
					totalLine: 48,
				},
			]);

			const result = (await buildTeamTrendSummary(
				mockDb,
				"team_mich",
				"overall",
			))!;

			expect(result.snapshotSource).toBe("live");
			expect(result.su.record.wins).toBe(6);
			expect(result.su.record.losses).toBe(3);
			expect(result.su.record.pushes).toBe(1);
			expect(result.su.record.display).toBe("6-3-1");
		});

		it("computes average cover margin from facts", async () => {
			(getTeamRecord as Mock).mockResolvedValue({
				wins: 2,
				losses: 0,
				pushes: 0,
				winPct: 1.0,
			});
			(getTeamStreak as Mock).mockResolvedValue(null);
			(listTeamGameFacts as Mock).mockResolvedValue([
				{
					gameTime: 1700000000,
					coverMargin: 4.0,
					actualTotal: null,
					totalLine: null,
				},
				{
					gameTime: 1699900000,
					coverMargin: 6.0,
					actualTotal: null,
					totalLine: null,
				},
			]);

			const result = (await buildTeamTrendSummary(
				mockDb,
				"team_mich",
				"overall",
			))!;

			expect(result.ats.avgCoverMargin).toBe(5.0);
		});

		it("computes average total margin from facts", async () => {
			(getTeamRecord as Mock).mockResolvedValue({
				wins: 2,
				losses: 0,
				pushes: 0,
				winPct: 1.0,
			});
			(getTeamStreak as Mock).mockResolvedValue(null);
			(listTeamGameFacts as Mock).mockResolvedValue([
				{
					gameTime: 1700000000,
					coverMargin: null,
					actualTotal: 50,
					totalLine: 45,
				},
				{
					gameTime: 1699900000,
					coverMargin: null,
					actualTotal: 40,
					totalLine: 45,
				},
			]);

			const result = (await buildTeamTrendSummary(
				mockDb,
				"team_mich",
				"overall",
			))!;

			// (50-45 + 40-45) / 2 = (5 + -5) / 2 = 0
			expect(result.ou.avgTotalMargin).toBe(0);
		});

		it("returns null margins when no valid data in facts", async () => {
			(getTeamRecord as Mock).mockResolvedValue({
				wins: 0,
				losses: 0,
				pushes: 0,
				winPct: null,
			});
			(getTeamStreak as Mock).mockResolvedValue(null);
			(listTeamGameFacts as Mock).mockResolvedValue([]);

			const result = (await buildTeamTrendSummary(
				mockDb,
				"team_mich",
				"overall",
			))!;

			expect(result.ats.avgCoverMargin).toBeNull();
			expect(result.ou.avgTotalMargin).toBeNull();
			expect(result.asOfTime).toBeNull();
		});

		it("passes correct filters for combined split type", async () => {
			(getTeamRecord as Mock).mockResolvedValue({
				wins: 0,
				losses: 0,
				pushes: 0,
				winPct: null,
			});
			(getTeamStreak as Mock).mockResolvedValue(null);
			(listTeamGameFacts as Mock).mockResolvedValue([]);

			await buildTeamTrendSummary(mockDb, "team_mich", "away_dog");

			// Verify filters passed to repository calls include venue + favDog
			expect(getTeamRecord).toHaveBeenCalledWith(
				mockDb,
				"team_mich",
				"su",
				expect.objectContaining({
					venueRole: "away",
					favDogRole: "dog",
				}),
			);
			expect(listTeamGameFacts).toHaveBeenCalledWith(
				mockDb,
				expect.objectContaining({
					teamId: "team_mich",
					venueRole: "away",
					favDogRole: "dog",
				}),
			);
		});

		it("uses custom window size", async () => {
			(getTeamRecord as Mock).mockResolvedValue({
				wins: 0,
				losses: 0,
				pushes: 0,
				winPct: null,
			});
			(getTeamStreak as Mock).mockResolvedValue(null);
			(listTeamGameFacts as Mock).mockResolvedValue([]);

			const result = (await buildTeamTrendSummary(
				mockDb,
				"team_mich",
				"overall",
				{ window: 5 },
			))!;

			expect(result.window).toBe(5);
			expect(getTeamRecord).toHaveBeenCalledWith(
				mockDb,
				"team_mich",
				"su",
				expect.objectContaining({ limit: 5 }),
			);
		});

		it("uses asOfTime from most recent fact", async () => {
			(getTeamRecord as Mock).mockResolvedValue({
				wins: 1,
				losses: 0,
				pushes: 0,
				winPct: 1.0,
			});
			(getTeamStreak as Mock).mockResolvedValue(null);
			(listTeamGameFacts as Mock).mockResolvedValue([
				{
					gameTime: 1700050000,
					coverMargin: null,
					actualTotal: null,
					totalLine: null,
				},
			]);

			const result = (await buildTeamTrendSummary(
				mockDb,
				"team_mich",
				"overall",
			))!;

			expect(result.asOfTime).toBe(1700050000);
		});
	});
});

// ---------------------------------------------------------------------------
// buildTeamTrendSummaryByName
// ---------------------------------------------------------------------------

describe("buildTeamTrendSummaryByName", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns null when team alias is not found", async () => {
		(findTeamByAlias as Mock).mockResolvedValue(null);

		const result = await buildTeamTrendSummaryByName(
			mockDb,
			"Nonexistent",
			"ncaaf",
			"overall",
		);
		expect(result).toBeNull();
		expect(findTeamByAlias).toHaveBeenCalledWith(
			mockDb,
			"ncaaf",
			"Nonexistent",
		);
	});

	it("resolves alias and delegates to buildTeamTrendSummary", async () => {
		(findTeamByAlias as Mock).mockResolvedValue(mockTeam);
		(getTeamById as Mock).mockResolvedValue(mockTeam);
		(getLatestTeamTrendSnapshot as Mock).mockResolvedValue(mockSnapshot);

		const result = await buildTeamTrendSummaryByName(
			mockDb,
			"Wolverines",
			"ncaaf",
			"home_favorite",
		);

		expect(result).not.toBeNull();
		expect(result!.team.name).toBe("Michigan");
		expect(result!.split.snapshotType).toBe("home_favorite");
	});
});

// ---------------------------------------------------------------------------
// getRecentFactsForSplit
// ---------------------------------------------------------------------------

describe("getRecentFactsForSplit", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("passes correct filters for the snapshot type", async () => {
		(listTeamGameFacts as Mock).mockResolvedValue([]);

		await getRecentFactsForSplit(mockDb, "team_mich", "home_dog", {
			sportTag: "ncaaf",
			limit: 5,
		});

		expect(listTeamGameFacts).toHaveBeenCalledWith(mockDb, {
			teamId: "team_mich",
			sportTag: "ncaaf",
			venueRole: "home",
			favDogRole: "dog",
			limit: 5,
		});
	});

	it("defaults to limit of 10", async () => {
		(listTeamGameFacts as Mock).mockResolvedValue([]);

		await getRecentFactsForSplit(mockDb, "team_mich", "overall");

		expect(listTeamGameFacts).toHaveBeenCalledWith(mockDb, {
			teamId: "team_mich",
			limit: 10,
		});
	});
});
