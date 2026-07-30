import { describe, expect, it } from "vitest";

import {
	detectSportTag,
	detectSportTagFromSeriesId,
	isNflPreseasonTime,
	isSportsMarket,
} from "./sports";

describe("detectSportTag", () => {
	it("prefers slug markers over overlapping title keywords", () => {
		expect(
			detectSportTag({
				title: "New York Yankees vs. San Francisco Giants: O/U 7.5",
				eventSlug: "mlb-yankees-vs-giants",
			}),
		).toBe("mlb");
	});

	it("prefers the sport with more title evidence when team names overlap", () => {
		expect(
			detectSportTag({
				title: "Tampa Bay Rays vs. St. Louis Cardinals",
			}),
		).toBe("mlb");
	});

	it("detects nba spread markets from abbreviations and team names", () => {
		expect(
			detectSportTag({
				title: "PHI vs CHA: Spread: Hornets (-6.5)",
			}),
		).toBe("nba");
	});

	it("detects college basketball from explicit event markers", () => {
		expect(
			detectSportTag({
				title: "Michigan State Spartans vs. Connecticut Huskies: O/U 140.5",
				eventSlug: "ncaab-michigan-state-vs-connecticut",
			}),
		).toBe("ncaab");
	});

	it("returns null when there is no sport evidence", () => {
		expect(
			detectSportTag({ title: "Who will win the presidency?" }),
		).toBeNull();
	});

	it("maps known sport series ids", () => {
		expect(detectSportTagFromSeriesId(10470)).toBe("ncaab");
		expect(detectSportTagFromSeriesId(10210)).toBe("ncaaf");
		expect(detectSportTagFromSeriesId(3)).toBe("mlb");
		expect(detectSportTagFromSeriesId(999999)).toBeNull();
	});
});

describe("isSportsMarket", () => {
	it("still recognizes sports markets when detectSportTag resolves from title", () => {
		expect(
			isSportsMarket({
				title: "Los Angeles Angels vs. Houston Astros",
			}),
		).toBe(true);
	});
});

describe("isNflPreseasonTime", () => {
	it("flags August and pre-kickoff September games as preseason", () => {
		// 2026: Labor Day Sep 7, kickoff Thursday Sep 10.
		expect(isNflPreseasonTime(Date.UTC(2026, 7, 6, 0, 0))).toBe(true); // HOF game
		expect(isNflPreseasonTime(Date.UTC(2026, 8, 9, 23, 0))).toBe(true); // day before kickoff
		expect(isNflPreseasonTime(Date.UTC(2026, 8, 11, 0, 20))).toBe(false); // week 1 Thu night
		expect(isNflPreseasonTime(Date.UTC(2026, 8, 13, 17, 0))).toBe(false); // week 1 Sunday
	});

	it("never flags games outside July-September", () => {
		expect(isNflPreseasonTime(Date.UTC(2026, 0, 11, 18, 0))).toBe(false); // playoffs
		expect(isNflPreseasonTime(Date.UTC(2026, 11, 13, 18, 0))).toBe(false); // December
	});

	it("rolls forward to other seasons' Labor Days", () => {
		// 2027: Labor Day Sep 6, kickoff Thursday Sep 9.
		expect(isNflPreseasonTime(Date.UTC(2027, 8, 8, 23, 0))).toBe(true);
		expect(isNflPreseasonTime(Date.UTC(2027, 8, 10, 0, 20))).toBe(false);
	});
});
