import { describe, expect, it } from "vitest";

import type { TrendSnapshotType } from "../types/canonical";
import { snapshotTypeLabel, splitFiltersForSnapshotType } from "./trend-summary";

// ---------------------------------------------------------------------------
// snapshotTypeLabel
// ---------------------------------------------------------------------------

describe("snapshotTypeLabel", () => {
	it("returns human-readable labels for all snapshot types", () => {
		expect(snapshotTypeLabel("overall")).toBe("Overall");
		expect(snapshotTypeLabel("home")).toBe("Home");
		expect(snapshotTypeLabel("away")).toBe("Away");
		expect(snapshotTypeLabel("favorite")).toBe("Favorite");
		expect(snapshotTypeLabel("dog")).toBe("Underdog");
		expect(snapshotTypeLabel("home_favorite")).toBe("Home Favorite");
		expect(snapshotTypeLabel("home_dog")).toBe("Home Underdog");
		expect(snapshotTypeLabel("away_favorite")).toBe("Away Favorite");
		expect(snapshotTypeLabel("away_dog")).toBe("Away Underdog");
	});
});

// ---------------------------------------------------------------------------
// splitFiltersForSnapshotType
// ---------------------------------------------------------------------------

describe("splitFiltersForSnapshotType", () => {
	it("returns empty filters for overall", () => {
		expect(splitFiltersForSnapshotType("overall")).toEqual({});
	});

	it("returns venueRole for home/away", () => {
		expect(splitFiltersForSnapshotType("home")).toEqual({
			venueRole: "home",
		});
		expect(splitFiltersForSnapshotType("away")).toEqual({
			venueRole: "away",
		});
	});

	it("returns favDogRole for favorite/dog", () => {
		expect(splitFiltersForSnapshotType("favorite")).toEqual({
			favDogRole: "favorite",
		});
		expect(splitFiltersForSnapshotType("dog")).toEqual({
			favDogRole: "dog",
		});
	});

	it("returns both venueRole and favDogRole for combined splits", () => {
		expect(splitFiltersForSnapshotType("home_favorite")).toEqual({
			venueRole: "home",
			favDogRole: "favorite",
		});
		expect(splitFiltersForSnapshotType("home_dog")).toEqual({
			venueRole: "home",
			favDogRole: "dog",
		});
		expect(splitFiltersForSnapshotType("away_favorite")).toEqual({
			venueRole: "away",
			favDogRole: "favorite",
		});
		expect(splitFiltersForSnapshotType("away_dog")).toEqual({
			venueRole: "away",
			favDogRole: "dog",
		});
	});

	it("covers all 9 snapshot types", () => {
		const allTypes: TrendSnapshotType[] = [
			"overall",
			"home",
			"away",
			"favorite",
			"dog",
			"home_favorite",
			"home_dog",
			"away_favorite",
			"away_dog",
		];
		for (const type of allTypes) {
			const result = splitFiltersForSnapshotType(type);
			expect(result).toBeDefined();
		}
	});
});
