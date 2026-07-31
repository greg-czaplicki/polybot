import { describe, expect, it, vi } from "vitest";

import type { Db } from "../db/client";
import { recordShadowCandidates } from "./shadow-book";

vi.mock("../db/client", () => ({
	all: vi.fn(async () => []),
	run: vi.fn(async () => ({ meta: { changes: 1 } })),
}));

import { run } from "../db/client";

const baseInput = {
	conditionId: "0xabc",
	rejectReason: "nfl_preseason_excluded",
	marketTitle: "Panthers vs. Cardinals",
	sharpSide: "A",
	price: 0.45,
	eventTime: "2026-08-06T00:00:00Z",
};

describe("recordShadowCandidates", () => {
	it("records settleable candidates", async () => {
		vi.mocked(run).mockClear();
		const recorded = await recordShadowCandidates({} as Db, [baseInput]);
		expect(recorded).toBe(1);
		expect(vi.mocked(run)).toHaveBeenCalledTimes(1);
	});

	it("skips candidates without a settleable side or price", async () => {
		vi.mocked(run).mockClear();
		const recorded = await recordShadowCandidates({} as Db, [
			{ ...baseInput, sharpSide: "EVEN" },
			{ ...baseInput, price: null },
			{ ...baseInput, price: 0 },
			{ ...baseInput, sharpSide: undefined },
		]);
		expect(recorded).toBe(0);
		expect(vi.mocked(run)).not.toHaveBeenCalled();
	});

	it("serializes trend context when provided", async () => {
		vi.mocked(run).mockClear();
		const trendContext = {
			canonicalScore: 55,
			favDogRole: "dog",
			team: { atsStreakType: "W", atsStreakLength: 3 },
		};
		await recordShadowCandidates({} as Db, [{ ...baseInput, trendContext }]);
		const params = vi.mocked(run).mock.calls[0].slice(2);
		expect(params).toContain(JSON.stringify(trendContext));

		vi.mocked(run).mockClear();
		await recordShadowCandidates({} as Db, [baseInput]);
		const noContextParams = vi.mocked(run).mock.calls[0].slice(2);
		expect(noContextParams.filter((p) => p === null).length).toBeGreaterThan(0);
	});

	it("dedupes by condition and reason within a batch", async () => {
		vi.mocked(run).mockClear();
		const recorded = await recordShadowCandidates({} as Db, [
			baseInput,
			{ ...baseInput, price: 0.5 },
			{ ...baseInput, rejectReason: "spread_market_excluded" },
		]);
		expect(recorded).toBe(2);
		expect(vi.mocked(run)).toHaveBeenCalledTimes(2);
	});
});
