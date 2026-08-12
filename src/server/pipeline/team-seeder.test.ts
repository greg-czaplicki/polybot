import { describe, expect, it } from "vitest";
import { parseTeamsFromTitle } from "./team-seeder";

describe("parseTeamsFromTitle", () => {
	it("parses a plain matchup (away vs home for US sports)", () => {
		expect(
			parseTeamsFromTitle("Philadelphia Phillies vs. St. Louis Cardinals"),
		).toEqual({
			away: "Philadelphia Phillies",
			home: "St. Louis Cardinals",
		});
	});

	it("parses the matchup after a prop-style question prefix", () => {
		// The 2026-04→08 line-ingestion killer: without colon handling the
		// away candidate is the entire 60+ char question fragment, whose
		// alias LIKE pattern exceeds D1's limit and throws.
		expect(
			parseTeamsFromTitle(
				"Will there be a run scored in the first inning?: Philadelphia Phillies vs. St. Louis Cardinals",
			),
		).toEqual({
			away: "Philadelphia Phillies",
			home: "St. Louis Cardinals",
		});
	});

	it("parses the matchup before a totals suffix", () => {
		expect(
			parseTeamsFromTitle("Colorado Rockies vs. Arizona Diamondbacks: O/U 9.5"),
		).toEqual({
			away: "Colorado Rockies",
			home: "Arizona Diamondbacks",
		});
	});

	it("keeps soccer titles home-first", () => {
		expect(parseTeamsFromTitle("Arsenal FC vs Burnley FC", "epl")).toEqual({
			home: "Arsenal FC",
			away: "Burnley FC",
		});
	});

	it("returns null when no matchup is present", () => {
		expect(parseTeamsFromTitle("Some futures market")).toBe(null);
	});
});
