import { describe, expect, it } from "vitest";

import { deriveSnapshotType } from "./canonical-analytics";
import {
	deriveFavDogRole,
	resolvePickedSide as resolvePickedSideForEnrichment,
} from "../pipeline/pick-enrichment-helpers";

// ---------------------------------------------------------------------------
// deriveSnapshotType
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
});
