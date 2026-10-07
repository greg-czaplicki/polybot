import { describe, expect, it } from "vitest";
import { NBA_TOTALS_FADE_LANE, nbaFadeSide } from "./nba-totals-fade-lane";

const REG = Date.UTC(2026, 10, 3, 0, 0); // 2026-11-03, regular season
const PRE = Date.UTC(2026, 9, 14, 23, 0); // 2026-10-14, preseason
const NOW = Date.UTC(2026, 10, 2, 22, 0) / 1000;
const over = { label: "Over", price: 0.52 };
const under = { label: "Under", price: 0.48 };
const sig = { conditionId: "c", fadeLabel: "Under", triggerTs: NOW - 3600, voided: false };

describe("nbaFadeSide", () => {
	it("bets the fade label's side in band", () => {
		expect(nbaFadeSide(sig, over, under, REG, NOW)).toBe("B");
		expect(nbaFadeSide({ ...sig, fadeLabel: "Over" }, over, under, REG, NOW)).toBe("A");
		expect(nbaFadeSide(sig, under, over, REG, NOW)).toBe("A");
	});
	it("rejects missing, voided, future, preseason, unlabelled and out-of-band", () => {
		expect(nbaFadeSide(undefined, over, under, REG, NOW)).toBeNull();
		expect(nbaFadeSide({ ...sig, voided: true }, over, under, REG, NOW)).toBeNull();
		expect(nbaFadeSide({ ...sig, triggerTs: NOW + 60 }, over, under, REG, NOW)).toBeNull();
		expect(nbaFadeSide(sig, over, under, PRE, NOW)).toBeNull();
		expect(nbaFadeSide(sig, over, { label: "Lakers", price: 0.5 }, REG, NOW)).toBeNull();
		expect(nbaFadeSide(sig, over, { label: "Under", price: 0.62 }, REG, NOW)).toBeNull();
		expect(nbaFadeSide(sig, over, { label: "Under", price: 0.39 }, REG, NOW)).toBeNull();
	});
});

describe("NBA_TOTALS_FADE_LANE contract", () => {
	it("freezes the registered values", () => {
		expect(NBA_TOTALS_FADE_LANE.name).toBe("nba_totals_fade");
		expect(NBA_TOTALS_FADE_LANE.sportTag).toBe("nba");
		expect(NBA_TOTALS_FADE_LANE.marketType).toBe("total");
		expect(NBA_TOTALS_FADE_LANE.stakeUsd).toBe(4);
		expect(NBA_TOTALS_FADE_LANE.maxPicksPerDay).toBe(5);
		expect(NBA_TOTALS_FADE_LANE.maxNotionalPerDay).toBe(20);
		expect(NBA_TOTALS_FADE_LANE.killDrawdownUsd).toBe(-40);
		expect(NBA_TOTALS_FADE_LANE.forwardStart).toBe(Date.UTC(2026, 9, 20) / 1000);
	});
});
