import { describe, expect, it } from "vitest";
import { CFB_HOT_FOLLOW_LANE, laneSignalSide } from "./cfb-hot-follow-lane";

const NOW = Date.UTC(2026, 9, 10, 15, 0) / 1000;
const over = { label: "Over", price: 0.52 };
const under = { label: "Under", price: 0.48 };
const sig = { conditionId: "c", betLabel: "Over", triggerTs: NOW - 600, voided: false };

describe("laneSignalSide", () => {
	it("follows the bet label's side in band", () => {
		expect(laneSignalSide(sig, over, under, NOW)).toBe("A");
		expect(laneSignalSide({ ...sig, betLabel: "Under" }, over, under, NOW)).toBe("B");
		expect(laneSignalSide(sig, under, over, NOW)).toBe("B");
	});
	it("rejects missing, cleared, voided, future, unlabelled and out-of-band", () => {
		expect(laneSignalSide(undefined, over, under, NOW)).toBeNull();
		expect(laneSignalSide({ ...sig, betLabel: null }, over, under, NOW)).toBeNull();
		expect(laneSignalSide({ ...sig, voided: true }, over, under, NOW)).toBeNull();
		expect(laneSignalSide({ ...sig, triggerTs: NOW + 60 }, over, under, NOW)).toBeNull();
		expect(laneSignalSide(sig, { label: "Iowa", price: 0.5 }, under, NOW)).toBeNull();
		expect(laneSignalSide(sig, { label: "Over", price: 0.65 }, under, NOW)).toBeNull();
		expect(laneSignalSide(sig, { label: "Over", price: 0.34 }, under, NOW)).toBeNull();
		expect(laneSignalSide(sig, { label: "Over", price: 0.35 }, under, NOW)).toBe("A");
	});
});

describe("CFB_HOT_FOLLOW_LANE contract", () => {
	it("freezes the registered values", () => {
		expect(CFB_HOT_FOLLOW_LANE.name).toBe("cfb_hot_follow");
		expect(CFB_HOT_FOLLOW_LANE.sportTag).toBe("ncaaf");
		expect(CFB_HOT_FOLLOW_LANE.marketType).toBe("total");
		expect(CFB_HOT_FOLLOW_LANE.stakeUsd).toBe(4);
		expect(CFB_HOT_FOLLOW_LANE.maxOpenPicks).toBe(5);
		expect(CFB_HOT_FOLLOW_LANE.killDrawdownUsd).toBe(-40);
		expect(CFB_HOT_FOLLOW_LANE.forwardStart).toBe(Date.UTC(2026, 9, 10, 12) / 1000);
	});
});
