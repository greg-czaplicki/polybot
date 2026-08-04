/**
 * Pure series math for the P/L charts: daily grids, cumulative and
 * trailing-window sums, and strategy-era markers. All timestamps are unix
 * seconds (manual_picks / shadow_candidates convention).
 */

export interface SettledPoint {
	settledAt: number;
	roi: number;
	clv?: number | null;
	strategyVersion?: string | null;
}

/**
 * Local-midnight day starts covering [startSec, endSec], built via Date
 * increments so DST days keep their real boundaries.
 */
export function buildDayGrid(startSec: number, endSec: number): number[] {
	if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return [];
	if (endSec < startSec) return [];
	const cursor = new Date(startSec * 1000);
	cursor.setHours(0, 0, 0, 0);
	const days: number[] = [];
	while (cursor.getTime() / 1000 <= endSec) {
		days.push(Math.floor(cursor.getTime() / 1000));
		cursor.setDate(cursor.getDate() + 1);
	}
	return days;
}

function dayEnd(days: number[], index: number): number {
	return days[index + 1] ?? days[index] + 86400;
}

/**
 * Cumulative sum of `value` over points settled inside the grid, evaluated at
 * each day end. Days before `startAt` (e.g. the CLV validity date) are null;
 * accumulation also ignores points settled before it.
 */
export function cumulativeByDay(
	points: SettledPoint[],
	days: number[],
	options?: {
		value?: (point: SettledPoint) => number | null | undefined;
		startAt?: number;
	},
): Array<number | null> {
	const value = options?.value ?? ((point: SettledPoint) => point.roi);
	const startAt = options?.startAt ?? days[0] ?? 0;
	const sorted = points
		.filter((point) => point.settledAt >= startAt)
		.sort((a, b) => a.settledAt - b.settledAt);
	const result: Array<number | null> = [];
	let cursor = 0;
	let sum = 0;
	for (let i = 0; i < days.length; i += 1) {
		const end = dayEnd(days, i);
		while (cursor < sorted.length && sorted[cursor].settledAt < end) {
			const v = value(sorted[cursor]);
			if (typeof v === "number" && Number.isFinite(v)) sum += v;
			cursor += 1;
		}
		result.push(end <= startAt ? null : sum);
	}
	return result;
}

/**
 * Trailing-window sum evaluated at each day end. Uses the full point history
 * (not just in-grid points) so early days in a narrow range still see their
 * complete look-back window.
 */
export function rollingByDay(
	points: SettledPoint[],
	days: number[],
	windowSecs: number,
): number[] {
	const sorted = [...points].sort((a, b) => a.settledAt - b.settledAt);
	return days.map((_, i) => {
		const end = dayEnd(days, i);
		const start = end - windowSecs;
		let sum = 0;
		for (const point of sorted) {
			if (point.settledAt >= end) break;
			if (point.settledAt >= start) sum += point.roi;
		}
		return sum;
	});
}

export interface EraMarker {
	dayIndex: number;
	label: string;
}

/**
 * One marker per strategy era whose first-ever settle lands inside the grid.
 * Eras that began before the grid get no marker (the whole range is theirs).
 */
export function eraMarkers(
	points: SettledPoint[],
	days: number[],
): EraMarker[] {
	if (days.length === 0) return [];
	const firstSettleByEra = new Map<string, number>();
	for (const point of points) {
		const match = /^v(\d+)/.exec(point.strategyVersion ?? "");
		if (!match) continue;
		const era = `v${match[1]}`;
		const existing = firstSettleByEra.get(era);
		if (existing === undefined || point.settledAt < existing) {
			firstSettleByEra.set(era, point.settledAt);
		}
	}
	const gridStart = days[0];
	const gridEnd = dayEnd(days, days.length - 1);
	const markers: EraMarker[] = [];
	for (const [label, settledAt] of firstSettleByEra) {
		if (settledAt < gridStart || settledAt >= gridEnd) continue;
		let dayIndex = days.length - 1;
		for (let i = 0; i < days.length; i += 1) {
			if (settledAt < dayEnd(days, i)) {
				dayIndex = i;
				break;
			}
		}
		markers.push({ dayIndex, label });
	}
	return markers.sort((a, b) => a.dayIndex - b.dayIndex);
}
