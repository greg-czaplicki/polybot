import { describe, expect, it } from "vitest";
import { GRADE_FLOOR_FORWARD_START, gradeFloorRead } from "./grade-floor-test";

/** Synthetic block: `wins` wins at ~w, the rest −1, one game per row. */
function rows(n: number, wins: number, createdAt: number, w = 1.2) {
	return Array.from({ length: n }, (_, i) => ({
		roi: i < wins ? w + (i % 3) * 0.05 : -1,
		win: i < wins,
		clusterKey: `g${createdAt}-${i}`,
		createdAt,
	}));
}

describe("gradeFloorRead (MLB policy floor B→C, two blocks)", () => {
	it("holds on the in-sample block alone (2026-09-15 state: 32-20 grade C)", () => {
		const v = gradeFloorRead(rows(52, 32, GRADE_FLOOR_FORWARD_START - 1));
		expect(v.verdict).toBe("hold");
		expect(v.block1.settled).toBe(52);
		expect(v.block2.settled).toBe(0);
		expect(v.reason).toContain("fwd n=0/30");
	});
	it("holds when the forward block is positive but too small, or negative at size", () => {
		const b1 = rows(52, 32, GRADE_FLOOR_FORWARD_START - 1);
		expect(
			gradeFloorRead([...b1, ...rows(20, 13, GRADE_FLOOR_FORWARD_START)])
				.verdict,
		).toBe("hold");
		const bad = gradeFloorRead([
			...b1,
			...rows(40, 15, GRADE_FLOOR_FORWARD_START),
		]);
		expect(bad.verdict).toBe("hold");
		expect(bad.reason).toContain("fwd roi≤0");
	});
	it("is ready only with forward n≥30 z≥1.5 roi>0 AND pooled n≥80 z≥2", () => {
		const v = gradeFloorRead([
			...rows(52, 32, GRADE_FLOOR_FORWARD_START - 1),
			...rows(36, 22, GRADE_FLOOR_FORWARD_START),
		]);
		expect(v.block2.settled).toBe(36);
		expect(v.pooled.settled).toBe(88);
		expect(v.block2.z ?? 0).toBeGreaterThanOrEqual(1.5);
		expect(v.pooled.z ?? 0).toBeGreaterThanOrEqual(2);
		expect(v.verdict).toBe("ready");
	});
});
