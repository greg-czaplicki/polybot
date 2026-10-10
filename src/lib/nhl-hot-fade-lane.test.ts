import { describe, expect, it } from "vitest";
import { NHL_HOT_FADE_LANE, nhlHotFadeSide } from "./nhl-hot-fade-lane";

const REG = Date.UTC(2026, 9, 10, 23, 0);
const NOW = Date.UTC(2026, 9, 10, 21, 0) / 1000;
const over = { label: "Over", price: 0.48 };
const under = { label: "Under", price: 0.52 };
const sig = {
	conditionId: "c",
	betLabel: "Over",
	triggerTs: NOW - 600,
	voided: false,
};

describe("nhlHotFadeSide", () => {
	it("bets the pushed (fade) side in the regular season", () => {
		expect(nhlHotFadeSide(sig, over, under, REG, NOW)).toBe("A");
		expect(
			nhlHotFadeSide({ ...sig, betLabel: "Under" }, over, under, REG, NOW),
		).toBe("B");
	});
	it("rejects missing time, voided and out-of-band", () => {
		expect(nhlHotFadeSide(sig, over, under, null, NOW)).toBeNull();
		expect(
			nhlHotFadeSide({ ...sig, voided: true }, over, under, REG, NOW),
		).toBeNull();
		expect(
			nhlHotFadeSide(sig, { label: "Over", price: 0.3 }, under, REG, NOW),
		).toBeNull();
	});
});

describe("NHL_HOT_FADE_LANE contract", () => {
	it("freezes the registered values", () => {
		expect(NHL_HOT_FADE_LANE.name).toBe("nhl_hot_fade");
		expect(NHL_HOT_FADE_LANE.sportTag).toBe("nhl");
		expect(NHL_HOT_FADE_LANE.marketType).toBe("total");
		expect(NHL_HOT_FADE_LANE.stakeUsd).toBe(4);
		expect(NHL_HOT_FADE_LANE.maxOpenPicks).toBe(5);
		expect(NHL_HOT_FADE_LANE.killDrawdownUsd).toBe(-40);
		expect(NHL_HOT_FADE_LANE.forwardStart).toBe(
			Date.UTC(2026, 9, 10, 12) / 1000,
		);
	});
});
