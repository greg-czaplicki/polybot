import { describe, expect, it } from "vitest";
import { evaluateLiveLadder, type LiveCohortInput } from "./live-verdict";

// units/sumSq for a cohort of n bets at ~even odds with the given mean ROI
// and unit variance ≈ 1 (roughly what a 50/50 binary produces).
function cohort(
	n: number,
	meanRoi: number,
	extra?: Partial<LiveCohortInput>,
): LiveCohortInput {
	return {
		settled: n,
		units: n * meanRoi,
		sumSq: n * (1 + meanRoi * meanRoi),
		pinMoveN: 0,
		avgPinMove: null,
		...extra,
	};
}

describe("evaluateLiveLadder", () => {
	it("fires nothing on today's shape (n<100 totals, thin pin_move)", () => {
		const t = evaluateLiveLadder({
			all: cohort(89, 0.31),
			totals: cohort(62, 0.29, { pinMoveN: 9, avgPinMove: 0.002 }),
			moneyline: cohort(27, 0.36, { pinMoveN: 11, avgPinMove: -0.004 }),
			trailing100: cohort(89, 0.31),
		});
		expect(t.map((x) => x.met)).toEqual([false, false, false, false]);
		expect(t[0].detail).toContain("n=62/100");
	});
	it("fires the totals lean-in only with n, z AND non-negative pin move", () => {
		const good = cohort(120, 0.3, { pinMoveN: 40, avgPinMove: 0.001 });
		const base = {
			all: cohort(150, 0.2),
			moneyline: cohort(30, 0.1),
			trailing100: cohort(100, 0.2),
		};
		expect(evaluateLiveLadder({ ...base, totals: good })[0].met).toBe(true);
		expect(
			evaluateLiveLadder({
				...base,
				totals: { ...good, avgPinMove: -0.002 },
			})[0].met,
		).toBe(false);
		expect(
			evaluateLiveLadder({ ...base, totals: { ...good, pinMoveN: 12 } })[0].met,
		).toBe(false);
		expect(
			evaluateLiveLadder({
				...base,
				totals: { ...cohort(120, 0.1), pinMoveN: 40, avgPinMove: 0.001 },
			})[0].met,
		).toBe(false); // z too low
	});
	it("results override needs n≥200 and z≥3, ignoring CLV", () => {
		const base = {
			totals: cohort(10, 0),
			moneyline: cohort(10, 0),
			trailing100: cohort(100, 0.1),
		};
		expect(evaluateLiveLadder({ ...base, all: cohort(220, 0.25) })[1].met).toBe(
			true,
		);
		expect(evaluateLiveLadder({ ...base, all: cohort(180, 0.3) })[1].met).toBe(
			false,
		);
	});
	it("stop rule fires only with a full trailing window and negative z", () => {
		const base = {
			all: cohort(150, 0.1),
			totals: cohort(10, 0),
			moneyline: cohort(10, 0),
		};
		expect(
			evaluateLiveLadder({ ...base, trailing100: cohort(100, -0.1) })[3].met,
		).toBe(true);
		expect(
			evaluateLiveLadder({ ...base, trailing100: cohort(60, -0.3) })[3].met,
		).toBe(false);
	});
});
