import { describe, expect, it } from "vitest";
import { NFL_TOTALS_PILOT_LANE, nflTotalsSide } from "./nfl-totals-lane";

const REG = Date.UTC(2026, 9, 11, 17, 0); // Sun 2026-10-11 1pm ET slate
const PRE = Date.UTC(2027, 7, 20, 0, 0); // August 2027 preseason

describe("nflTotalsSide", () => {
	it("takes the sighted side in-band on a regular-season game", () => {
		expect(nflTotalsSide("A", 0.52, 0.48, REG)).toBe("A");
		expect(nflTotalsSide("B", 0.52, 0.48, REG)).toBe("B");
	});
	it("rejects preseason games, missing event time, and out-of-band prices", () => {
		expect(nflTotalsSide("A", 0.52, 0.48, PRE)).toBeNull();
		expect(nflTotalsSide("A", 0.52, 0.48, null)).toBeNull();
		expect(nflTotalsSide("A", 0.8, 0.2, REG)).toBeNull();
		expect(nflTotalsSide(null, 0.5, 0.5, REG)).toBeNull();
	});
});

describe("NFL_TOTALS_PILOT_LANE contract", () => {
	it("freezes the registered values", () => {
		expect(NFL_TOTALS_PILOT_LANE.name).toBe("nfl_totals_pilot");
		expect(NFL_TOTALS_PILOT_LANE.sportTag).toBe("nfl");
		expect(NFL_TOTALS_PILOT_LANE.marketType).toBe("total");
		expect(NFL_TOTALS_PILOT_LANE.stakeUsd).toBe(4);
		expect(NFL_TOTALS_PILOT_LANE.maxOpenPicks).toBe(5);
		expect(NFL_TOTALS_PILOT_LANE.killDrawdownUsd).toBe(-40);
		expect(NFL_TOTALS_PILOT_LANE.forwardStart).toBe(
			Date.UTC(2026, 9, 5, 17, 0) / 1000,
		);
	});
});
