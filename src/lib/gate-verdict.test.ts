import { describe, expect, it } from "vitest";
import { gateVerdict, roiZScore } from "./gate-verdict";

/** Build sums for `wins` rows at +w and `losses` rows at -1. */
function cohort(wins: number, losses: number, w = 0.9) {
	return {
		settled: wins + losses,
		units: wins * w - losses,
		sumSq: wins * w * w + losses,
	};
}

describe("roiZScore", () => {
	it("is null below Z_MIN_N rows or with zero variance", () => {
		expect(roiZScore(1, 0.9, 0.81)).toBeNull();
		// 2-0 at slightly different prices: variance ≈ 0 → z would be ~70
		expect(roiZScore(2, 2.36, 2.79)).toBeNull();
		expect(roiZScore(5, 4.5, 4.05)).toBeNull(); // five identical wins
	});
	it("matches mean/SE", () => {
		// 19-15 at even money: mean=4/34=0.118, sd≈0.99, se≈0.17 → z≈0.69
		const c = cohort(19, 15, 1);
		const z = roiZScore(c.settled, c.units, c.sumSq);
		expect(z).not.toBeNull();
		expect(z ?? 0).toBeGreaterThan(0.6);
		expect(z ?? 0).toBeLessThan(0.8);
	});
});

describe("gateVerdict", () => {
	it("holds on a small hot sample (the 8/25 MLB edge_rating_saturation case)", () => {
		const v = gateVerdict({
			...cohort(19, 15),
			avgPinClv: -0.005,
			pinN: 7,
			avgClv: 0.0024,
		});
		expect(v.verdict).toBe("hold");
		expect(v.clvSource).toBe("polymarket"); // pinN below the floor
		expect(v.reason).toContain("n=34/50");
	});

	it("watches when n>=25, z>=1, roi>0 but the bar is not met", () => {
		const v = gateVerdict({
			...cohort(20, 10),
			avgPinClv: null,
			pinN: 0,
			avgClv: 0.001,
		});
		expect(v.verdict).toBe("watch");
	});

	it("holds, not watches, when Pinnacle CLV is negative however hot the ROI", () => {
		// 8/25 MLB below_policy_grade: 24-22 (+17%), z≈1, pin_clv −0.9% on 18 rows
		const v = gateVerdict({
			...cohort(24, 22, 1.2),
			avgPinClv: -0.009,
			pinN: 18,
			avgClv: -0.004,
		});
		expect(v.verdict).toBe("hold");
		expect(v.clvSource).toBe("pinnacle");
	});

	it("is ready only with n>=50, z>=2 and positive CLV", () => {
		const base = { ...cohort(40, 20), avgClv: 0.002 };
		expect(gateVerdict({ ...base, avgPinClv: 0.004, pinN: 30 }).verdict).toBe(
			"ready",
		);
		// Pinnacle says no → not ready even though PM clv is positive.
		expect(
			gateVerdict({ ...base, avgPinClv: -0.003, pinN: 30 }).verdict,
		).not.toBe("ready");
		// Thin pin coverage falls back to PM clv.
		const thin = gateVerdict({ ...base, avgPinClv: -0.003, pinN: 3 });
		expect(thin.clvSource).toBe("polymarket");
		expect(thin.verdict).toBe("ready");
	});

	it("never promotes a losing cohort regardless of n", () => {
		const v = gateVerdict({
			...cohort(40, 60),
			avgPinClv: 0.01,
			pinN: 50,
			avgClv: 0.01,
		});
		expect(v.verdict).toBe("hold");
	});
});
