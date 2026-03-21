import { describe, expect, it } from "vitest";

import { deriveSnapshotType } from "./canonical-analytics";
import {
	deriveFavDogRole,
	resolvePickedSide as resolvePickedSideForEnrichment,
} from "../pipeline/pick-enrichment-helpers";
import { splitFiltersForSnapshotType } from "../domain/trend-summary";
import type { TrendSnapshotType, VenueRole, FavDogRole } from "../types/canonical";

// ---------------------------------------------------------------------------
// deriveSnapshotType — comprehensive coverage
// ---------------------------------------------------------------------------

describe("deriveSnapshotType", () => {
	it("returns overall when no role info", () => {
		expect(deriveSnapshotType(null, null)).toBe("overall");
	});

	it("returns venue role when only venue is known", () => {
		expect(deriveSnapshotType("home", null)).toBe("home");
		expect(deriveSnapshotType("away", null)).toBe("away");
	});

	it("returns fav/dog role when only fav/dog is known", () => {
		expect(deriveSnapshotType(null, "favorite")).toBe("favorite");
		expect(deriveSnapshotType(null, "dog")).toBe("dog");
	});

	it("returns combined type when both venue and fav/dog are known", () => {
		expect(deriveSnapshotType("home", "favorite")).toBe("home_favorite");
		expect(deriveSnapshotType("home", "dog")).toBe("home_dog");
		expect(deriveSnapshotType("away", "favorite")).toBe("away_favorite");
		expect(deriveSnapshotType("away", "dog")).toBe("away_dog");
	});

	it("falls back to venue role when fav/dog is pickem", () => {
		expect(deriveSnapshotType("home", "pickem")).toBe("home");
		expect(deriveSnapshotType("away", "pickem")).toBe("away");
	});

	it("returns overall for neutral venue without fav/dog", () => {
		expect(deriveSnapshotType("neutral", null)).toBe("overall");
	});

	// Additional edge cases
	it("returns overall for neutral venue even with pickem", () => {
		expect(deriveSnapshotType("neutral", "pickem")).toBe("overall");
	});

	it("returns fav/dog for neutral venue with fav/dog role", () => {
		// neutral is not "home" or "away", so combined types won't match
		expect(deriveSnapshotType("neutral", "favorite")).toBe("favorite");
		expect(deriveSnapshotType("neutral", "dog")).toBe("dog");
	});

	it("all valid combined types are in the TrendSnapshotType union", () => {
		// Verify that deriveSnapshotType only returns valid TrendSnapshotType values
		const venueRoles: (VenueRole | null)[] = ["home", "away", "neutral", null];
		const favDogRoles: (FavDogRole | null)[] = [
			"favorite",
			"dog",
			"pickem",
			null,
		];

		const validTypes: TrendSnapshotType[] = [
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

		for (const venue of venueRoles) {
			for (const favDog of favDogRoles) {
				const result = deriveSnapshotType(venue, favDog);
				expect(validTypes).toContain(result);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// deriveSnapshotType × splitFiltersForSnapshotType round-trip consistency
// ---------------------------------------------------------------------------

describe("deriveSnapshotType round-trip with splitFiltersForSnapshotType", () => {
	it("home+favorite → home_favorite → {venueRole: home, favDogRole: favorite}", () => {
		const snapshotType = deriveSnapshotType("home", "favorite");
		expect(snapshotType).toBe("home_favorite");
		const filters = splitFiltersForSnapshotType(snapshotType);
		expect(filters).toEqual({ venueRole: "home", favDogRole: "favorite" });
	});

	it("away+dog → away_dog → {venueRole: away, favDogRole: dog}", () => {
		const snapshotType = deriveSnapshotType("away", "dog");
		expect(snapshotType).toBe("away_dog");
		const filters = splitFiltersForSnapshotType(snapshotType);
		expect(filters).toEqual({ venueRole: "away", favDogRole: "dog" });
	});

	it("home+null → home → {venueRole: home}", () => {
		const snapshotType = deriveSnapshotType("home", null);
		expect(snapshotType).toBe("home");
		const filters = splitFiltersForSnapshotType(snapshotType);
		expect(filters).toEqual({ venueRole: "home" });
	});

	it("null+null → overall → {}", () => {
		const snapshotType = deriveSnapshotType(null, null);
		expect(snapshotType).toBe("overall");
		const filters = splitFiltersForSnapshotType(snapshotType);
		expect(filters).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// deriveFavDogRole
// ---------------------------------------------------------------------------

describe("deriveFavDogRole", () => {
	it("returns null when spread is null", () => {
		expect(deriveFavDogRole(null, true)).toBeNull();
		expect(deriveFavDogRole(null, false)).toBeNull();
	});

	it("returns pickem when spread is 0", () => {
		expect(deriveFavDogRole(0, true)).toBe("pickem");
		expect(deriveFavDogRole(0, false)).toBe("pickem");
	});

	it("returns favorite for home team when home spread is negative", () => {
		expect(deriveFavDogRole(-3.5, true)).toBe("favorite");
	});

	it("returns dog for away team when home spread is negative", () => {
		expect(deriveFavDogRole(-3.5, false)).toBe("dog");
	});

	it("returns dog for home team when home spread is positive", () => {
		expect(deriveFavDogRole(7, true)).toBe("dog");
	});

	it("returns favorite for away team when home spread is positive", () => {
		expect(deriveFavDogRole(7, false)).toBe("favorite");
	});

	// Edge cases for typical spreads
	it("handles small favorites correctly", () => {
		expect(deriveFavDogRole(-1, true)).toBe("favorite");
		expect(deriveFavDogRole(-0.5, true)).toBe("favorite");
	});

	it("handles large spreads correctly", () => {
		expect(deriveFavDogRole(-21.5, true)).toBe("favorite");
		expect(deriveFavDogRole(-21.5, false)).toBe("dog");
	});
});

// ---------------------------------------------------------------------------
// resolvePickedSideForEnrichment
// ---------------------------------------------------------------------------

describe("resolvePickedSideForEnrichment", () => {
	const baseOpts = {
		homeTeamName: "Kansas City Chiefs",
		awayTeamName: "San Francisco 49ers",
		homeTeamId: "team_kc",
		awayTeamId: "team_sf",
	};

	it("returns null when pickedLabel is null", () => {
		expect(
			resolvePickedSideForEnrichment({
				...baseOpts,
				pickedLabel: null,
				sideALabel: "49ers",
				sideBLabel: "Chiefs",
			}),
		).toBeNull();
	});

	it("returns null when pickedLabel is empty", () => {
		expect(
			resolvePickedSideForEnrichment({
				...baseOpts,
				pickedLabel: "  ",
				sideALabel: "49ers",
				sideBLabel: "Chiefs",
			}),
		).toBeNull();
	});

	it("resolves side A label to away team", () => {
		const result = resolvePickedSideForEnrichment({
			...baseOpts,
			pickedLabel: "49ers",
			sideALabel: "49ers",
			sideBLabel: "Chiefs",
		});
		expect(result).toEqual({
			teamId: "team_sf",
			opponentId: "team_kc",
			venueRole: "away",
			isHomeTeam: false,
		});
	});

	it("resolves side B label to home team", () => {
		const result = resolvePickedSideForEnrichment({
			...baseOpts,
			pickedLabel: "Chiefs",
			sideALabel: "49ers",
			sideBLabel: "Chiefs",
		});
		expect(result).toEqual({
			teamId: "team_kc",
			opponentId: "team_sf",
			venueRole: "home",
			isHomeTeam: true,
		});
	});

	it("case-insensitive side label matching", () => {
		const result = resolvePickedSideForEnrichment({
			...baseOpts,
			pickedLabel: "CHIEFS",
			sideALabel: "49ers",
			sideBLabel: "Chiefs",
		});
		expect(result).toEqual({
			teamId: "team_kc",
			opponentId: "team_sf",
			venueRole: "home",
			isHomeTeam: true,
		});
	});

	it("falls back to substring match against team names", () => {
		const result = resolvePickedSideForEnrichment({
			...baseOpts,
			pickedLabel: "Chiefs",
			sideALabel: null,
			sideBLabel: null,
		});
		expect(result).toEqual({
			teamId: "team_kc",
			opponentId: "team_sf",
			venueRole: "home",
			isHomeTeam: true,
		});
	});

	it("returns null for ambiguous substring match", () => {
		const result = resolvePickedSideForEnrichment({
			homeTeamName: "New York Giants",
			awayTeamName: "New York Jets",
			homeTeamId: "team_nyg",
			awayTeamId: "team_nyj",
			pickedLabel: "New York",
			sideALabel: null,
			sideBLabel: null,
		});
		expect(result).toBeNull();
	});

	it("returns null when no match found", () => {
		const result = resolvePickedSideForEnrichment({
			...baseOpts,
			pickedLabel: "Lakers",
			sideALabel: null,
			sideBLabel: null,
		});
		expect(result).toBeNull();
	});

	// Additional edge cases
	it("matches team name substring when side labels are absent", () => {
		const result = resolvePickedSideForEnrichment({
			...baseOpts,
			pickedLabel: "San Francisco",
			sideALabel: null,
			sideBLabel: null,
		});
		expect(result).toEqual({
			teamId: "team_sf",
			opponentId: "team_kc",
			venueRole: "away",
			isHomeTeam: false,
		});
	});

	it("prefers exact side label match over substring", () => {
		// If sideA is "49ers" and pickedLabel is "49ers", should match even if
		// team name also contains it
		const result = resolvePickedSideForEnrichment({
			...baseOpts,
			pickedLabel: "49ers",
			sideALabel: "49ers",
			sideBLabel: "Chiefs",
		});
		expect(result!.teamId).toBe("team_sf");
	});
});

// ---------------------------------------------------------------------------
// Server function contract validation
// ---------------------------------------------------------------------------

describe("server function contract shapes", () => {
	it("getTeamTrendSummaryFn is exported and callable", async () => {
		// Verify the server fn module exports are structurally sound
		const mod = await import("./canonical-analytics");
		expect(mod.getTeamTrendSummaryFn).toBeDefined();
		expect(mod.getTeamTrendOverviewFn).toBeDefined();
		expect(mod.getMatchupComparisonFn).toBeDefined();
		expect(mod.getPickContextFn).toBeDefined();
		expect(mod.getPipelineStatusFn).toBeDefined();
	});

	it("deriveSnapshotType is exported for external use", async () => {
		const mod = await import("./canonical-analytics");
		expect(typeof mod.deriveSnapshotType).toBe("function");
	});
});
