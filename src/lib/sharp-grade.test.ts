import { describe, expect, it } from "vitest";

import {
	computeSignalScoreFromHistory,
	gradeWeight,
	signalScoreToGradeLabel,
} from "@/lib/sharp-grade";

describe("signalScoreToGradeLabel", () => {
	it("returns A+ when score and floors are met", () => {
		const grade = signalScoreToGradeLabel(92, {
			edgeRating: 80,
			scoreDifferential: 30,
		});
		expect(grade).toBe("A+");
	});

	it("downgrades A+ to A when floors are missed", () => {
		const grade = signalScoreToGradeLabel(92, {
			edgeRating: 79,
			scoreDifferential: 30,
		});
		expect(grade).toBe("A");
	});

	it("returns A when score and floors are met", () => {
		const grade = signalScoreToGradeLabel(85, {
			edgeRating: 72,
			scoreDifferential: 20,
		});
		expect(grade).toBe("A");
	});

	it("downgrades A to B when floors are missed", () => {
		const grade = signalScoreToGradeLabel(85, {
			edgeRating: 71,
			scoreDifferential: 20,
		});
		expect(grade).toBe("B");
	});

	it("maps lower score bands correctly", () => {
		expect(signalScoreToGradeLabel(75)).toBe("B");
		expect(signalScoreToGradeLabel(65)).toBe("C");
		expect(signalScoreToGradeLabel(64.9)).toBe("D");
	});
});

describe("computeSignalScoreFromHistory", () => {
	it("uses fallback blend when history is missing", () => {
		const score = computeSignalScoreFromHistory(
			{ edgeRating: 80, scoreDifferential: 30 },
			undefined,
		);
		expect(score).toBeCloseTo(72.5, 6);
	});

	it("computes signal score with history trends (fresh, 2 stable snapshots)", () => {
		const score = computeSignalScoreFromHistory(
			{ edgeRating: 80, scoreDifferential: 30 },
			[
				{
					edgeRating: 70,
					scoreDifferential: 20,
					sideA: { totalValue: 100_000 },
					sideB: { totalValue: 100_000 },
				},
				{
					edgeRating: 80,
					scoreDifferential: 30,
					sideA: { totalValue: 150_000 },
					sideB: { totalValue: 150_000 },
				},
			],
		);
		// edge*0.7 (56) + diff*0.2 (10) + trend (10) + diffTrend (5) + volume (10) + novelty (6) = 97
		expect(score).toBeCloseTo(97, 6);
	});

	it("penalizes stale signals (6+ stable snapshots) vs fresh ones", () => {
		const staleHistory = Array.from({ length: 8 }, () => ({
			edgeRating: 80,
			scoreDifferential: 30,
			sideA: { totalValue: 150_000 },
			sideB: { totalValue: 150_000 },
		}));
		const stale = computeSignalScoreFromHistory(
			{ edgeRating: 80, scoreDifferential: 30 },
			staleHistory,
		);
		const fresh = computeSignalScoreFromHistory(
			{ edgeRating: 80, scoreDifferential: 30 },
			[
				{
					edgeRating: 60,
					scoreDifferential: 20,
					sideA: { totalValue: 150_000 },
					sideB: { totalValue: 150_000 },
				},
				{
					edgeRating: 80,
					scoreDifferential: 30,
					sideA: { totalValue: 150_000 },
					sideB: { totalValue: 150_000 },
				},
			],
		);
		expect(fresh).toBeGreaterThan(stale);
	});
});

describe("gradeWeight", () => {
	it("returns numeric weights for ordering", () => {
		expect(gradeWeight("A+")).toBe(100);
		expect(gradeWeight("A")).toBe(80);
		expect(gradeWeight("B")).toBe(60);
		expect(gradeWeight("C")).toBe(40);
		expect(gradeWeight("D")).toBe(20);
	});
});
