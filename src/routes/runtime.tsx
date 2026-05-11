import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AuthGate } from "@/components/auth-gate";
import {
	getBotCandidatesFn,
	getBotCohortsFn,
	getBotInspectDefaultsFn,
} from "../server/api/bot";
import { getDailyStatsSnapshotsFn } from "../server/api/daily-stats";
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

function getCanonicalScoreBand(score: number | null | undefined): {
	label: string;
	className: string;
} {
	if (score === null || score === undefined || !Number.isFinite(score)) {
		return {
			label: "no context",
			className: "border-ink-25 bg-ink-05 text-ink-55",
		};
	}
	if (score >= 70) {
		return {
			label: "strong",
			className: "border-signal-pos/30 bg-signal-pos/10 text-signal-pos",
		};
	}
	if (score >= 45) {
		return {
			label: "mixed",
			className: "border-signal-warn/30 bg-signal-warn/10 text-signal-warn",
		};
	}
	return {
		label: "weak",
		className: "border-signal-bad/35 bg-signal-bad/10 text-signal-bad",
	};
}

function formatCanonicalWarningLabel(warning: string): string {
	return warning.replace(/\.$/, "").replaceAll("_", " ");
}

function formatSegmentNote(note: string): string {
	return note.replaceAll("_", " ");
}

function coverageStatus(
	covered: number,
	total: number,
): { label: "good" | "ok" | "low"; className: string; ratio: number } {
	if (total <= 0) {
		return {
			label: "low",
			className: "border-signal-bad/35 bg-signal-bad/10 text-signal-bad",
			ratio: 0,
		};
	}
	const ratio = covered / total;
	if (ratio >= 0.8) {
		return {
			label: "good",
			className: "border-signal-pos/30 bg-signal-pos/10 text-signal-pos",
			ratio,
		};
	}
	if (ratio >= 0.4) {
		return {
			label: "ok",
			className: "border-signal-warn/30 bg-signal-warn/10 text-signal-warn",
			ratio,
		};
	}
	return {
		label: "low",
		className: "border-signal-bad/35 bg-signal-bad/10 text-signal-bad",
		ratio,
	};
}

