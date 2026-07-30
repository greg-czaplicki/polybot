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

		const week1 = getBotCandidatePolicy({
			marketType: "moneyline",
			sportSeriesId: 10187,
			minutesToStart: 120,
			eventTimeMs: Date.UTC(2026, 8, 11, 0, 20),
			baseMinGrade: "A",
			baseMarketQualityThreshold: 0.7,
		});
		expect(week1.reject).toBeUndefined();
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
