import { describe, expect, it } from "vitest";
import type { LanePickRow } from "./cs2-pickem-lane";
import { evaluateLadder, LANE_LADDER } from "./lane-ladder";

/** n settled even-money rows; `wins` spread evenly (or all first when `winsFirst`). */
function exact(
	n: number,
	wins: number,
	winsFirst = false,
	before = false,
): LanePickRow[] {
	return Array.from({ length: n }, (_, i) => {
		const isWin = winsFirst
			? i < wins
			: Math.floor(((i + 1) * wins) / n) > Math.floor((i * wins) / n);
		return {
			status: isWin ? "win" : "loss",
			roi: isWin ? 1 : -1,
			fillNotional: 4,
			clusterKey: `g${i}`,
			teams: [],
			pickedAt:
				(before ? LANE_LADDER.start - 86400 : LANE_LADDER.start) + i * 60,
			settledAt: LANE_LADDER.start + i * 60 + 3600,
		};
	});
}

describe("evaluateLadder", () => {
	it("starts at level 0 / $4", () => {
		const s = evaluateLadder([]);
		expect(s.level).toBe(0);
		expect(s.stakeUsd).toBe(4);
	});
	it("ignores rows picked before the ladder start", () => {
		expect(evaluateLadder(exact(300, 300, false, true)).settled).toBe(0);
	});
	it("needs 100 settled for level 1 even with a big edge", () => {
		expect(evaluateLadder(exact(99, 70)).level).toBe(0);
	});
	it("level 1 at n>=100, z>=0.8; level 2 at n>=250, z>=1.5", () => {
		// 100 bets, 55 wins at even money: ROI +10 %, z ≈ 1.0
		const one = evaluateLadder(exact(100, 55));
		expect(one.z).toBeGreaterThan(0.8);
		expect(one.level).toBe(1);
		expect(one.stakeUsd).toBe(6);
		// 250 bets, 140 wins: ROI +12 %, z ≈ 1.9
		const two = evaluateLadder(exact(250, 140));
		expect(two.level).toBe(2);
		expect(two.stakeUsd).toBe(8);
		expect(two.ownerCall).toBe(false);
	});
	it("steps down one level when the last 100 are net negative", () => {
		// wins front-loaded: overall z high, last 100 all losses
		const s = evaluateLadder(exact(260, 160, true));
		expect(s.trailingRoi).toBeLessThan(0);
		expect(s.demoted).toBe(true);
		expect(s.level).toBe(1);
	});
	it("stays at level 0 with a losing record", () => {
		expect(evaluateLadder(exact(150, 60)).level).toBe(0);
	});
});
