import { describe, expect, it } from "vitest";
import { evaluateLaneState, type LanePickRow } from "./cs2-pickem-lane";
import { NCAAF_TOTALS_PILOT_LANE, totalsSide } from "./ncaaf-totals-lane";

describe("totalsSide", () => {
	it("takes the sighted sharp side when its price is inside the band", () => {
		expect(totalsSide("A", 0.53, 0.47)).toBe("A");
		expect(totalsSide("B", 0.53, 0.47)).toBe("B");
	});
	it("returns null without a sighted side", () => {
		expect(totalsSide(null, 0.5, 0.5)).toBeNull();
		expect(totalsSide(undefined, 0.5, 0.5)).toBeNull();
		expect(totalsSide("", 0.5, 0.5)).toBeNull();
	});
	it("returns null when the taken side's price is outside [0.25, 0.75)", () => {
		expect(totalsSide("A", 0.2, 0.8)).toBeNull();
		expect(totalsSide("A", 0.75, 0.25)).toBeNull();
		expect(totalsSide("A", 0.25, 0.75)).toBe("A");
		expect(totalsSide("B", 0.5, null)).toBeNull();
		expect(totalsSide("B", 0.5, Number.NaN)).toBeNull();
	});
});

describe("NCAAF_TOTALS_PILOT_LANE contract", () => {
	it("freezes the registered values", () => {
		expect(NCAAF_TOTALS_PILOT_LANE.name).toBe("ncaaf_totals_pilot");
		expect(NCAAF_TOTALS_PILOT_LANE.stakeUsd).toBe(4);
		expect(NCAAF_TOTALS_PILOT_LANE.maxPicksPerDay).toBe(5);
		expect(NCAAF_TOTALS_PILOT_LANE.maxNotionalPerDay).toBe(20);
		expect(NCAAF_TOTALS_PILOT_LANE.killDrawdownUsd).toBe(-40);
		expect(NCAAF_TOTALS_PILOT_LANE.forwardStart).toBe(Date.UTC(2026, 8, 20) / 1000);
		expect(NCAAF_TOTALS_PILOT_LANE.oneTeamPerDay).toBe(false);
	});
	it("runs the shared cap/kill machinery: 5 picks or $20 per UTC day, kill at -$40", () => {
		const now = NCAAF_TOTALS_PILOT_LANE.forwardStart + 6 * 86400 + 3600;
		const day = now - (now % 86400);
		const row = (p: Partial<LanePickRow> & { pickedAt: number }): LanePickRow => ({
			status: "pending",
			roi: null,
			fillNotional: null,
			clusterKey: `c${p.pickedAt}`,
			teams: [],
			settledAt: null,
			...p,
		});
		const before = evaluateLaneState([], NCAAF_TOTALS_PILOT_LANE.forwardStart - 1, NCAAF_TOTALS_PILOT_LANE);
		expect(before.active).toBe(false);
		expect(before.reason).toBe("before_forward_start");
		const fresh = evaluateLaneState([], now, NCAAF_TOTALS_PILOT_LANE);
		expect(fresh.active).toBe(true);
		expect(fresh.remainingToday).toBe(5);
		const five = [1, 2, 3, 4, 5].map((i) => row({ pickedAt: day + i }));
		expect(evaluateLaneState(five, now, NCAAF_TOTALS_PILOT_LANE).reason).toBe("daily_pick_cap");
		const losses = Array.from({ length: 10 }, (_, i) =>
			row({ pickedAt: day - 86400 * (i + 1), status: "loss", roi: -1, fillNotional: 4, settledAt: day - 3600 * (i + 1) }),
		);
		expect(evaluateLaneState(losses, now, NCAAF_TOTALS_PILOT_LANE).reason).toBe("kill_drawdown");
	});
});
