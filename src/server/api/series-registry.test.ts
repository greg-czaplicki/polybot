import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	__resetSeriesRegistryCache,
	getSeriesRegistrySnapshot,
	resolveSeriesRegistry,
	SPORT_SERIES_CONFIG,
} from "./series-registry";

type MockSeries = {
	id: string;
	slug: string;
	active: boolean;
	closed: boolean;
};

function mockGamma(seriesBySlug: Record<string, MockSeries>) {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		const slug = url.searchParams.get("slug") ?? "";
		const match = seriesBySlug[slug];
		return new Response(JSON.stringify(match ? [match] : []), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
}

describe("resolveSeriesRegistry", () => {
	beforeEach(() => {
		__resetSeriesRegistryCache();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-20T12:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("discovers a new season series and keeps the still-active old one", async () => {
		const fetchMock = mockGamma({
			"premier-league-2025": {
				id: "10188",
				slug: "premier-league-2025",
				active: true,
				closed: false,
			},
			"premier-league-2026": {
				id: "13001",
				slug: "premier-league-2026",
				active: true,
				closed: false,
			},
		});
		vi.stubGlobal("fetch", fetchMock);

		const registry = await resolveSeriesRegistry();
		const epl = registry.series.filter((s) => s.tag === "epl");
		expect(epl.map((s) => s.seriesId).sort()).toEqual([10188, 13001]);
		expect(epl.every((s) => s.source === "discovered")).toBe(true);
		expect(registry.targetSeriesIds).toContain(13001);
		expect(registry.idToTag.get(13001)).toBe("epl");
	});

	it("falls back to last-known-good IDs when no seasonal slug matches", async () => {
		vi.stubGlobal("fetch", mockGamma({}));

		const registry = await resolveSeriesRegistry();
		const nfl = registry.series.filter((s) => s.tag === "nfl");
		expect(nfl).toEqual([
			expect.objectContaining({ seriesId: 10187, source: "fallback" }),
		]);
		// No probe errors occurred, so this is off-season, not a failure.
		expect(registry.discoveryFailures).toEqual([]);
	});

	it("ignores closed and inactive series", async () => {
		vi.stubGlobal(
			"fetch",
			mockGamma({
				"mls-2025": { id: "10189", slug: "mls-2025", active: true, closed: true },
				"mls-2026": {
					id: "13002",
					slug: "mls-2026",
					active: false,
					closed: false,
				},
			}),
		);

		const registry = await resolveSeriesRegistry();
		const mls = registry.series.filter((s) => s.tag === "mls");
		expect(mls).toEqual([
			expect.objectContaining({ seriesId: 10189, source: "fallback" }),
		]);
	});

	it("includes static sports without probing them", async () => {
		const fetchMock = mockGamma({});
		vi.stubGlobal("fetch", fetchMock);

		const registry = await resolveSeriesRegistry();
		expect(registry.idToTag.get(3)).toBe("mlb");
		expect(registry.idToTag.get(10470)).toBe("ncaab");
		expect(registry.targetSeriesIds).toContain(3);
		// atp/mma are label-only.
		expect(registry.targetSeriesIds).not.toContain(10365);
		expect(registry.targetSeriesIds).not.toContain(38);
		const probedSlugs = fetchMock.mock.calls.map(
			(call) => new URL(String(call[0])).searchParams.get("slug") ?? "",
		);
		expect(probedSlugs.some((slug) => slug.startsWith("mlb"))).toBe(false);
	});

	it("caches results within the TTL", async () => {
		const fetchMock = mockGamma({});
		vi.stubGlobal("fetch", fetchMock);

		await resolveSeriesRegistry();
		const callsAfterFirst = fetchMock.mock.calls.length;
		await resolveSeriesRegistry();
		expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
	});

	it("keeps a stale cache when every probe errors", async () => {
		vi.stubGlobal(
			"fetch",
			mockGamma({
				"premier-league-2026": {
					id: "13001",
					slug: "premier-league-2026",
					active: true,
					closed: false,
				},
			}),
		);
		const first = await resolveSeriesRegistry();
		expect(first.idToTag.get(13001)).toBe("epl");

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("oops", { status: 500 })),
		);
		vi.setSystemTime(new Date("2026-08-21T12:00:00Z"));
		const second = await resolveSeriesRegistry();
		expect(second.idToTag.get(13001)).toBe("epl");
	});

	it("degrades to hardcoded fallbacks when probes error with no cache", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("oops", { status: 500 })),
		);

		const registry = await resolveSeriesRegistry();
		expect(registry.idToTag.get(10188)).toBe("epl");
		expect(registry.idToTag.get(10189)).toBe("mls");
		expect(registry.discoveryFailures.length).toBeGreaterThan(0);
	});
});

describe("getSeriesRegistrySnapshot", () => {
	it("returns fallback mappings before any resolution", () => {
		__resetSeriesRegistryCache();
		const snapshot = getSeriesRegistrySnapshot();
		expect(snapshot.idToTag.get(10346)).toBe("nhl");
		expect(snapshot.idToTag.get(10189)).toBe("mls");
	});
});

describe("SPORT_SERIES_CONFIG", () => {
	it("has unique tags", () => {
		const tags = SPORT_SERIES_CONFIG.map((c) => c.tag);
		expect(new Set(tags).size).toBe(tags.length);
	});
});
