import { describe, expect, it } from "vitest";
import {
	NFL_WALLET_FOLLOW_LANE,
	nflWalletSide,
} from "./nfl-wallet-follow-lane";

const REG = Date.UTC(2026, 9, 11, 17, 0); // Sunday 2026-10-11, regular season
const PRE = Date.UTC(2026, 7, 15, 23, 0); // 2026-08-15, preseason
const NOW = Date.UTC(2026, 9, 11, 15, 0) / 1000;
const over = { label: "Over", price: 0.5 };
const under = { label: "Under", price: 0.5 };
const sig = {
	conditionId: "c",
	betLabel: "Under",
	triggerTs: NOW - 600,
	voided: false,
};

describe("nflWalletSide", () => {
	it("bets the signal side in the regular season", () => {
		expect(nflWalletSide(sig, over, under, REG, NOW)).toBe("B");
		expect(
			nflWalletSide({ ...sig, betLabel: "Over" }, over, under, REG, NOW),
		).toBe("A");
	});
	it("rejects preseason, missing time, voided and out-of-band", () => {
		expect(nflWalletSide(sig, over, under, PRE, NOW)).toBeNull();
		expect(nflWalletSide(sig, over, under, null, NOW)).toBeNull();
		expect(
			nflWalletSide({ ...sig, voided: true }, over, under, REG, NOW),
		).toBeNull();
		expect(
			nflWalletSide(sig, over, { label: "Under", price: 0.7 }, REG, NOW),
		).toBeNull();
	});
});

describe("NFL_WALLET_FOLLOW_LANE contract", () => {
	it("freezes the registered values", () => {
		expect(NFL_WALLET_FOLLOW_LANE.name).toBe("nfl_wallet_follow");
		expect(NFL_WALLET_FOLLOW_LANE.sportTag).toBe("nfl");
		expect(NFL_WALLET_FOLLOW_LANE.marketType).toBe("total");
		expect(NFL_WALLET_FOLLOW_LANE.stakeUsd).toBe(4);
		expect(NFL_WALLET_FOLLOW_LANE.maxOpenPicks).toBe(5);
		expect(NFL_WALLET_FOLLOW_LANE.killDrawdownUsd).toBe(-40);
		expect(NFL_WALLET_FOLLOW_LANE.forwardStart).toBe(
			Date.UTC(2026, 9, 11, 12) / 1000,
		);
	});
});
