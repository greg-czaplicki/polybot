import { describe, expect, it } from "vitest";

import type { GameLine } from "../types/canonical";
import {
	deriveAtsResult,
	deriveFavDogRoles,
	deriveOuResult,
	deriveSpreadLine,
	deriveSuResult,
} from "./fact-computation";

// ---------------------------------------------------------------------------
// deriveSuResult
// ---------------------------------------------------------------------------

describe("deriveSuResult", () => {
	it("returns win for positive margin", () => {
		expect(deriveSuResult(7)).toBe("win");
	});

	it("returns loss for negative margin", () => {
		expect(deriveSuResult(-3)).toBe("loss");
	});

	it("returns push for zero margin", () => {
		expect(deriveSuResult(0)).toBe("push");
	});
});

// ---------------------------------------------------------------------------
// deriveAtsResult — the core fix
// ---------------------------------------------------------------------------

describe("deriveAtsResult", () => {
	it("returns undefined when no spread line", () => {
		const result = deriveAtsResult(7, undefined);
		expect(result.coverMargin).toBeUndefined();
		expect(result.atsResult).toBeUndefined();
	});

	// Favorite scenarios (negative spread = must win by more than spread)
	describe("favorite (spread < 0)", () => {
		it("covers when winning by more than the spread", () => {
			// Fav at -3.5, won by 7 → 7 + (-3.5) = +3.5 → cover
			const result = deriveAtsResult(7, -3.5);
			expect(result.coverMargin).toBe(3.5);
			expect(result.atsResult).toBe("cover");
		});

		it("pushes when winning by exactly the spread", () => {
			// Fav at -3, won by 3 → 3 + (-3) = 0 → push
			const result = deriveAtsResult(3, -3);
			expect(result.coverMargin).toBe(0);
			expect(result.atsResult).toBe("push");
		});

		it("does not cover when winning by less than the spread", () => {
			// Fav at -3.5, won by 3 → 3 + (-3.5) = -0.5 → no_cover
			const result = deriveAtsResult(3, -3.5);
			expect(result.coverMargin).toBe(-0.5);
			expect(result.atsResult).toBe("no_cover");
		});

		it("does not cover when losing", () => {
			// Fav at -3.5, lost by 1 → -1 + (-3.5) = -4.5 → no_cover
			const result = deriveAtsResult(-1, -3.5);
			expect(result.coverMargin).toBe(-4.5);
			expect(result.atsResult).toBe("no_cover");
		});
	});

	// Underdog scenarios (positive spread = can lose by up to spread)
	describe("underdog (spread > 0)", () => {
		it("covers when losing by less than the spread", () => {
			// Dog at +3.5, lost by 1 → -1 + 3.5 = +2.5 → cover
			const result = deriveAtsResult(-1, 3.5);
			expect(result.coverMargin).toBe(2.5);
			expect(result.atsResult).toBe("cover");
		});

		it("covers when winning outright", () => {
			// Dog at +3.5, won by 3 → 3 + 3.5 = +6.5 → cover
			const result = deriveAtsResult(3, 3.5);
			expect(result.coverMargin).toBe(6.5);
			expect(result.atsResult).toBe("cover");
		});

		it("does not cover when losing by more than the spread", () => {
			// Dog at +3.5, lost by 4 → -4 + 3.5 = -0.5 → no_cover
			const result = deriveAtsResult(-4, 3.5);
			expect(result.coverMargin).toBe(-0.5);
			expect(result.atsResult).toBe("no_cover");
		});

		it("pushes when losing by exactly the spread", () => {
			// Dog at +3, lost by 3 → -3 + 3 = 0 → push
			const result = deriveAtsResult(-3, 3);
			expect(result.coverMargin).toBe(0);
			expect(result.atsResult).toBe("push");
		});
	});

	// Pick'em (spread = 0)
	describe("pick'em (spread = 0)", () => {
		it("covers when winning", () => {
			const result = deriveAtsResult(3, 0);
			expect(result.coverMargin).toBe(3);
			expect(result.atsResult).toBe("cover");
		});

		it("does not cover when losing", () => {
			const result = deriveAtsResult(-3, 0);
			expect(result.coverMargin).toBe(-3);
			expect(result.atsResult).toBe("no_cover");
		});

		it("pushes on a tie", () => {
			const result = deriveAtsResult(0, 0);
			expect(result.coverMargin).toBe(0);
			expect(result.atsResult).toBe("push");
		});
	});

	// Spec examples from grading-rules.md §2.2
	describe("grading-rules.md §2.2 examples", () => {
		it("actual +7, spread -3.5 → cover margin +3.5 → cover", () => {
			const result = deriveAtsResult(7, -3.5);
			expect(result.coverMargin).toBe(3.5);
			expect(result.atsResult).toBe("cover");
		});

		it("actual +3, spread -3.0 → cover margin 0 → push", () => {
			const result = deriveAtsResult(3, -3.0);
			expect(result.coverMargin).toBe(0);
			expect(result.atsResult).toBe("push");
		});

		it("actual -1, spread -3.5 → cover margin -4.5 → no_cover", () => {
			const result = deriveAtsResult(-1, -3.5);
			expect(result.coverMargin).toBe(-4.5);
			expect(result.atsResult).toBe("no_cover");
		});
	});
});

