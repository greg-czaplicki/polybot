import { describe, expect, it } from "vitest";
import {
	CS2_PICKEM_DOG_LANE,
	clusteredZ,
	evaluateLaneState,
	type LanePickRow,
	pickemSide,
	utcDayStart,
} from "./cs2-pickem-lane";

const NOW = CS2_PICKEM_DOG_LANE.forwardStart + 10 * 86400 + 3600; // some day, 01:00Z
const DAY = utcDayStart(NOW);

function row(
	partial: Partial<LanePickRow> & { pickedAt: number },
): LanePickRow {
	return {
		status: "pending",
		roi: null,
		fillNotional: null,
		clusterKey: `c${partial.pickedAt}`,
		settledAt: null,
		...partial,
	};
}

describe("pickemSide", () => {
	it("takes the one side in [0.40, 0.50)", () => {
		expect(pickemSide(0.45, 0.55)).toBe("A");
		expect(pickemSide(0.58, 0.42)).toBe("B");
	});
	it("band is half-open: 0.50 is out, 0.40 is in", () => {
		expect(pickemSide(0.5, 0.5)).toBeNull();
		expect(pickemSide(0.4, 0.6)).toBe("A");
		expect(pickemSide(0.399, 0.601)).toBeNull();
	});
	it("skips ambiguous markets where both sides sit in the band", () => {
		expect(pickemSide(0.45, 0.45)).toBeNull();
	});
	it("skips missing prices", () => {
		expect(pickemSide(null, 0.45)).toBe("B");
		expect(pickemSide(undefined, undefined)).toBeNull();
	});
});

describe("evaluateLaneState", () => {
	it("is active with a fresh book", () => {
		const s = evaluateLaneState([], NOW);
		expect(s.active).toBe(true);
		expect(s.remainingToday).toBe(CS2_PICKEM_DOG_LANE.maxPicksPerDay);
	});
	it("refuses before the forward start", () => {
		const s = evaluateLaneState([], CS2_PICKEM_DOG_LANE.forwardStart - 1);
		expect(s.active).toBe(false);
		expect(s.reason).toBe("before_forward_start");
	});
	it("caps at 3 picks per UTC day, ignoring yesterday", () => {
		const rows = [
			row({ pickedAt: DAY - 100 }), // yesterday
			row({ pickedAt: DAY + 10 }),
			row({ pickedAt: DAY + 20 }),
		];
		expect(evaluateLaneState(rows, NOW).remainingToday).toBe(1);
		rows.push(row({ pickedAt: DAY + 30 }));
		const s = evaluateLaneState(rows, NOW);
		expect(s.active).toBe(false);
		expect(s.reason).toBe("daily_pick_cap");
	});
	it("caps daily notional using executed fills", () => {
		const rows = [
			row({ pickedAt: DAY + 10, fillNotional: 9 }),
			row({ pickedAt: DAY + 20, fillNotional: 9 }),
		];
		// 18 spent, 2 left < stake 4 → no more room even though only 2 picks
		const s = evaluateLaneState(rows, NOW);
		expect(s.active).toBe(false);
		expect(s.reason).toBe("daily_notional_cap");
	});
	it("kills on realized drawdown of $40 at the assumed stake", () => {
		const rows = Array.from({ length: 10 }, (_, i) =>
			row({
				pickedAt: DAY - (i + 2) * 86400,
				status: "loss",
				roi: -1,
				settledAt: DAY - i,
			}),
		);
		const s = evaluateLaneState(rows, NOW);
		expect(s.realizedPnl).toBe(-40);
		expect(s.active).toBe(false);
		expect(s.reason).toBe("kill_drawdown");
	});
	it("kills on a negative clustered z once 30 have settled", () => {
		// 30 settled, alternating small losses and smaller wins → z < -1, PnL > -40
		const rows: LanePickRow[] = [];
		for (let i = 0; i < 30; i++) {
			const win = i % 3 === 0;
			rows.push(
				row({
					pickedAt: DAY - (i + 2) * 86400,
					status: win ? "win" : "loss",
					roi: win ? 0.9 : -1,
					fillNotional: 1,
					clusterKey: `m${i}`,
					settledAt: DAY - i,
				}),
			);
		}
		const s = evaluateLaneState(rows, NOW);
		expect(s.settled).toBe(30);
		expect(s.z).not.toBeNull();
		expect((s.z as number) < -1).toBe(true);
		expect(s.reason).toBe("kill_z");
	});
	it("does not evaluate z under 30 settled", () => {
		const rows = Array.from({ length: 12 }, (_, i) =>
			row({
				pickedAt: DAY - (i + 2) * 86400,
				status: "loss",
				roi: -1,
				fillNotional: 1,
				clusterKey: `m${i}`,
				settledAt: DAY - i,
			}),
		);
		const s = evaluateLaneState(rows, NOW);
		expect(s.z).toBeNull();
		expect(s.active).toBe(true);
	});
});

describe("clusteredZ", () => {
	it("needs five clusters", () => {
		expect(clusteredZ([{ roi: 1, clusterKey: "a" }])).toBeNull();
	});
	it("collapses a market's sides into one cluster", () => {
		const rows = [
			...Array.from({ length: 6 }, (_, i) => ({
				roi: 0.5,
				clusterKey: `c${i}`,
			})),
			{ roi: -1, clusterKey: "c0" },
			{ roi: -1, clusterKey: "c0" },
		];
		const z = clusteredZ(rows);
		expect(z).not.toBeNull();
	});
});
