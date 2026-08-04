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
});
