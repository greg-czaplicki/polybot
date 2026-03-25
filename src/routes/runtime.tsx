import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AuthGate } from "@/components/auth-gate";
import { getBotCandidatesFn } from "../server/api/bot";
import { getBotEvalFn } from "../server/api/bot-eval";
import {
	getManualPicksBucketPerformanceFn,
	getManualPicksCalibrationFn,
	getManualPicksClvTimingFn,
	getManualPicksGradeRecalibrationFn,
	getManualPicksMarketTypePerformanceFn,
	getManualPicksShadowWindowsFn,
	getManualPicksSportPerformanceFn,
} from "../server/api/manual-picks";
import {
	backfillSharpMoneyHistoryFn,
	fetchTrendingSportsMarketsFn,
	getRuntimeMarketStatsFn,
} from "../server/api/sharp-money";

export const Route = createFileRoute("/runtime")({
	component: RuntimePage,
});

const USD_COMPACT_FORMATTER = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	notation: "compact",
	maximumFractionDigits: 1,
});

function formatUsdCompact(value: number): string {
	return USD_COMPACT_FORMATTER.format(value);
}

function formatRelativeTime(timestamp?: number): string {
	if (!timestamp) return "Never";
	const now = Math.floor(Date.now() / 1000);
	const diff = now - timestamp;
	if (diff < 60) return "Just now";
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	return `${Math.floor(diff / 86400)}d ago`;
}

function formatPercent(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value))
		return "—";
	return `${(value * 100).toFixed(1)}%`;
}

function formatSignedPercent(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value))
		return "—";
	const percent = value * 100;
	return `${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%`;
}

function formatBps(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value))
		return "—";
	return `${value.toFixed(1)} bps`;
}

function formatMinutesToStart(eventTime?: string): string {
	if (!eventTime) return "—";
	const eventTimeMs = new Date(eventTime).getTime();
	if (!Number.isFinite(eventTimeMs)) return "—";
	const minutes = Math.round((eventTimeMs - Date.now()) / 60000);
	return `${minutes}m`;
}

function coverageStatus(
	covered: number,
	total: number,
): { label: "good" | "ok" | "low"; className: string; ratio: number } {
	if (total <= 0) {
		return {
			label: "low",
			className: "border-rose-500/40 bg-rose-500/10 text-rose-200",
			ratio: 0,
		};
	}
	const ratio = covered / total;
	if (ratio >= 0.8) {
		return {
			label: "good",
			className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
			ratio,
		};
	}
	if (ratio >= 0.4) {
		return {
			label: "ok",
			className: "border-amber-500/40 bg-amber-500/10 text-amber-200",
			ratio,
		};
	}
	return {
		label: "low",
		className: "border-rose-500/40 bg-rose-500/10 text-rose-200",
		ratio,
	};
}

function sampleClassName(count: number): string {
	if (count < 20) return "bg-rose-950/20";
	if (count < 50) return "bg-amber-950/20";
	return "";
}

function sampleBadge(count: number): string | null {
	if (count < 20) return "low sample";
	if (count < 50) return "small sample";
	return null;
}

function describeError(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "string" && error) return error;
	try {
		return JSON.stringify(error);
	} catch {
		return "unknown_error";
	}
}

function topEntries(record: Record<string, number>, limit: number = 5) {
	return Object.entries(record)
		.sort((left, right) => right[1] - left[1])
		.slice(0, limit);
}

type RuntimeStats = {
	fetchedAt: number;
	totalMarkets: number;
	expandedEventCount: number;
	expandedMarketCount: number;
	tagStats: Array<{
		tag: string;
		seriesId: number;
		count: number;
		markets: Array<{
			title: string;
			volume: number;
			eventSlug?: string;
			slug?: string;
		}>;
	}>;
	combinedTagStats: Array<{
		tag: string;
		count: number;
		markets: Array<{
			title: string;
			volume: number;
			eventSlug?: string;
			slug?: string;
		}>;
	}>;
	filteredTagStats: Array<{
		tag: string;
		count: number;
		markets: Array<{
			title: string;
			volume: number;
			eventSlug?: string;
			slug?: string;
		}>;
	}>;
	eventStats: Array<{
		tag: string;
		seriesId: number;
		eventCount: number;
		marketCount: number;
	}>;
	eventDetails: Array<{
		tag: string;
		seriesId: number;
		eventSlug: string;
		eventTitle: string;
		marketCount: number;
		rawMarketCount: number;
	}>;
	retryCount: number;
	failureCount: number;
	totalRuns: number;
	totalRetries: number;
	totalFailures: number;
	paginationCapHits: Array<{
		tag: string;
		seriesId: number;
		eventCount: number;
	}>;
	cacheFreshness?: {
		total: number;
		missingHistory: number;
		staleHistory: number;
	};
};

type EvalBucket = {
	triggered: number;
	resolved: number;
	hitRate: number | null;
	avgMoveBps: number | null;
	medianMoveBps: number | null;
};

type EvalStrategy = {
	triggered: number;
	resolved: number;
	hitRate: number | null;
	avgMoveBps: number | null;
	medianMoveBps: number | null;
	byGrade: Record<string, EvalBucket>;
	byHourToStart: Record<string, EvalBucket>;
};

type EvalResult = {
	computedAt: number;
	windowHours: number;
	horizonMinutes: number;
	historyWindowMinutes: number;
	minGrade: string;
	includeStarted: boolean;
	filteredQualityThreshold: number;
	totalHistoryRows: number;
	eligibleSnapshots: number;
	strategies: {
		baseline: EvalStrategy;
		filtered: EvalStrategy;
	};
	thresholdSweep: Array<{
		threshold: number;
		triggered: number;
		resolved: number;
		hitRate: number | null;
		avgMoveBps: number | null;
		medianMoveBps: number | null;
		retainedRate: number | null;
		avgMoveDeltaBps: number | null;
	}>;
};

type CalibrationBucket = {
	label: string;
	count: number;
	wins: number;
	losses: number;
	pushes: number;
	winRate: number | null;
	avgRoi: number | null;
	avgClvBps: number | null;
};

type CalibrationResult = {
	computedAt: number;
	totalPicks: number;
	settledPicks: number;
	withSignalScore: number;
	withQualityScore: number;
	withEventTime: number;
	bySignalScore: CalibrationBucket[];
	byQualityScore: CalibrationBucket[];
	byTimeToStart: CalibrationBucket[];
};

type PerformanceBucket = {
	bucket: string;
	count: number;
	wins: number;
	losses: number;
	pushes: number;
	hitRate: number | null;
	avgRoi: number | null;
	avgClvBps: number | null;
};

type BucketPerformanceResult = {
	computedAt: number;
	settledPicks: number;
	byTimeToStart: PerformanceBucket[];
	bySignalScore: PerformanceBucket[];
	byL2ImbalanceNearMid: PerformanceBucket[];
	byL2Disagreement: PerformanceBucket[];
};

type ClvTimingSegment = {
	key: string;
	label: string;
	matchedPicks: number;
	withEventTime: number;
	byTimeToStart: PerformanceBucket[];
};

type ClvTimingResult = {
	computedAt: number;
	settledPicks: number;
	qualityThreshold: number;
	segments: ClvTimingSegment[];
};

type ShadowWindowRow = {
	windowKey: string;
	windowLabel: string;
	leadMinutes: number | null;
	count: number;
	wins: number;
	losses: number;
	pushes: number;
	hitRate: number | null;
	avgRoi: number | null;
	avgClvBps: number | null;
};

type ShadowWindowSegment = {
	key: string;
	label: string;
	matchedPicks: number;
	rows: ShadowWindowRow[];
};

type ShadowWindowResult = {
	computedAt: number;
	settledPicks: number;
	qualityThreshold: number;
	segments: ShadowWindowSegment[];
};

type SportPerformanceRow = {
	sportTag: string;
	label: string;
	seriesId?: number;
	totalCount: number;
	winRate: number | null;
	avgRoi: number | null;
	avgClvBps: number | null;
	qualityCount: number;
	qualityWinRate: number | null;
	qualityAvgRoi: number | null;
	qualityAvgClvBps: number | null;
};

type SportPerformanceResult = {
	computedAt: number;
	settledPicks: number;
	qualityThreshold: number;
	rows: SportPerformanceRow[];
};

type MarketTypePerformanceRow = {
	marketType: string;
	label: string;
	totalCount: number;
	winRate: number | null;
	avgRoi: number | null;
	avgClvBps: number | null;
	qualityCount: number;
	qualityWinRate: number | null;
	qualityAvgRoi: number | null;
	qualityAvgClvBps: number | null;
};

type MarketTypePerformanceResult = {
	computedAt: number;
	settledPicks: number;
	qualityThreshold: number;
	rows: MarketTypePerformanceRow[];
};

type GradeRecalibrationRow = {
	grade: string;
	count: number;
	wins: number;
	losses: number;
	pushes: number;
	winRate: number | null;
	avgRoi: number | null;
	avgClvBps: number | null;
	avgSignalScore: number | null;
	minSignalScore: number | null;
	maxSignalScore: number | null;
};

type GradeRecalibrationResult = {
	computedAt: number;
	settledPicks: number;
	rows: GradeRecalibrationRow[];
	observations: string[];
};

type CandidateDebugCandidate = {
	entry: {
		conditionId: string;
		marketTitle: string;
		marketSlug?: string;
		eventSlug?: string;
		sportSeriesId?: number;
		eventTime?: string;
		sharpSide: "A" | "B" | "EVEN";
		marketType: string;
		sideA: {
			label: string;
			price: number | null;
		};
		sideB: {
			label: string;
			price: number | null;
		};
		sharpSidePrice: number | null;
		edgeRating: number;
		scoreDifferential: number;
	};
	grade: {
		grade: string;
		signalScore?: number;
		edgeRating?: number;
		scoreDifferential?: number;
		microstructureScore?: number;
		isReady?: boolean;
		warnings?: string[];
		computedAt?: number;
		historyUpdatedAt?: number;
	};
};

type CandidateNearMiss = {
	reason: string;
	conditionId: string;
	marketTitle: string;
	sportSeriesId?: number;
	marketType: string;
	sharpSide: "A" | "B" | "EVEN";
	sharpSidePrice: number | null;
	grade?: string;
	policyMinGrade?: string;
	signalScore?: number;
	marketQualityScore?: number;
	minutesToStart?: number | null;
	l2ImbalanceNearMid?: number | null;
	l2Disagreement?: boolean | null;
};

type CandidateDebugResult = {
	candidates: CandidateDebugCandidate[];
	requested: number;
	returned: number;
	debug: {
		totalEntries: number;
		upcomingEntries: number;
		candidatesBeforeDedup: number;
		returnedAfterDedup: number;
		excluded: Record<string, number>;
		dedupDropped: number;
		dedupReasons: Record<string, number>;
		policyMatched: Record<string, number>;
		returnedByMarketType: Record<string, number>;
		returnedByTimingBucket: Record<string, number>;
		returnedBySportSeries: Record<string, number>;
		nearMisses: CandidateNearMiss[];
	};
};

