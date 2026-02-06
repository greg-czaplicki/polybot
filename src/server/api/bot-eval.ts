import { createServerFn } from "@tanstack/react-start";
import {
	computeSignalScoreFromWindow,
	MIN_EDGE_RATING,
	signalScoreToGradeLabel,
	type GradeLabel,
} from "../../lib/sharp-grade";
import type { Db } from "../db/client";
import { getDb, nowUnixSeconds } from "../env";
import { listSharpMoneyHistorySince, type SharpMoneyHistoryEntry } from "../repositories/sharp-money";
import { computePriceEdgeFromEntry } from "./sharp-money";

const DEFAULT_EVAL_WINDOW_HOURS = 24;
const DEFAULT_EVAL_HORIZON_MINUTES = 15;
const DEFAULT_EVAL_HISTORY_WINDOW_MINUTES = 60;
const MAX_EVAL_ROWS = 20_000;
const MIN_MARKET_QUALITY_SCORE = 0.58;
const DEFAULT_SWEEP_THRESHOLDS = [0.58, 0.62, 0.66, 0.7];
const GRADE_RANK: Record<GradeLabel, number> = {
	"A+": 5,
	"A": 4,
	"B": 3,
	"C": 2,
	"D": 1,
};

export type BotEvalPayload = {
	windowHours?: number;
	horizonMinutes?: number;
	historyWindowMinutes?: number;
	minGrade?: GradeLabel;
	includeStarted?: boolean;
	limit?: number;
	sweepThresholds?: number[];
};

