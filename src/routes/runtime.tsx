import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AuthGate } from "@/components/auth-gate";
import { getBotEvalFn } from "../server/api/bot-eval";
import {
	getManualPicksBucketPerformanceFn,
	getManualPicksCalibrationFn,
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
	if (value === null || value === undefined || !Number.isFinite(value)) return "—";
	return `${(value * 100).toFixed(1)}%`;
}

function formatSignedPercent(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return "—";
	const percent = value * 100;
	return `${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%`;
}

function formatBps(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return "—";
	return `${value.toFixed(1)} bps`;
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
		markets: Array<{ title: string; volume: number; eventSlug?: string; slug?: string }>;
	}>;
	combinedTagStats: Array<{
		tag: string;
		count: number;
		markets: Array<{ title: string; volume: number; eventSlug?: string; slug?: string }>;
	}>;
	filteredTagStats: Array<{
		tag: string;
		count: number;
		markets: Array<{ title: string; volume: number; eventSlug?: string; slug?: string }>;
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
	paginationCapHits: Array<{ tag: string; seriesId: number; eventCount: number }>;
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
	const [evalHistoryWindowMinutes, setEvalHistoryWindowMinutes] = useState("60");
	const [evalMinGrade, setEvalMinGrade] = useState<"A+" | "A" | "B" | "C" | "D">("A");
	const [evalIncludeStarted, setEvalIncludeStarted] = useState(false);
	const [evalSweepThresholds, setEvalSweepThresholds] = useState("0.58,0.62,0.66,0.70");

	const [calibrationResult, setCalibrationResult] = useState<CalibrationResult | null>(null);
	const [isCalibrationLoading, setIsCalibrationLoading] = useState(false);
	const [calibrationError, setCalibrationError] = useState<string | null>(null);
	const [calibrationLimit, setCalibrationLimit] = useState("2000");
	const isCalibrationLoadingRef = useRef(false);
	const [bucketPerformanceResult, setBucketPerformanceResult] =
		useState<BucketPerformanceResult | null>(null);
	const [isBucketPerformanceLoading, setIsBucketPerformanceLoading] = useState(false);
	const [bucketPerformanceError, setBucketPerformanceError] = useState<string | null>(
		null,
	);
	const isBucketPerformanceLoadingRef = useRef(false);

	const filteredTotalMarkets = stats
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

	const loadStats = useCallback(async () => {
		setError(null);
		try {
			const result = await getRuntimeMarketStatsFn({ data: { freshnessWindowHours: 24 } });
			setStats((result.stats ?? null) as RuntimeStats | null);
		} catch (err) {
			console.error("Failed to load runtime stats", err);
			setError("Failed to load runtime stats");
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
					limit: Number.isFinite(limitValue) && limitValue > 0 ? limitValue : 2000,
				},
			});
			setCalibrationResult((result.calibration ?? null) as CalibrationResult | null);
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
					limit: Number.isFinite(limitValue) && limitValue > 0 ? limitValue : 2000,
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

	const refreshStats = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			await fetchTrendingSportsMarketsFn({ data: { limit: 50, includeLowVolume: true } });
			await loadStats();
		} catch (err) {
			console.error("Failed to refresh runtime stats", err);
			setError("Failed to refresh runtime stats");
		} finally {
			setIsLoading(false);
		}
	}, [loadStats]);

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
					windowHours: Number.isFinite(windowHours) && windowHours > 0 ? windowHours : 24,
					horizonMinutes:
						Number.isFinite(horizonMinutes) && horizonMinutes > 0 ? horizonMinutes : 15,
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
		void loadCalibration(2000);
		void loadBucketPerformance(2000);
	}, [loadStats, loadCalibration, loadBucketPerformance]);

	return (
		<AuthGate>
			<div className="min-h-screen bg-slate-950 text-slate-100">
				<div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-10">
					<header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
						<div>
							<p className="text-xs uppercase tracking-[0.3em] text-slate-400">Runtime</p>
							<h1 className="text-3xl font-semibold text-slate-50">Market Fetch Stats</h1>
							<p className="mt-2 text-sm text-slate-400">
								Verify how many markets we pull per sport tag and which ones dominate by volume.
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
								<p className="text-sm text-slate-400">Last fetched: {formatRelativeTime(stats?.fetchedAt)}</p>
								<p className="text-sm text-slate-400">Filtered markets (window): {filteredTotalMarkets}</p>
								<p className="text-sm text-slate-400">
									Expanded events: {stats?.expandedEventCount ?? 0} • Expanded markets: {stats?.expandedMarketCount ?? 0}
								</p>
								<p className="text-sm text-slate-400">
									Retries: {stats?.retryCount ?? 0} • Failures: {stats?.failureCount ?? 0} • Pagination caps: {stats?.paginationCapHits?.length ?? 0}
								</p>
								<p className="text-sm text-slate-400">
									Totals: {stats?.totalRuns ?? 0} runs • {stats?.totalRetries ?? 0} retries • {stats?.totalFailures ?? 0} failures
								</p>
								{stats?.cacheFreshness && (
									<p className="text-sm text-slate-400">
										Cache freshness: {stats.cacheFreshness.total} total • {stats.cacheFreshness.staleHistory} stale • {stats.cacheFreshness.missingHistory} missing history
									</p>
								)}
							</div>
							<div className="flex flex-wrap items-center gap-3">
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
					</section>

					<section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
						<div className="flex flex-col gap-4">
							<div>
								<h2 className="text-lg font-semibold text-slate-50">Eval Comparison</h2>
								<p className="mt-1 text-sm text-slate-400">
									Compare baseline candidate logic vs filtered market-quality logic using historical snapshots.
								</p>
							</div>
							<div className="grid gap-3 md:grid-cols-6">
								<div>
									<label htmlFor="eval-window-hours" className="block text-xs text-slate-400">Window hours</label>
									<input id="eval-window-hours" value={evalWindowHours} onChange={(event) => setEvalWindowHours(event.target.value)} className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950/60 px-2 py-1 text-sm text-white" />
								</div>
								<div>
									<label htmlFor="eval-horizon-mins" className="block text-xs text-slate-400">Horizon (mins)</label>
									<input id="eval-horizon-mins" value={evalHorizonMinutes} onChange={(event) => setEvalHorizonMinutes(event.target.value)} className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950/60 px-2 py-1 text-sm text-white" />
								</div>
								<div>
									<label htmlFor="eval-history-mins" className="block text-xs text-slate-400">Signal window (mins)</label>
									<input id="eval-history-mins" value={evalHistoryWindowMinutes} onChange={(event) => setEvalHistoryWindowMinutes(event.target.value)} className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950/60 px-2 py-1 text-sm text-white" />
								</div>
								<div>
									<label htmlFor="eval-min-grade" className="block text-xs text-slate-400">Min grade</label>
									<select id="eval-min-grade" value={evalMinGrade} onChange={(event) => setEvalMinGrade(event.target.value as "A+" | "A" | "B" | "C" | "D")} className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950/60 px-2 py-1 text-sm text-white">
										<option value="A+">A+</option>
										<option value="A">A</option>
										<option value="B">B</option>
										<option value="C">C</option>
										<option value="D">D</option>
									</select>
								</div>
								<div className="flex items-end gap-2">
									<button type="button" onClick={runEval} disabled={isEvaluating} className="w-full rounded-lg bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-60">
										{isEvaluating ? "Running..." : "Run Eval"}
									</button>
								</div>
								<div className="md:col-span-6">
									<label htmlFor="eval-thresholds" className="block text-xs text-slate-400">Sweep thresholds (comma separated)</label>
									<input id="eval-thresholds" value={evalSweepThresholds} onChange={(event) => setEvalSweepThresholds(event.target.value)} className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950/60 px-2 py-1 text-sm text-white" placeholder="0.58,0.62,0.66,0.70" />
								</div>
							</div>
							<label className="inline-flex items-center gap-2 text-sm text-slate-300">
								<input type="checkbox" checked={evalIncludeStarted} onChange={(event) => setEvalIncludeStarted(event.target.checked)} />
								Include started events
							</label>
							{evalError && <div className="rounded-lg border border-red-500/40 bg-red-950/40 px-4 py-2 text-sm text-red-200">{evalError}</div>}
							{evalResult && (
								<div className="space-y-5">
									<div className="grid gap-3 md:grid-cols-2">
										<div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
											<p className="text-sm font-semibold text-slate-100">Baseline</p>
											<p className="mt-2 text-sm text-slate-300">Triggered: {evalResult.strategies.baseline.triggered} • Resolved: {evalResult.strategies.baseline.resolved}</p>
											<p className="text-sm text-slate-300">Hit rate: {formatPercent(evalResult.strategies.baseline.hitRate)} • Avg move: {formatBps(evalResult.strategies.baseline.avgMoveBps)}</p>
										</div>
										<div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
											<p className="text-sm font-semibold text-slate-100">Filtered</p>
											<p className="mt-2 text-sm text-slate-300">Triggered: {evalResult.strategies.filtered.triggered} • Resolved: {evalResult.strategies.filtered.resolved}</p>
											<p className="text-sm text-slate-300">Hit rate: {formatPercent(evalResult.strategies.filtered.hitRate)} • Avg move: {formatBps(evalResult.strategies.filtered.avgMoveBps)}</p>
										</div>
									</div>
									<div className="overflow-auto rounded-xl border border-slate-800 bg-slate-950/60 p-4">
										<p className="text-sm font-semibold text-slate-100">By hour to start</p>
										<table className="mt-3 min-w-full text-left text-sm text-slate-200">
											<thead><tr className="text-xs uppercase tracking-[0.2em] text-slate-500"><th className="pb-2">Bucket</th><th className="pb-2">Base Hit</th><th className="pb-2">Base Avg</th><th className="pb-2">Filt Hit</th><th className="pb-2">Filt Avg</th></tr></thead>
											<tbody>
												{evalHourBuckets.map((bucket) => {
													const base = evalResult.strategies.baseline.byHourToStart[bucket];
													const filt = evalResult.strategies.filtered.byHourToStart[bucket];
													return (
														<tr key={bucket} className="border-t border-slate-800">
															<td className="py-2 pr-4 font-semibold text-slate-100">{bucket}</td>
															<td className="py-2 pr-4">{formatPercent(base?.hitRate)}</td>
															<td className="py-2 pr-4">{formatBps(base?.avgMoveBps)}</td>
															<td className="py-2 pr-4">{formatPercent(filt?.hitRate)}</td>
															<td className="py-2">{formatBps(filt?.avgMoveBps)}</td>
														</tr>
													);
												})}
											</tbody>
										</table>
									</div>
									<div className="overflow-auto rounded-xl border border-slate-800 bg-slate-950/60 p-4">
										<p className="text-sm font-semibold text-slate-100">Threshold sweep</p>
										<table className="mt-3 min-w-full text-left text-sm text-slate-200">
											<thead><tr className="text-xs uppercase tracking-[0.2em] text-slate-500"><th className="pb-2">Threshold</th><th className="pb-2">Retained</th><th className="pb-2">Hit Rate</th><th className="pb-2">Avg Move</th><th className="pb-2">Delta vs Base</th></tr></thead>
											<tbody>
												{evalResult.thresholdSweep.map((row) => (
													<tr key={row.threshold} className="border-t border-slate-800">
														<td className="py-2 pr-4 font-semibold text-slate-100">{row.threshold.toFixed(2)}</td>
														<td className="py-2 pr-4">{formatPercent(row.retainedRate)}</td>
														<td className="py-2 pr-4">{formatPercent(row.hitRate)}</td>
														<td className="py-2 pr-4">{formatBps(row.avgMoveBps)}</td>
														<td className="py-2">{row.avgMoveDeltaBps === null || !Number.isFinite(row.avgMoveDeltaBps) ? "—" : `${row.avgMoveDeltaBps >= 0 ? "+" : ""}${row.avgMoveDeltaBps.toFixed(1)} bps`}</td>
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
								<h2 className="text-lg font-semibold text-slate-50">Pick Calibration</h2>
								<p className="mt-1 text-sm text-slate-400">Where picks are actually performing: by score and by time-to-start.</p>
							</div>
							<div className="flex flex-wrap items-end gap-3">
								<div>
									<label htmlFor="calibration-limit" className="block text-xs text-slate-400">Pick sample limit</label>
									<input id="calibration-limit" value={calibrationLimit} onChange={(event) => setCalibrationLimit(event.target.value)} className="mt-1 w-40 rounded-md border border-slate-700 bg-slate-950/60 px-2 py-1 text-sm text-white" />
								</div>
								<button type="button" onClick={() => void loadCalibration(Number(calibrationLimit))} disabled={isCalibrationLoading} className="rounded-lg bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-60">{isCalibrationLoading ? "Refreshing..." : "Refresh Calibration"}</button>
								<button
									type="button"
									onClick={() => void loadBucketPerformance(Number(calibrationLimit))}
									disabled={isBucketPerformanceLoading}
									className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-60"
								>
									{isBucketPerformanceLoading ? "Refreshing..." : "Refresh Buckets"}
								</button>
							</div>
							{calibrationError && <div className="rounded-lg border border-red-500/40 bg-red-950/40 px-4 py-2 text-sm text-red-200">{calibrationError}</div>}
							{bucketPerformanceError && <div className="rounded-lg border border-red-500/40 bg-red-950/40 px-4 py-2 text-sm text-red-200">{bucketPerformanceError}</div>}
							{calibrationResult ? (
								<div className="space-y-5">
									<div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
										Total picks: {calibrationResult.totalPicks} • Settled: {calibrationResult.settledPicks} • Signal scored: {calibrationResult.withSignalScore} • Quality scored: {calibrationResult.withQualityScore} • With event time: {calibrationResult.withEventTime}
									</div>
									{[
										{ title: "By signal score", rows: calibrationResult.bySignalScore },
										{ title: "By market quality score", rows: calibrationResult.byQualityScore },
										{ title: "By time to start", rows: calibrationResult.byTimeToStart },
									].map((table) => (
										<div key={table.title} className="overflow-auto rounded-xl border border-slate-800 bg-slate-950/60 p-4">
											<p className="text-sm font-semibold text-slate-100">{table.title}</p>
											<table className="mt-3 min-w-full text-left text-sm text-slate-200">
												<thead><tr className="text-xs uppercase tracking-[0.2em] text-slate-500"><th className="pb-2">Bucket</th><th className="pb-2">Count</th><th className="pb-2">Win Rate</th><th className="pb-2">Avg ROI</th><th className="pb-2">Avg CLV</th></tr></thead>
												<tbody>
													{table.rows.map((row) => (
														<tr key={`${table.title}-${row.label}`} className="border-t border-slate-800">
															<td className="py-2 pr-4 font-semibold text-slate-100">{row.label}</td>
															<td className="py-2 pr-4">{row.count}</td>
															<td className="py-2 pr-4">{formatPercent(row.winRate)}</td>
															<td className="py-2 pr-4">{formatSignedPercent(row.avgRoi)}</td>
															<td className="py-2">{formatBps(row.avgClvBps)}</td>
														</tr>
													))}
												</tbody>
											</table>
										</div>
									))}
								</div>
							) : (
								<p className="text-sm text-slate-400">No calibration data yet. Place bets and settle outcomes, then refresh.</p>
							)}
							{bucketPerformanceResult ? (
								<div className="space-y-5">
									<div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
										Settled picks in bucket analysis: {bucketPerformanceResult.settledPicks}
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
										<div key={table.title} className="overflow-auto rounded-xl border border-slate-800 bg-slate-950/60 p-4">
											<p className="text-sm font-semibold text-slate-100">{table.title}</p>
											<table className="mt-3 min-w-full text-left text-sm text-slate-200">
												<thead><tr className="text-xs uppercase tracking-[0.2em] text-slate-500"><th className="pb-2">Bucket</th><th className="pb-2">Count</th><th className="pb-2">Hit Rate</th><th className="pb-2">Avg ROI</th><th className="pb-2">Avg CLV</th></tr></thead>
												<tbody>
													{table.rows.map((row) => (
														<tr key={`${table.title}-${row.bucket}`} className="border-t border-slate-800">
															<td className="py-2 pr-4 font-semibold text-slate-100">{row.bucket}</td>
															<td className="py-2 pr-4">{row.count}</td>
															<td className="py-2 pr-4">{formatPercent(row.hitRate)}</td>
															<td className="py-2 pr-4">{formatSignedPercent(row.avgRoi)}</td>
															<td className="py-2">{formatBps(row.avgClvBps)}</td>
														</tr>
													))}
												</tbody>
											</table>
										</div>
									))}
								</div>
							) : (
								<p className="text-sm text-slate-400">No bucket performance data yet.</p>
							)}
						</div>
					</section>

					<section className="rounded-2xl border border-slate-800 bg-slate-950/70 p-6">
						{stats ? (
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
											<tr key={`${entry.seriesId}-${entry.tag}`} className="border-t border-slate-800">
												<td className="py-3 pr-4 font-semibold text-slate-100">{entry.tag} <span className="text-xs text-slate-500">(series {entry.seriesId})</span></td>
												<td className="py-3 pr-4">{entry.count}</td>
												<td className="py-3 text-slate-300">
													{entry.markets.length === 0 ? (
														<span className="text-slate-500">No markets returned</span>
													) : (
														entry.markets.map((market) => (
															<div key={`${entry.seriesId}-${market.title}`} className="text-sm">
																{market.title} • {formatUsdCompact(market.volume)}
																{market.eventSlug ? ` • ${market.eventSlug}` : market.slug ? ` • ${market.slug}` : ""}
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
							<p className="text-sm text-slate-400">No runtime stats yet. Click "Refresh Stats" to capture the latest fetch results.</p>
						)}
					</section>
				</div>
			</div>
		</AuthGate>
	);
}