function sampleClassName(count: number): string {
	if (count < 20) return "bg-signal-bad/10";
	if (count < 50) return "bg-signal-warn/10";
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

function formatTopEntriesForClipboard(
	record: Record<string, number>,
	limit: number = 5,
): string {
	const rows = topEntries(record, limit);
	if (rows.length === 0) return "none";
	return rows.map(([key, count]) => `${key}: ${count}`).join("\n");
}

function sumRecordEntries(
	snapshots: BotCandidateCohortSnapshot[],
	select: (snapshot: BotCandidateCohortSnapshot) => Record<string, number>,
): Record<string, number> {
	const totals: Record<string, number> = {};
	for (const snapshot of snapshots) {
		for (const [key, value] of Object.entries(select(snapshot))) {
			totals[key] = (totals[key] ?? 0) + value;
		}
	}
	return totals;
}

function areBotInspectDefaultsEqual(
	left: BotInspectDefaults,
	right: BotInspectDefaults,
): boolean {
	return (
		left.minGrade === right.minGrade &&
		left.windowMinutes === right.windowMinutes &&
		left.minMinutesToStart === right.minMinutesToStart &&
		left.maxMinutesToStart === right.maxMinutesToStart &&
		left.maxBets === right.maxBets &&
		left.candidateLimit === right.candidateLimit &&
		left.requireReady === right.requireReady &&
		left.includeStarted === right.includeStarted &&
		left.requireMicrostructure === right.requireMicrostructure &&
		left.marketQualityThreshold === right.marketQualityThreshold
	);
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
	withEdgeRating: number;
	withScoreDifferential: number;
	withPriceEdge: number;
	withPriceEdgeRatio: number;
	bySignalScore: CalibrationBucket[];
	byQualityScore: CalibrationBucket[];
	byTimeToStart: CalibrationBucket[];
	byEdgeRating: CalibrationBucket[];
	byScoreDifferential: CalibrationBucket[];
	byPriceEdge: CalibrationBucket[];
	byPriceEdgeRatio: CalibrationBucket[];
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
	avgEdgeRating: number | null;
	avgScoreDifferential: number | null;
	avgPriceEdge: number | null;
	avgPriceEdgeRatio: number | null;
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
		segmentScore?: number;
		segmentKey?: string;
		segmentLabel?: string;
		segmentNotes?: string[];
		canonicalScore?: number | null;
		canonicalSnapshotType?: string | null;
		canonicalWarnings?: string[];
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

type BotCandidateCohortSnapshot = {
	id: string;
	createdAt: number;
	minGrade: string;
	windowMinutes: number;
	minMinutesToStart: number;
	maxMinutesToStart: number;
	requireReady: boolean;
	includeStarted: boolean;
	requireMicrostructure: boolean;
	marketQualityThreshold: number;
	requested: number;
	returned: number;
	totalEntries: number;
	upcomingEntries: number;
	candidatesBeforeDedup: number;
	returnedAfterDedup: number;
	excluded: Record<string, number>;
	policyMatched: Record<string, number>;
	returnedByMarketType: Record<string, number>;
	returnedByTimingBucket: Record<string, number>;
	returnedBySportSeries: Record<string, number>;
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

type BotInspectDefaults = {
	minGrade: "A+" | "A" | "B" | "C" | "D";
	windowMinutes: number;
	minMinutesToStart: number;
	maxMinutesToStart: number;
	maxBets: number;
	candidateLimit: number;
	requireReady: boolean;
	includeStarted: boolean;
	requireMicrostructure: boolean;
	marketQualityThreshold: number;
};

type DailyStatsPerformanceBucket = {
	bucket: string;
	count: number;
	wins: number;
	losses: number;
	pushes: number;
	hitRate: number | null;
	avgRoi: number | null;
	avgClvBps: number | null;
};

type DailyStatsCalibrationBucket = {
	label: string;
	count: number;
	wins: number;
	losses: number;
	pushes: number;
	winRate: number | null;
	avgRoi: number | null;
	avgClvBps: number | null;
};

type DailyStatsSnapshot = {
	dayKey: string;
	windowStartAt: number;
	windowEndAt: number;
	snapshotCreatedAt: number;
	manualPicks: {
		total: number;
		settled: number;
		wins: number;
		losses: number;
		pushes: number;
		avgRoi: number | null;
		totalRoi: number | null;
		avgClv: number | null;
		byTimeToStart: DailyStatsPerformanceBucket[];
		byMarketType: MarketTypePerformanceRow[];
		bySport: SportPerformanceRow[];
		byScoreDifferential: DailyStatsCalibrationBucket[];
		byEdgeRating: DailyStatsCalibrationBucket[];
		byQualityScore: DailyStatsCalibrationBucket[];
	};
	candidateFunnel: {
		runCount: number;
		totalRequested: number;
		totalReturned: number;
		totalEntries: number;
		totalUpcomingEntries: number;
		totalCandidatesBeforeDedup: number;
		totalDedupDropped: number;
		avgReturnedPerRun: number | null;
		avgReturnRate: number | null;
		topExclusions: Array<[string, number]>;
		topPolicyMatched: Array<[string, number]>;
		returnedByMarketType: Record<string, number>;
		returnedByTimingBucket: Record<string, number>;
		returnedBySportSeries: Record<string, number>;
	};
	drift: {
		trailingDays: number;
		baselineDays: number;
		picks: {
			settledDelta: number | null;
			avgRoiDelta: number | null;
			avgClvDelta: number | null;
		};
		candidates: {
			runCountDelta: number | null;
			avgReturnedPerRunDelta: number | null;
			avgReturnRateDelta: number | null;
		};
	};
};

const FALLBACK_BOT_DEFAULTS: BotInspectDefaults = {
	minGrade: "B",
	windowMinutes: 90,
	minMinutesToStart: 15,
	maxMinutesToStart: 75,
	maxBets: 5,
	candidateLimit: 100,
	requireReady: true,
	includeStarted: true,
	requireMicrostructure: true,
	marketQualityThreshold: 0.7,
};

function RuntimePage() {
	const [stats, setStats] = useState<RuntimeStats | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [isBackfilling, setIsBackfilling] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [backfillResult, setBackfillResult] = useState<string | null>(null);

	const [gradeRecalCopyStatus, setGradeRecalCopyStatus] = useState<
		string | null
	>(null);
	const [calibrationCopyStatus, setCalibrationCopyStatus] = useState<
		string | null
	>(null);

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
	const [candidateCohorts, setCandidateCohorts] = useState<
		BotCandidateCohortSnapshot[]
	>([]);
	const [isCandidateCohortsLoading, setIsCandidateCohortsLoading] =
		useState(false);
	const [candidateCohortsError, setCandidateCohortsError] = useState<
		string | null
	>(null);
	const [_botDefaults, setBotDefaults] = useState<BotInspectDefaults>(
		FALLBACK_BOT_DEFAULTS,
	);
	const botDefaultsRef = useRef<BotInspectDefaults>(FALLBACK_BOT_DEFAULTS);
	const [copySnapshotStatus, setCopySnapshotStatus] = useState<string | null>(
		null,
	);
	const [copyCandidateStatus, setCopyCandidateStatus] = useState<string | null>(
		null,
	);
	const [copyCohortStatus, setCopyCohortStatus] = useState<string | null>(null);
	const [isCopyingSnapshot, setIsCopyingSnapshot] = useState(false);
	const [sinceFilter, setSinceFilter] = useState<string>("");
	const sincePickedAtRef = useRef<number | undefined>(undefined);
	const [dailySnapshots, setDailySnapshots] = useState<DailyStatsSnapshot[]>(
		[],
	);
	const [isDailySnapshotsLoading, setIsDailySnapshotsLoading] = useState(false);
	const [dailySnapshotsError, setDailySnapshotsError] = useState<string | null>(
		null,
	);

	const filteredTotalMarkets = stats?.filteredTagStats
		? stats.filteredTagStats.reduce((sum, entry) => sum + entry.count, 0)
		: 0;

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
	const cohortLatest = candidateCohorts[0] ?? null;
	const cohortSummary = useMemo(() => {
		if (candidateCohorts.length === 0) return null;
		const scans = candidateCohorts.length;
		const returnedScans = candidateCohorts.filter(
			(snapshot) => snapshot.returnedAfterDedup > 0,
		).length;
		const totalReturned = candidateCohorts.reduce(
			(sum, snapshot) => sum + snapshot.returnedAfterDedup,
			0,
		);
		const totalUpcoming = candidateCohorts.reduce(
			(sum, snapshot) => sum + snapshot.upcomingEntries,
			0,
		);
		return {
			scans,
			returnedScans,
			totalReturned,
			totalUpcoming,
			avgReturned: totalReturned / scans,
			hitRate: returnedScans / scans,
			aggregatedExcluded: sumRecordEntries(
				candidateCohorts,
				(snapshot) => snapshot.excluded,
			),
			aggregatedReturnedByMarketType: sumRecordEntries(
				candidateCohorts,
				(snapshot) => snapshot.returnedByMarketType,
			),
			aggregatedReturnedByTimingBucket: sumRecordEntries(
				candidateCohorts,
				(snapshot) => snapshot.returnedByTimingBucket,
			),
			aggregatedReturnedBySportSeries: sumRecordEntries(
				candidateCohorts,
				(snapshot) => snapshot.returnedBySportSeries,
			),
		};
	}, [candidateCohorts]);
	const cohortExclusionRows = useMemo(
		() => topEntries(cohortLatest?.excluded ?? {}, 6),
		[cohortLatest],
	);
	const cohortReturnedSections = useMemo(
		() =>
			cohortLatest
				? [
						{
							title: "Returned by market type",
							rows: Object.entries(cohortLatest.returnedByMarketType).sort(
								(left, right) => right[1] - left[1],
							),
						},
						{
							title: "Returned by timing bucket",
							rows: Object.entries(cohortLatest.returnedByTimingBucket).sort(
								(left, right) => right[1] - left[1],
							),
						},
						{
							title: "Returned by sport series",
							rows: Object.entries(cohortLatest.returnedBySportSeries).sort(
								(left, right) => right[1] - left[1],
							),
						},
					]
				: [],
		[cohortLatest],
	);
	const cohortTrendSections = useMemo(
		() =>
			cohortSummary
				? [
						{
							title: "Returned by market type",
							rows: topEntries(cohortSummary.aggregatedReturnedByMarketType, 6),
						},
						{
							title: "Returned by timing bucket",
							rows: topEntries(
								cohortSummary.aggregatedReturnedByTimingBucket,
								6,
							),
						},
						{
							title: "Returned by sport series",
							rows: topEntries(
								cohortSummary.aggregatedReturnedBySportSeries,
								6,
							),
						},
					]
				: [],
		[cohortSummary],
	);
	const latestDailySnapshot = dailySnapshots[0] ?? null;
	const dailyBestTimingBucket = useMemo(() => {
		if (!latestDailySnapshot) return null;
		return (
			[...latestDailySnapshot.manualPicks.byTimeToStart]
				.filter((row) => row.count > 0)
				.sort((left, right) => {
					const roiDelta =
						(right.avgRoi ?? Number.NEGATIVE_INFINITY) -
						(left.avgRoi ?? Number.NEGATIVE_INFINITY);
					if (roiDelta !== 0) return roiDelta;
					return (
						(right.avgClvBps ?? Number.NEGATIVE_INFINITY) -
						(left.avgClvBps ?? Number.NEGATIVE_INFINITY)
					);
				})[0] ?? null
		);
	}, [latestDailySnapshot]);
	const dailyWorstTimingBucket = useMemo(() => {
		if (!latestDailySnapshot) return null;
		return (
			[...latestDailySnapshot.manualPicks.byTimeToStart]
				.filter((row) => row.count > 0)
				.sort((left, right) => {
					const roiDelta =
						(left.avgRoi ?? Number.POSITIVE_INFINITY) -
						(right.avgRoi ?? Number.POSITIVE_INFINITY);
					if (roiDelta !== 0) return roiDelta;
					return (
						(left.avgClvBps ?? Number.POSITIVE_INFINITY) -
						(right.avgClvBps ?? Number.POSITIVE_INFINITY)
					);
				})[0] ?? null
		);
	}, [latestDailySnapshot]);
	const dailyTopMarketTypes = useMemo(
		() => latestDailySnapshot?.manualPicks.byMarketType.slice(0, 3) ?? [],
		[latestDailySnapshot],
	);
	const dailyRecentRows = useMemo(
		() => dailySnapshots.slice(0, 7),
		[dailySnapshots],
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

	const applyBotDefaults = useCallback((nextDefaults: BotInspectDefaults) => {
		botDefaultsRef.current = nextDefaults;
		setBotDefaults((current) =>
			areBotInspectDefaultsEqual(current, nextDefaults)
				? current
				: nextDefaults,
		);
	}, []);

	const loadBotDefaults = useCallback(async () => {
		try {
			const result = await getBotInspectDefaultsFn();
			if (result?.defaults) {
				applyBotDefaults(result.defaults as BotInspectDefaults);
			}
		} catch (err) {
			console.error("Failed to load bot inspect defaults", err);
		}
	}, [applyBotDefaults]);

	const loadCandidateDebug = useCallback(
		async (defaultsOverride?: BotInspectDefaults) => {
			const activeDefaults = defaultsOverride ?? botDefaultsRef.current;
			setIsCandidateDebugLoading(true);
			setCandidateDebugError(null);
			try {
				const result = await getBotCandidatesFn({
					data: {
						minGrade: activeDefaults.minGrade,
						windowMinutes: activeDefaults.windowMinutes,
						minMinutesToStart: activeDefaults.minMinutesToStart,
						maxMinutesToStart: activeDefaults.maxMinutesToStart,
						limit: Math.max(activeDefaults.candidateLimit, 100),
						requireReady: activeDefaults.requireReady,
						includeStarted: activeDefaults.includeStarted,
						requireMicrostructure: activeDefaults.requireMicrostructure,
						marketQualityThreshold: activeDefaults.marketQualityThreshold,
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
		},
		[],
	);

	const loadCandidateCohorts = useCallback(async () => {
		setIsCandidateCohortsLoading(true);
		setCandidateCohortsError(null);
		try {
			const result = await getBotCohortsFn({
				data: { limit: 24 },
			});
			setCandidateCohorts(
				(result.snapshots ?? []) as BotCandidateCohortSnapshot[],
			);
		} catch (err) {
			console.error("Failed to load candidate cohorts", err);
			setCandidateCohortsError("Failed to load candidate cohorts");
		} finally {
			setIsCandidateCohortsLoading(false);
		}
	}, []);

	const loadDailySnapshots = useCallback(async () => {
		setIsDailySnapshotsLoading(true);
		setDailySnapshotsError(null);
		try {
			const result = await getDailyStatsSnapshotsFn({
				data: { limit: 14 },
			});
			setDailySnapshots((result.snapshots ?? []) as DailyStatsSnapshot[]);
		} catch (err) {
			console.error("Failed to load daily stats snapshots", err);
			setDailySnapshotsError("Failed to load daily stats snapshots");
		} finally {
			setIsDailySnapshotsLoading(false);
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
			await loadCandidateCohorts();
			await loadDailySnapshots();
		} catch (err) {
			console.error("Failed to refresh runtime stats", err);
			setError("Failed to refresh runtime stats");
		} finally {
			setIsLoading(false);
		}
	}, [loadStats, loadCandidateDebug, loadCandidateCohorts, loadDailySnapshots]);

	const copySnapshot = useCallback(async () => {
		setCopySnapshotStatus(null);
		setIsCopyingSnapshot(true);
		try {
			const calibrationLimitValue = Number(calibrationLimit);
			const clvThresholdValue = Number(clvQualityThreshold);
			const refreshedStats = await getRuntimeMarketStatsFn({
				data: { freshnessWindowHours: 24 },
			});
			const refreshedDefaults = await getBotInspectDefaultsFn();
			const activeDefaults = (refreshedDefaults.defaults ??
				botDefaultsRef.current) as BotInspectDefaults;
			const refreshedCandidateDebug = await getBotCandidatesFn({
				data: {
					minGrade: activeDefaults.minGrade,
					windowMinutes: activeDefaults.windowMinutes,
					minMinutesToStart: activeDefaults.minMinutesToStart,
					maxMinutesToStart: activeDefaults.maxMinutesToStart,
					limit: Math.max(activeDefaults.candidateLimit, 100),
					requireReady: activeDefaults.requireReady,
					includeStarted: activeDefaults.includeStarted,
					requireMicrostructure: activeDefaults.requireMicrostructure,
					marketQualityThreshold: activeDefaults.marketQualityThreshold,
				},
			});
			if ("error" in refreshedCandidateDebug) {
				throw new Error(refreshedCandidateDebug.error);
			}
			applyBotDefaults(activeDefaults);
			const refreshedCandidateCohorts = await getBotCohortsFn({
				data: { limit: 24 },
			});
			const refreshedDailySnapshots = await getDailyStatsSnapshotsFn({
				data: { limit: 14 },
			});
			const [
				refreshedCalibration,
				refreshedBucketPerformance,
				refreshedClvTiming,
				refreshedSportPerformance,
				refreshedMarketTypePerformance,
				refreshedGradeRecalibration,
			] = await Promise.all([
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
			setCandidateCohorts(
				(refreshedCandidateCohorts.snapshots ??
					[]) as BotCandidateCohortSnapshot[],
			);
			setDailySnapshots(
				(refreshedDailySnapshots.snapshots ?? []) as DailyStatsSnapshot[],
			);
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
						expandedMarketCount: refreshedRuntimeStats.expandedMarketCount ?? 0,
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
							canonicalScore: candidate.grade.canonicalScore ?? null,
							canonicalSnapshotType:
								candidate.grade.canonicalSnapshotType ?? null,
							minutesToStart: candidate.entry.eventTime
								? Math.round(
										(new Date(candidate.entry.eventTime).getTime() -
											Date.now()) /
											60000,
									)
								: null,
						})),
				},
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
	}, [calibrationLimit, clvQualityThreshold, applyBotDefaults]);

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

	const copyCandidatePolicySummary = useCallback(async () => {
		if (!candidateDebugResult) return;
		setCopyCandidateStatus(null);
		const payload = [
			"Candidate Policy",
			`Entries: ${candidateDebugResult.debug.totalEntries}`,
			`Upcoming: ${candidateDebugResult.debug.upcomingEntries}`,
			`Before dedup: ${candidateDebugResult.debug.candidatesBeforeDedup}`,
			`Returned: ${candidateDebugResult.returned}`,
			`Top exclusion: ${formatTopEntriesForClipboard(
				candidateDebugResult.debug.excluded,
				5,
			)}`,
			`Top policy buckets: ${formatTopEntriesForClipboard(
				candidateDebugResult.debug.policyMatched,
				8,
			)}`,
			`Returned by market type: ${formatTopEntriesForClipboard(
				candidateDebugResult.debug.returnedByMarketType,
				5,
			)}`,
			`Returned by timing bucket: ${formatTopEntriesForClipboard(
				candidateDebugResult.debug.returnedByTimingBucket,
				5,
			)}`,
			`Returned by sport series: ${formatTopEntriesForClipboard(
				candidateDebugResult.debug.returnedBySportSeries,
				5,
			)}`,
		].join("\n\n");
		try {
			await navigator.clipboard.writeText(payload);
			setCopyCandidateStatus("Candidate policy copied");
			window.setTimeout(() => setCopyCandidateStatus(null), 2500);
		} catch {
			setCopyCandidateStatus("Copy failed");
			window.setTimeout(() => setCopyCandidateStatus(null), 2500);
		}
	}, [candidateDebugResult]);

	const copyCandidateCohortsSummary = useCallback(async () => {
		if (!cohortLatest || !cohortSummary) return;
		setCopyCohortStatus(null);
		const payload = [
			"Candidate Cohorts",
			`Latest scan: ${formatRelativeTime(cohortLatest.createdAt)}`,
			`Latest returned: ${cohortLatest.returned}`,
			`Latest config: ${cohortLatest.minGrade} | ${cohortLatest.minMinutesToStart}-${cohortLatest.maxMinutesToStart}m | q${cohortLatest.marketQualityThreshold.toFixed(2)}`,
			`Recent scans: ${cohortSummary.scans}`,
			`Returned scans: ${cohortSummary.returnedScans} (${formatPercent(cohortSummary.hitRate)})`,
			`Total returned: ${cohortSummary.totalReturned}`,
			`Avg returned/scan: ${cohortSummary.avgReturned.toFixed(2)}`,
			`Trend top exclusions: ${formatTopEntriesForClipboard(
				cohortSummary.aggregatedExcluded,
				8,
			)}`,
			`Returned by market type: ${formatTopEntriesForClipboard(
				cohortSummary.aggregatedReturnedByMarketType,
				6,
			)}`,
			`Returned by timing bucket: ${formatTopEntriesForClipboard(
				cohortSummary.aggregatedReturnedByTimingBucket,
				6,
			)}`,
			`Returned by sport series: ${formatTopEntriesForClipboard(
				cohortSummary.aggregatedReturnedBySportSeries,
				6,
			)}`,
		].join("\n\n");
		try {
			await navigator.clipboard.writeText(payload);
			setCopyCohortStatus("Candidate cohorts copied");
			window.setTimeout(() => setCopyCohortStatus(null), 2500);
		} catch {
			setCopyCohortStatus("Copy failed");
			window.setTimeout(() => setCopyCohortStatus(null), 2500);
		}
	}, [cohortLatest, cohortSummary]);

	const copyGradeRecal = useCallback(async () => {
		if (!gradeRecalibrationResult) return;
		const header =
			"grade\tcount\twins\tlosses\tpushes\twinRate\tavgRoi\tavgClvBps\tavgSignalScore\tavgEdgeRating\tavgScoreDiff\tavgPriceEdge\tavgPriceEdgeRatio";
		const lines = gradeRecalibrationResult.rows.map((r) =>
			[
				r.grade,
				r.count,
				r.wins,
				r.losses,
				r.pushes,
				r.winRate !== null ? `${(r.winRate * 100).toFixed(1)}%` : "—",
				r.avgRoi !== null ? `${(r.avgRoi * 100).toFixed(1)}%` : "—",
				r.avgClvBps !== null ? r.avgClvBps.toFixed(1) : "—",
				r.avgSignalScore !== null ? r.avgSignalScore.toFixed(1) : "—",
				r.avgEdgeRating !== null ? r.avgEdgeRating.toFixed(1) : "—",
				r.avgScoreDifferential !== null
					? r.avgScoreDifferential.toFixed(1)
					: "—",
				r.avgPriceEdge !== null ? r.avgPriceEdge.toFixed(4) : "—",
				r.avgPriceEdgeRatio !== null ? r.avgPriceEdgeRatio.toFixed(2) : "—",
			].join("\t"),
		);
		const text = `${header}\n${lines.join("\n")}`;
		try {
			await navigator.clipboard.writeText(text);
			setGradeRecalCopyStatus("Copied!");
			window.setTimeout(() => setGradeRecalCopyStatus(null), 2500);
		} catch {
			setGradeRecalCopyStatus("Copy failed");
			window.setTimeout(() => setGradeRecalCopyStatus(null), 2500);
		}
	}, [gradeRecalibrationResult]);

	const copyCalibration = useCallback(async () => {
		if (!calibrationResult) return;
		const allTables = [
			{ title: "Signal Score", rows: calibrationResult.bySignalScore },
			{ title: "Quality Score", rows: calibrationResult.byQualityScore },
			{ title: "Time to Start", rows: calibrationResult.byTimeToStart },
			{ title: "Edge Rating", rows: calibrationResult.byEdgeRating },
			{
				title: "Score Differential",
				rows: calibrationResult.byScoreDifferential,
			},
			{ title: "Price Edge", rows: calibrationResult.byPriceEdge },
			{ title: "Price Edge Ratio", rows: calibrationResult.byPriceEdgeRatio },
		];
		const header =
			"dimension\tbucket\tcount\twins\tlosses\twinRate\tavgRoi\tavgClvBps";
		const lines: string[] = [];
		for (const table of allTables) {
			for (const row of table.rows) {
				lines.push(
					[
						table.title,
						row.label,
						row.count,
						row.wins,
						row.losses,
						row.winRate !== null ? `${(row.winRate * 100).toFixed(1)}%` : "—",
						row.avgRoi !== null ? `${(row.avgRoi * 100).toFixed(1)}%` : "—",
						row.avgClvBps !== null ? row.avgClvBps.toFixed(1) : "—",
					].join("\t"),
				);
			}
		}
		const text = `${header}\n${lines.join("\n")}`;
		try {
			await navigator.clipboard.writeText(text);
			setCalibrationCopyStatus("Copied!");
			window.setTimeout(() => setCalibrationCopyStatus(null), 2500);
		} catch {
			setCalibrationCopyStatus("Copy failed");
			window.setTimeout(() => setCalibrationCopyStatus(null), 2500);
		}
	}, [calibrationResult]);

	useEffect(() => {
		void loadStats();
		void loadBotDefaults();
		void loadCandidateDebug();
		void loadCandidateCohorts();
		void loadDailySnapshots();
		void loadCalibration(2000);
		void loadBucketPerformance(2000);
		void loadClvTiming(2000, 0.66);
		void loadShadowWindows(2000, 0.66);
		void loadSportPerformance(2000, 0.66);
		void loadMarketTypePerformance(2000, 0.66);
		void loadGradeRecalibration(2000);
	}, [
		loadStats,
		loadBotDefaults,
		loadCandidateDebug,
		loadCandidateCohorts,
		loadDailySnapshots,
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
			<div className="min-h-screen bg-ink-00 text-ink-85">
				<div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-10">
					<header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
						<div>
							<p className="text-xs uppercase tracking-[0.3em] text-ink-55">
								Runtime
							</p>
							<h1 className="text-3xl font-semibold text-ink-95">
								Market Fetch Stats
							</h1>
							<p className="mt-2 text-sm text-ink-55">
								Verify how many markets we pull per sport tag and which ones
								dominate by volume.
							</p>
						</div>
						<a
							href="/sharp"
							className="inline-flex h-8 items-center justify-center rounded-md px-3 font-mono text-xxs font-semibold uppercase tracking-wider text-ink-85 ring-1 ring-inset ring-ink-25 transition-colors hover:bg-ink-15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
						>
							Back to Sharp
						</a>
					</header>

					<section className="rounded-lg bg-ink-05 p-6 ring-1 ring-inset ring-ink-15">
						<div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
							<div>
								<p className="text-sm text-ink-55">
									Last fetched: {formatRelativeTime(stats?.fetchedAt)}
								</p>
								<p className="text-sm text-ink-55">
									Filtered markets (window): {filteredTotalMarkets}
								</p>
								<p className="text-sm text-ink-55">
									Expanded events: {stats?.expandedEventCount ?? 0} • Expanded
									markets: {stats?.expandedMarketCount ?? 0}
								</p>
								<p className="text-sm text-ink-55">
									Retries: {stats?.retryCount ?? 0} • Failures:{" "}
									{stats?.failureCount ?? 0} • Pagination caps:{" "}
									{stats?.paginationCapHits?.length ?? 0}
								</p>
								<p className="text-sm text-ink-55">
									Totals: {stats?.totalRuns ?? 0} runs •{" "}
									{stats?.totalRetries ?? 0} retries •{" "}
									{stats?.totalFailures ?? 0} failures
								</p>
								{stats?.cacheFreshness && (
									<p className="text-sm text-ink-55">
										Cache freshness: {stats.cacheFreshness.total} total •{" "}
										{stats.cacheFreshness.staleHistory} stale •{" "}
										{stats.cacheFreshness.missingHistory} missing history
									</p>
								)}
								<p
									className="font-mono text-xxs text-ink-55"
									title={__BUILD_COMMIT_SUBJECT__}
								>
									Build {__BUILD_COMMIT__} · {__BUILD_TIME__}
								</p>
							</div>
							{/* Action hierarchy: primary (Refresh Stats), secondary (Copy Snapshot),
							    tertiary destructive-ish (Backfill, with confirm). */}
							<div className="flex flex-wrap items-center gap-2">
								<button
									type="button"
									onClick={refreshStats}
									disabled={isLoading}
									className="inline-flex h-9 items-center rounded-md bg-brand-blue px-4 font-mono text-xxs font-semibold uppercase tracking-wider text-ink-00 transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue disabled:opacity-40"
								>
									{isLoading ? "refreshing…" : "refresh stats"}
								</button>
								<button
									type="button"
									onClick={() => void copySnapshot()}
									disabled={isCopyingSnapshot}
									className="inline-flex h-9 items-center rounded-md px-3 font-mono text-xxs font-semibold uppercase tracking-wider text-ink-85 ring-1 ring-inset ring-ink-25 transition-colors hover:bg-ink-15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue disabled:opacity-40"
								>
									{isCopyingSnapshot ? "copying…" : "copy snapshot"}
								</button>
								<button
									type="button"
									onClick={() => {
										if (
											!confirm(
												"Backfill historical market data? This may consume API quota.",
											)
										)
											return;
										handleBackfill();
									}}
									disabled={isBackfilling}
									className="inline-flex h-9 items-center rounded-md px-3 font-mono text-xxs font-semibold uppercase tracking-wider text-ink-55 transition-colors hover:bg-signal-warn/10 hover:text-signal-warn focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue disabled:opacity-40"
								>
									{isBackfilling ? "backfilling…" : "backfill history"}
								</button>
							</div>
						</div>

						{error && (
							<div className="mt-4 rounded-md bg-signal-bad/10 px-4 py-2 text-sm text-signal-bad ring-1 ring-inset ring-signal-bad/35">
								{error}
							</div>
						)}
						{backfillResult && (
							<div className="mt-4 rounded-md bg-signal-pos/10 px-4 py-2 text-sm text-signal-pos ring-1 ring-inset ring-signal-pos/30">
								{backfillResult}
							</div>
						)}
						{copySnapshotStatus && (
							<div className="mt-4 rounded-md bg-signal-pos/10 px-4 py-2 text-sm text-signal-pos ring-1 ring-inset ring-signal-pos/30">
								{copySnapshotStatus}
							</div>
						)}
					</section>

					<section className="rounded-lg bg-ink-05 p-6 ring-1 ring-inset ring-ink-15">
						<div className="flex items-start justify-between gap-4">
							<div>
								<p className="text-xs uppercase tracking-[0.3em] text-ink-950">
									Daily Snapshots
								</p>
								<h2 className="mt-2 text-xl font-semibold text-ink-95">
									Automatic Daily Collection
								</h2>
								<p className="mt-2 max-w-2xl text-sm text-ink-55">
									Each UTC day stores a compact pick-performance and
									candidate-funnel snapshot. Use this to spot drift without
									exporting ad hoc tables.
								</p>
							</div>
							<div className="rounded-lg border border-ink-15 bg-ink-10 px-3 py-2 text-right text-xs text-ink-55">
								<div>Rows loaded: {dailySnapshots.length}</div>
								<div>
									Latest refresh:{" "}
									{latestDailySnapshot
										? formatRelativeTime(latestDailySnapshot.snapshotCreatedAt)
										: "Never"}
								</div>
							</div>
						</div>

						{dailySnapshotsError && (
							<div className="mt-4 rounded-md bg-signal-bad/10 px-4 py-2 text-sm text-signal-bad ring-1 ring-inset ring-signal-bad/35">
								{dailySnapshotsError}
							</div>
						)}

						{latestDailySnapshot ? (
							<div className="mt-5 space-y-5">
								<div className="grid gap-3 md:grid-cols-4">
									<div className="rounded-md bg-ink-10 p-4">
										<p className="text-xs uppercase tracking-[0.2em] text-ink-950">
											Latest Day
										</p>
										<p className="mt-2 text-lg font-semibold text-ink-95">
											{latestDailySnapshot.dayKey}
										</p>
										<p className="mt-1 text-sm text-ink-55">
											Settled: {latestDailySnapshot.manualPicks.settled} • Wins:{" "}
											{latestDailySnapshot.manualPicks.wins} • Losses:{" "}
											{latestDailySnapshot.manualPicks.losses}
										</p>
									</div>
									<div className="rounded-md bg-ink-10 p-4">
										<p className="text-xs uppercase tracking-[0.2em] text-ink-950">
											Daily ROI
										</p>
										<p className="mt-2 text-lg font-semibold text-ink-95">
											{formatSignedPercent(
												latestDailySnapshot.manualPicks.avgRoi,
											)}
										</p>
										<p className="mt-1 text-sm text-ink-55">
											vs trailing {latestDailySnapshot.drift.trailingDays}d:{" "}
											{formatSignedPercent(
												latestDailySnapshot.drift.picks.avgRoiDelta,
											)}
										</p>
									</div>
									<div className="rounded-md bg-ink-10 p-4">
										<p className="text-xs uppercase tracking-[0.2em] text-ink-950">
											Daily CLV
										</p>
										<p className="mt-2 text-lg font-semibold text-ink-95">
											{latestDailySnapshot.manualPicks.avgClv !== null
												? formatBps(
														latestDailySnapshot.manualPicks.avgClv * 10000,
													)
												: "—"}
										</p>
										<p className="mt-1 text-sm text-ink-55">
											vs trailing {latestDailySnapshot.drift.trailingDays}d:{" "}
											{latestDailySnapshot.drift.picks.avgClvDelta !== null
												? formatBps(
														latestDailySnapshot.drift.picks.avgClvDelta * 10000,
													)
												: "—"}
										</p>
									</div>
									<div className="rounded-md bg-ink-10 p-4">
										<p className="text-xs uppercase tracking-[0.2em] text-ink-950">
											Candidate Funnel
										</p>
										<p className="mt-2 text-lg font-semibold text-ink-95">
											{latestDailySnapshot.candidateFunnel.totalReturned}{" "}
											returned
										</p>
										<p className="mt-1 text-sm text-ink-55">
											{latestDailySnapshot.candidateFunnel.runCount} runs •{" "}
											{formatPercent(
												latestDailySnapshot.candidateFunnel.avgReturnRate,
											)}{" "}
											return rate
										</p>
									</div>
								</div>

								<div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
									<div className="rounded-md bg-ink-00 p-4">
										<div className="flex items-center justify-between">
											<p className="text-sm font-semibold text-ink-95">
												Recent Daily Trend
											</p>
											{isDailySnapshotsLoading ? (
												<span className="text-xs text-ink-950">
													Refreshing…
												</span>
											) : null}
										</div>
										<table className="mt-3 min-w-full text-left text-sm text-ink-85">
											<thead>
												<tr className="text-xs uppercase tracking-[0.2em] text-ink-950">
													<th scope="col" className="pb-2">
														Day
													</th>
													<th scope="col" className="pb-2">
														Settled
													</th>
													<th scope="col" className="pb-2">
														Avg ROI
													</th>
													<th scope="col" className="pb-2">
														Avg CLV
													</th>
													<th scope="col" className="pb-2">
														Runs
													</th>
													<th scope="col" className="pb-2">
														Return Rate
													</th>
												</tr>
											</thead>
											<tbody>
												{dailyRecentRows.map((snapshot) => (
													<tr
														key={snapshot.dayKey}
														className={`border-t border-ink-15 ${sampleClassName(
															snapshot.manualPicks.settled,
														)}`}
													>
														<td className="py-2 pr-4 font-semibold text-ink-95">
															{snapshot.dayKey}
														</td>
														<td className="py-2 pr-4">
															{snapshot.manualPicks.settled}
														</td>
														<td className="py-2 pr-4">
															{formatSignedPercent(snapshot.manualPicks.avgRoi)}
														</td>
														<td className="py-2 pr-4">
															{snapshot.manualPicks.avgClv !== null
																? formatBps(snapshot.manualPicks.avgClv * 10000)
																: "—"}
														</td>
														<td className="py-2 pr-4">
															{snapshot.candidateFunnel.runCount}
														</td>
														<td className="py-2">
															{formatPercent(
																snapshot.candidateFunnel.avgReturnRate,
															)}
														</td>
													</tr>
												))}
											</tbody>
										</table>
									</div>

									<div className="space-y-4">
										<div className="rounded-md bg-ink-00 p-4">
											<p className="text-sm font-semibold text-ink-95">
												Latest Read
											</p>
											<div className="mt-3 space-y-3 text-sm text-ink-70">
												<div>
													<span className="text-ink-950">
														Best timing bucket:
													</span>{" "}
													{dailyBestTimingBucket
														? `${dailyBestTimingBucket.bucket} • ${formatSignedPercent(
																dailyBestTimingBucket.avgRoi,
															)} • ${formatBps(dailyBestTimingBucket.avgClvBps)}`
														: "—"}
												</div>
												<div>
													<span className="text-ink-950">
														Worst timing bucket:
													</span>{" "}
													{dailyWorstTimingBucket
														? `${dailyWorstTimingBucket.bucket} • ${formatSignedPercent(
																dailyWorstTimingBucket.avgRoi,
															)} • ${formatBps(dailyWorstTimingBucket.avgClvBps)}`
														: "—"}
												</div>
												<div>
													<span className="text-ink-950">Top exclusions:</span>{" "}
													{latestDailySnapshot.candidateFunnel.topExclusions
														.slice(0, 3)
														.map(([reason, count]) => `${reason} (${count})`)
														.join(", ") || "none"}
												</div>
												<div>
													<span className="text-ink-950">
														Top policy buckets:
													</span>{" "}
													{latestDailySnapshot.candidateFunnel.topPolicyMatched
														.slice(0, 3)
														.map(([bucket, count]) => `${bucket} (${count})`)
														.join(", ") || "none"}
												</div>
											</div>
										</div>

										<div className="rounded-md bg-ink-00 p-4">
											<p className="text-sm font-semibold text-ink-95">
												Top Market Types
											</p>
											<div className="mt-3 space-y-2">
												{dailyTopMarketTypes.length > 0 ? (
													dailyTopMarketTypes.map((row) => (
														<div
															key={row.marketType}
															className="flex items-center justify-between rounded-lg border border-ink-15 bg-ink-10 px-3 py-2 text-sm text-ink-85"
														>
															<div>
																<div className="font-semibold text-ink-95">
																	{row.label}
																</div>
																<div className="text-xs text-ink-950">
																	{row.totalCount} picks
																</div>
															</div>
															<div className="text-right">
																<div>{formatSignedPercent(row.avgRoi)}</div>
																<div className="text-xs text-ink-950">
																	{formatBps(row.avgClvBps)}
																</div>
															</div>
														</div>
													))
												) : (
													<p className="text-sm text-ink-55">
														No market-type rollup yet.
													</p>
												)}
											</div>
										</div>
									</div>
								</div>
							</div>
						) : (
							<p className="mt-4 text-sm text-ink-55">
								No daily snapshots yet. The scheduled worker will populate this
								section automatically after the first refresh window.
							</p>
						)}
					</section>

					<section className="rounded-lg bg-ink-05 p-6 ring-1 ring-inset ring-ink-15">
						<div className="flex flex-col gap-4">
							<div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
								<div>
									<h2 className="text-lg font-semibold text-ink-95">
										Candidate Policy
									</h2>
									<p className="mt-1 text-sm text-ink-55">
										Live candidate debug using the current API-side policy
										ranking and filtering defaults.
									</p>
								</div>
								<button
									type="button"
									onClick={() => void loadCandidateDebug()}
									disabled={isCandidateDebugLoading}
									className="rounded-md bg-ink-00 px-3 py-2 text-sm font-semibold text-ink-85 ring-1 ring-inset ring-ink-25 hover:bg-ink-15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue disabled:opacity-40"
								>
									{isCandidateDebugLoading
										? "Refreshing..."
										: "Refresh Candidate Debug"}
								</button>
								<button
									type="button"
									onClick={() => void copyCandidatePolicySummary()}
									disabled={!candidateDebugResult}
									className="rounded-md bg-ink-10 px-3 py-2 text-sm font-semibold text-ink-85 ring-1 ring-inset ring-ink-25 hover:bg-ink-15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue disabled:opacity-40"
								>
									Copy Candidate Policy
								</button>
							</div>
							{candidateDebugError && (
								<div className="rounded-md bg-signal-bad/10 px-4 py-2 text-sm text-signal-bad ring-1 ring-inset ring-signal-bad/35">
									{candidateDebugError}
								</div>
							)}
							{copyCandidateStatus && (
								<div className="rounded-md bg-ink-10 px-4 py-2 text-sm text-ink-85 ring-1 ring-inset ring-brand-blue/30">
									{copyCandidateStatus}
								</div>
							)}
							{candidateDebugResult && (
								<div className="space-y-5">
									<div className="grid gap-3 md:grid-cols-4">
										<div className="rounded-md bg-ink-00 p-4 text-sm text-ink-70">
											<p>Entries: {candidateDebugResult.debug.totalEntries}</p>
											<p>
												Upcoming: {candidateDebugResult.debug.upcomingEntries}
											</p>
										</div>
										<div className="rounded-md bg-ink-00 p-4 text-sm text-ink-70">
											<p>
												Before dedup:{" "}
												{candidateDebugResult.debug.candidatesBeforeDedup}
											</p>
											<p>Returned: {candidateDebugResult.returned}</p>
										</div>
										<div className="rounded-md bg-ink-00 p-4 text-sm text-ink-70">
											<p>
												Dedup dropped: {candidateDebugResult.debug.dedupDropped}
											</p>
											<p>Requested grades: {candidateDebugResult.requested}</p>
										</div>
										<div className="rounded-md bg-ink-00 p-4 text-sm text-ink-70">
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
										<div className="overflow-auto rounded-md bg-ink-00 p-4">
											<h3 className="text-sm font-semibold text-ink-95">
												Top policy buckets
											</h3>
											<table className="mt-3 min-w-full text-left text-sm text-ink-70">
												<thead className="text-xs uppercase tracking-wide text-ink-950">
													<tr>
														<th scope="col" className="pb-2 pr-4">
															Policy
														</th>
														<th scope="col" className="pb-2 text-right">
															Count
														</th>
													</tr>
												</thead>
												<tbody>
													{candidatePolicyRows.map(([key, count]) => (
														<tr
															key={key}
															className="border-t border-ink-15 align-top"
														>
															<td className="py-2 pr-4 text-ink-85">{key}</td>
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
													className="overflow-auto rounded-md bg-ink-00 p-4"
												>
													<h3 className="text-sm font-semibold text-ink-95">
														{section.title}
													</h3>
													<table className="mt-3 min-w-full text-left text-sm text-ink-70">
														<tbody>
															{section.rows.map(([key, count]) => (
																<tr
																	key={key}
																	className="border-t border-ink-15"
																>
																	<td className="py-2 pr-4 text-ink-85">
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
									<div className="overflow-auto rounded-md bg-ink-00 p-4">
										<h3 className="text-sm font-semibold text-ink-95">
											Top returned candidates
										</h3>
										{returnedCandidates.length > 0 ? (
											<table className="mt-3 min-w-full text-left text-sm text-ink-70">
												<thead className="text-xs uppercase tracking-wide text-ink-950">
													<tr>
														<th scope="col" className="pb-2 pr-4">
															Market
														</th>
														<th scope="col" className="pb-2 pr-4">
															Type
														</th>
														<th scope="col" className="pb-2 pr-4">
															Side
														</th>
														<th scope="col" className="pb-2 pr-4">
															Grade
														</th>
														<th scope="col" className="pb-2 pr-4">
															Segment
														</th>
														<th scope="col" className="pb-2 pr-4">
															Quality
														</th>
														<th scope="col" className="pb-2 pr-4">
															Canonical
														</th>
														<th scope="col" className="pb-2 pr-4">
															Why
														</th>
														<th scope="col" className="pb-2 pr-4">
															Score
														</th>
														<th scope="col" className="pb-2 pr-4">
															Price
														</th>
														<th scope="col" className="pb-2">
															Start
														</th>
													</tr>
												</thead>
												<tbody>
													{returnedCandidates.map((candidate) => {
														const canonicalBand = getCanonicalScoreBand(
															candidate.grade.canonicalScore,
														);
														return (
															<tr
																key={candidate.entry.conditionId}
																className="border-t border-ink-15 align-top"
															>
																<td className="py-2 pr-4 text-ink-85">
																	<div className="font-semibold text-ink-95">
																		{candidate.entry.marketTitle}
																	</div>
																	<div className="text-xs text-ink-950">
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
																	<div>
																		{candidate.grade.segmentScore !== undefined
																			? candidate.grade.segmentScore > 0
																				? `+${candidate.grade.segmentScore}`
																				: `${candidate.grade.segmentScore}`
																			: "—"}
																	</div>
																	{candidate.grade.segmentLabel && (
																		<div className="text-xs text-ink-950">
																			{candidate.grade.segmentLabel}
																		</div>
																	)}
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
																	<div>
																		{candidate.grade.canonicalScore != null
																			? candidate.grade.canonicalScore.toFixed(
																					0,
																				)
																			: "—"}
																	</div>
																	{candidate.grade.canonicalSnapshotType && (
																		<div className="text-xs text-ink-950">
																			{candidate.grade.canonicalSnapshotType}
																		</div>
																	)}
																</td>
																<td className="py-2 pr-4">
																	<div
																		className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${canonicalBand.className}`}
																	>
																		{canonicalBand.label}
																	</div>
																	{(candidate.grade.segmentNotes ?? []).length >
																		0 && (
																		<div className="mt-1 flex flex-wrap gap-1">
																			{candidate.grade.segmentNotes
																				.slice(0, 2)
																				.map((note) => (
																					<span
																						key={note}
																						className="rounded-full border ring-brand-blue/30 bg-ink-10 px-2 py-0.5 text-[11px] text-brand-blue"
																					>
																						{formatSegmentNote(note)}
																					</span>
																				))}
																		</div>
																	)}
																	{(candidate.grade.canonicalWarnings ?? [])
																		.length > 0 && (
																		<div className="mt-1 flex flex-wrap gap-1">
																			{candidate.grade.canonicalWarnings
																				.slice(0, 2)
																				.map((warning) => (
																					<span
																						key={warning}
																						className="rounded-full border border-ink-25 bg-ink-10 px-2 py-0.5 text-[11px] text-ink-70"
																					>
																						{formatCanonicalWarningLabel(
																							warning,
																						)}
																					</span>
																				))}
																		</div>
																	)}
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
														);
													})}
												</tbody>
											</table>
										) : (
											<p className="mt-3 text-sm text-ink-55">
												No returned candidates in the current snapshot.
											</p>
										)}
									</div>
									<div className="overflow-auto rounded-md bg-ink-00 p-4">
										<h3 className="text-sm font-semibold text-ink-95">
											Top near misses
										</h3>
										{nearMissCandidates.length > 0 ? (
											<table className="mt-3 min-w-full text-left text-sm text-ink-70">
												<thead className="text-xs uppercase tracking-wide text-ink-950">
													<tr>
														<th scope="col" className="pb-2 pr-4">
															Market
														</th>
														<th scope="col" className="pb-2 pr-4">
															Reason
														</th>
														<th scope="col" className="pb-2 pr-4">
															Grade
														</th>
														<th scope="col" className="pb-2 pr-4">
															Target
														</th>
														<th scope="col" className="pb-2 pr-4">
															Quality
														</th>
														<th scope="col" className="pb-2 pr-4">
															Score
														</th>
														<th scope="col" className="pb-2 pr-4">
															Price
														</th>
														<th scope="col" className="pb-2">
															Start
														</th>
													</tr>
												</thead>
												<tbody>
													{nearMissCandidates.map((candidate) => (
														<tr
															key={`${candidate.reason}-${candidate.conditionId}`}
															className="border-t border-ink-15 align-top"
														>
															<td className="py-2 pr-4 text-ink-85">
																<div className="font-semibold text-ink-95">
																	{candidate.marketTitle}
																</div>
																<div className="text-xs text-ink-950">
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
											<p className="mt-3 text-sm text-ink-55">
												No near misses captured in the current snapshot.
											</p>
										)}
									</div>
								</div>
							)}
						</div>
					</section>

					<section className="rounded-lg bg-ink-05 p-6 ring-1 ring-inset ring-ink-15">
						<div className="flex flex-col gap-4">
							<div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
								<div>
									<h2 className="text-lg font-semibold text-ink-95">
										Candidate Cohorts
									</h2>
									<p className="mt-1 text-sm text-ink-55">
										Recent production candidate scans persisted by the bot API.
									</p>
								</div>
								<div className="flex flex-wrap gap-2">
									<button
										type="button"
										onClick={() => void loadCandidateCohorts()}
										disabled={isCandidateCohortsLoading}
										className="rounded-md bg-ink-00 px-3 py-2 text-sm font-semibold text-ink-85 ring-1 ring-inset ring-ink-25 hover:bg-ink-15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue disabled:opacity-40"
									>
										{isCandidateCohortsLoading
											? "Refreshing..."
											: "Refresh Cohorts"}
									</button>
									<button
										type="button"
										onClick={() => void copyCandidateCohortsSummary()}
										disabled={!cohortLatest || !cohortSummary}
										className="rounded-md bg-ink-10 px-3 py-2 text-sm font-semibold text-ink-85 ring-1 ring-inset ring-ink-25 hover:bg-ink-15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue disabled:opacity-40"
									>
										Copy Candidate Cohorts
									</button>
								</div>
							</div>
							{candidateCohortsError && (
								<div className="rounded-md bg-signal-bad/10 px-4 py-2 text-sm text-signal-bad ring-1 ring-inset ring-signal-bad/35">
									{candidateCohortsError}
								</div>
							)}
							{copyCohortStatus && (
								<div className="rounded-md bg-ink-10 px-4 py-2 text-sm text-ink-85 ring-1 ring-inset ring-brand-blue/30">
									{copyCohortStatus}
								</div>
							)}
							{cohortLatest && (
								<div className="space-y-5">
									<div className="grid gap-3 md:grid-cols-4">
										<div className="rounded-md bg-ink-00 p-4 text-sm text-ink-70">
											<p>
												Latest: {formatRelativeTime(cohortLatest.createdAt)}
											</p>
											<p>Returned: {cohortLatest.returned}</p>
										</div>
										<div className="rounded-md bg-ink-00 p-4 text-sm text-ink-70">
											<p>Upcoming: {cohortLatest.upcomingEntries}</p>
											<p>Before dedup: {cohortLatest.candidatesBeforeDedup}</p>
										</div>
										<div className="rounded-md bg-ink-00 p-4 text-sm text-ink-70">
											<p>
												Config: {cohortLatest.minGrade} •{" "}
												{cohortLatest.minMinutesToStart}-
												{cohortLatest.maxMinutesToStart}m
											</p>
											<p>
												Quality:{" "}
												{cohortLatest.marketQualityThreshold.toFixed(2)}
											</p>
										</div>
										<div className="rounded-md bg-ink-00 p-4 text-sm text-ink-70">
											<p>
												Started:{" "}
												{cohortLatest.includeStarted ? "included" : "excluded"}
											</p>
											<p>
												Microstructure:{" "}
												{cohortLatest.requireMicrostructure ? "on" : "off"}
											</p>
										</div>
									</div>
									{cohortSummary && (
										<div className="grid gap-3 md:grid-cols-4">
											<div className="rounded-md bg-ink-00 p-4 text-sm text-ink-70">
												<p>Recent scans: {cohortSummary.scans}</p>
												<p>
													Returned scans: {cohortSummary.returnedScans} (
													{formatPercent(cohortSummary.hitRate)})
												</p>
											</div>
											<div className="rounded-md bg-ink-00 p-4 text-sm text-ink-70">
												<p>Total returned: {cohortSummary.totalReturned}</p>
												<p>
													Avg returned/scan:{" "}
													{cohortSummary.avgReturned.toFixed(2)}
												</p>
											</div>
											<div className="rounded-md bg-ink-00 p-4 text-sm text-ink-70">
												<p>Total upcoming: {cohortSummary.totalUpcoming}</p>
												<p>
													Avg upcoming/scan:{" "}
													{cohortSummary.scans > 0
														? (
																cohortSummary.totalUpcoming /
																cohortSummary.scans
															).toFixed(1)
														: "—"}
												</p>
											</div>
											<div className="rounded-md bg-ink-00 p-4 text-sm text-ink-70">
												<p>
													Trend top exclusion:{" "}
													{topEntries(
														cohortSummary.aggregatedExcluded,
														1,
													)[0]?.join(" = ") ?? "—"}
												</p>
												<p>
													Window: last {cohortSummary.scans} persisted scans
												</p>
											</div>
										</div>
									)}
									<div className="grid gap-4 lg:grid-cols-2">
										<div className="overflow-auto rounded-md bg-ink-00 p-4">
											<h3 className="text-sm font-semibold text-ink-95">
												Top exclusions
											</h3>
											<table className="mt-3 min-w-full text-left text-sm text-ink-70">
												<tbody>
													{cohortExclusionRows.map(([key, count]) => (
														<tr key={key} className="border-t border-ink-15">
															<td className="py-2 pr-4 text-ink-85">{key}</td>
															<td className="py-2 text-right">{count}</td>
														</tr>
													))}
												</tbody>
											</table>
										</div>
										<div className="space-y-4">
											{cohortReturnedSections.map((section) => (
												<div
													key={section.title}
													className="overflow-auto rounded-md bg-ink-00 p-4"
												>
													<h3 className="text-sm font-semibold text-ink-95">
														{section.title}
													</h3>
													<table className="mt-3 min-w-full text-left text-sm text-ink-70">
														<tbody>
															{section.rows.length > 0 ? (
																section.rows.map(([key, count]) => (
																	<tr
																		key={key}
																		className="border-t border-ink-15"
																	>
																		<td className="py-2 pr-4 text-ink-85">
																			{key}
																		</td>
																		<td className="py-2 text-right">{count}</td>
																	</tr>
																))
															) : (
																<tr className="border-t border-ink-15">
																	<td className="py-2 text-ink-950" colSpan={2}>
																		No returned candidates
																	</td>
																</tr>
															)}
														</tbody>
													</table>
												</div>
											))}
										</div>
									</div>
									{cohortSummary && (
										<div className="grid gap-4 lg:grid-cols-2">
											<div className="overflow-auto rounded-md bg-ink-00 p-4">
												<h3 className="text-sm font-semibold text-ink-95">
													Trend top exclusions
												</h3>
												<table className="mt-3 min-w-full text-left text-sm text-ink-70">
													<tbody>
														{topEntries(
															cohortSummary.aggregatedExcluded,
															8,
														).map(([key, count]) => (
															<tr key={key} className="border-t border-ink-15">
																<td className="py-2 pr-4 text-ink-85">{key}</td>
																<td className="py-2 text-right">{count}</td>
															</tr>
														))}
													</tbody>
												</table>
											</div>
											<div className="space-y-4">
												{cohortTrendSections.map((section) => (
													<div
														key={section.title}
														className="overflow-auto rounded-md bg-ink-00 p-4"
													>
														<h3 className="text-sm font-semibold text-ink-95">
															{section.title}
														</h3>
														<table className="mt-3 min-w-full text-left text-sm text-ink-70">
															<tbody>
																{section.rows.length > 0 ? (
																	section.rows.map(([key, count]) => (
																		<tr
																			key={key}
																			className="border-t border-ink-15"
																		>
																			<td className="py-2 pr-4 text-ink-85">
																				{key}
																			</td>
																			<td className="py-2 text-right">
																				{count}
																			</td>
																		</tr>
																	))
																) : (
																	<tr className="border-t border-ink-15">
																		<td
																			className="py-2 text-ink-950"
																			colSpan={2}
																		>
																			No returned candidates
																		</td>
																	</tr>
																)}
															</tbody>
														</table>
													</div>
												))}
											</div>
										</div>
									)}
									<div className="overflow-auto rounded-md bg-ink-00 p-4">
										<h3 className="text-sm font-semibold text-ink-95">
											Recent scans
										</h3>
										<table className="mt-3 min-w-full text-left text-sm text-ink-70">
											<thead className="text-xs uppercase tracking-wide text-ink-950">
												<tr>
													<th scope="col" className="pb-2 pr-4">
														When
													</th>
													<th scope="col" className="pb-2 pr-4">
														Config
													</th>
													<th scope="col" className="pb-2 pr-4">
														Returned
													</th>
													<th scope="col" className="pb-2 pr-4">
														Upcoming
													</th>
													<th scope="col" className="pb-2">
														Top exclusion
													</th>
												</tr>
											</thead>
											<tbody>
												{candidateCohorts.map((snapshot) => (
													<tr
														key={snapshot.id}
														className="border-t border-ink-15"
													>
														<td className="py-2 pr-4 text-ink-85">
															{formatRelativeTime(snapshot.createdAt)}
														</td>
														<td className="py-2 pr-4">
															{snapshot.minGrade} • {snapshot.minMinutesToStart}
															-{snapshot.maxMinutesToStart}m • q
															{snapshot.marketQualityThreshold.toFixed(2)}
														</td>
														<td className="py-2 pr-4">
															{snapshot.returnedAfterDedup}
														</td>
														<td className="py-2 pr-4">
															{snapshot.upcomingEntries}
														</td>
														<td className="py-2">
															{topEntries(snapshot.excluded, 1)[0]?.join(
																" = ",
															) ?? "—"}
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

					<section className="rounded-lg bg-ink-05 p-6 ring-1 ring-inset ring-ink-15">
						<div className="flex flex-col gap-4">
							<div>
								<h2 className="text-lg font-semibold text-ink-95">
									CLV Timing Dashboard
								</h2>
								<p className="mt-1 text-sm text-ink-55">
									Compare CLV and ROI by entry timing, split by grade and
									quality threshold.
								</p>
							</div>
							<div className="flex flex-wrap items-end gap-3">
								<div>
									<label
										htmlFor="clv-quality-threshold"
										className="block text-xs text-ink-55"
									>
										Quality threshold
									</label>
									<input
										id="clv-quality-threshold"
										value={clvQualityThreshold}
										onChange={(event) =>
											setClvQualityThreshold(event.target.value)
										}
										className="mt-1 w-40 rounded-md border border-ink-25 bg-ink-00 px-2 py-1 text-sm text-ink-95"
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
									className="rounded-lg bg-brand-blue px-3 py-2 text-sm font-semibold text-ink-00 hover:brightness-110 disabled:opacity-60"
								>
									{isClvTimingLoading ? "Refreshing..." : "Refresh CLV Timing"}
								</button>
							</div>
							{clvTimingError && (
								<div className="rounded-md bg-signal-bad/10 px-4 py-2 text-sm text-signal-bad ring-1 ring-inset ring-signal-bad/35">
									{clvTimingError}
								</div>
							)}
							{clvTimingResult ? (
								<div className="space-y-5">
									<div className="rounded-md bg-ink-00 p-4 text-sm text-ink-70">
										Settled picks: {clvTimingResult.settledPicks} • Quality
										threshold: {clvTimingResult.qualityThreshold.toFixed(2)}
									</div>
									{clvTimingResult.segments.map((segment) => (
										<div
											key={segment.key}
											className="overflow-auto rounded-md bg-ink-00 p-4"
										>
											<p className="text-sm font-semibold text-ink-95">
												{segment.label}
											</p>
											<p className="mt-1 text-xs text-ink-55">
												Matched: {segment.matchedPicks} • With event time:{" "}
												{segment.withEventTime}
											</p>
											<table className="mt-3 min-w-full text-left text-sm text-ink-85">
												<thead>
													<tr className="text-xs uppercase tracking-[0.2em] text-ink-950">
														<th scope="col" className="pb-2">
															Time Bucket
														</th>
														<th scope="col" className="pb-2">
															Count
														</th>
														<th scope="col" className="pb-2">
															Hit Rate
														</th>
														<th scope="col" className="pb-2">
															Avg ROI
														</th>
														<th scope="col" className="pb-2">
															Avg CLV
														</th>
													</tr>
												</thead>
												<tbody>
													{segment.byTimeToStart.map((row) => (
														<tr
															key={`${segment.key}-${row.bucket}`}
															className={`border-t border-ink-15 ${sampleClassName(row.count)}`}
														>
															<td className="py-2 pr-4 font-semibold text-ink-95">
																{row.bucket}
															</td>
															<td className="py-2 pr-4">
																{row.count}
																{sampleBadge(row.count) ? (
																	<span className="ml-2 rounded border border-signal-warn/30 bg-signal-warn/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-signal-warn">
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
								<p className="text-sm text-ink-55">No CLV timing data yet.</p>
							)}
							<div className="mt-6">
								<div className="mb-3 flex flex-wrap items-center justify-between gap-3">
									<p className="text-sm font-semibold text-ink-95">
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
										className="rounded-lg border ring-brand-blue/30 bg-brand-blue/10 px-3 py-2 text-sm font-semibold text-brand-blue hover:bg-brand-blue/15 disabled:opacity-60"
									>
										{isShadowWindowLoading
											? "Refreshing..."
											: "Refresh Shadow Windows"}
									</button>
								</div>
								<p className="text-xs text-ink-55">
									Hypothetical windows use historical snapshots
									(T-120/T-60/T-30/T-15/T-5/T-2) without placing real bets.
								</p>
								{shadowWindowError && (
									<div className="mt-3 rounded-md bg-signal-bad/10 px-4 py-2 text-sm text-signal-bad ring-1 ring-inset ring-signal-bad/35">
										{shadowWindowError}
									</div>
								)}
								{shadowWindowResult ? (
									<div className="mt-4 space-y-5">
										<div className="rounded-md bg-ink-00 p-4 text-sm text-ink-70">
											Settled picks: {shadowWindowResult.settledPicks} • Quality
											threshold:{" "}
											{shadowWindowResult.qualityThreshold.toFixed(2)}
										</div>
										{shadowWindowResult.segments.map((segment) => (
											<div
												key={segment.key}
												className="overflow-auto rounded-md bg-ink-00 p-4"
											>
												<p className="text-sm font-semibold text-ink-95">
													{segment.label}
												</p>
												<p className="mt-1 text-xs text-ink-55">
													Matched picks: {segment.matchedPicks}
												</p>
												<table className="mt-3 min-w-full text-left text-sm text-ink-85">
													<thead>
														<tr className="text-xs uppercase tracking-[0.2em] text-ink-950">
															<th scope="col" className="pb-2">
																Window
															</th>
															<th scope="col" className="pb-2">
																Count
															</th>
															<th scope="col" className="pb-2">
																Hit Rate
															</th>
															<th scope="col" className="pb-2">
																Avg ROI
															</th>
															<th scope="col" className="pb-2">
																Avg CLV
															</th>
														</tr>
													</thead>
													<tbody>
														{segment.rows.map((row) => (
															<tr
																key={`${segment.key}-${row.windowKey}`}
																className={`border-t border-ink-15 ${sampleClassName(row.count)}`}
															>
																<td className="py-2 pr-4 font-semibold text-ink-95">
																	{row.windowLabel}
																</td>
																<td className="py-2 pr-4">
																	{row.count}
																	{sampleBadge(row.count) ? (
																		<span className="ml-2 rounded border border-signal-warn/30 bg-signal-warn/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-signal-warn">
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
									<p className="mt-3 text-sm text-ink-55">
										No shadow window data yet.
									</p>
								)}
							</div>
							<details className="mt-6 rounded-md bg-ink-00 p-4">
								<summary className="cursor-pointer text-sm font-semibold text-ink-95">
									Performance by Market Type
								</summary>
								<p className="mt-2 text-xs text-ink-55">
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
										className="rounded-lg border ring-brand-blue/30 bg-brand-blue/10 px-3 py-2 text-sm font-semibold text-brand-blue hover:bg-brand-blue/15 disabled:opacity-60"
									>
										{isMarketTypePerformanceLoading
											? "Refreshing..."
											: "Refresh Market Types"}
									</button>
								</div>
								{marketTypePerformanceError && (
									<div className="mt-3 rounded-md bg-signal-bad/10 px-4 py-2 text-sm text-signal-bad ring-1 ring-inset ring-signal-bad/35">
										{marketTypePerformanceError}
									</div>
								)}
								{marketTypePerformanceResult ? (
									<div className="mt-4 overflow-auto">
										<div className="mb-2 text-xs text-ink-55">
											Settled picks: {marketTypePerformanceResult.settledPicks}{" "}
											• Quality threshold:{" "}
											{marketTypePerformanceResult.qualityThreshold.toFixed(2)}
										</div>
										<table className="min-w-full text-left text-sm text-ink-85">
											<thead>
												<tr className="text-xs uppercase tracking-[0.2em] text-ink-950">
													<th scope="col" className="pb-2">
														Market Type
													</th>
													<th scope="col" className="pb-2">
														All Count
													</th>
													<th scope="col" className="pb-2">
														All Hit
													</th>
													<th scope="col" className="pb-2">
														All ROI
													</th>
													<th scope="col" className="pb-2">
														All CLV
													</th>
													<th scope="col" className="pb-2">
														Q Count
													</th>
													<th scope="col" className="pb-2">
														Q Hit
													</th>
													<th scope="col" className="pb-2">
														Q ROI
													</th>
													<th scope="col" className="pb-2">
														Q CLV
													</th>
												</tr>
											</thead>
											<tbody>
												{marketTypePerformanceResult.rows.map((row) => (
													<tr
														key={row.marketType}
														className={`border-t border-ink-15 ${sampleClassName(row.totalCount)}`}
													>
														<td className="py-2 pr-4 font-semibold text-ink-95">
															{row.label}
														</td>
														<td className="py-2 pr-4">
															{row.totalCount}
															{sampleBadge(row.totalCount) ? (
																<span className="ml-2 rounded border border-signal-warn/30 bg-signal-warn/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-signal-warn">
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
									<p className="mt-3 text-sm text-ink-55">
										No market-type performance data yet.
									</p>
								)}
							</details>
							<details className="mt-6 rounded-md bg-ink-00 p-4">
								<summary className="cursor-pointer text-sm font-semibold text-ink-95">
									Performance by Sport
								</summary>
								<p className="mt-2 text-xs text-ink-55">
									Shows sport-level hit/ROI/CLV across all settled picks and the
									quality-threshold subset.
								</p>
								{ncaabSportRow ? (
									<div className="mt-3 grid gap-3 md:grid-cols-2">
										<div className="rounded-xl border border-signal-warn/30 bg-signal-warn/10 p-4">
											<p className="text-xs uppercase tracking-[0.2em] text-signal-warn">
												NCAAB All
											</p>
											<p className="mt-2 text-sm text-ink-85">
												{ncaabSportRow.totalCount} picks •{" "}
												{formatPercent(ncaabSportRow.winRate)} hit •{" "}
												{formatSignedPercent(ncaabSportRow.avgRoi)} ROI •{" "}
												{formatBps(ncaabSportRow.avgClvBps)} CLV
											</p>
										</div>
										<div className="rounded-xl border ring-brand-blue/25 bg-brand-blue/10 p-4">
											<p className="text-xs uppercase tracking-[0.2em] text-brand-blue">
												NCAAB Quality
											</p>
											<p className="mt-2 text-sm text-ink-85">
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
										className="rounded-lg border ring-brand-blue/30 bg-brand-blue/10 px-3 py-2 text-sm font-semibold text-brand-blue hover:bg-brand-blue/15 disabled:opacity-60"
									>
										{isSportPerformanceLoading
											? "Refreshing..."
											: "Refresh Sport Performance"}
									</button>
								</div>
								{sportPerformanceError && (
									<div className="mt-3 rounded-md bg-signal-bad/10 px-4 py-2 text-sm text-signal-bad ring-1 ring-inset ring-signal-bad/35">
										{sportPerformanceError}
									</div>
								)}
								{sportPerformanceResult ? (
									<div className="mt-4 overflow-auto">
										<div className="mb-2 text-xs text-ink-55">
											Settled picks: {sportPerformanceResult.settledPicks} •
											Quality threshold:{" "}
											{sportPerformanceResult.qualityThreshold.toFixed(2)}
										</div>
										<table className="min-w-full text-left text-sm text-ink-85">
											<thead>
												<tr className="text-xs uppercase tracking-[0.2em] text-ink-950">
													<th scope="col" className="pb-2">
														Sport
													</th>
													<th scope="col" className="pb-2">
														All Count
													</th>
													<th scope="col" className="pb-2">
														All Hit
													</th>
													<th scope="col" className="pb-2">
														All ROI
													</th>
													<th scope="col" className="pb-2">
														All CLV
													</th>
													<th scope="col" className="pb-2">
														Q Count
													</th>
													<th scope="col" className="pb-2">
														Q Hit
													</th>
													<th scope="col" className="pb-2">
														Q ROI
													</th>
													<th scope="col" className="pb-2">
														Q CLV
													</th>
												</tr>
											</thead>
											<tbody>
												{sportPerformanceResult.rows.map((row) => (
													<tr
														key={row.sportTag}
														className={`border-t border-ink-15 ${sampleClassName(row.totalCount)}`}
													>
														<td className="py-2 pr-4 font-semibold text-ink-95">
															{row.label}
														</td>
														<td className="py-2 pr-4">
															{row.totalCount}
															{sampleBadge(row.totalCount) ? (
																<span className="ml-2 rounded border border-signal-warn/30 bg-signal-warn/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-signal-warn">
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
									<p className="mt-3 text-sm text-ink-55">
										No sport performance data yet.
									</p>
								)}
							</details>
						</div>
					</section>

					<section className="rounded-lg bg-ink-05 p-6 ring-1 ring-inset ring-ink-15">
						<div className="flex flex-col gap-4">
							<div>
								<h2 className="text-lg font-semibold text-ink-95">
									Pick Calibration
								</h2>
								<p className="mt-1 text-sm text-ink-55">
									Where picks are actually performing: by score and by
									time-to-start.
								</p>
							</div>
							<div className="rounded-md bg-ink-00 p-4">
								<p className="text-sm font-semibold text-ink-95">
									Coverage Health
								</p>
								<p className="mt-1 text-xs text-ink-55">
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
										className="block text-xs text-ink-55"
									>
										Pick sample limit
									</label>
									<input
										id="calibration-limit"
										value={calibrationLimit}
										onChange={(event) =>
											setCalibrationLimit(event.target.value)
										}
										className="mt-1 w-40 rounded-md border border-ink-25 bg-ink-00 px-2 py-1 text-sm text-ink-95"
									/>
								</div>
								<div>
									<label
										htmlFor="since-filter"
										className="block text-xs text-ink-55"
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
										className="mt-1 w-40 rounded-md border border-ink-25 bg-ink-00 px-2 py-1 text-sm text-ink-95"
									>
										<option value="">All time</option>
										<option value="1">Last 24h</option>
										<option value="3">Last 3d</option>
										<option value="7">Last 7d</option>
										<option value="14">Last 14d</option>
										<option value="@1774480000">
											Since L2 removal (Mar 25)
										</option>
										<option value="30">Last 30d</option>
									</select>
									{sinceFilter !== "" && (
										<p className="mt-1 text-xs text-ink-55">
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
									className="rounded-lg bg-brand-blue px-3 py-2 text-sm font-semibold text-ink-00 hover:brightness-110 disabled:opacity-60"
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
									className="rounded-lg border ring-brand-blue/30 bg-brand-blue/10 px-3 py-2 text-sm font-semibold text-brand-blue hover:bg-brand-blue/15 disabled:opacity-60"
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
									className="rounded-lg border ring-brand-blue/30 bg-brand-blue/10 px-3 py-2 text-sm font-semibold text-brand-blue hover:bg-brand-blue/15 disabled:opacity-60"
								>
									{isGradeRecalibrationLoading
										? "Refreshing..."
										: "Refresh Grade Recal"}
								</button>
							</div>
							{calibrationError && (
								<div className="rounded-md bg-signal-bad/10 px-4 py-2 text-sm text-signal-bad ring-1 ring-inset ring-signal-bad/35">
									{calibrationError}
								</div>
							)}
							{bucketPerformanceError && (
								<div className="rounded-md bg-signal-bad/10 px-4 py-2 text-sm text-signal-bad ring-1 ring-inset ring-signal-bad/35">
									{bucketPerformanceError}
								</div>
							)}
							{gradeRecalibrationError && (
								<div className="rounded-md bg-signal-bad/10 px-4 py-2 text-sm text-signal-bad ring-1 ring-inset ring-signal-bad/35">
									{gradeRecalibrationError}
								</div>
							)}
							{calibrationResult ? (
								<div className="space-y-5">
									<div className="flex items-center justify-between rounded-md bg-ink-00 p-4 text-sm text-ink-70">
										<span>
											Total picks: {calibrationResult.totalPicks} • Settled:{" "}
											{calibrationResult.settledPicks} • Signal scored:{" "}
											{calibrationResult.withSignalScore} • Quality scored:{" "}
											{calibrationResult.withQualityScore} • With event time:{" "}
											{calibrationResult.withEventTime}
										</span>
										<button
											type="button"
											onClick={copyCalibration}
											className="ml-3 shrink-0 rounded-lg border border-ink-25 px-3 py-1.5 text-xs text-ink-70 hover:bg-ink-15"
										>
											{calibrationCopyStatus ?? "Copy TSV"}
										</button>
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
										{
											title: "By edge rating",
											rows: calibrationResult.byEdgeRating,
										},
										{
											title: "By score differential",
											rows: calibrationResult.byScoreDifferential,
										},
										{
											title: "By price edge",
											rows: calibrationResult.byPriceEdge,
										},
										{
											title: "By price edge ratio (edge/minEdge)",
											rows: calibrationResult.byPriceEdgeRatio,
										},
									].map((table) => (
										<div
											key={table.title}
											className="overflow-auto rounded-md bg-ink-00 p-4"
										>
											<p className="text-sm font-semibold text-ink-95">
												{table.title}
											</p>
											<table className="mt-3 min-w-full text-left text-sm text-ink-85">
												<thead>
													<tr className="text-xs uppercase tracking-[0.2em] text-ink-950">
														<th scope="col" className="pb-2">
															Bucket
														</th>
														<th scope="col" className="pb-2">
															Count
														</th>
														<th scope="col" className="pb-2">
															Win Rate
														</th>
														<th scope="col" className="pb-2">
															Avg ROI
														</th>
														<th scope="col" className="pb-2">
															Avg CLV
														</th>
													</tr>
												</thead>
												<tbody>
													{table.rows.map((row) => (
														<tr
															key={`${table.title}-${row.label}`}
															className={`border-t border-ink-15 ${sampleClassName(row.count)}`}
														>
															<td className="py-2 pr-4 font-semibold text-ink-95">
																{row.label}
															</td>
															<td className="py-2 pr-4">
																{row.count}
																{sampleBadge(row.count) ? (
																	<span className="ml-2 rounded border border-signal-warn/30 bg-signal-warn/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-signal-warn">
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
										<div className="rounded-md bg-ink-00 p-4">
											<div className="flex items-center justify-between">
												<div>
													<p className="text-sm font-semibold text-ink-95">
														Grade Recalibration
													</p>
													<p className="mt-1 text-xs text-ink-55">
														Current grade performance and the score ranges
														feeding those grades.
													</p>
												</div>
												<button
													type="button"
													onClick={copyGradeRecal}
													className="rounded-lg border border-ink-25 px-3 py-1.5 text-xs text-ink-70 hover:bg-ink-15"
												>
													{gradeRecalCopyStatus ?? "Copy TSV"}
												</button>
											</div>
											<div className="mt-3 flex flex-wrap gap-2">
												{gradeRecalibrationResult.observations.map(
													(observation) => (
														<div
															key={observation}
															className="rounded-lg border border-signal-warn/30 bg-signal-warn/10 px-3 py-2 text-xs text-signal-warn"
														>
															{observation}
														</div>
													),
												)}
											</div>
											<table className="mt-3 min-w-full text-left text-sm text-ink-85">
												<thead>
													<tr className="text-xs uppercase tracking-[0.2em] text-ink-950">
														<th scope="col" className="pb-2">
															Grade
														</th>
														<th scope="col" className="pb-2">
															Count
														</th>
														<th scope="col" className="pb-2">
															Hit Rate
														</th>
														<th scope="col" className="pb-2">
															Avg ROI
														</th>
														<th scope="col" className="pb-2">
															Avg CLV
														</th>
														<th scope="col" className="pb-2">
															Avg Score
														</th>
														<th scope="col" className="pb-2">
															Score Range
														</th>
														<th scope="col" className="pb-2">
															Avg Edge
														</th>
														<th scope="col" className="pb-2">
															Avg PriceEdge
														</th>
														<th scope="col" className="pb-2">
															Avg PE Ratio
														</th>
													</tr>
												</thead>
												<tbody>
													{gradeRecalibrationResult.rows.map((row) => (
														<tr
															key={row.grade}
															className={`border-t border-ink-15 ${sampleClassName(row.count)}`}
														>
															<td className="py-2 pr-4 font-semibold text-ink-95">
																{row.grade}
															</td>
															<td className="py-2 pr-4">
																{row.count}
																{sampleBadge(row.count) ? (
																	<span className="ml-2 rounded border border-signal-warn/30 bg-signal-warn/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-signal-warn">
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
															<td className="py-2 pr-4">
																{row.minSignalScore !== null &&
																row.maxSignalScore !== null
																	? `${row.minSignalScore.toFixed(1)}-${row.maxSignalScore.toFixed(1)}`
																	: "—"}
															</td>
															<td className="py-2 pr-4">
																{row.avgEdgeRating !== null
																	? row.avgEdgeRating.toFixed(1)
																	: "—"}
															</td>
															<td className="py-2 pr-4">
																{row.avgPriceEdge !== null
																	? row.avgPriceEdge.toFixed(4)
																	: "—"}
															</td>
															<td className="py-2">
																{row.avgPriceEdgeRatio !== null
																	? row.avgPriceEdgeRatio.toFixed(2)
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
								<p className="text-sm text-ink-55">
									No calibration data yet. Place bets and settle outcomes, then
									refresh.
								</p>
							)}
							{bucketPerformanceResult ? (
								<div className="space-y-5">
									<div className="rounded-md bg-ink-00 p-4 text-sm text-ink-70">
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
											className="overflow-auto rounded-md bg-ink-00 p-4"
										>
											<p className="text-sm font-semibold text-ink-95">
												{table.title}
											</p>
											<table className="mt-3 min-w-full text-left text-sm text-ink-85">
												<thead>
													<tr className="text-xs uppercase tracking-[0.2em] text-ink-950">
														<th scope="col" className="pb-2">
															Bucket
														</th>
														<th scope="col" className="pb-2">
															Count
														</th>
														<th scope="col" className="pb-2">
															Hit Rate
														</th>
														<th scope="col" className="pb-2">
															Avg ROI
														</th>
														<th scope="col" className="pb-2">
															Avg CLV
														</th>
													</tr>
												</thead>
												<tbody>
													{table.rows.map((row) => (
														<tr
															key={`${table.title}-${row.bucket}`}
															className={`border-t border-ink-15 ${sampleClassName(row.count)}`}
														>
															<td className="py-2 pr-4 font-semibold text-ink-95">
																{row.bucket}
															</td>
															<td className="py-2 pr-4">
																{row.count}
																{sampleBadge(row.count) ? (
																	<span className="ml-2 rounded border border-signal-warn/30 bg-signal-warn/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-signal-warn">
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
								<p className="text-sm text-ink-55">
									No bucket performance data yet.
								</p>
							)}
						</div>
					</section>

					<section className="rounded-lg bg-ink-05 p-6 ring-1 ring-inset ring-ink-15">
						{stats?.filteredTagStats ? (
							<div className="overflow-auto">
								<table className="min-w-full text-left text-sm text-ink-85">
									<thead>
										<tr className="text-xs uppercase tracking-[0.2em] text-ink-950">
											<th scope="col" className="pb-3">
												Tag
											</th>
											<th scope="col" className="pb-3">
												Count
											</th>
											<th scope="col" className="pb-3">
												Markets (today)
											</th>
										</tr>
									</thead>
									<tbody>
										{stats.filteredTagStats.map((entry) => (
											<tr
												key={`${entry.seriesId}-${entry.tag}`}
												className="border-t border-ink-15"
											>
												<td className="py-3 pr-4 font-semibold text-ink-95">
													{entry.tag}{" "}
													<span className="text-xs text-ink-950">
														(series {entry.seriesId})
													</span>
												</td>
												<td className="py-3 pr-4">{entry.count}</td>
												<td className="py-3 text-ink-70">
													{entry.markets.length === 0 ? (
														<span className="text-ink-950">
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
							<p className="text-sm text-ink-55">
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
