import { describe, expect, it } from "vitest";
import { NCAAB_ML_DOG_LANE, ncaabMlDogSide } from "./ncaab-ml-dog-lane";

describe("ncaabMlDogSide", () => {
	it("takes the side priced in [0.30, 0.50)", () => {
		expect(ncaabMlDogSide(0.35, 0.66)).toBe("A");
		expect(ncaabMlDogSide(0.7, 0.3)).toBe("B");
		expect(ncaabMlDogSide(0.52, 0.49)).toBe("B");
	});
	it("skips out-of-band, missing and ambiguous prices", () => {
		expect(ncaabMlDogSide(0.25, 0.76)).toBeNull();
		expect(ncaabMlDogSide(0.5, 0.5)).toBeNull();
		expect(ncaabMlDogSide(0.45, 0.45)).toBeNull();
		expect(ncaabMlDogSide(null, 0.4)).toBe("B");
		expect(ncaabMlDogSide(undefined, undefined)).toBeNull();
	});
	it("freezes the registered values", () => {
		expect(NCAAB_ML_DOG_LANE.name).toBe("ncaab_ml_dog");
		expect(NCAAB_ML_DOG_LANE.sportTag).toBe("ncaab");
		expect(NCAAB_ML_DOG_LANE.marketType).toBe("moneyline");
		expect(NCAAB_ML_DOG_LANE.stakeUsd).toBe(4);
		expect(NCAAB_ML_DOG_LANE.maxOpenPicks).toBe(10);
		expect(NCAAB_ML_DOG_LANE.killDrawdownUsd).toBe(-40);
		expect(NCAAB_ML_DOG_LANE.forwardStart).toBe(Date.UTC(2026, 10, 2) / 1000);
	});
});
