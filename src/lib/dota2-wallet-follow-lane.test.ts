import { describe, expect, it } from "vitest";
import {
	DOTA2_WALLET_FOLLOW_LANE,
	dota2WalletFollowSide,
} from "./dota2-wallet-follow-lane";

const NOW = Date.UTC(2026, 9, 23, 15, 0) / 1000;
const a = { label: "Dota 2: Team Spirit", price: 0.62 };
const b = { label: "Aurora (BO3) - BLAST Slam", price: 0.38 };
const sig = {
	conditionId: "c",
	betLabel: "A",
	triggerTs: NOW - 600,
	voided: false,
};

describe("dota2WalletFollowSide", () => {
	it("follows the pushed outcome index", () => {
		expect(dota2WalletFollowSide(sig, a, b, NOW)).toBe("A");
		expect(dota2WalletFollowSide({ ...sig, betLabel: "B" }, a, b, NOW)).toBe(
			"B",
		);
	});
	it("rejects voided, future trigger, unknown label and out-of-band", () => {
		expect(
			dota2WalletFollowSide({ ...sig, voided: true }, a, b, NOW),
		).toBeNull();
		expect(
			dota2WalletFollowSide({ ...sig, triggerTs: NOW + 60 }, a, b, NOW),
		).toBeNull();
		expect(
			dota2WalletFollowSide({ ...sig, betLabel: "Over" }, a, b, NOW),
		).toBeNull();
		expect(dota2WalletFollowSide(sig, { price: 0.96 }, b, NOW)).toBeNull();
		expect(dota2WalletFollowSide(undefined, a, b, NOW)).toBeNull();
	});
});

describe("DOTA2_WALLET_FOLLOW_LANE contract", () => {
	it("freezes the registered values", () => {
		expect(DOTA2_WALLET_FOLLOW_LANE.name).toBe("dota2_wallet_follow");
		expect(DOTA2_WALLET_FOLLOW_LANE.sportTag).toBe("dota2");
		expect(DOTA2_WALLET_FOLLOW_LANE.marketType).toBe("moneyline");
		expect(DOTA2_WALLET_FOLLOW_LANE.stakeUsd).toBe(4);
		expect(DOTA2_WALLET_FOLLOW_LANE.maxOpenPicks).toBe(5);
		expect(DOTA2_WALLET_FOLLOW_LANE.killDrawdownUsd).toBe(-40);
		expect(DOTA2_WALLET_FOLLOW_LANE.forwardStart).toBe(
			Date.UTC(2026, 9, 23, 12) / 1000,
		);
	});
});
