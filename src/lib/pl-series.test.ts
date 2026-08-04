import { describe, expect, it } from "vitest";
import {
	buildDayGrid,
	cumulativeByDay,
	eraMarkers,
	rollingByDay,
	type SettledPoint,
} from "./pl-series";

function localMidnight(iso: string): number {
	const date = new Date(`${iso}T00:00:00`);
	return Math.floor(date.getTime() / 1000);
}

function at(iso: string, hour: number): number {
	return localMidnight(iso) + hour * 3600;
}

describe("buildDayGrid", () => {
	it("covers the range inclusively at local midnights", () => {
		const days = buildDayGrid(at("2026-07-01", 14), at("2026-07-04", 2));
		expect(days).toHaveLength(4);
		expect(days[0]).toBe(localMidnight("2026-07-01"));
		expect(days[3]).toBe(localMidnight("2026-07-04"));
	});

	it("returns empty for inverted ranges", () => {
		expect(buildDayGrid(at("2026-07-04", 0), at("2026-07-01", 0))).toEqual([]);
	});
});

describe("cumulativeByDay", () => {
	const points: SettledPoint[] = [
		{ settledAt: at("2026-07-01", 20), roi: 0.5 },
		{ settledAt: at("2026-07-02", 21), roi: -1 },
		{ settledAt: at("2026-07-02", 22), roi: 0.8 },
		{ settledAt: at("2026-07-04", 1), roi: 1 },
	];

	it("accumulates by day end", () => {
		const days = buildDayGrid(at("2026-07-01", 0), at("2026-07-03", 0));
		const values = cumulativeByDay(points, days);
		expect(values[0]).toBeCloseTo(0.5);
		expect(values[1]).toBeCloseTo(0.3);
		expect(values[2]).toBeCloseTo(0.3);
	});

	it("nulls days before startAt and excludes earlier points", () => {
		const days = buildDayGrid(at("2026-07-01", 0), at("2026-07-04", 0));
		const values = cumulativeByDay(points, days, {
			startAt: localMidnight("2026-07-02"),
		});
		expect(values[0]).toBeNull();
		expect(values[1]).toBeCloseTo(-0.2);
		expect(values[3]).toBeCloseTo(0.8);
	});

	it("uses the value accessor and skips non-finite values", () => {
		const days = buildDayGrid(at("2026-07-01", 0), at("2026-07-02", 0));
		const withClv: SettledPoint[] = [
			{ settledAt: at("2026-07-01", 12), roi: 1, clv: 0.03 },
			{ settledAt: at("2026-07-01", 13), roi: 1, clv: null },
		];
		const values = cumulativeByDay(withClv, days, {
			value: (point) => point.clv,
		});
		expect(values[1]).toBeCloseTo(0.03);
	});
});

describe("rollingByDay", () => {
	it("sums only the trailing window, using full history", () => {
		const points: SettledPoint[] = [
			{ settledAt: at("2026-06-01", 12), roi: 2 },
			{ settledAt: at("2026-07-05", 12), roi: 1 },
		];
		const days = buildDayGrid(at("2026-07-06", 0), at("2026-07-06", 0));
		// 2026-06-01 is outside a 30d window ending 2026-07-07; 2026-07-05 is in.
		expect(rollingByDay(points, days, 30 * 86400)).toEqual([1]);
	});
});

describe("eraMarkers", () => {
	it("marks the first in-grid settle of each era, skipping pre-grid eras", () => {
		const points: SettledPoint[] = [
			{ settledAt: at("2026-06-20", 12), roi: 1, strategyVersion: "v4-x+sha" },
			{ settledAt: at("2026-07-02", 12), roi: 1, strategyVersion: "v4-x+sha" },
			{ settledAt: at("2026-07-03", 12), roi: 1, strategyVersion: "v5-y+sha" },
		];
		const days = buildDayGrid(at("2026-07-01", 0), at("2026-07-04", 0));
		expect(eraMarkers(points, days)).toEqual([{ dayIndex: 2, label: "v5" }]);
	});
});
