import { describe, expect, it } from "vitest";

import { resolvePickResult } from "./manual-picks";

// Shape of a voided CS2 market as Gamma returned it on 2026-09-25
// (paiN Academy vs Semente do Mal): no resolution, plain "resolved" UMA
// status, 50/50 payout.
const voided = {
	closed: true,
	resolution: null,
	umaResolutionStatus: "resolved",
	outcomes: '["paiN Academy", "Semente do Mal"]',
	outcomePrices: '["0.5", "0.5"]',
};

describe("resolvePickResult", () => {
	it("settles a 50/50 voided market as a push", () => {
		expect(
			resolvePickResult({ sharpSide: "B", entryPrice: 0.47, market: voided }),
		).toEqual({ status: "push", resolvedOutcome: null, roi: 0 });
	});

	it("leaves a closed market near 0.5 pending until UMA resolves it", () => {
		expect(
			resolvePickResult({
				sharpSide: "B",
				entryPrice: 0.47,
				market: { ...voided, umaResolutionStatus: "proposed" },
			}),
		).toBeNull();
	});

	it("still settles a decided market as a win", () => {
		const result = resolvePickResult({
			sharpSide: "B",
			entryPrice: 0.47,
			market: { ...voided, outcomePrices: '["0", "1"]' },
		});
		expect(result?.status).toBe("win");
	});
});
