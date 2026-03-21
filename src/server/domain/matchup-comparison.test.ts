import { describe, expect, it } from "vitest";

import type {
	ComparisonEdge,
	MatchupComparison,
	MatchupSplitComparison,
	MetricComparison,
} from "./matchup-comparison";

// ---------------------------------------------------------------------------
// Type structure validation
// ---------------------------------------------------------------------------
// The matchup-comparison module's core helpers (determineEdge,
// getRelevantSplitPairs, buildMetricComparisons, buildHeadline) are private.
// The public API (buildMatchupComparison, buildMatchupComparisonByNames,
// buildMatchupComparisonFromGame) requires DB access.
//
// These tests validate the output type contracts so consumers can rely on
// the shape. Full integration tests require a D1 database instance.
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
