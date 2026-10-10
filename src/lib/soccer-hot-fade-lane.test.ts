import { describe, expect, it } from "vitest";
import {
	SOCCER_HOT_FADE_LANE,
	soccerHotFadeSide,
} from "./soccer-hot-fade-lane";

const NOW = Date.UTC(2026, 9, 10, 12, 0) / 1000;
const over = { label: "Over", price: 0.55 };
const under = { label: "Under", price: 0.45 };
const sig = {
	conditionId: "c",
	betLabel: "Under",
	triggerTs: NOW - 600,
	voided: false,
};

describe("soccerHotFadeSide", () => {
	it("bets the pushed (fade) side in band", () => {
		expect(soccerHotFadeSide(sig, over, under, NOW)).toBe("B");
	});
	it("rejects voided and out-of-band (tail lines)", () => {
		expect(
			soccerHotFadeSide({ ...sig, voided: true }, over, under, NOW),
		).toBeNull();
		expect(
			soccerHotFadeSide(sig, over, { label: "Under", price: 0.1 }, NOW),
		).toBeNull();
	});
});

describe("SOCCER_HOT_FADE_LANE contract", () => {
	it("freezes the registered values", () => {
		expect(SOCCER_HOT_FADE_LANE.name).toBe("soccer_hot_fade");
		expect(SOCCER_HOT_FADE_LANE.sportTags).toEqual([
			"epl",
			"mls",
			"championship",
			"laliga",
			"bundesliga",
			"seriea",
			"ligue1",
			"ucl",
		]);
		expect(SOCCER_HOT_FADE_LANE.marketType).toBe("total");
		expect(SOCCER_HOT_FADE_LANE.stakeUsd).toBe(4);
		expect(SOCCER_HOT_FADE_LANE.maxOpenPicks).toBe(5);
		expect(SOCCER_HOT_FADE_LANE.killDrawdownUsd).toBe(-40);
		expect(SOCCER_HOT_FADE_LANE.forwardStart).toBe(
			Date.UTC(2026, 9, 10, 12) / 1000,
		);
	});
});
