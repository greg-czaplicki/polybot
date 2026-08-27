import { describe, expect, it } from "vitest";

import { getBotCandidatePolicy, resolveTimingBucket } from "./bot";

describe("resolveTimingBucket", () => {
	it("maps minute ranges into stable timing buckets", () => {
		expect(resolveTimingBucket(10)).toBe("0-15m");
		expect(resolveTimingBucket(45)).toBe("15-60m");
		expect(resolveTimingBucket(120)).toBe("1-3h");
		expect(resolveTimingBucket(240)).toBe("3h+");
	});
});

describe("getBotCandidatePolicy", () => {
	it("rejects 15-60m spreads", () => {
		const policy = getBotCandidatePolicy({
			marketType: "spread",
			sportSeriesId: 10345,
			minutesToStart: 30,
			baseMinGrade: "A",
			baseMarketQualityThreshold: 0.7,
		});
		expect(policy.reject).toBe(true);
		expect(policy.rejectReason).toBe("spread_market_excluded");
	});

	it("rejects ncaab spreads", () => {
		const policy = getBotCandidatePolicy({
			marketType: "spread",
			sportSeriesId: 10470,
			minutesToStart: 90,
			baseMinGrade: "A",
			baseMarketQualityThreshold: 0.7,
		});
		expect(policy.reject).toBe(true);
		expect(policy.rejectReason).toBe("ncaab_spread_excluded");
	});

	it("boosts nba 1-3h moneylines over baseline", () => {
		const baseline = getBotCandidatePolicy({
			marketType: "moneyline",
			sportSeriesId: 3,
			minutesToStart: 90,
			baseMinGrade: "A",
			baseMarketQualityThreshold: 0.7,
		});
		const nba = getBotCandidatePolicy({
			marketType: "moneyline",
			sportSeriesId: 10345,
			minutesToStart: 90,
			baseMinGrade: "A",
			baseMarketQualityThreshold: 0.7,
		});
		expect(nba.reject).toBeUndefined();
		expect(nba.rankingAdjustment).toBeGreaterThan(baseline.rankingAdjustment);
		expect(nba.minGrade).toBe("B");
		expect(nba.notes).toContain("nba_moneyline_core");
	});

	it("prefers nba totals over ncaab totals in 1-3h", () => {
		const nbaTotal = getBotCandidatePolicy({
			marketType: "total",
			sportSeriesId: 10345,
			minutesToStart: 90,
			baseMinGrade: "A",
			baseMarketQualityThreshold: 0.7,
		});
		const ncaabTotal = getBotCandidatePolicy({
			marketType: "total",
			sportSeriesId: 10470,
			minutesToStart: 90,
			baseMinGrade: "A",
			baseMarketQualityThreshold: 0.7,
		});
		expect(nbaTotal.rankingAdjustment).toBeGreaterThan(
			ncaabTotal.rankingAdjustment,
		);
		expect(ncaabTotal.minGrade).toBe("A");
		expect(ncaabTotal.marketQualityThreshold).toBeGreaterThanOrEqual(0.78);
		expect(ncaabTotal.notes).toContain("ncaab_total_caution");
	});

	it("boosts mlb 1-3h totals over baseline totals", () => {
		const baseline = getBotCandidatePolicy({
			marketType: "total",
			minutesToStart: 90,
			baseMinGrade: "A",
			baseMarketQualityThreshold: 0.7,
		});
		const mlbTotal = getBotCandidatePolicy({
			marketType: "total",
			sportSeriesId: 3,
			minutesToStart: 90,
			baseMinGrade: "A",
			baseMarketQualityThreshold: 0.7,
		});
		expect(mlbTotal.rankingAdjustment).toBeGreaterThan(
			baseline.rankingAdjustment,
		);
		expect(mlbTotal.minGrade).toBe("B");
		expect(mlbTotal.notes).toContain("mlb_total_preferred");
	});

	it("shadow-settles NHL behind league probation, after the market-type gates", () => {
		// 10346 is the NHL fallback series ID (series-registry.ts).
		const ml = getBotCandidatePolicy({
			marketType: "moneyline",
			sportSeriesId: 10346,
			minutesToStart: 120,
			baseMinGrade: "A",
			baseMarketQualityThreshold: 0.7,
		});
		expect(ml.reject).toBe(true);
		expect(ml.rejectReason).toBe("nhl_league_probation");

		// A puck-line (spread) must hit the spread gate first: probation rows
		// are would-be-bettable market types only, so the cohort stays clean.
		const puckLine = getBotCandidatePolicy({
			marketType: "spread",
			sportSeriesId: 10346,
			minutesToStart: 120,
			baseMinGrade: "A",
			baseMarketQualityThreshold: 0.7,
		});
		expect(puckLine.reject).toBe(true);
		expect(puckLine.rejectReason).toBe("spread_market_excluded");
	});

	it("shadow-settles NCAAF behind league probation (era v10)", () => {
		// 10210 is the NCAAF fallback series ID (series-registry.ts).
		const ml = getBotCandidatePolicy({
			marketType: "moneyline",
			sportSeriesId: 10210,
			minutesToStart: 120,
			baseMinGrade: "A",
			baseMarketQualityThreshold: 0.7,
		});
		expect(ml.reject).toBe(true);
		expect(ml.rejectReason).toBe("ncaaf_league_probation");
	});

	it("shadow-settles NFL behind league probation (era v11), preseason gate first", () => {
		// 12185 is the nfl-2026 series ID (series-registry.ts).
		const regularSeason = getBotCandidatePolicy({
			marketType: "moneyline",
			sportSeriesId: 12185,
			minutesToStart: 120,
			// Mid-October: regular season, preseason gate does not fire.
			eventTimeMs: Date.parse("2026-10-18T17:00:00Z"),
			baseMinGrade: "A",
			baseMarketQualityThreshold: 0.7,
		});
		expect(regularSeason.reject).toBe(true);
		expect(regularSeason.rejectReason).toBe("nfl_league_probation");

		// Preseason keeps its own (earlier) gate and reason.
		const preseason = getBotCandidatePolicy({
			marketType: "moneyline",
			sportSeriesId: 12185,
			minutesToStart: 120,
			eventTimeMs: Date.parse("2026-08-30T17:00:00Z"),
			baseMinGrade: "A",
			baseMarketQualityThreshold: 0.7,
		});
		expect(preseason.reject).toBe(true);
		expect(preseason.rejectReason).toBe("nfl_preseason_excluded");
	});

	it("shadow-settles NBA >90m behind the timing gate, after the market-type gates", () => {
		// 10345 is the NBA fallback series ID (series-registry.ts).
		const ml = getBotCandidatePolicy({
			marketType: "moneyline",
			sportSeriesId: 10345,
			minutesToStart: 120,
			baseMinGrade: "A",
			baseMarketQualityThreshold: 0.7,
		});
		expect(ml.reject).toBe(true);
		expect(ml.rejectReason).toBe("nba_timing_excluded");

		// Spreads hit the spread gate first so the NBA fade cohort stays
		// two-way (ML/totals) only.
		const spread = getBotCandidatePolicy({
			marketType: "spread",
			sportSeriesId: 10345,
			minutesToStart: 120,
			baseMinGrade: "A",
			baseMarketQualityThreshold: 0.7,
		});
		expect(spread.rejectReason).toBe("spread_market_excluded");

		const inWindow = getBotCandidatePolicy({
			marketType: "moneyline",
			sportSeriesId: 10345,
			minutesToStart: 75,
			baseMinGrade: "A",
			baseMarketQualityThreshold: 0.7,
		});
		expect(inWindow.reject).toBeUndefined();
	});

	it("rejects NFL preseason games by event date", () => {
		// 2026 Labor Day is Sep 7; kickoff Thursday is Sep 10.
		const preseason = getBotCandidatePolicy({
			marketType: "moneyline",
			sportSeriesId: 10187,
			minutesToStart: 120,
			eventTimeMs: Date.UTC(2026, 7, 15, 23, 0),
			baseMinGrade: "A",
			baseMarketQualityThreshold: 0.7,
		});
		expect(preseason.reject).toBe(true);
		expect(preseason.rejectReason).toBe("nfl_preseason_excluded");

		// Week 1 clears the preseason gate but lands in league probation
		// (era v11) — shadow-only until NFL earns its own checkpoint.
		const week1 = getBotCandidatePolicy({
			marketType: "moneyline",
			sportSeriesId: 10187,
			minutesToStart: 120,
			eventTimeMs: Date.UTC(2026, 8, 11, 0, 20),
			baseMinGrade: "A",
			baseMarketQualityThreshold: 0.7,
		});
		expect(week1.reject).toBe(true);
		expect(week1.rejectReason).toBe("nfl_league_probation");
	});

	it("does not apply the preseason gate to non-NFL sports", () => {
		const mlbAugust = getBotCandidatePolicy({
			marketType: "moneyline",
			sportSeriesId: 3,
			minutesToStart: 120,
			eventTimeMs: Date.UTC(2026, 7, 15, 23, 0),
			baseMinGrade: "A",
			baseMarketQualityThreshold: 0.7,
		});
		expect(mlbAugust.reject).toBeUndefined();
	});
});