// ---------------------------------------------------------------------------
// deriveOuResult
// ---------------------------------------------------------------------------

describe("deriveOuResult", () => {
	it("returns undefined when no total line", () => {
		expect(deriveOuResult(200, undefined)).toBeUndefined();
	});

	it("returns over when actual > line", () => {
		expect(deriveOuResult(215, 210.5)).toBe("over");
	});

	it("returns under when actual < line", () => {
		expect(deriveOuResult(205, 210.5)).toBe("under");
	});

	it("returns push when actual = line", () => {
		expect(deriveOuResult(210, 210)).toBe("push");
	});
});

// ---------------------------------------------------------------------------
// deriveFavDogRoles
// ---------------------------------------------------------------------------

describe("deriveFavDogRoles", () => {
	const makeLine = (homeSpread?: number): GameLine => ({
		id: "line-1",
		gameId: "game-1",
		source: "test",
		snapshotType: "close",
		homeSpread,
		recordedAt: 0,
		createdAt: 0,
	});

	it("returns undefined when no line", () => {
		const result = deriveFavDogRoles(null);
		expect(result.homeFavDog).toBeUndefined();
		expect(result.awayFavDog).toBeUndefined();
	});

	it("returns undefined when homeSpread is undefined", () => {
		const result = deriveFavDogRoles(makeLine(undefined));
		expect(result.homeFavDog).toBeUndefined();
		expect(result.awayFavDog).toBeUndefined();
	});

	it("home favorite when spread is negative", () => {
		const result = deriveFavDogRoles(makeLine(-3.5));
		expect(result.homeFavDog).toBe("favorite");
		expect(result.awayFavDog).toBe("dog");
	});

	it("home dog when spread is positive", () => {
		const result = deriveFavDogRoles(makeLine(3.5));
		expect(result.homeFavDog).toBe("dog");
		expect(result.awayFavDog).toBe("favorite");
	});

	it("pick'em when spread is zero", () => {
		const result = deriveFavDogRoles(makeLine(0));
		expect(result.homeFavDog).toBe("pickem");
		expect(result.awayFavDog).toBe("pickem");
	});
});

// ---------------------------------------------------------------------------
// deriveSpreadLine
// ---------------------------------------------------------------------------

describe("deriveSpreadLine", () => {
	const makeLine = (opts: {
		homeSpread?: number;
		awaySpread?: number;
	}): GameLine => ({
		id: "line-1",
		gameId: "game-1",
		source: "test",
		snapshotType: "close",
		homeSpread: opts.homeSpread,
		awaySpread: opts.awaySpread,
		recordedAt: 0,
		createdAt: 0,
	});

	it("returns undefined for null line", () => {
		expect(deriveSpreadLine(null, true)).toBeUndefined();
	});

	it("returns homeSpread for home team", () => {
		expect(deriveSpreadLine(makeLine({ homeSpread: -3.5 }), true)).toBe(-3.5);
	});

	it("returns awaySpread when explicitly stored", () => {
		expect(
			deriveSpreadLine(makeLine({ homeSpread: -3.5, awaySpread: 3.5 }), false),
		).toBe(3.5);
	});

	it("negates homeSpread for away team when awaySpread not stored", () => {
		expect(deriveSpreadLine(makeLine({ homeSpread: -3.5 }), false)).toBe(3.5);
	});
});
