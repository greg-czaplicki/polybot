import { describe, expect, it } from "vitest";
import { computeWalletEntryDiffs, type MarketSnapshot } from "./wallet-clv";

function snapshot(
	priceA: number | null,
	holdersA: Array<[string, number]>,
	priceB: number | null = 0.5,
	holdersB: Array<[string, number]> = [],
): MarketSnapshot {
	return {
		sideA: {
			price: priceA,
			topHolders: holdersA.map(([proxyWallet, amount]) => ({
				proxyWallet,
				amount,
			})),
		},
		sideB: {
			price: priceB,
			topHolders: holdersB.map(([proxyWallet, amount]) => ({
				proxyWallet,
				amount,
			})),
		},
	};
}

describe("computeWalletEntryDiffs", () => {
	it("returns nothing for the baseline snapshot", () => {
		const next = snapshot(0.5, [["0xabc", 5000]]);
		expect(computeWalletEntryDiffs(null, next)).toEqual([]);
	});

	it("records share growth as an increase, in USD at the new price", () => {
		// 10,000 shares at 0.40 → $4,000; same wallet at 15,000 shares × 0.50.
		const prev = snapshot(0.4, [["0xABC", 4000]]);
		const next = snapshot(0.5, [["0xabc", 7500]]);
		const diffs = computeWalletEntryDiffs(prev, next);
		expect(diffs).toHaveLength(1);
		expect(diffs[0].kind).toBe("increase");
		expect(diffs[0].walletAddress).toBe("0xabc");
		expect(diffs[0].entryPrice).toBe(0.5);
		expect(diffs[0].deltaUsd).toBeCloseTo(2500); // 5,000 new shares × 0.50
	});

	it("does not record a pure price move as an entry", () => {
		// 10,000 shares at 0.40 → $4,000; price rises to 0.50, same shares.
		const prev = snapshot(0.4, [["0xabc", 4000]]);
		const next = snapshot(0.5, [["0xabc", 5000]]);
		expect(computeWalletEntryDiffs(prev, next)).toEqual([]);
	});

	it("records first-time top-20 appearances above the dust floor", () => {
		const prev = snapshot(0.5, [["0xaaa", 3000]]);
		const next = snapshot(0.5, [
			["0xaaa", 3000],
			["0xbbb", 900],
			["0xccc", 50], // below MIN_DELTA_USD
		]);
		const diffs = computeWalletEntryDiffs(prev, next);
		expect(diffs).toHaveLength(1);
		expect(diffs[0]).toMatchObject({
			walletAddress: "0xbbb",
			kind: "new_top20",
			deltaUsd: 900,
		});
	});

	it("skips a side whose previous price is unknown", () => {
		const prev = snapshot(null, [["0xabc", 4000]]);
		const next = snapshot(0.5, [["0xabc", 9000]]);
		expect(computeWalletEntryDiffs(prev, next)).toEqual([]);
	});

	it("skips a side whose current price is invalid", () => {
		const prev = snapshot(0.4, [["0xabc", 4000]]);
		const next = snapshot(0, [["0xabc", 9000]]);
		expect(computeWalletEntryDiffs(prev, next)).toEqual([]);
	});

	it("handles both sides independently", () => {
		const prev = snapshot(0.4, [], 0.6, [["0xddd", 600]]);
		const next = snapshot(0.4, [["0xnew", 500]], 0.6, [["0xddd", 1200]]);
		const diffs = computeWalletEntryDiffs(prev, next);
		expect(diffs.map((d) => `${d.side}:${d.kind}`).sort()).toEqual([
			"A:new_top20",
			"B:increase",
		]);
	});

	it("prefers raw shares over amount/price reconstruction (basis mismatch)", () => {
		// Static 20,000-share position. The USD amount is valued at the mid
		// while side price is the ask, so amount/price reconstruction drifts
		// tick to tick (0.50→0.505 mid at a fixed 0.51 ask ≈ +$100 phantom
		// delta). With raw shares present, no entry is recorded.
		const prev: MarketSnapshot = {
			sideA: {
				price: 0.51,
				topHolders: [{ proxyWallet: "0xabc", amount: 10_000, shares: 20_000 }],
			},
			sideB: { price: 0.49, topHolders: [] },
		};
		const next: MarketSnapshot = {
			sideA: {
				price: 0.51,
				topHolders: [{ proxyWallet: "0xabc", amount: 10_100, shares: 20_000 }],
			},
			sideB: { price: 0.49, topHolders: [] },
		};
		expect(computeWalletEntryDiffs(prev, next)).toEqual([]);
	});

	it("computes deltas from raw shares when present", () => {
		const prev: MarketSnapshot = {
			sideA: {
				price: 0.5,
				topHolders: [{ proxyWallet: "0xabc", amount: 5_000, shares: 10_000 }],
			},
			sideB: { price: 0.5, topHolders: [] },
		};
		const next: MarketSnapshot = {
			sideA: {
				price: 0.5,
				topHolders: [{ proxyWallet: "0xabc", amount: 7_500, shares: 15_000 }],
			},
			sideB: { price: 0.5, topHolders: [] },
		};
		const diffs = computeWalletEntryDiffs(prev, next);
		expect(diffs).toHaveLength(1);
		expect(diffs[0].deltaUsd).toBeCloseTo(2500); // 5,000 shares × 0.50
	});

	it("skips wallets whose prev and next snapshots use different share bases", () => {
		// Legacy prev (reconstructed shares) vs shares-carrying next: the two
		// values live on different price bases, so a delta between them is the
		// fabrication bug. The transition tick records nothing; the wallet
		// resumes diffing once both snapshots carry raw shares.
		const prev = snapshot(0.4, [["0xabc", 4000]]); // legacy: no shares field
		const next: MarketSnapshot = {
			sideA: {
				price: 0.5,
				topHolders: [{ proxyWallet: "0xabc", amount: 7_500, shares: 15_000 }],
			},
			sideB: { price: 0.5, topHolders: [] },
		};
		expect(computeWalletEntryDiffs(prev, next)).toEqual([]);
	});

	it("new wallets still record as new_top20 during the basis transition", () => {
		const prev = snapshot(0.5, [["0xaaa", 3000]]); // legacy
		const next: MarketSnapshot = {
			sideA: {
				price: 0.5,
				topHolders: [
					{ proxyWallet: "0xaaa", amount: 3000, shares: 6000 },
					{ proxyWallet: "0xnew", amount: 900, shares: 1800 },
				],
			},
			sideB: { price: 0.5, topHolders: [] },
		};
		const diffs = computeWalletEntryDiffs(prev, next);
		expect(diffs).toHaveLength(1);
		expect(diffs[0]).toMatchObject({
			walletAddress: "0xnew",
			kind: "new_top20",
		});
	});
});