function clampUnit(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function normalizeMarketPrice(price?: number | null): number | null {
	if (typeof price !== "number" || !Number.isFinite(price)) return null;
	if (price <= 0 || price >= 1) return null;
	return price;
}

function parseEventTime(value?: string | null): Date | null {
	if (!value) return null;
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return new Date(`${value}T23:59:59Z`);
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function computeMarketQualityScore(entry: {
	sharpSide: "A" | "B" | "EVEN";
	sideA: { price?: number | null };
	sideB: { price?: number | null };
	marketVolume?: number;
	marketLiquidity?: number;
}): number {
	const sideAPrice = normalizeMarketPrice(entry.sideA.price);
	const sideBPrice = normalizeMarketPrice(entry.sideB.price);
	const hasBothPrices = sideAPrice !== null && sideBPrice !== null;
	const complementGap = hasBothPrices
		? Math.abs(sideAPrice + sideBPrice - 1)
		: 0.08;
	const complementScore = hasBothPrices ? clampUnit(1 - complementGap / 0.08) : 0.45;
	const sharpSidePrice =
		entry.sharpSide === "A"
			? sideAPrice
			: entry.sharpSide === "B"
				? sideBPrice
				: null;
	const priceBandScore =
		sharpSidePrice === null
			? 0.5
			: clampUnit(1 - Math.abs(sharpSidePrice - 0.5) / 0.4);
	let depthScore = 0.5;
	if (
		typeof entry.marketLiquidity === "number" &&
		Number.isFinite(entry.marketLiquidity) &&
		entry.marketLiquidity > 0 &&
		typeof entry.marketVolume === "number" &&
		Number.isFinite(entry.marketVolume) &&
		entry.marketVolume > 0
	) {
		const depthRatio = entry.marketLiquidity / Math.max(entry.marketVolume, 1);
		depthScore = clampUnit(depthRatio / 0.35);
	} else if (
		typeof entry.marketLiquidity === "number" &&
		Number.isFinite(entry.marketLiquidity) &&
		entry.marketLiquidity > 0
	) {
		depthScore = clampUnit(entry.marketLiquidity / 200_000);
	}
	return clampUnit(
		complementScore * 0.45 + depthScore * 0.35 + priceBandScore * 0.2,
	);
}

function getSharpSidePrice(entry: SharpMoneyHistoryEntry): number | null {
	if (entry.sharpSide === "A") return normalizeMarketPrice(entry.sideA.price);
	if (entry.sharpSide === "B") return normalizeMarketPrice(entry.sideB.price);
	return null;
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = values.slice().sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 0) {
		return (sorted[mid - 1] + sorted[mid]) / 2;
	}
	return sorted[mid];
}

type EvalAccumulator = {
	triggered: number;
	resolved: number;
	hits: number;
	movesBps: number[];
	byGrade: Record<
		string,
		{
			triggered: number;
			resolved: number;
			hits: number;
			movesBps: number[];
		}
	>;
	byHourToStart: Record<
		string,
		{
			triggered: number;
			resolved: number;
			hits: number;
			movesBps: number[];
		}
	>;
};

function initEvalAccumulator(): EvalAccumulator {
	return {
		triggered: 0,
		resolved: 0,
		hits: 0,
		movesBps: [],
		byGrade: {},
		byHourToStart: {},
	};
}

function getHourToStartBucket(
	eventTime: Date | null,
	recordedAtSeconds: number,
): string {
	if (!eventTime) return "unknown";
	const hoursToStart = (eventTime.getTime() / 1000 - recordedAtSeconds) / 3600;
	if (hoursToStart < 0) return "started";
	if (hoursToStart <= 0.25) return "0-15m";
	if (hoursToStart <= 1) return "15-60m";
	if (hoursToStart <= 3) return "1-3h";
	return "3h+";
}

function ensureBucket(
	record: Record<
		string,
		{
			triggered: number;
			resolved: number;
			hits: number;
			movesBps: number[];
		}
	>,
	key: string,
): {
	triggered: number;
	resolved: number;
	hits: number;
	movesBps: number[];
} {
	if (!record[key]) {
		record[key] = {
			triggered: 0,
			resolved: 0,
			hits: 0,
			movesBps: [],
		};
	}
	return record[key];
}

function addEvalPoint(
	acc: EvalAccumulator,
	grade: GradeLabel,
	hourToStartBucket: string,
	moveBps: number | null,
): void {
	acc.triggered += 1;
	const gradeBucket = ensureBucket(acc.byGrade, grade);
	const hourBucket = ensureBucket(acc.byHourToStart, hourToStartBucket);
	gradeBucket.triggered += 1;
	hourBucket.triggered += 1;
	if (moveBps === null) return;
	acc.resolved += 1;
	acc.movesBps.push(moveBps);
	if (moveBps > 0) acc.hits += 1;
	gradeBucket.resolved += 1;
	hourBucket.resolved += 1;
	if (moveBps > 0) {
		gradeBucket.hits += 1;
		hourBucket.hits += 1;
	}
	gradeBucket.movesBps.push(moveBps);
	hourBucket.movesBps.push(moveBps);
}

function finalizeEval(acc: EvalAccumulator) {
	const avgMoveBps =
		acc.movesBps.length > 0
			? acc.movesBps.reduce((sum, value) => sum + value, 0) / acc.movesBps.length
			: null;
	const byGrade = Object.fromEntries(
		Object.entries(acc.byGrade).map(([grade, bucket]) => {
			const bucketAvgMoveBps =
				bucket.movesBps.length > 0
					? bucket.movesBps.reduce((sum, value) => sum + value, 0) /
						bucket.movesBps.length
					: null;
			return [
				grade,
				{
					triggered: bucket.triggered,
					resolved: bucket.resolved,
					hitRate: bucket.resolved > 0 ? bucket.hits / bucket.resolved : null,
					avgMoveBps: bucketAvgMoveBps,
					medianMoveBps: median(bucket.movesBps),
				},
			];
		}),
	);
	const byHourToStart = Object.fromEntries(
		Object.entries(acc.byHourToStart).map(([bucketLabel, bucket]) => {
			const bucketAvgMoveBps =
				bucket.movesBps.length > 0
					? bucket.movesBps.reduce((sum, value) => sum + value, 0) /
						bucket.movesBps.length
					: null;
			return [
				bucketLabel,
				{
					triggered: bucket.triggered,
					resolved: bucket.resolved,
					hitRate: bucket.resolved > 0 ? bucket.hits / bucket.resolved : null,
					avgMoveBps: bucketAvgMoveBps,
					medianMoveBps: median(bucket.movesBps),
				},
			];
		}),
	);
	return {
		triggered: acc.triggered,
		resolved: acc.resolved,
		hitRate: acc.resolved > 0 ? acc.hits / acc.resolved : null,
		avgMoveBps,
		medianMoveBps: median(acc.movesBps),
		byGrade,
		byHourToStart,
	};
}

function normalizeSweepThresholds(values?: number[]): number[] {
	if (!Array.isArray(values) || values.length === 0) {
		return DEFAULT_SWEEP_THRESHOLDS;
	}
	const normalized = values
		.filter((value) => typeof value === "number" && Number.isFinite(value))
		.map((value) => Math.max(0, Math.min(1, value)));
	if (normalized.length === 0) return DEFAULT_SWEEP_THRESHOLDS;
	return Array.from(new Set(normalized)).sort((a, b) => a - b);
}

export async function computeBotEval(db: Db, payload?: BotEvalPayload) {
	const minGrade = payload?.minGrade ?? "A";
	const windowHours =
		typeof payload?.windowHours === "number" &&
		Number.isFinite(payload.windowHours) &&
		payload.windowHours > 0
			? payload.windowHours
			: DEFAULT_EVAL_WINDOW_HOURS;
	const horizonMinutes =
		typeof payload?.horizonMinutes === "number" &&
		Number.isFinite(payload.horizonMinutes) &&
		payload.horizonMinutes > 0
			? payload.horizonMinutes
			: DEFAULT_EVAL_HORIZON_MINUTES;
	const historyWindowMinutes =
		typeof payload?.historyWindowMinutes === "number" &&
		Number.isFinite(payload.historyWindowMinutes) &&
		payload.historyWindowMinutes > 0
			? payload.historyWindowMinutes
			: DEFAULT_EVAL_HISTORY_WINDOW_MINUTES;
	const includeStarted = payload?.includeStarted === true;
	const limit =
		typeof payload?.limit === "number" &&
		Number.isFinite(payload.limit) &&
		payload.limit > 0
			? Math.min(payload.limit, MAX_EVAL_ROWS)
			: 5000;
	const sinceSeconds = nowUnixSeconds() - Math.floor(windowHours * 60 * 60);
	const horizonSeconds = Math.floor(horizonMinutes * 60);
	const minGradeRank = GRADE_RANK[minGrade];
	const sweepThresholds = normalizeSweepThresholds(payload?.sweepThresholds);

	const historyRows = await listSharpMoneyHistorySince(db, sinceSeconds, limit);
	const byConditionId = new Map<string, SharpMoneyHistoryEntry[]>();
	for (const row of historyRows) {
		if (!byConditionId.has(row.conditionId)) {
			byConditionId.set(row.conditionId, []);
		}
		byConditionId.get(row.conditionId)?.push(row);
	}
	for (const rows of byConditionId.values()) {
		rows.sort((a, b) => a.recordedAt - b.recordedAt);
	}

	const baseline = initEvalAccumulator();
	const filtered = initEvalAccumulator();
	const sweepAccumulators = new Map<number, EvalAccumulator>(
		sweepThresholds.map((threshold) => [threshold, initEvalAccumulator()]),
	);
	let eligibleSnapshots = 0;

	for (const rows of byConditionId.values()) {
		let windowStart = 0;
		let futureIndex = 0;
		for (let i = 0; i < rows.length; i += 1) {
			const snapshot = rows[i];
			if (snapshot.sharpSide === "EVEN") continue;
			if (!includeStarted) {
				const eventTime = parseEventTime(snapshot.eventTime);
				if (eventTime && eventTime.getTime() <= snapshot.recordedAt * 1000) {
					continue;
				}
			}
			while (
				windowStart < i &&
				rows[windowStart].recordedAt < snapshot.recordedAt - historyWindowMinutes * 60
			) {
				windowStart += 1;
			}
			const scoreWindow = rows.slice(windowStart, i + 1);
			const signalScore = computeSignalScoreFromWindow(
				{
					edgeRating: snapshot.edgeRating,
					scoreDifferential: snapshot.scoreDifferential,
					sideA: { totalValue: snapshot.sideA.totalValue },
					sideB: { totalValue: snapshot.sideB.totalValue },
				},
				scoreWindow.map((entry) => ({
					edgeRating: entry.edgeRating,
					scoreDifferential: entry.scoreDifferential,
					sideA: { totalValue: entry.sideA.totalValue },
					sideB: { totalValue: entry.sideB.totalValue },
				})),
				MIN_EDGE_RATING,
			);
			const grade = signalScoreToGradeLabel(signalScore, {
				edgeRating: snapshot.edgeRating,
				scoreDifferential: snapshot.scoreDifferential,
			});
			if (GRADE_RANK[grade] < minGradeRank) continue;
			const priceEdge = computePriceEdgeFromEntry({
				sharpSide: snapshot.sharpSide,
				confidence: snapshot.confidence,
				edgeRating: snapshot.edgeRating,
				sideA: {
					sharpScore: snapshot.sideA.sharpScore,
					price: snapshot.sideA.price,
				},
				sideB: {
					sharpScore: snapshot.sideB.sharpScore,
					price: snapshot.sideB.price,
				},
			});
			const hasPriceEdge =
				priceEdge.priceEdge !== null &&
				priceEdge.minPriceEdge !== null &&
				priceEdge.priceEdge >= priceEdge.minPriceEdge;
			if (!hasPriceEdge) continue;

			eligibleSnapshots += 1;
			const eventTime = parseEventTime(snapshot.eventTime);
			const hourToStartBucket = getHourToStartBucket(eventTime, snapshot.recordedAt);
			const qualityScore = computeMarketQualityScore({
				sharpSide: snapshot.sharpSide,
				sideA: { price: snapshot.sideA.price },
				sideB: { price: snapshot.sideB.price },
			});
			const passesFiltered = qualityScore >= MIN_MARKET_QUALITY_SCORE;

			const targetTime = snapshot.recordedAt + horizonSeconds;
			if (futureIndex < i + 1) futureIndex = i + 1;
			while (futureIndex < rows.length && rows[futureIndex].recordedAt < targetTime) {
				futureIndex += 1;
			}
			let moveBps: number | null = null;
			if (futureIndex < rows.length) {
				const entryPrice = getSharpSidePrice(snapshot);
				const exitPrice = getSharpSidePrice(rows[futureIndex]);
				if (entryPrice !== null && exitPrice !== null) {
					moveBps = (exitPrice - entryPrice) * 10_000;
				}
			}

			addEvalPoint(baseline, grade, hourToStartBucket, moveBps);
			if (passesFiltered) {
				addEvalPoint(filtered, grade, hourToStartBucket, moveBps);
			}
			for (const threshold of sweepThresholds) {
				if (qualityScore < threshold) continue;
				const acc = sweepAccumulators.get(threshold);
				if (!acc) continue;
				addEvalPoint(acc, grade, hourToStartBucket, moveBps);
			}
		}
	}

	const baselineFinal = finalizeEval(baseline);
	const filteredFinal = finalizeEval(filtered);
	const thresholdSweep = sweepThresholds.map((threshold) => {
		const result = finalizeEval(sweepAccumulators.get(threshold) ?? initEvalAccumulator());
		return {
			threshold,
			...result,
			retainedRate:
				baselineFinal.triggered > 0
					? result.triggered / baselineFinal.triggered
					: null,
			avgMoveDeltaBps:
				result.avgMoveBps !== null && baselineFinal.avgMoveBps !== null
					? result.avgMoveBps - baselineFinal.avgMoveBps
					: null,
		};
	});

	return {
		computedAt: nowUnixSeconds(),
		windowHours,
		horizonMinutes,
		historyWindowMinutes,
		minGrade,
		includeStarted,
		totalHistoryRows: historyRows.length,
		eligibleSnapshots,
		strategies: {
			baseline: baselineFinal,
			filtered: filteredFinal,
		},
		thresholdSweep,
	};
}

export const getBotEvalFn = createServerFn({ method: "POST" }).handler(
	async ({ context, data }) => {
		const db = getDb(context);
		return computeBotEval(db, (data ?? {}) as BotEvalPayload);
	},
);