type SnapshotRuntimeSummary =
	| {
			fetchedAt: number;
			filteredMarketsWindow: number;
			expandedEventCount: number;
			expandedMarketCount: number;
			retryCount: number;
			failureCount: number;
			totalRuns: number;
			totalRetries: number;
			totalFailures: number;
			cacheFreshness: RuntimeStats["cacheFreshness"] | null;
	  }
	| {
			error: string;
	  }
	| null;

function RuntimePage() {
	const [stats, setStats] = useState<RuntimeStats | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [isBackfilling, setIsBackfilling] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [backfillResult, setBackfillResult] = useState<string | null>(null);

	const [evalResult, setEvalResult] = useState<EvalResult | null>(null);
	const [isEvaluating, setIsEvaluating] = useState(false);
	const [evalError, setEvalError] = useState<string | null>(null);
	const [evalWindowHours, setEvalWindowHours] = useState("24");
	const [evalHorizonMinutes, setEvalHorizonMinutes] = useState("15");
	const [evalHistoryWindowMinutes, setEvalHistoryWindowMinutes] =
		useState("60");
	const [evalMinGrade, setEvalMinGrade] = useState<
		"A+" | "A" | "B" | "C" | "D"
	>("A");
	const [evalIncludeStarted, setEvalIncludeStarted] = useState(false);
	const [evalSweepThresholds, setEvalSweepThresholds] = useState(
		"0.58,0.62,0.66,0.70",
	);

	const [calibrationResult, setCalibrationResult] =
		useState<CalibrationResult | null>(null);
	const [isCalibrationLoading, setIsCalibrationLoading] = useState(false);
	const [calibrationError, setCalibrationError] = useState<string | null>(null);
	const [calibrationLimit, setCalibrationLimit] = useState("2000");
	const isCalibrationLoadingRef = useRef(false);
	const [bucketPerformanceResult, setBucketPerformanceResult] =
		useState<BucketPerformanceResult | null>(null);
	const [isBucketPerformanceLoading, setIsBucketPerformanceLoading] =
		useState(false);
	const [bucketPerformanceError, setBucketPerformanceError] = useState<
		string | null
	>(null);
	const isBucketPerformanceLoadingRef = useRef(false);
	const [clvTimingResult, setClvTimingResult] =
		useState<ClvTimingResult | null>(null);
	const [isClvTimingLoading, setIsClvTimingLoading] = useState(false);
	const [clvTimingError, setClvTimingError] = useState<string | null>(null);
	const [clvQualityThreshold, setClvQualityThreshold] = useState("0.66");
	const isClvTimingLoadingRef = useRef(false);
	const [shadowWindowResult, setShadowWindowResult] =
		useState<ShadowWindowResult | null>(null);
	const [isShadowWindowLoading, setIsShadowWindowLoading] = useState(false);
	const [shadowWindowError, setShadowWindowError] = useState<string | null>(
		null,
	);
	const isShadowWindowLoadingRef = useRef(false);
	const [sportPerformanceResult, setSportPerformanceResult] =
		useState<SportPerformanceResult | null>(null);
	const [isSportPerformanceLoading, setIsSportPerformanceLoading] =
		useState(false);
	const [sportPerformanceError, setSportPerformanceError] = useState<
		string | null
	>(null);
	const isSportPerformanceLoadingRef = useRef(false);
	const [marketTypePerformanceResult, setMarketTypePerformanceResult] =
		useState<MarketTypePerformanceResult | null>(null);
	const [isMarketTypePerformanceLoading, setIsMarketTypePerformanceLoading] =
		useState(false);
	const [marketTypePerformanceError, setMarketTypePerformanceError] = useState<
		string | null
	>(null);
	const isMarketTypePerformanceLoadingRef = useRef(false);
	const [gradeRecalibrationResult, setGradeRecalibrationResult] =
		useState<GradeRecalibrationResult | null>(null);
	const [isGradeRecalibrationLoading, setIsGradeRecalibrationLoading] =
		useState(false);
	const [gradeRecalibrationError, setGradeRecalibrationError] = useState<
		string | null
	>(null);
	const isGradeRecalibrationLoadingRef = useRef(false);
	const [candidateDebugResult, setCandidateDebugResult] =
		useState<CandidateDebugResult | null>(null);
	const [isCandidateDebugLoading, setIsCandidateDebugLoading] = useState(false);
	const [candidateDebugError, setCandidateDebugError] = useState<string | null>(
		null,
	);
	const [copySnapshotStatus, setCopySnapshotStatus] = useState<string | null>(
		null,
	);
	const [isCopyingSnapshot, setIsCopyingSnapshot] = useState(false);
	const [sinceFilter, setSinceFilter] = useState<string>("");
	const sincePickedAtRef = useRef<number | undefined>(undefined);

	const filteredTotalMarkets = stats?.filteredTagStats
		? stats.filteredTagStats.reduce((sum, entry) => sum + entry.count, 0)
		: 0;

	const evalHourBuckets = useMemo(
		() =>
			evalResult
				? Array.from(
						new Set([
							...Object.keys(evalResult.strategies.baseline.byHourToStart),
							...Object.keys(evalResult.strategies.filtered.byHourToStart),
						]),
					)
				: [],
		[evalResult],
	);
	const ncaabSportRow = useMemo(
		() =>
			sportPerformanceResult?.rows.find(
				(row) =>
					row.seriesId === 10470 ||
					row.sportTag === "series_10470" ||
					row.label.toLowerCase().includes("ncaab"),
			) ?? null,
		[sportPerformanceResult],
	);

	const coverageHealth = useMemo(() => {
		const settled = calibrationResult?.settledPicks ?? 0;
		const signalCovered = calibrationResult?.withSignalScore ?? 0;
		const qualityCovered = calibrationResult?.withQualityScore ?? 0;
		const eventTimeCovered = calibrationResult?.withEventTime ?? 0;
		const l2ImbalanceCovered =
			bucketPerformanceResult?.byL2ImbalanceNearMid.reduce(
				(sum, row) => sum + row.count,
				0,
			) ?? 0;
		const l2DisagreementCovered =
			bucketPerformanceResult?.byL2Disagreement.reduce(
				(sum, row) => sum + row.count,
				0,
			) ?? 0;

		return [
			{
				key: "signal",
				label: "Signal",
				covered: signalCovered,
				total: settled,
				status: coverageStatus(signalCovered, settled),
			},
			{
				key: "quality",
				label: "Quality",
				covered: qualityCovered,
				total: settled,
				status: coverageStatus(qualityCovered, settled),
			},
			{
				key: "event-time",
				label: "Event Time",
				covered: eventTimeCovered,
				total: settled,
				status: coverageStatus(eventTimeCovered, settled),
			},
			{
				key: "l2-imbalance",
				label: "L2 Imbalance",
				covered: l2ImbalanceCovered,
				total: settled,
				status: coverageStatus(l2ImbalanceCovered, settled),
			},
			{
				key: "l2-disagreement",
				label: "L2 Disagree",
				covered: l2DisagreementCovered,
				total: settled,
				status: coverageStatus(l2DisagreementCovered, settled),
			},
		] as const;
	}, [calibrationResult, bucketPerformanceResult]);

	const candidatePolicyRows = useMemo(() => {
		if (!candidateDebugResult) return [];
		return Object.entries(candidateDebugResult.debug.policyMatched)
			.sort((left, right) => right[1] - left[1])
			.slice(0, 8);
	}, [candidateDebugResult]);

	const candidateReturnedBreakdowns = useMemo(() => {
		if (!candidateDebugResult) return [];
		return [
			{
				title: "Returned by market type",
				rows: Object.entries(
					candidateDebugResult.debug.returnedByMarketType,
				).sort((left, right) => right[1] - left[1]),
			},
			{
				title: "Returned by timing bucket",
				rows: Object.entries(
					candidateDebugResult.debug.returnedByTimingBucket,
				).sort((left, right) => right[1] - left[1]),
			},
			{
				title: "Returned by sport series",
				rows: Object.entries(
					candidateDebugResult.debug.returnedBySportSeries,
				).sort((left, right) => right[1] - left[1]),
			},
		];
	}, [candidateDebugResult]);
	const returnedCandidates = useMemo(
		() => candidateDebugResult?.candidates.slice(0, 5) ?? [],
		[candidateDebugResult],
	);
	const nearMissCandidates = useMemo(
		() => candidateDebugResult?.debug.nearMisses.slice(0, 5) ?? [],
		[candidateDebugResult],
	);

	const loadStats = useCallback(async () => {
		setError(null);
		try {
			const result = await getRuntimeMarketStatsFn({
				data: { freshnessWindowHours: 24 },
			});
			setStats((result.stats ?? null) as RuntimeStats | null);
		} catch (err) {
			console.error("Failed to load runtime stats", err);
			setError("Failed to load runtime stats");
		}
	}, []);

	const loadCandidateDebug = useCallback(async () => {
		setIsCandidateDebugLoading(true);
		setCandidateDebugError(null);
		try {
			const result = await getBotCandidatesFn({
				data: {
					minGrade: "B",
					windowMinutes: 90,
					minMinutesToStart: 15,
					maxMinutesToStart: 75,
					limit: 100,
					requireReady: true,
					includeStarted: true,
					requireMicrostructure: true,
					marketQualityThreshold: 0.7,
				},
			});
			if ("error" in result) {
				throw new Error(result.error);
			}
			setCandidateDebugResult(result as CandidateDebugResult);
		} catch (err) {
			console.error("Failed to load candidate debug", err);
			setCandidateDebugError("Failed to load candidate debug");
		} finally {
			setIsCandidateDebugLoading(false);
		}
	}, []);

	const loadCalibration = useCallback(async (requestedLimit?: number) => {
		if (isCalibrationLoadingRef.current) return;
		isCalibrationLoadingRef.current = true;
		setIsCalibrationLoading(true);
		setCalibrationError(null);
		try {
			const limitValue = requestedLimit ?? 2000;
			const result = await getManualPicksCalibrationFn({
				data: {
					limit:
						Number.isFinite(limitValue) && limitValue > 0 ? limitValue : 2000,
					sincePickedAt: sincePickedAtRef.current,
				},
			});
			setCalibrationResult(
				(result.calibration ?? null) as CalibrationResult | null,
			);
		} catch (err) {
			console.error("Failed to load pick calibration", err);
			setCalibrationError("Failed to load pick calibration");
		} finally {
			setIsCalibrationLoading(false);
			isCalibrationLoadingRef.current = false;
		}
	}, []);

	const loadBucketPerformance = useCallback(async (requestedLimit?: number) => {
		if (isBucketPerformanceLoadingRef.current) return;
		isBucketPerformanceLoadingRef.current = true;
		setIsBucketPerformanceLoading(true);
		setBucketPerformanceError(null);
		try {
			const limitValue = requestedLimit ?? 2000;
			const result = await getManualPicksBucketPerformanceFn({
				data: {
					limit:
						Number.isFinite(limitValue) && limitValue > 0 ? limitValue : 2000,
					sincePickedAt: sincePickedAtRef.current,
				},
			});
			setBucketPerformanceResult(
				(result.performance ?? null) as BucketPerformanceResult | null,
			);
		} catch (err) {
			console.error("Failed to load bucket performance", err);
			setBucketPerformanceError("Failed to load bucket performance");
		} finally {
			setIsBucketPerformanceLoading(false);
			isBucketPerformanceLoadingRef.current = false;
		}
	}, []);

	const loadClvTiming = useCallback(
		async (requestedLimit?: number, requestedThreshold?: number) => {
			if (isClvTimingLoadingRef.current) return;
			isClvTimingLoadingRef.current = true;
			setIsClvTimingLoading(true);
			setClvTimingError(null);
			try {
				const limitValue = requestedLimit ?? 2000;
				const thresholdValue = requestedThreshold ?? 0.66;
				const result = await getManualPicksClvTimingFn({
					data: {
						limit:
							Number.isFinite(limitValue) && limitValue > 0 ? limitValue : 2000,
						qualityThreshold:
							Number.isFinite(thresholdValue) && thresholdValue > 0
								? thresholdValue
								: 0.66,
						sincePickedAt: sincePickedAtRef.current,
					},
				});
				setClvTimingResult((result.timing ?? null) as ClvTimingResult | null);
			} catch (err) {
				console.error("Failed to load CLV timing", err);
				setClvTimingError("Failed to load CLV timing");
			} finally {
				setIsClvTimingLoading(false);
				isClvTimingLoadingRef.current = false;
			}
		},
		[],
	);

	const loadShadowWindows = useCallback(
		async (requestedLimit?: number, requestedThreshold?: number) => {
			if (isShadowWindowLoadingRef.current) return;
			isShadowWindowLoadingRef.current = true;
			setIsShadowWindowLoading(true);
			setShadowWindowError(null);
			try {
				const limitValue = requestedLimit ?? 2000;
				const thresholdValue = requestedThreshold ?? 0.66;
				const result = await getManualPicksShadowWindowsFn({
					data: {
						limit:
							Number.isFinite(limitValue) && limitValue > 0 ? limitValue : 2000,
						qualityThreshold:
							Number.isFinite(thresholdValue) && thresholdValue > 0
								? thresholdValue
								: 0.66,
						sincePickedAt: sincePickedAtRef.current,
					},
				});
				setShadowWindowResult(
					(result.shadow ?? null) as ShadowWindowResult | null,
				);
			} catch (err) {
				console.error("Failed to load shadow windows", err);
				setShadowWindowError(
					`Failed to load shadow windows: ${describeError(err)}`,
				);
			} finally {
				setIsShadowWindowLoading(false);
				isShadowWindowLoadingRef.current = false;
			}
		},
		[],
	);

	const loadSportPerformance = useCallback(
		async (requestedLimit?: number, requestedThreshold?: number) => {
			if (isSportPerformanceLoadingRef.current) return;
			isSportPerformanceLoadingRef.current = true;
			setIsSportPerformanceLoading(true);
			setSportPerformanceError(null);
			try {
				const limitValue = requestedLimit ?? 2000;
				const thresholdValue = requestedThreshold ?? 0.66;
				const result = await getManualPicksSportPerformanceFn({
					data: {
						limit:
							Number.isFinite(limitValue) && limitValue > 0 ? limitValue : 2000,
						qualityThreshold:
							Number.isFinite(thresholdValue) && thresholdValue > 0
								? thresholdValue
								: 0.66,
						sincePickedAt: sincePickedAtRef.current,
					},
				});
				setSportPerformanceResult(
					(result.sportPerformance ?? null) as SportPerformanceResult | null,
				);
			} catch (err) {
				console.error("Failed to load sport performance", err);
				setSportPerformanceError(
					`Failed to load sport performance: ${describeError(err)}`,
				);
			} finally {
				setIsSportPerformanceLoading(false);
				isSportPerformanceLoadingRef.current = false;
			}
		},
		[],
	);

	const loadMarketTypePerformance = useCallback(
		async (requestedLimit?: number, requestedThreshold?: number) => {
			if (isMarketTypePerformanceLoadingRef.current) return;
			isMarketTypePerformanceLoadingRef.current = true;
			setIsMarketTypePerformanceLoading(true);
			setMarketTypePerformanceError(null);
			try {
				const limitValue = requestedLimit ?? 2000;
				const thresholdValue = requestedThreshold ?? 0.66;
				const result = await getManualPicksMarketTypePerformanceFn({
					data: {
						limit:
							Number.isFinite(limitValue) && limitValue > 0 ? limitValue : 2000,
						qualityThreshold:
							Number.isFinite(thresholdValue) && thresholdValue > 0
								? thresholdValue
								: 0.66,
						sincePickedAt: sincePickedAtRef.current,
					},
				});
				setMarketTypePerformanceResult(
					(result.marketTypePerformance ??
						null) as MarketTypePerformanceResult | null,
				);
			} catch (err) {
				console.error("Failed to load market type performance", err);
				setMarketTypePerformanceError(
					`Failed to load market type performance: ${describeError(err)}`,
				);
			} finally {
				setIsMarketTypePerformanceLoading(false);
				isMarketTypePerformanceLoadingRef.current = false;
			}
		},
		[],
	);

	const loadGradeRecalibration = useCallback(
		async (requestedLimit?: number) => {
			if (isGradeRecalibrationLoadingRef.current) return;
			isGradeRecalibrationLoadingRef.current = true;
			setIsGradeRecalibrationLoading(true);
			setGradeRecalibrationError(null);
			try {
				const limitValue = requestedLimit ?? 2000;
				const result = await getManualPicksGradeRecalibrationFn({
					data: {
						limit:
							Number.isFinite(limitValue) && limitValue > 0 ? limitValue : 2000,
						sincePickedAt: sincePickedAtRef.current,
					},
				});
				setGradeRecalibrationResult(
					(result.gradeRecalibration ??
						null) as GradeRecalibrationResult | null,
				);
			} catch (err) {
				console.error("Failed to load grade recalibration", err);
				setGradeRecalibrationError(
					`Failed to load grade recalibration: ${describeError(err)}`,
				);
			} finally {
				setIsGradeRecalibrationLoading(false);
				isGradeRecalibrationLoadingRef.current = false;
			}
		},
		[],
	);

	const refreshStats = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			await fetchTrendingSportsMarketsFn({
				data: { limit: 50, includeLowVolume: true },
			});
			await loadStats();
			await loadCandidateDebug();
		} catch (err) {
			console.error("Failed to refresh runtime stats", err);
			setError("Failed to refresh runtime stats");
		} finally {
			setIsLoading(false);
		}
	}, [loadStats, loadCandidateDebug]);

	const copySnapshot = useCallback(async () => {
		setCopySnapshotStatus(null);
		setIsCopyingSnapshot(true);
		try {
			const calibrationLimitValue = Number(calibrationLimit);
			const clvThresholdValue = Number(clvQualityThreshold);
			const evalWindowHoursValue = Number(evalWindowHours);
			const evalHorizonMinutesValue = Number(evalHorizonMinutes);
			const evalHistoryWindowMinutesValue = Number(evalHistoryWindowMinutes);
			const refreshedStats = await getRuntimeMarketStatsFn({
				data: { freshnessWindowHours: 24 },
			});
			const refreshedCandidateDebug = await getBotCandidatesFn({
				data: {
					minGrade: "B",
					windowMinutes: 90,
					minMinutesToStart: 15,
					maxMinutesToStart: 75,
					limit: 100,
					requireReady: true,
					includeStarted: true,
					requireMicrostructure: true,
					marketQualityThreshold: 0.7,
				},
			});
			if ("error" in refreshedCandidateDebug) {
				throw new Error(refreshedCandidateDebug.error);
			}
			const [
				refreshedEval,
				refreshedCalibration,
				refreshedBucketPerformance,
				refreshedClvTiming,
				refreshedSportPerformance,
				refreshedMarketTypePerformance,
				refreshedGradeRecalibration,
			] = await Promise.all([
				getBotEvalFn({
					data: {
						windowHours:
							Number.isFinite(evalWindowHoursValue) && evalWindowHoursValue > 0
								? evalWindowHoursValue
								: 24,
						horizonMinutes:
							Number.isFinite(evalHorizonMinutesValue) &&
							evalHorizonMinutesValue > 0
								? evalHorizonMinutesValue
								: 15,
						historyWindowMinutes:
							Number.isFinite(evalHistoryWindowMinutesValue) &&
							evalHistoryWindowMinutesValue > 0
								? evalHistoryWindowMinutesValue
								: 60,
						minGrade: evalMinGrade,
						includeStarted: evalIncludeStarted,
						limit: 10000,
						sweepThresholds: evalSweepThresholds
							.split(",")
							.map((value) => Number(value.trim()))
							.filter((value) => Number.isFinite(value)),
					},
				}),
				getManualPicksCalibrationFn({
					data: {
						limit:
							Number.isFinite(calibrationLimitValue) &&
							calibrationLimitValue > 0
								? calibrationLimitValue
								: 2000,
						sincePickedAt: sincePickedAtRef.current,
					},
				}),
				getManualPicksBucketPerformanceFn({
					data: {
						limit:
							Number.isFinite(calibrationLimitValue) &&
							calibrationLimitValue > 0
								? calibrationLimitValue
								: 2000,
						sincePickedAt: sincePickedAtRef.current,
					},
				}),
				getManualPicksClvTimingFn({
					data: {
						limit:
							Number.isFinite(calibrationLimitValue) &&
							calibrationLimitValue > 0
								? calibrationLimitValue
								: 2000,
						qualityThreshold:
							Number.isFinite(clvThresholdValue) && clvThresholdValue > 0
								? clvThresholdValue
								: 0.66,
						sincePickedAt: sincePickedAtRef.current,
					},
				}),
				getManualPicksSportPerformanceFn({
					data: {
						limit:
							Number.isFinite(calibrationLimitValue) &&
							calibrationLimitValue > 0
								? calibrationLimitValue
								: 2000,
						qualityThreshold:
							Number.isFinite(clvThresholdValue) && clvThresholdValue > 0
								? clvThresholdValue
								: 0.66,
						sincePickedAt: sincePickedAtRef.current,
					},
				}),
				getManualPicksMarketTypePerformanceFn({
					data: {
						limit:
							Number.isFinite(calibrationLimitValue) &&
							calibrationLimitValue > 0
								? calibrationLimitValue
								: 2000,
						qualityThreshold:
							Number.isFinite(clvThresholdValue) && clvThresholdValue > 0
								? clvThresholdValue
								: 0.66,
						sincePickedAt: sincePickedAtRef.current,
					},
				}),
				getManualPicksGradeRecalibrationFn({
					data: {
						limit:
							Number.isFinite(calibrationLimitValue) &&
							calibrationLimitValue > 0
								? calibrationLimitValue
								: 2000,
						sincePickedAt: sincePickedAtRef.current,
					},
				}),
			]);
			setStats((refreshedStats.stats ?? null) as RuntimeStats | null);
			setCandidateDebugResult(refreshedCandidateDebug as CandidateDebugResult);
			setEvalResult(refreshedEval as EvalResult);
			setCalibrationResult(
				(refreshedCalibration.calibration ?? null) as CalibrationResult | null,
			);
			setBucketPerformanceResult(
				(refreshedBucketPerformance.performance ??
					null) as BucketPerformanceResult | null,
			);
			setClvTimingResult(
				(refreshedClvTiming.timing ?? null) as ClvTimingResult | null,
			);
			setSportPerformanceResult(
				(refreshedSportPerformance.sportPerformance ??
					null) as SportPerformanceResult | null,
			);
			setMarketTypePerformanceResult(
				(refreshedMarketTypePerformance.marketTypePerformance ??
					null) as MarketTypePerformanceResult | null,
			);
			setGradeRecalibrationResult(
				(refreshedGradeRecalibration.gradeRecalibration ??
					null) as GradeRecalibrationResult | null,
			);
			const refreshedRuntimeStats = (refreshedStats.stats ??
				null) as RuntimeStats | null;
			const refreshedFilteredTotalMarkets =
				refreshedRuntimeStats?.filteredTagStats?.reduce(
					(sum, entry) => sum + entry.count,
					0,
				) ?? 0;
			const hasFullStats =
				refreshedRuntimeStats && "fetchedAt" in refreshedRuntimeStats;
			const runtimeSummary: SnapshotRuntimeSummary = hasFullStats
				? {
						fetchedAt: refreshedRuntimeStats.fetchedAt,
						filteredMarketsWindow: refreshedFilteredTotalMarkets,
						expandedEventCount: refreshedRuntimeStats.expandedEventCount ?? 0,
						expandedMarketCount:
							refreshedRuntimeStats.expandedMarketCount ?? 0,
						retryCount: refreshedRuntimeStats.retryCount ?? 0,
						failureCount: refreshedRuntimeStats.failureCount ?? 0,
						totalRuns: refreshedRuntimeStats.totalRuns ?? 0,
						totalRetries: refreshedRuntimeStats.totalRetries ?? 0,
						totalFailures: refreshedRuntimeStats.totalFailures ?? 0,
						cacheFreshness: refreshedRuntimeStats.cacheFreshness ?? null,
					}
				: {
						fetchedAt: Math.floor(Date.now() / 1000),
						filteredMarketsWindow: 0,
						expandedEventCount: 0,
						expandedMarketCount: 0,
						retryCount: 0,
						failureCount: 0,
						totalRuns: 0,
						totalRetries: 0,
						totalFailures: 0,
						cacheFreshness:
							((refreshedRuntimeStats as Record<string, unknown> | null)
								?.cacheFreshness as RuntimeStats["cacheFreshness"]) ?? null,
					};
			const snapshot = {
				generatedAt: new Date().toISOString(),
				runtime: runtimeSummary,
				candidateDebug: {
					requested: refreshedCandidateDebug.requested,
					returned: refreshedCandidateDebug.returned,
					totalEntries: refreshedCandidateDebug.debug.totalEntries,
					upcomingEntries: refreshedCandidateDebug.debug.upcomingEntries,
					candidatesBeforeDedup:
						refreshedCandidateDebug.debug.candidatesBeforeDedup,
					dedupDropped: refreshedCandidateDebug.debug.dedupDropped,
					topExclusions: topEntries(refreshedCandidateDebug.debug.excluded),
					topDedupReasons: topEntries(
						refreshedCandidateDebug.debug.dedupReasons,
					),
					topPolicyBuckets: topEntries(
						refreshedCandidateDebug.debug.policyMatched,
						8,
					),
					returnedByMarketType:
						refreshedCandidateDebug.debug.returnedByMarketType,
					returnedByTimingBucket:
						refreshedCandidateDebug.debug.returnedByTimingBucket,
					returnedBySportSeries:
						refreshedCandidateDebug.debug.returnedBySportSeries,
					nearMisses: refreshedCandidateDebug.debug.nearMisses
						.slice(0, 5)
						.map((candidate) => ({
							reason: candidate.reason,
							conditionId: candidate.conditionId,
							marketTitle: candidate.marketTitle,
							sportSeriesId: candidate.sportSeriesId ?? null,
							marketType: candidate.marketType,
							sharpSide: candidate.sharpSide,
							sharpSidePrice: candidate.sharpSidePrice,
							grade: candidate.grade ?? null,
							policyMinGrade: candidate.policyMinGrade ?? null,
							signalScore: candidate.signalScore ?? null,
							marketQualityScore: candidate.marketQualityScore ?? null,
							minutesToStart: candidate.minutesToStart ?? null,
						})),
					returnedCandidates: refreshedCandidateDebug.candidates
						.slice(0, 5)
						.map((candidate) => ({
							conditionId: candidate.entry.conditionId,
							marketTitle: candidate.entry.marketTitle,
							sportSeriesId: candidate.entry.sportSeriesId ?? null,
							marketType: candidate.entry.marketType,
							sharpSide: candidate.entry.sharpSide,
							sharpSidePrice: candidate.entry.sharpSidePrice,
							grade: candidate.grade.grade,
							signalScore: candidate.grade.signalScore ?? null,
							marketQualityScore: candidate.grade.microstructureScore ?? null,
							minutesToStart: candidate.entry.eventTime
								? Math.round(
										(new Date(candidate.entry.eventTime).getTime() -
											Date.now()) /
											60000,
									)
								: null,
						})),
				},
				eval: refreshedEval,
				clvTiming: refreshedClvTiming.timing ?? null,
				calibration: refreshedCalibration.calibration ?? null,
				bucketPerformance: refreshedBucketPerformance.performance ?? null,
				marketTypePerformance:
					refreshedMarketTypePerformance.marketTypePerformance ?? null,
				sportPerformance: refreshedSportPerformance.sportPerformance ?? null,
				gradeRecalibration:
					refreshedGradeRecalibration.gradeRecalibration ?? null,
			};
			await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
			setCopySnapshotStatus("Snapshot refreshed and copied");
			window.setTimeout(() => setCopySnapshotStatus(null), 2500);
		} catch (err) {
			console.error("Failed to copy runtime snapshot", err);
			setCopySnapshotStatus("Copy failed");
			window.setTimeout(() => setCopySnapshotStatus(null), 2500);
		} finally {
			setIsCopyingSnapshot(false);
		}
	}, [
		calibrationLimit,
		clvQualityThreshold,
		evalWindowHours,
		evalHorizonMinutes,
		evalHistoryWindowMinutes,
		evalMinGrade,
		evalIncludeStarted,
		evalSweepThresholds,
	]);

	const handleBackfill = useCallback(async () => {
		if (isBackfilling) return;
		if (!confirm("Backfill history for cache entries missing it?")) return;
		setIsBackfilling(true);
		setBackfillResult(null);
		setError(null);
		try {
			let totalUpdated = 0;
			const batchLimit = 200;
			for (let i = 0; i < 5; i += 1) {
				const result = await backfillSharpMoneyHistoryFn({
					data: { limit: batchLimit },
				});
				const updated = result.updated ?? 0;
				totalUpdated += updated;
				if (updated < batchLimit) break;
			}
			setBackfillResult(`Backfilled ${totalUpdated} entries`);
			await loadStats();
		} catch (err) {
			console.error("Failed to backfill history", err);
			setError("Failed to backfill history");
		} finally {
			setIsBackfilling(false);
		}
	}, [isBackfilling, loadStats]);

	const runEval = useCallback(async () => {
		if (isEvaluating) return;
		setIsEvaluating(true);
		setEvalError(null);
		try {
			const windowHours = Number(evalWindowHours);
			const horizonMinutes = Number(evalHorizonMinutes);
			const historyWindowMinutes = Number(evalHistoryWindowMinutes);
			const result = await getBotEvalFn({
				data: {
					windowHours:
						Number.isFinite(windowHours) && windowHours > 0 ? windowHours : 24,
					horizonMinutes:
						Number.isFinite(horizonMinutes) && horizonMinutes > 0
							? horizonMinutes
							: 15,
					historyWindowMinutes:
						Number.isFinite(historyWindowMinutes) && historyWindowMinutes > 0
							? historyWindowMinutes
							: 60,
					minGrade: evalMinGrade,
					includeStarted: evalIncludeStarted,
					limit: 10000,
					sweepThresholds: evalSweepThresholds
						.split(",")
						.map((value) => Number(value.trim()))
						.filter((value) => Number.isFinite(value)),
				},
			});
			setEvalResult(result as EvalResult);
		} catch (err) {
			console.error("Failed to run eval", err);
			setEvalError("Failed to run eval comparison");
		} finally {
			setIsEvaluating(false);
		}
	}, [
		isEvaluating,
		evalWindowHours,
		evalHorizonMinutes,
		evalHistoryWindowMinutes,
		evalMinGrade,
		evalIncludeStarted,
		evalSweepThresholds,
	]);

	useEffect(() => {
		void loadStats();
		void loadCandidateDebug();
		void loadCalibration(2000);
		void loadBucketPerformance(2000);
		void loadClvTiming(2000, 0.66);
		void loadShadowWindows(2000, 0.66);
		void loadSportPerformance(2000, 0.66);
		void loadMarketTypePerformance(2000, 0.66);
		void loadGradeRecalibration(2000);
	}, [
		loadStats,
		loadCandidateDebug,
		loadCalibration,
		loadBucketPerformance,
		loadClvTiming,
		loadShadowWindows,
		loadSportPerformance,
		loadMarketTypePerformance,
		loadGradeRecalibration,
	]);

	return (
		<AuthGate>
			<div className="min-h-screen bg-slate-950 text-slate-100">
				<div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-10">
					<header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
						<div>
							<p className="text-xs uppercase tracking-[0.3em] text-slate-400">
								Runtime
							</p>
							<h1 className="text-3xl font-semibold text-slate-50">
								Market Fetch Stats
							</h1>
							<p className="mt-2 text-sm text-slate-400">
								Verify how many markets we pull per sport tag and which ones
								dominate by volume.
							</p>
						</div>
						<a
							href="/sharp"
							className="inline-flex items-center justify-center rounded-lg border border-slate-700/60 bg-slate-900/60 px-3 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-200 transition-colors hover:bg-slate-800/60"
						>
							Back to Sharp
						</a>
					</header>

					<section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
						<div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
							<div>
								<p className="text-sm text-slate-400">
									Last fetched: {formatRelativeTime(stats?.fetchedAt)}
								</p>
								<p className="text-sm text-slate-400">
									Filtered markets (window): {filteredTotalMarkets}
								</p>
								<p className="text-sm text-slate-400">
									Expanded events: {stats?.expandedEventCount ?? 0} • Expanded
									markets: {stats?.expandedMarketCount ?? 0}
								</p>
								<p className="text-sm text-slate-400">
									Retries: {stats?.retryCount ?? 0} • Failures:{" "}
									{stats?.failureCount ?? 0} • Pagination caps:{" "}
									{stats?.paginationCapHits?.length ?? 0}
								</p>
								<p className="text-sm text-slate-400">
									Totals: {stats?.totalRuns ?? 0} runs •{" "}
									{stats?.totalRetries ?? 0} retries •{" "}
									{stats?.totalFailures ?? 0} failures
								</p>
								{stats?.cacheFreshness && (
									<p className="text-sm text-slate-400">
										Cache freshness: {stats.cacheFreshness.total} total •{" "}
										{stats.cacheFreshness.staleHistory} stale •{" "}
										{stats.cacheFreshness.missingHistory} missing history
									</p>
								)}
							</div>
							<div className="flex flex-wrap items-center gap-3">
								<button
									type="button"
									onClick={() => void copySnapshot()}
									disabled={isCopyingSnapshot}
									className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/20"
								>
									{isCopyingSnapshot
										? "Refreshing..."
										: "Refresh + Copy Snapshot"}
								</button>
								<button
									type="button"
									onClick={refreshStats}
									disabled={isLoading}
									className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-60"
								>
									{isLoading ? "Refreshing..." : "Refresh Stats"}
								</button>
								<button
									type="button"
									onClick={handleBackfill}
									disabled={isBackfilling}
									className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-500/20 disabled:opacity-60"
								>
									{isBackfilling ? "Backfilling..." : "Backfill History"}
								</button>
							</div>
						</div>

						{error && (
							<div className="mt-4 rounded-lg border border-red-500/40 bg-red-950/40 px-4 py-2 text-sm text-red-200">
								{error}
							</div>
						)}
						{backfillResult && (
							<div className="mt-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-100">
								{backfillResult}
							</div>
						)}
						{copySnapshotStatus && (
							<div className="mt-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-100">
								{copySnapshotStatus}
							</div>
						)}
					</section>

					<section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
						<div className="flex flex-col gap-4">
							<div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
								<div>
									<h2 className="text-lg font-semibold text-slate-50">
										Candidate Policy
									</h2>
									<p className="mt-1 text-sm text-slate-400">
										Live candidate debug using the current API-side policy
										ranking and filtering defaults.
									</p>
								</div>
								<button
									type="button"
									onClick={() => void loadCandidateDebug()}
									disabled={isCandidateDebugLoading}
									className="rounded-lg border border-slate-700/60 bg-slate-950/60 px-3 py-2 text-sm font-semibold text-slate-100 hover:bg-slate-800/60 disabled:opacity-60"
								>
									{isCandidateDebugLoading
										? "Refreshing..."
										: "Refresh Candidate Debug"}
								</button>
							</div>
							{candidateDebugError && (
								<div className="rounded-lg border border-red-500/40 bg-red-950/40 px-4 py-2 text-sm text-red-200">
									{candidateDebugError}
								</div>
							)}
							{candidateDebugResult && (
								<div className="space-y-5">
									<div className="grid gap-3 md:grid-cols-4">
										<div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
											<p>Entries: {candidateDebugResult.debug.totalEntries}</p>
											<p>
												Upcoming: {candidateDebugResult.debug.upcomingEntries}
											</p>
										</div>
										<div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
											<p>
												Before dedup:{" "}
												{candidateDebugResult.debug.candidatesBeforeDedup}
											</p>
											<p>Returned: {candidateDebugResult.returned}</p>
										</div>
										<div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
											<p>
												Dedup dropped: {candidateDebugResult.debug.dedupDropped}
											</p>
											<p>Requested grades: {candidateDebugResult.requested}</p>
										</div>
										<div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
											<p>
												Top exclusion:{" "}
												{Object.entries(candidateDebugResult.debug.excluded)
													.sort((left, right) => right[1] - left[1])[0]
													?.join(" = ") ?? "—"}
											</p>
											<p>
												Top dedup:{" "}
												{Object.entries(candidateDebugResult.debug.dedupReasons)
													.sort((left, right) => right[1] - left[1])[0]
													?.join(" = ") ?? "—"}
											</p>
										</div>
									</div>
									<div className="grid gap-4 lg:grid-cols-2">
										<div className="overflow-auto rounded-xl border border-slate-800 bg-slate-950/60 p-4">
											<h3 className="text-sm font-semibold text-slate-100">
												Top policy buckets
											</h3>
											<table className="mt-3 min-w-full text-left text-sm text-slate-300">
												<thead className="text-xs uppercase tracking-wide text-slate-500">
													<tr>
														<th className="pb-2 pr-4">Policy</th>
														<th className="pb-2 text-right">Count</th>
													</tr>
												</thead>
												<tbody>
													{candidatePolicyRows.map(([key, count]) => (
														<tr
															key={key}
															className="border-t border-slate-800/80 align-top"
														>
															<td className="py-2 pr-4 text-slate-200">
																{key}
															</td>
															<td className="py-2 text-right">{count}</td>
														</tr>
													))}
												</tbody>
											</table>
										</div>
										<div className="space-y-4">
											{candidateReturnedBreakdowns.map((section) => (
												<div
													key={section.title}
													className="overflow-auto rounded-xl border border-slate-800 bg-slate-950/60 p-4"
												>
													<h3 className="text-sm font-semibold text-slate-100">
														{section.title}
													</h3>
													<table className="mt-3 min-w-full text-left text-sm text-slate-300">
														<tbody>
															{section.rows.map(([key, count]) => (
																<tr
																	key={key}
																	className="border-t border-slate-800/80"
																>
																	<td className="py-2 pr-4 text-slate-200">
																		{key}
																	</td>
																	<td className="py-2 text-right">{count}</td>
																</tr>
															))}
														</tbody>
													</table>
												</div>
											))}
										</div>
									</div>
									<div className="overflow-auto rounded-xl border border-slate-800 bg-slate-950/60 p-4">
										<h3 className="text-sm font-semibold text-slate-100">
											Top returned candidates
										</h3>
										{returnedCandidates.length > 0 ? (
											<table className="mt-3 min-w-full text-left text-sm text-slate-300">
												<thead className="text-xs uppercase tracking-wide text-slate-500">
													<tr>
														<th className="pb-2 pr-4">Market</th>
														<th className="pb-2 pr-4">Type</th>
														<th className="pb-2 pr-4">Side</th>
														<th className="pb-2 pr-4">Grade</th>
														<th className="pb-2 pr-4">Quality</th>
														<th className="pb-2 pr-4">Score</th>
														<th className="pb-2 pr-4">Price</th>
														<th className="pb-2">Start</th>
													</tr>
												</thead>
												<tbody>
													{returnedCandidates.map((candidate) => (
														<tr
															key={candidate.entry.conditionId}
															className="border-t border-slate-800/80 align-top"
														>
															<td className="py-2 pr-4 text-slate-200">
																<div className="font-semibold text-slate-100">
																	{candidate.entry.marketTitle}
																</div>
																<div className="text-xs text-slate-500">
																	Series:{" "}
																	{candidate.entry.sportSeriesId ?? "unknown"}
																</div>
															</td>
															<td className="py-2 pr-4">
																{candidate.entry.marketType}
															</td>
															<td className="py-2 pr-4">
																{candidate.entry.sharpSide}
															</td>
															<td className="py-2 pr-4">
																{candidate.grade.grade}
															</td>
															<td className="py-2 pr-4">
																{candidate.grade.microstructureScore !==
																undefined
																	? candidate.grade.microstructureScore.toFixed(
																			2,
																		)
																	: "—"}
															</td>
															<td className="py-2 pr-4">
																{candidate.grade.signalScore !== undefined
																	? candidate.grade.signalScore.toFixed(1)
																	: "—"}
															</td>
															<td className="py-2 pr-4">
																{candidate.entry.sharpSidePrice !== null
																	? candidate.entry.sharpSidePrice.toFixed(3)
																	: "—"}
															</td>
															<td className="py-2">
																{formatMinutesToStart(
																	candidate.entry.eventTime,
																)}
															</td>
														</tr>
													))}
												</tbody>
											</table>
										) : (
											<p className="mt-3 text-sm text-slate-400">
												No returned candidates in the current snapshot.
											</p>
										)}
									</div>
									<div className="overflow-auto rounded-xl border border-slate-800 bg-slate-950/60 p-4">
										<h3 className="text-sm font-semibold text-slate-100">
											Top near misses
										</h3>
										{nearMissCandidates.length > 0 ? (
											<table className="mt-3 min-w-full text-left text-sm text-slate-300">
												<thead className="text-xs uppercase tracking-wide text-slate-500">
													<tr>
														<th className="pb-2 pr-4">Market</th>
														<th className="pb-2 pr-4">Reason</th>
														<th className="pb-2 pr-4">Grade</th>
														<th className="pb-2 pr-4">Target</th>
														<th className="pb-2 pr-4">Quality</th>
														<th className="pb-2 pr-4">Score</th>
														<th className="pb-2 pr-4">Price</th>
														<th className="pb-2">Start</th>
													</tr>
												</thead>
												<tbody>
													{nearMissCandidates.map((candidate) => (
														<tr
															key={`${candidate.reason}-${candidate.conditionId}`}
															className="border-t border-slate-800/80 align-top"
														>
															<td className="py-2 pr-4 text-slate-200">
																<div className="font-semibold text-slate-100">
																	{candidate.marketTitle}
																</div>
																<div className="text-xs text-slate-500">
																	Series: {candidate.sportSeriesId ?? "unknown"}{" "}
																	• {candidate.marketType}
																</div>
															</td>
															<td className="py-2 pr-4">{candidate.reason}</td>
															<td className="py-2 pr-4">
																{candidate.grade ?? "—"}
															</td>
															<td className="py-2 pr-4">
																{candidate.policyMinGrade ?? "—"}
															</td>
															<td className="py-2 pr-4">
																{candidate.marketQualityScore !== undefined
																	? candidate.marketQualityScore.toFixed(2)
																	: "—"}
															</td>
															<td className="py-2 pr-4">
																{candidate.signalScore !== undefined
																	? candidate.signalScore.toFixed(1)
																	: "—"}
															</td>
															<td className="py-2 pr-4">
																{candidate.sharpSidePrice !== null
																	? candidate.sharpSidePrice.toFixed(3)
																	: "—"}
															</td>
															<td className="py-2">
																{candidate.minutesToStart !== null &&
																candidate.minutesToStart !== undefined
																	? `${Math.round(candidate.minutesToStart)}m`
																	: "—"}
															</td>
														</tr>
													))}
												</tbody>
											</table>
										) : (
											<p className="mt-3 text-sm text-slate-400">
												No near misses captured in the current snapshot.
											</p>
										)}
									</div>
								</div>
							)}
						</div>
					</section>

					<section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
						<div className="flex flex-col gap-4">
							<div>
								<h2 className="text-lg font-semibold text-slate-50">
									Eval Comparison
								</h2>
								<p className="mt-1 text-sm text-slate-400">
									Compare baseline candidate logic vs filtered market-quality
									logic using historical snapshots.
								</p>
							</div>
							<div className="grid gap-3 md:grid-cols-6">
								<div>
									<label
										htmlFor="eval-window-hours"
										className="block text-xs text-slate-400"
									>
										Window hours
									</label>
									<input
										id="eval-window-hours"
										value={evalWindowHours}
										onChange={(event) => setEvalWindowHours(event.target.value)}
										className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950/60 px-2 py-1 text-sm text-white"
									/>
								</div>
								<div>
									<label
										htmlFor="eval-horizon-mins"
										className="block text-xs text-slate-400"
									>
										Horizon (mins)
									</label>
									<input
										id="eval-horizon-mins"
										value={evalHorizonMinutes}
										onChange={(event) =>
											setEvalHorizonMinutes(event.target.value)
										}
										className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950/60 px-2 py-1 text-sm text-white"
									/>
								</div>
								<div>
									<label
										htmlFor="eval-history-mins"
										className="block text-xs text-slate-400"
									>
										Signal window (mins)
									</label>
									<input
										id="eval-history-mins"
										value={evalHistoryWindowMinutes}
										onChange={(event) =>
											setEvalHistoryWindowMinutes(event.target.value)
										}
										className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950/60 px-2 py-1 text-sm text-white"
									/>
								</div>
								<div>
									<label
										htmlFor="eval-min-grade"
										className="block text-xs text-slate-400"
									>
										Min grade
									</label>
									<select
										id="eval-min-grade"
										value={evalMinGrade}
										onChange={(event) =>
											setEvalMinGrade(
												event.target.value as "A+" | "A" | "B" | "C" | "D",
											)
										}
										className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950/60 px-2 py-1 text-sm text-white"
									>
										<option value="A+">A+</option>
										<option value="A">A</option>
										<option value="B">B</option>
										<option value="C">C</option>
										<option value="D">D</option>
									</select>
								</div>
								<div className="flex items-end gap-2">
									<button
										type="button"
										onClick={runEval}
										disabled={isEvaluating}
										className="w-full rounded-lg bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-60"
									>
										{isEvaluating ? "Running..." : "Run Eval"}
									</button>
								</div>
								<div className="md:col-span-6">
									<label
										htmlFor="eval-thresholds"
										className="block text-xs text-slate-400"
									>
										Sweep thresholds (comma separated)
									</label>
									<input
										id="eval-thresholds"
										value={evalSweepThresholds}
										onChange={(event) =>
											setEvalSweepThresholds(event.target.value)
										}
										className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950/60 px-2 py-1 text-sm text-white"
										placeholder="0.58,0.62,0.66,0.70"
									/>
								</div>
							</div>
							<label className="inline-flex items-center gap-2 text-sm text-slate-300">
								<input
									type="checkbox"
									checked={evalIncludeStarted}
									onChange={(event) =>
										setEvalIncludeStarted(event.target.checked)
									}
								/>
								Include started events
							</label>
							{evalError && (
								<div className="rounded-lg border border-red-500/40 bg-red-950/40 px-4 py-2 text-sm text-red-200">
									{evalError}
								</div>
							)}
							{evalResult && (
								<div className="space-y-5">
									<div className="grid gap-3 md:grid-cols-2">
										<div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
											<p className="text-sm font-semibold text-slate-100">
												Baseline
											</p>
											<p className="mt-2 text-sm text-slate-300">
												Triggered: {evalResult.strategies.baseline.triggered} •
												Resolved: {evalResult.strategies.baseline.resolved}
											</p>
											<p className="text-sm text-slate-300">
												Hit rate:{" "}
												{formatPercent(evalResult.strategies.baseline.hitRate)}{" "}
												• Avg move:{" "}
												{formatBps(evalResult.strategies.baseline.avgMoveBps)}
											</p>
										</div>
										<div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
											<p className="text-sm font-semibold text-slate-100">
												Filtered
											</p>
											<p className="mt-1 text-xs text-slate-400">
												Quality threshold:{" "}
												{evalResult.filteredQualityThreshold.toFixed(2)}
											</p>
											<p className="mt-2 text-sm text-slate-300">
												Triggered: {evalResult.strategies.filtered.triggered} •
												Resolved: {evalResult.strategies.filtered.resolved}
											</p>
											<p className="text-sm text-slate-300">
												Hit rate:{" "}
												{formatPercent(evalResult.strategies.filtered.hitRate)}{" "}
												• Avg move:{" "}
												{formatBps(evalResult.strategies.filtered.avgMoveBps)}
											</p>
										</div>
									</div>
									<div className="overflow-auto rounded-xl border border-slate-800 bg-slate-950/60 p-4">
										<p className="text-sm font-semibold text-slate-100">
											By hour to start
										</p>
										<table className="mt-3 min-w-full text-left text-sm text-slate-200">
											<thead>
												<tr className="text-xs uppercase tracking-[0.2em] text-slate-500">
													<th className="pb-2">Bucket</th>
													<th className="pb-2">Base Hit</th>
													<th className="pb-2">Base Avg</th>
													<th className="pb-2">Filt Hit</th>
													<th className="pb-2">Filt Avg</th>
												</tr>
											</thead>
											<tbody>
												{evalHourBuckets.map((bucket) => {
													const base =
														evalResult.strategies.baseline.byHourToStart[
															bucket
														];
													const filt =
														evalResult.strategies.filtered.byHourToStart[
															bucket
														];
													return (
														<tr
															key={bucket}
															className="border-t border-slate-800"
														>
															<td className="py-2 pr-4 font-semibold text-slate-100">
																{bucket}
															</td>
															<td className="py-2 pr-4">
																{formatPercent(base?.hitRate)}
															</td>
															<td className="py-2 pr-4">
																{formatBps(base?.avgMoveBps)}
															</td>
															<td className="py-2 pr-4">
																{formatPercent(filt?.hitRate)}
															</td>
															<td className="py-2">
																{formatBps(filt?.avgMoveBps)}
															</td>
														</tr>
													);
												})}
											</tbody>
										</table>
									</div>
									<div className="overflow-auto rounded-xl border border-slate-800 bg-slate-950/60 p-4">
										<p className="text-sm font-semibold text-slate-100">
											Threshold sweep
										</p>
										<table className="mt-3 min-w-full text-left text-sm text-slate-200">
											<thead>
												<tr className="text-xs uppercase tracking-[0.2em] text-slate-500">
													<th className="pb-2">Threshold</th>
													<th className="pb-2">Retained</th>
													<th className="pb-2">Hit Rate</th>
													<th className="pb-2">Avg Move</th>
													<th className="pb-2">Delta vs Base</th>
												</tr>
											</thead>
											<tbody>
												{evalResult.thresholdSweep.map((row) => (
													<tr
														key={row.threshold}
														className="border-t border-slate-800"
													>
														<td className="py-2 pr-4 font-semibold text-slate-100">
															{row.threshold.toFixed(2)}
														</td>
														<td className="py-2 pr-4">
															{formatPercent(row.retainedRate)}
														</td>
														<td className="py-2 pr-4">
															{formatPercent(row.hitRate)}
														</td>
														<td className="py-2 pr-4">
															{formatBps(row.avgMoveBps)}
														</td>
														<td className="py-2">
															{row.avgMoveDeltaBps === null ||
															!Number.isFinite(row.avgMoveDeltaBps)
																? "—"
																: `${row.avgMoveDeltaBps >= 0 ? "+" : ""}${row.avgMoveDeltaBps.toFixed(1)} bps`}
														</td>
													</tr>
												))}
											</tbody>
										</table>
									</div>
								</div>
							)}
						</div>
					</section>

					<section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
						<div className="flex flex-col gap-4">
							<div>
								<h2 className="text-lg font-semibold text-slate-50">
									CLV Timing Dashboard
								</h2>
								<p className="mt-1 text-sm text-slate-400">
									Compare CLV and ROI by entry timing, split by grade and
									quality threshold.
								</p>
							</div>
							<div className="flex flex-wrap items-end gap-3">
								<div>
									<label
										htmlFor="clv-quality-threshold"
										className="block text-xs text-slate-400"
									>
										Quality threshold
									</label>
									<input
										id="clv-quality-threshold"
										value={clvQualityThreshold}
										onChange={(event) =>
											setClvQualityThreshold(event.target.value)
										}
										className="mt-1 w-40 rounded-md border border-slate-700 bg-slate-950/60 px-2 py-1 text-sm text-white"
									/>
								</div>
								<button
									type="button"
									onClick={() =>
										void loadClvTiming(
											Number(calibrationLimit),
											Number(clvQualityThreshold),
										)
									}
									disabled={isClvTimingLoading}
									className="rounded-lg bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-60"
								>
									{isClvTimingLoading ? "Refreshing..." : "Refresh CLV Timing"}
								</button>
							</div>
							{clvTimingError && (
								<div className="rounded-lg border border-red-500/40 bg-red-950/40 px-4 py-2 text-sm text-red-200">
									{clvTimingError}
								</div>
							)}
							{clvTimingResult ? (
								<div className="space-y-5">
									<div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
										Settled picks: {clvTimingResult.settledPicks} • Quality
										threshold: {clvTimingResult.qualityThreshold.toFixed(2)}
									</div>
									{clvTimingResult.segments.map((segment) => (
										<div
											key={segment.key}
											className="overflow-auto rounded-xl border border-slate-800 bg-slate-950/60 p-4"
										>
											<p className="text-sm font-semibold text-slate-100">
												{segment.label}
											</p>
											<p className="mt-1 text-xs text-slate-400">
												Matched: {segment.matchedPicks} • With event time:{" "}
												{segment.withEventTime}
											</p>
											<table className="mt-3 min-w-full text-left text-sm text-slate-200">
												<thead>
													<tr className="text-xs uppercase tracking-[0.2em] text-slate-500">
														<th className="pb-2">Time Bucket</th>
														<th className="pb-2">Count</th>
														<th className="pb-2">Hit Rate</th>
														<th className="pb-2">Avg ROI</th>
														<th className="pb-2">Avg CLV</th>
													</tr>
												</thead>
												<tbody>
													{segment.byTimeToStart.map((row) => (
														<tr
															key={`${segment.key}-${row.bucket}`}
															className={`border-t border-slate-800 ${sampleClassName(row.count)}`}
														>
															<td className="py-2 pr-4 font-semibold text-slate-100">
																{row.bucket}
															</td>
															<td className="py-2 pr-4">
																{row.count}
																{sampleBadge(row.count) ? (
																	<span className="ml-2 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-200">
																		{sampleBadge(row.count)}
																	</span>
																) : null}
															</td>
															<td className="py-2 pr-4">
																{formatPercent(row.hitRate)}
															</td>
															<td className="py-2 pr-4">
																{formatSignedPercent(row.avgRoi)}
															</td>
															<td className="py-2">
																{formatBps(row.avgClvBps)}
															</td>
														</tr>
													))}
												</tbody>
											</table>
										</div>
									))}
								</div>
							) : (
								<p className="text-sm text-slate-400">
									No CLV timing data yet.
								</p>
							)}
							<div className="mt-6">
								<div className="mb-3 flex flex-wrap items-center justify-between gap-3">
									<p className="text-sm font-semibold text-slate-100">
										Shadow Entry Windows
									</p>
									<button
										type="button"
										onClick={() =>
											void loadShadowWindows(
												Number(calibrationLimit),
												Number(clvQualityThreshold),
											)
										}
										disabled={isShadowWindowLoading}
										className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-60"
									>
										{isShadowWindowLoading
											? "Refreshing..."
											: "Refresh Shadow Windows"}
									</button>
								</div>
								<p className="text-xs text-slate-400">
									Hypothetical windows use historical snapshots
									(T-120/T-60/T-30/T-15/T-5/T-2) without placing real bets.
								</p>
								{shadowWindowError && (
									<div className="mt-3 rounded-lg border border-red-500/40 bg-red-950/40 px-4 py-2 text-sm text-red-200">
										{shadowWindowError}
									</div>
								)}
								{shadowWindowResult ? (
									<div className="mt-4 space-y-5">
										<div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
											Settled picks: {shadowWindowResult.settledPicks} • Quality
											threshold:{" "}
											{shadowWindowResult.qualityThreshold.toFixed(2)}
										</div>
										{shadowWindowResult.segments.map((segment) => (
											<div
												key={segment.key}
												className="overflow-auto rounded-xl border border-slate-800 bg-slate-950/60 p-4"
											>
												<p className="text-sm font-semibold text-slate-100">
													{segment.label}
												</p>
												<p className="mt-1 text-xs text-slate-400">
													Matched picks: {segment.matchedPicks}
												</p>
												<table className="mt-3 min-w-full text-left text-sm text-slate-200">
													<thead>
														<tr className="text-xs uppercase tracking-[0.2em] text-slate-500">
															<th className="pb-2">Window</th>
															<th className="pb-2">Count</th>
															<th className="pb-2">Hit Rate</th>
															<th className="pb-2">Avg ROI</th>
															<th className="pb-2">Avg CLV</th>
														</tr>
													</thead>
													<tbody>
														{segment.rows.map((row) => (
															<tr
																key={`${segment.key}-${row.windowKey}`}
																className={`border-t border-slate-800 ${sampleClassName(row.count)}`}
															>
																<td className="py-2 pr-4 font-semibold text-slate-100">
																	{row.windowLabel}
																</td>
																<td className="py-2 pr-4">
																	{row.count}
																	{sampleBadge(row.count) ? (
																		<span className="ml-2 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-200">
																			{sampleBadge(row.count)}
																		</span>
																	) : null}
																</td>
																<td className="py-2 pr-4">
																	{formatPercent(row.hitRate)}
																</td>
																<td className="py-2 pr-4">
																	{formatSignedPercent(row.avgRoi)}
																</td>
																<td className="py-2">
																	{formatBps(row.avgClvBps)}
																</td>
															</tr>
														))}
													</tbody>
												</table>
											</div>
										))}
									</div>
								) : (
									<p className="mt-3 text-sm text-slate-400">
										No shadow window data yet.
									</p>
								)}
							</div>
							<details className="mt-6 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
								<summary className="cursor-pointer text-sm font-semibold text-slate-100">
									Performance by Market Type
								</summary>
								<p className="mt-2 text-xs text-slate-400">
									Shows totals, spreads, moneylines, and other market classes
									across all settled picks and the quality-threshold subset.
								</p>
								<div className="mt-3 flex flex-wrap items-center gap-3">
									<button
										type="button"
										onClick={() =>
											void loadMarketTypePerformance(
												Number(calibrationLimit),
												Number(clvQualityThreshold),
											)
										}
										disabled={isMarketTypePerformanceLoading}
										className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-60"
									>
										{isMarketTypePerformanceLoading
											? "Refreshing..."
											: "Refresh Market Types"}
									</button>
								</div>
								{marketTypePerformanceError && (
									<div className="mt-3 rounded-lg border border-red-500/40 bg-red-950/40 px-4 py-2 text-sm text-red-200">
										{marketTypePerformanceError}
									</div>
								)}
								{marketTypePerformanceResult ? (
									<div className="mt-4 overflow-auto">
										<div className="mb-2 text-xs text-slate-400">
											Settled picks: {marketTypePerformanceResult.settledPicks}{" "}
											• Quality threshold:{" "}
											{marketTypePerformanceResult.qualityThreshold.toFixed(2)}
										</div>
										<table className="min-w-full text-left text-sm text-slate-200">
											<thead>
												<tr className="text-xs uppercase tracking-[0.2em] text-slate-500">
													<th className="pb-2">Market Type</th>
													<th className="pb-2">All Count</th>
													<th className="pb-2">All Hit</th>
													<th className="pb-2">All ROI</th>
													<th className="pb-2">All CLV</th>
													<th className="pb-2">Q Count</th>
													<th className="pb-2">Q Hit</th>
													<th className="pb-2">Q ROI</th>
													<th className="pb-2">Q CLV</th>
												</tr>
											</thead>
											<tbody>
												{marketTypePerformanceResult.rows.map((row) => (
													<tr
														key={row.marketType}
														className={`border-t border-slate-800 ${sampleClassName(row.totalCount)}`}
													>
														<td className="py-2 pr-4 font-semibold text-slate-100">
															{row.label}
														</td>
														<td className="py-2 pr-4">
															{row.totalCount}
															{sampleBadge(row.totalCount) ? (
																<span className="ml-2 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-200">
																	{sampleBadge(row.totalCount)}
																</span>
															) : null}
														</td>
														<td className="py-2 pr-4">
															{formatPercent(row.winRate)}
														</td>
														<td className="py-2 pr-4">
															{formatSignedPercent(row.avgRoi)}
														</td>
														<td className="py-2 pr-4">
															{formatBps(row.avgClvBps)}
														</td>
														<td className="py-2 pr-4">{row.qualityCount}</td>
														<td className="py-2 pr-4">
															{formatPercent(row.qualityWinRate)}
														</td>
														<td className="py-2 pr-4">
															{formatSignedPercent(row.qualityAvgRoi)}
														</td>
														<td className="py-2">
															{formatBps(row.qualityAvgClvBps)}
														</td>
													</tr>
												))}
											</tbody>
										</table>
									</div>
								) : (
									<p className="mt-3 text-sm text-slate-400">
										No market-type performance data yet.
									</p>
								)}
							</details>
							<details className="mt-6 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
								<summary className="cursor-pointer text-sm font-semibold text-slate-100">
									Performance by Sport
								</summary>
								<p className="mt-2 text-xs text-slate-400">
									Shows sport-level hit/ROI/CLV across all settled picks and the
									quality-threshold subset.
								</p>
								{ncaabSportRow ? (
									<div className="mt-3 grid gap-3 md:grid-cols-2">
										<div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
											<p className="text-xs uppercase tracking-[0.2em] text-amber-200">
												NCAAB All
											</p>
											<p className="mt-2 text-sm text-slate-200">
												{ncaabSportRow.totalCount} picks •{" "}
												{formatPercent(ncaabSportRow.winRate)} hit •{" "}
												{formatSignedPercent(ncaabSportRow.avgRoi)} ROI •{" "}
												{formatBps(ncaabSportRow.avgClvBps)} CLV
											</p>
										</div>
										<div className="rounded-xl border border-cyan-500/30 bg-cyan-500/10 p-4">
											<p className="text-xs uppercase tracking-[0.2em] text-cyan-200">
												NCAAB Quality
											</p>
											<p className="mt-2 text-sm text-slate-200">
												{ncaabSportRow.qualityCount} picks •{" "}
												{formatPercent(ncaabSportRow.qualityWinRate)} hit •{" "}
												{formatSignedPercent(ncaabSportRow.qualityAvgRoi)} ROI •{" "}
												{formatBps(ncaabSportRow.qualityAvgClvBps)} CLV
											</p>
										</div>
									</div>
								) : null}
								<div className="mt-3 flex flex-wrap items-center gap-3">
									<button
										type="button"
										onClick={() =>
											void loadSportPerformance(
												Number(calibrationLimit),
												Number(clvQualityThreshold),
											)
										}
										disabled={isSportPerformanceLoading}
										className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-60"
									>
										{isSportPerformanceLoading
											? "Refreshing..."
											: "Refresh Sport Performance"}
									</button>
								</div>
								{sportPerformanceError && (
									<div className="mt-3 rounded-lg border border-red-500/40 bg-red-950/40 px-4 py-2 text-sm text-red-200">
										{sportPerformanceError}
									</div>
								)}
								{sportPerformanceResult ? (
									<div className="mt-4 overflow-auto">
										<div className="mb-2 text-xs text-slate-400">
											Settled picks: {sportPerformanceResult.settledPicks} •
											Quality threshold:{" "}
											{sportPerformanceResult.qualityThreshold.toFixed(2)}
										</div>
										<table className="min-w-full text-left text-sm text-slate-200">
											<thead>
												<tr className="text-xs uppercase tracking-[0.2em] text-slate-500">
													<th className="pb-2">Sport</th>
													<th className="pb-2">All Count</th>
													<th className="pb-2">All Hit</th>
													<th className="pb-2">All ROI</th>
													<th className="pb-2">All CLV</th>
													<th className="pb-2">Q Count</th>
													<th className="pb-2">Q Hit</th>
													<th className="pb-2">Q ROI</th>
													<th className="pb-2">Q CLV</th>
												</tr>
											</thead>
											<tbody>
												{sportPerformanceResult.rows.map((row) => (
													<tr
														key={row.sportTag}
														className={`border-t border-slate-800 ${sampleClassName(row.totalCount)}`}
													>
														<td className="py-2 pr-4 font-semibold text-slate-100">
															{row.label}
														</td>
														<td className="py-2 pr-4">
															{row.totalCount}
															{sampleBadge(row.totalCount) ? (
																<span className="ml-2 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-200">
																	{sampleBadge(row.totalCount)}
																</span>
															) : null}
														</td>
														<td className="py-2 pr-4">
															{formatPercent(row.winRate)}
														</td>
														<td className="py-2 pr-4">
															{formatSignedPercent(row.avgRoi)}
														</td>
														<td className="py-2 pr-4">
															{formatBps(row.avgClvBps)}
														</td>
														<td className="py-2 pr-4">{row.qualityCount}</td>
														<td className="py-2 pr-4">
															{formatPercent(row.qualityWinRate)}
														</td>
														<td className="py-2 pr-4">
															{formatSignedPercent(row.qualityAvgRoi)}
														</td>
														<td className="py-2">
															{formatBps(row.qualityAvgClvBps)}
														</td>
													</tr>
												))}
											</tbody>
										</table>
									</div>
								) : (
									<p className="mt-3 text-sm text-slate-400">
										No sport performance data yet.
									</p>
								)}
							</details>
						</div>
					</section>

					<section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
						<div className="flex flex-col gap-4">
							<div>
								<h2 className="text-lg font-semibold text-slate-50">
									Pick Calibration
								</h2>
								<p className="mt-1 text-sm text-slate-400">
									Where picks are actually performing: by score and by
									time-to-start.
								</p>
							</div>
							<div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
								<p className="text-sm font-semibold text-slate-100">
									Coverage Health
								</p>
								<p className="mt-1 text-xs text-slate-400">
									Checks whether new pick records are storing fields needed for
									calibration and filtering.
								</p>
								<div className="mt-3 flex flex-wrap gap-2">
									{coverageHealth.map((item) => (
										<div
											key={item.key}
											className={`rounded-lg border px-3 py-2 text-xs ${item.status.className}`}
										>
											<span className="font-semibold">{item.label}</span>{" "}
											{item.covered}/{item.total} (
											{formatPercent(item.status.ratio)}) • {item.status.label}
										</div>
									))}
								</div>
							</div>
							<div className="flex flex-wrap items-end gap-3">
								<div>
									<label
										htmlFor="calibration-limit"
										className="block text-xs text-slate-400"
									>
										Pick sample limit
									</label>
									<input
										id="calibration-limit"
										value={calibrationLimit}
										onChange={(event) =>
											setCalibrationLimit(event.target.value)
										}
										className="mt-1 w-40 rounded-md border border-slate-700 bg-slate-950/60 px-2 py-1 text-sm text-white"
									/>
								</div>
								<div>
									<label
										htmlFor="since-filter"
										className="block text-xs text-slate-400"
									>
										Since
									</label>
									<select
										id="since-filter"
										value={sinceFilter}
										onChange={(event) => {
											const value = event.target.value;
											setSinceFilter(value);
											if (value === "") {
												sincePickedAtRef.current = undefined;
											} else if (value.startsWith("@")) {
												sincePickedAtRef.current = Number(value.slice(1));
											} else {
												const nowSec = Math.floor(Date.now() / 1000);
												sincePickedAtRef.current =
													nowSec - Number(value) * 86400;
											}
										}}
										className="mt-1 w-40 rounded-md border border-slate-700 bg-slate-950/60 px-2 py-1 text-sm text-white"
									>
										<option value="">All time</option>
										<option value="1">Last 24h</option>
										<option value="3">Last 3d</option>
										<option value="7">Last 7d</option>
										<option value="14">Last 14d</option>
										<option value="@1774480000">Since L2 removal (Mar 25)</option>
										<option value="30">Last 30d</option>
									</select>
									{sinceFilter !== "" && (
										<p className="mt-1 text-xs text-slate-400">
											{sinceFilter.startsWith("@")
												? `Showing picks since Mar 25 (L2 removal)`
												: `Showing picks since ${new Date(Date.now() - Number(sinceFilter) * 86400000).toLocaleDateString("en-US", { month: "short", day: "numeric" })} (${sinceFilter}d)`}
										</p>
									)}
								</div>
								<button
									type="button"
									onClick={() => void loadCalibration(Number(calibrationLimit))}
									disabled={isCalibrationLoading}
									className="rounded-lg bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-60"
								>
									{isCalibrationLoading
										? "Refreshing..."
										: "Refresh Calibration"}
								</button>
								<button
									type="button"
									onClick={() =>
										void loadBucketPerformance(Number(calibrationLimit))
									}
									disabled={isBucketPerformanceLoading}
									className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-60"
								>
									{isBucketPerformanceLoading
										? "Refreshing..."
										: "Refresh Buckets"}
								</button>
								<button
									type="button"
									onClick={() =>
										void loadGradeRecalibration(Number(calibrationLimit))
									}
									disabled={isGradeRecalibrationLoading}
									className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-60"
								>
									{isGradeRecalibrationLoading
										? "Refreshing..."
										: "Refresh Grade Recal"}
								</button>
							</div>
							{calibrationError && (
								<div className="rounded-lg border border-red-500/40 bg-red-950/40 px-4 py-2 text-sm text-red-200">
									{calibrationError}
								</div>
							)}
							{bucketPerformanceError && (
								<div className="rounded-lg border border-red-500/40 bg-red-950/40 px-4 py-2 text-sm text-red-200">
									{bucketPerformanceError}
								</div>
							)}
							{gradeRecalibrationError && (
								<div className="rounded-lg border border-red-500/40 bg-red-950/40 px-4 py-2 text-sm text-red-200">
									{gradeRecalibrationError}
								</div>
							)}
							{calibrationResult ? (
								<div className="space-y-5">
									<div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
										Total picks: {calibrationResult.totalPicks} • Settled:{" "}
										{calibrationResult.settledPicks} • Signal scored:{" "}
										{calibrationResult.withSignalScore} • Quality scored:{" "}
										{calibrationResult.withQualityScore} • With event time:{" "}
										{calibrationResult.withEventTime}
									</div>
									{[
										{
											title: "By signal score",
											rows: calibrationResult.bySignalScore,
										},
										{
											title: "By market quality score",
											rows: calibrationResult.byQualityScore,
										},
										{
											title: "By time to start",
											rows: calibrationResult.byTimeToStart,
										},
									].map((table) => (
										<div
											key={table.title}
											className="overflow-auto rounded-xl border border-slate-800 bg-slate-950/60 p-4"
										>
											<p className="text-sm font-semibold text-slate-100">
												{table.title}
											</p>
											<table className="mt-3 min-w-full text-left text-sm text-slate-200">
												<thead>
													<tr className="text-xs uppercase tracking-[0.2em] text-slate-500">
														<th className="pb-2">Bucket</th>
														<th className="pb-2">Count</th>
														<th className="pb-2">Win Rate</th>
														<th className="pb-2">Avg ROI</th>
														<th className="pb-2">Avg CLV</th>
													</tr>
												</thead>
												<tbody>
													{table.rows.map((row) => (
														<tr
															key={`${table.title}-${row.label}`}
															className={`border-t border-slate-800 ${sampleClassName(row.count)}`}
														>
															<td className="py-2 pr-4 font-semibold text-slate-100">
																{row.label}
															</td>
															<td className="py-2 pr-4">
																{row.count}
																{sampleBadge(row.count) ? (
																	<span className="ml-2 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-200">
																		{sampleBadge(row.count)}
																	</span>
																) : null}
															</td>
															<td className="py-2 pr-4">
																{formatPercent(row.winRate)}
															</td>
															<td className="py-2 pr-4">
																{formatSignedPercent(row.avgRoi)}
															</td>
															<td className="py-2">
																{formatBps(row.avgClvBps)}
															</td>
														</tr>
													))}
												</tbody>
											</table>
										</div>
									))}
									{gradeRecalibrationResult ? (
										<div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
											<p className="text-sm font-semibold text-slate-100">
												Grade Recalibration
											</p>
											<p className="mt-1 text-xs text-slate-400">
												Current grade performance and the score ranges feeding
												those grades.
											</p>
											<div className="mt-3 flex flex-wrap gap-2">
												{gradeRecalibrationResult.observations.map(
													(observation) => (
														<div
															key={observation}
															className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100"
														>
															{observation}
														</div>
													),
												)}
											</div>
											<table className="mt-3 min-w-full text-left text-sm text-slate-200">
												<thead>
													<tr className="text-xs uppercase tracking-[0.2em] text-slate-500">
														<th className="pb-2">Grade</th>
														<th className="pb-2">Count</th>
														<th className="pb-2">Hit Rate</th>
														<th className="pb-2">Avg ROI</th>
														<th className="pb-2">Avg CLV</th>
														<th className="pb-2">Avg Score</th>
														<th className="pb-2">Score Range</th>
													</tr>
												</thead>
												<tbody>
													{gradeRecalibrationResult.rows.map((row) => (
														<tr
															key={row.grade}
															className={`border-t border-slate-800 ${sampleClassName(row.count)}`}
														>
															<td className="py-2 pr-4 font-semibold text-slate-100">
																{row.grade}
															</td>
															<td className="py-2 pr-4">
																{row.count}
																{sampleBadge(row.count) ? (
																	<span className="ml-2 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-200">
																		{sampleBadge(row.count)}
																	</span>
																) : null}
															</td>
															<td className="py-2 pr-4">
																{formatPercent(row.winRate)}
															</td>
															<td className="py-2 pr-4">
																{formatSignedPercent(row.avgRoi)}
															</td>
															<td className="py-2 pr-4">
																{formatBps(row.avgClvBps)}
															</td>
															<td className="py-2 pr-4">
																{row.avgSignalScore !== null
																	? row.avgSignalScore.toFixed(1)
																	: "—"}
															</td>
															<td className="py-2">
																{row.minSignalScore !== null &&
																row.maxSignalScore !== null
																	? `${row.minSignalScore.toFixed(1)}-${row.maxSignalScore.toFixed(1)}`
																	: "—"}
															</td>
														</tr>
													))}
												</tbody>
											</table>
										</div>
									) : null}
								</div>
							) : (
								<p className="text-sm text-slate-400">
									No calibration data yet. Place bets and settle outcomes, then
									refresh.
								</p>
							)}
							{bucketPerformanceResult ? (
								<div className="space-y-5">
									<div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
										Settled picks in bucket analysis:{" "}
										{bucketPerformanceResult.settledPicks}
									</div>
									{[
										{
											title: "Time to start buckets",
											rows: bucketPerformanceResult.byTimeToStart,
										},
										{
											title: "Signal score buckets",
											rows: bucketPerformanceResult.bySignalScore,
										},
										{
											title: "L2 near-mid imbalance buckets",
											rows: bucketPerformanceResult.byL2ImbalanceNearMid,
										},
										{
											title: "L2 disagreement buckets",
											rows: bucketPerformanceResult.byL2Disagreement,
										},
									].map((table) => (
										<div
											key={table.title}
											className="overflow-auto rounded-xl border border-slate-800 bg-slate-950/60 p-4"
										>
											<p className="text-sm font-semibold text-slate-100">
												{table.title}
											</p>
											<table className="mt-3 min-w-full text-left text-sm text-slate-200">
												<thead>
													<tr className="text-xs uppercase tracking-[0.2em] text-slate-500">
														<th className="pb-2">Bucket</th>
														<th className="pb-2">Count</th>
														<th className="pb-2">Hit Rate</th>
														<th className="pb-2">Avg ROI</th>
														<th className="pb-2">Avg CLV</th>
													</tr>
												</thead>
												<tbody>
													{table.rows.map((row) => (
														<tr
															key={`${table.title}-${row.bucket}`}
															className={`border-t border-slate-800 ${sampleClassName(row.count)}`}
														>
															<td className="py-2 pr-4 font-semibold text-slate-100">
																{row.bucket}
															</td>
															<td className="py-2 pr-4">
																{row.count}
																{sampleBadge(row.count) ? (
																	<span className="ml-2 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-200">
																		{sampleBadge(row.count)}
																	</span>
																) : null}
															</td>
															<td className="py-2 pr-4">
																{formatPercent(row.hitRate)}
															</td>
															<td className="py-2 pr-4">
																{formatSignedPercent(row.avgRoi)}
															</td>
															<td className="py-2">
																{formatBps(row.avgClvBps)}
															</td>
														</tr>
													))}
												</tbody>
											</table>
										</div>
									))}
								</div>
							) : (
								<p className="text-sm text-slate-400">
									No bucket performance data yet.
								</p>
							)}
						</div>
					</section>

					<section className="rounded-2xl border border-slate-800 bg-slate-950/70 p-6">
						{stats?.filteredTagStats ? (
							<div className="overflow-auto">
								<table className="min-w-full text-left text-sm text-slate-200">
									<thead>
										<tr className="text-xs uppercase tracking-[0.2em] text-slate-500">
											<th className="pb-3">Tag</th>
											<th className="pb-3">Count</th>
											<th className="pb-3">Markets (today)</th>
										</tr>
									</thead>
									<tbody>
										{stats.filteredTagStats.map((entry) => (
											<tr
												key={`${entry.seriesId}-${entry.tag}`}
												className="border-t border-slate-800"
											>
												<td className="py-3 pr-4 font-semibold text-slate-100">
													{entry.tag}{" "}
													<span className="text-xs text-slate-500">
														(series {entry.seriesId})
													</span>
												</td>
												<td className="py-3 pr-4">{entry.count}</td>
												<td className="py-3 text-slate-300">
													{entry.markets.length === 0 ? (
														<span className="text-slate-500">
															No markets returned
														</span>
													) : (
														entry.markets.map((market) => (
															<div
																key={`${entry.seriesId}-${market.title}`}
																className="text-sm"
															>
																{market.title} •{" "}
																{formatUsdCompact(market.volume)}
																{market.eventSlug
																	? ` • ${market.eventSlug}`
																	: market.slug
																		? ` • ${market.slug}`
																		: ""}
															</div>
														))
													)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						) : (
							<p className="text-sm text-slate-400">
								No runtime stats yet. Click "Refresh Stats" to capture the
								latest fetch results.
							</p>
						)}
					</section>
				</div>
			</div>
		</AuthGate>
	);
}
