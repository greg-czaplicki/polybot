import { createFileRoute, Outlet, useMatchRoute } from "@tanstack/react-router";
import {
	ExternalLink,
	Eye,
	EyeOff,
	Loader2,
	RefreshCw,
	Target,
	User,
	Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AuthGate } from "@/components/auth-gate";
import {
	computeSignalScoreFromHistory,
	computeSignalScoreFromWindow,
	gradeWeight,
	MIN_EDGE_RATING,
	signalScoreToGradeLabel,
} from "@/lib/sharp-grade";
import type { BotInspectDefaults } from "../server/api/bot";
import {
	getBotCandidateInspectFn,
	getBotCandidatesFn,
	getBotInspectDefaultsFn,
} from "../server/api/bot";
import { listManualPicksFn } from "../server/api/manual-picks";
import {
	fetchTrendingSportsMarketsFn,
	getRuntimeMarketStatsFn,
	getSharpMoneyCacheFn,
	getSharpMoneyCacheStatsFn,
	getSharpMoneyEdgeStatsHistoryFn,
	getSharpMoneyGradeMixFn,
	getSharpMoneyGradesFn,
	getSharpMoneyHistoryFn,
	refreshMarketSharpnessFn,
	type SharpMoneyCacheEntry,
	type SharpMoneyGradeMix,
	type SharpMoneyHistoryEntry,
	type TopHolderPnlData,
} from "../server/api/sharp-money";

export const Route = createFileRoute("/sharp")({
	component: SharpMoneyPage,
});

// Sport and A+ filters were removed from the UI — the bot-aligned pipeline
// already surfaces exactly the markets worth looking at. Constants kept at
// module scope so the downstream filter/fetch logic continues to work with
// stable identities (no stale-closure / re-render churn).
const selectedSeriesId = "all" as const;
const showAPlusOnly = false;

const SERIES_LABELS: Record<number, string> = {
	10187: "NFL",
	10345: "NBA",
	10210: "College Football",
	10470: "College Basketball",
	3: "MLB",
	10346: "NHL",
	10188: "Premier League",
};

const USD_FORMATTER = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	maximumFractionDigits: 0,
});

const USD_COMPACT_FORMATTER = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	notation: "compact",
	maximumFractionDigits: 1,
});

const UNIT_FORMATTER = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
});

const EDGE_TARGETS = {
	aPlus: { min: 0.03, max: 0.08 },
	aPlusOrA: { min: 0.12, max: 0.2 },
	minEdge: { min: 0.45, max: 0.6 },
};

function formatUsdCompact(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		return "$0";
	}
	if (Math.abs(value) >= 1000) {
		return USD_COMPACT_FORMATTER.format(value);
	}
	return USD_FORMATTER.format(value);
}

function getEntryHolderVolume(entry: SharpMoneyCacheEntry): number {
	return entry.sideA.totalValue + entry.sideB.totalValue;
}

function getEntryMarketVolume(entry: SharpMoneyCacheEntry): number {
	return (
		entry.marketVolume ?? entry.marketLiquidity ?? getEntryHolderVolume(entry)
	);
}

function getVolumePercentLogScaled(volume: number, maxVolume: number): number {
	if (!Number.isFinite(volume) || volume <= 0) return 0;
	if (!Number.isFinite(maxVolume) || maxVolume <= 0) return 0;
	const safeVolume = Math.max(0, volume);
	const safeMax = Math.max(1, maxVolume);
	const numerator = Math.log10(safeVolume + 1);
	const denominator = Math.log10(safeMax + 1);
	if (denominator <= 0) return 0;
	return Math.min((numerator / denominator) * 100, 100);
}

function formatUnits(value: number | null | undefined): string | null {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		return null;
	}
	return UNIT_FORMATTER.format(value);
}

function formatPercent(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		return "0%";
	}
	return `${Math.round(value * 100)}%`;
}

function getTargetTone(
	value: number,
	target: { min: number; max: number },
): "low" | "high" | "ok" {
	if (value < target.min) return "low";
	if (value > target.max) return "high";
	return "ok";
}

function getTargetToneClass(
	value: number,
	target: { min: number; max: number },
): string {
	const tone = getTargetTone(value, target);
	if (tone === "ok") return "text-signal-pos";
	if (tone === "low") return "text-signal-warn";
	return "text-signal-bad";
}

function buildGradeMix(
	entries: SharpMoneyCacheEntry[],
	gradesByConditionId: Record<
		string,
		{
			grade: string;
			signalScore: number;
		}
	>,
	signalScoreByConditionId: Record<string, number>,
): SharpMoneyGradeMix | null {
	if (entries.length === 0) return null;
	let total = 0;
	let passing = 0;
	let aPlusCount = 0;
	let aPlusOrACount = 0;
	for (const entry of entries) {
		const score =
			signalScoreByConditionId[entry.conditionId] ?? entry.edgeRating;
		if (!Number.isFinite(score)) continue;
		total += 1;
		if (entry.edgeRating >= MIN_EDGE_RATING) passing += 1;
		const grade =
			gradesByConditionId[entry.conditionId]?.grade ??
			signalScoreToGradeLabel(score, {
				edgeRating: entry.edgeRating,
				scoreDifferential: entry.scoreDifferential,
			});
		if (grade === "A+") {
			aPlusCount += 1;
			aPlusOrACount += 1;
		} else if (grade === "A") {
			aPlusOrACount += 1;
		}
	}
	if (total === 0) return null;
	return {
		total,
		passing,
		passingRate: passing / total,
		aPlusCount,
		aPlusRate: aPlusCount / total,
		aPlusOrACount,
		aPlusOrARate: aPlusOrACount / total,
	};
}

function formatAmericanOdds(price?: number | null): string | null {
	if (!price || !Number.isFinite(price) || price <= 0 || price >= 1) {
		return null;
	}
	if (price >= 0.5) {
		const odds = Math.round((price / (1 - price)) * 100);
		return `-${odds}`;
	}
	const odds = Math.round(((1 - price) / price) * 100);
	return `+${odds}`;
}

function formatRelativeTime(timestamp: number): string {
	const now = Math.floor(Date.now() / 1000);
	const diff = now - timestamp;

	if (diff < 60) return "Just now";
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	return `${Math.floor(diff / 86400)}d ago`;
}

function formatHourLabel(timestampSeconds: number): string {
	const date = new Date(timestampSeconds * 1000);
	return date.toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "2-digit",
	});
}

function formatDayLabel(timestampSeconds: number): string {
	const date = new Date(timestampSeconds * 1000);
	return date.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
	});
}

type EdgeStatsBucket = {
	start: number;
	count: number;
	average: number;
	p50: number;
	p75: number;
	p90: number;
	max: number;
};

function selectRecentHistory(
	history: SharpMoneyHistoryEntry[] | undefined,
	windowMinutes: number,
): SharpMoneyHistoryEntry[] | undefined {
	if (!history || history.length === 0) return history;
	const cutoff = Math.floor(Date.now() / 1000) - windowMinutes * 60;
	const recent = history.filter((entry) => entry.recordedAt >= cutoff);
	return recent.length > 0 ? recent : history;
}

const STARTING_SOON_MINUTES = 30;
const MIN_READY_HOLDER_COUNT = 10;
const MIN_READY_PNL_COVERAGE = 0.6;
const UPCOMING_WINDOW_HOURS = 12;
const START_TIME_BUFFER_MINUTES = 10;
const STALE_HISTORY_MINUTES = 15;

function getPnlCoverage(holders: TopHolderPnlData[]): number {
	if (holders.length === 0) return 0;
	const withPnl = holders.filter(
		(holder) =>
			holder.pnlDay !== null ||
			holder.pnlWeek !== null ||
			holder.pnlMonth !== null ||
			holder.pnlAll !== null,
	).length;
	return withPnl / holders.length;
}

function isEntryReady(entry: SharpMoneyCacheEntry): boolean {
	const minHolderCount = Math.min(
		entry.sideA.holderCount,
		entry.sideB.holderCount,
	);
	if (minHolderCount < MIN_READY_HOLDER_COUNT) return false;
	const pnlCoverage =
		entry.pnlCoverage ??
		Math.min(
			getPnlCoverage(entry.sideA.topHolders),
			getPnlCoverage(entry.sideB.topHolders),
		);
	return pnlCoverage >= MIN_READY_PNL_COVERAGE;
}

function truncateWalletName(
	name: string | null | undefined,
	maxLength: number = 20,
): string {
	if (!name) return "";
	if (name.length <= maxLength) return name;
	return `${name.slice(0, maxLength)}...`;
}

function parseEventTime(isoDate?: string): Date | null {
	if (!isoDate) return null;
	if (/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
		return new Date(`${isoDate}T23:59:59Z`);
	}
	const parsed = new Date(isoDate);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatBotPolicySummary(defaults: BotInspectDefaults | null): string {
	if (!defaults) return "Bot-aligned (loading config...)";
	return `Bot-aligned (${defaults.minGrade}, ${defaults.minMinutesToStart}-${defaults.maxMinutesToStart}m, q>=${defaults.marketQualityThreshold.toFixed(2)})`;
}

function formatEventTime(isoDate?: string): string | null {
	if (!isoDate) return null;

	try {
		const date = parseEventTime(isoDate);
		if (!date) return null;
		const now = new Date();

		// Check if it's today
		const isToday = date.toDateString() === now.toDateString();

		// Check if it's tomorrow
		const tomorrow = new Date(now);
		tomorrow.setDate(tomorrow.getDate() + 1);
		const isTomorrow = date.toDateString() === tomorrow.toDateString();

		// Format time
		const timeStr = date.toLocaleTimeString("en-US", {
			hour: "numeric",
			minute: "2-digit",
			hour12: true,
		});

		if (isToday) {
			return `Today ${timeStr}`;
		}
		if (isTomorrow) {
			return `Tomorrow ${timeStr}`;
		}

		// Format as day of week + time for this week
		const daysUntil = Math.ceil(
			(date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
		);
		if (daysUntil <= 7 && daysUntil > 0) {
			const dayName = date.toLocaleDateString("en-US", { weekday: "short" });
			return `${dayName} ${timeStr}`;
		}

		// Otherwise format as date
		return date.toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
			hour12: true,
		});
	} catch {
		return null;
	}
}

const GAME_PROP_KEYWORDS = [
	"nrfi",
	"yrfi",
	"btts",
	"both teams to score",
	"draw no bet",
	"first goal",
	"clean sheet",
	"double result",
];

function getMarketTypeLabel(marketTitle: string): string {
	const lower = marketTitle.toLowerCase();
	const plainMatchup =
		!marketTitle.includes(":") && /\bvs\.?\b/i.test(marketTitle);
	if (
		lower.includes("o/u") ||
		lower.includes("over/under") ||
		lower.includes("total")
	) {
		return "total";
	}
	if (lower.includes("spread")) return "spread";
	if (plainMatchup) return "moneyline";
	if (lower.includes("moneyline") || lower.includes("ml")) return "moneyline";
	if (GAME_PROP_KEYWORDS.some((kw) => lower.includes(kw))) return "prop";
	return "other";
}

function normalizeMatchupTitle(marketTitle: string): string {
	const [matchup] = marketTitle.split(":", 1);
	return matchup.trim().toLowerCase();
}

function getMarketGroupKey(entry: SharpMoneyCacheEntry): string {
	const base = entry.eventSlug ?? normalizeMatchupTitle(entry.marketTitle);
	const type = getMarketTypeLabel(entry.marketTitle);
	const sport = entry.sportSeriesId ?? "na";
	return `${sport}|${base}|${type}`;
}

function getSeriesLabel(seriesId?: number): string | null {
	if (!seriesId) return null;
	return SERIES_LABELS[seriesId] ?? `Series ${seriesId}`;
}

type BotInspectResult = {
	stage?: string;
	reason?: string;
	dedupGroupKey?: string;
	wonDedup?: boolean;
	foundInEntries?: boolean;
	diagnosticReason?: string;
	isReady?: boolean;
	marketType?: string;
	minutesToStart?: number | null;
	candidateWindowMinutes?: number;
	inEventWindow?: boolean;
	inRecentCacheWindow?: boolean;
	cacheUpdatedAt?: number;
};

function formatBotInspectStatus(result: BotInspectResult | null): {
	message: string;
	tone: "good" | "warn" | "bad";
	detail?: string;
} {
	if (!result) return { message: "No bot debug data", tone: "warn" };
	if (result.stage === "checking") {
		return { message: "Checking bot pipeline...", tone: "warn" };
	}
	if (result.stage === "no_inspect_data") {
		return { message: "No inspect data returned", tone: "warn" };
	}
	if (result.stage === "not_found_in_entries") {
		const detailParts: string[] = [];
		if (result.diagnosticReason)
			detailParts.push(`reason=${result.diagnosticReason}`);
		if (typeof result.isReady === "boolean")
			detailParts.push(`ready=${result.isReady ? "yes" : "no"}`);
		if (result.marketType) detailParts.push(`type=${result.marketType}`);
		if (
			typeof result.minutesToStart === "number" &&
			Number.isFinite(result.minutesToStart)
		) {
			detailParts.push(`minsToStart=${Math.round(result.minutesToStart)}`);
		}
		if (typeof result.candidateWindowMinutes === "number") {
			detailParts.push(`window=${result.candidateWindowMinutes}m`);
		}
		if (typeof result.inEventWindow === "boolean") {
			detailParts.push(`inEventWindow=${result.inEventWindow ? "yes" : "no"}`);
		}
		if (typeof result.inRecentCacheWindow === "boolean") {
			detailParts.push(
				`inRecentCacheWindow=${result.inRecentCacheWindow ? "yes" : "no"}`,
			);
		}
		return {
			message: "Not in bot cache input",
			tone: "bad",
			detail: detailParts.length > 0 ? detailParts.join(" • ") : undefined,
		};
	}
	if (result.stage === "filtered_pre") {
		return {
			message: `Excluded pre-filter: ${result.reason ?? "unknown"}`,
			tone: "warn",
		};
	}
	if (result.stage === "filtered_grade") {
		return {
			message: `Excluded grade-filter: ${result.reason ?? "unknown"}`,
			tone: "warn",
		};
	}
	if (result.stage === "dedup_lost") {
		return {
			message: `Dedup dropped: ${result.reason ?? "unknown"}`,
			tone: "bad",
		};
	}
	if (result.stage === "dedup_seed" || result.wonDedup) {
		return {
			message: "Bot-eligible snapshot (won dedup)",
			tone: "good",
		};
	}
	if (result.stage === "entries" || result.foundInEntries) {
		return { message: "In bot candidate pool", tone: "good" };
	}
	return {
		message: `Bot stage: ${result.stage ?? "unknown"}`,
		tone: "warn",
	};
}

function buildPolymarketUrl(eventSlug?: string, slug?: string): string | null {
	if (eventSlug && slug) {
		return `https://polymarket.com/event/${eventSlug}/${slug}`;
	}
	if (eventSlug) {
		return `https://polymarket.com/event/${eventSlug}`;
	}
	return null;
}

function buildPolymarketProfileUrl(walletAddress: string): string {
	return `https://polymarket.com/profile/${walletAddress}`;
}

function SharpMoneyPage() {
	const matchRoute = useMatchRoute();
	const marketDepthMatch = matchRoute({
		to: "/sharp/market/$conditionId",
		fuzzy: false,
	});

	const [entries, setEntries] = useState<SharpMoneyCacheEntry[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [isInitialSortReady, setIsInitialSortReady] = useState(false);
	const [lastCacheFetchAt, setLastCacheFetchAt] = useState<number | null>(null);
	const [pipelineStatus, setPipelineStatus] = useState<{
		inProgress: boolean;
		startedAt?: number;
		updatedAt?: number;
		totalQueued?: number;
		processed?: number;
	} | null>(null);
	const [expandedMarkets, setExpandedMarkets] = useState<Set<string>>(
		new Set(),
	);
	// showAllEntries is kept as a constant for now — the toggle was removed in
	// favor of the dim-not-hide near-miss pattern. Leaving the flag in place so
	// the downstream filter and sort paths still compile and we can reintroduce
	// an override later if we want one.
	const [showAllEntries] = useState(false);
	const [showEdgeStats, setShowEdgeStats] = useState(true);
	const [botAlignedConditionOrder, setBotAlignedConditionOrder] = useState<
		string[]
	>([]);
	const [botAlignedError, setBotAlignedError] = useState<string | null>(null);
	const [pickStatusByConditionId, setPickStatusByConditionId] = useState<
		Record<
			string,
			{
				status: "pending" | "win" | "loss" | "push";
				pickedAt: number;
			}
		>
	>({});
	const [edgeStatsWindowHours, setEdgeStatsWindowHours] = useState(24 * 7);
	const [edgeStatsHistory, setEdgeStatsHistory] = useState<EdgeStatsBucket[]>(
		[],
	);
	const [edgeStatsHistoryLoading, setEdgeStatsHistoryLoading] = useState(false);
	const [edgeStatsGradeMix, setEdgeStatsGradeMix] =
		useState<SharpMoneyGradeMix | null>(null);
	const [edgeStatsGradeMixLoading, setEdgeStatsGradeMixLoading] =
		useState(false);
	const [signalHistoryByConditionId, setSignalHistoryByConditionId] = useState<
		Record<string, SharpMoneyHistoryEntry[]>
	>({});
	const [signalHistoryFetchedAt, setSignalHistoryFetchedAt] = useState<
		Record<string, number>
	>({});
	const [gradesByConditionId, setGradesByConditionId] = useState<
		Record<
			string,
			{
				grade: string;
				signalScore: number;
				warnings: string[];
				historyUpdatedAt?: number;
			}
		>
	>({});
	const [healthStatus, setHealthStatus] = useState<{
		label: "Good" | "Warn" | "Unknown";
		detail?: string;
	}>({ label: "Unknown" });
	const [refreshingEntryId, setRefreshingEntryId] = useState<string | null>(
		null,
	);
	const [historyByConditionId, setHistoryByConditionId] = useState<
		Record<string, SharpMoneyHistoryEntry[]>
	>({});
	const [historyLoading, setHistoryLoading] = useState<Set<string>>(new Set());
	const [pullDistance, setPullDistance] = useState(0);
	const [isPulling, setIsPulling] = useState(false);
	const pullStartYRef = useRef<number | null>(null);
	const pullActiveRef = useRef(false);
	const pullDistanceRef = useRef(0);
	const isRefreshingRef = useRef(false);
	const handleRefreshRef = useRef<() => Promise<void>>(async () => {});
	const showRefreshDebug =
		typeof window !== "undefined" &&
		new URLSearchParams(window.location.search).has("refreshDebug");
	const [cacheStats, setCacheStats] = useState<{
		totalEntries: number;
		newestEntry?: number;
	} | null>(null);
	const [botDefaults, setBotDefaults] = useState<BotInspectDefaults | null>(
		null,
	);
	const PULL_THRESHOLD = 80;
	const PULL_MAX = 120;
	const CACHE_FETCH_LIMIT = 200;

	const setPullDistanceSafe = useCallback((value: number) => {
		pullDistanceRef.current = value;
		setPullDistance(value);
	}, []);

	const resetPullState = useCallback(() => {
		pullStartYRef.current = null;
		pullActiveRef.current = false;
		setIsPulling(false);
		setPullDistanceSafe(0);
	}, [setPullDistanceSafe]);

	// Load cached data
	const loadCache = useCallback(async (options?: { silent?: boolean }) => {
		let result: {
			entries: SharpMoneyCacheEntry[];
			stats: { totalEntries: number; newestEntry?: number } | null;
		} | null = null;
		if (!options?.silent) {
			setIsLoading(true);
			setIsInitialSortReady(false);
		}
		try {
			const [cacheResult, statsResult] = await Promise.all([
				getSharpMoneyCacheFn({
					data: {
						sportSeriesId:
							selectedSeriesId === "all" ? undefined : Number(selectedSeriesId),
						limit: CACHE_FETCH_LIMIT,
						windowHours: UPCOMING_WINDOW_HOURS,
					},
				}),
				getSharpMoneyCacheStatsFn({ data: {} }),
			]);

			const nextEntries = cacheResult.entries ?? [];
			const nextStats = statsResult.stats ?? null;
			setEntries(nextEntries);
			setCacheStats(nextStats);
			result = { entries: nextEntries, stats: nextStats };
		} catch (error) {
			console.error("Failed to load sharp money cache:", error);
		} finally {
			if (!options?.silent) {
				setIsLoading(false);
			}
			setLastCacheFetchAt(Date.now());
		}
		return result;
	}, []);

	const loadPipelineStatus = useCallback(async () => {
		try {
			const response = await fetch("/_pipeline/status");
			if (!response.ok) {
				throw new Error("Failed to load pipeline status");
			}
			const status = await response.json();
			setPipelineStatus(status);
		} catch (error) {
			console.error("Failed to load pipeline status:", error);
		}
	}, []);

	const loadBotDefaults = useCallback(async () => {
		try {
			const response = await getBotInspectDefaultsFn();
			setBotDefaults(response.defaults ?? null);
		} catch (error) {
			console.error("Failed to load bot defaults:", error);
		}
	}, []);

	// Initial load
	useEffect(() => {
		loadCache();
	}, [loadCache]);

	useEffect(() => {
		loadPipelineStatus();
	}, [loadPipelineStatus]);

	useEffect(() => {
		void loadBotDefaults();
	}, [loadBotDefaults]);

	const loadEdgeStatsHistory = useCallback(async () => {
		setEdgeStatsHistoryLoading(true);
		try {
			const result = await getSharpMoneyEdgeStatsHistoryFn({
				data: {
					windowHours: edgeStatsWindowHours,
					bucketHours: edgeStatsWindowHours === 24 ? 1 : 24,
				},
			});
			setEdgeStatsHistory(result.buckets ?? []);
		} catch (error) {
			console.error("Failed to load edge stats history:", error);
		} finally {
			setEdgeStatsHistoryLoading(false);
		}
	}, [edgeStatsWindowHours]);

	const loadEdgeStatsGradeMix = useCallback(async () => {
		setEdgeStatsGradeMixLoading(true);
		try {
			const result = await getSharpMoneyGradeMixFn({
				data: {
					windowHours: 24 * 7,
					sportSeriesId:
						selectedSeriesId === "all" ? undefined : Number(selectedSeriesId),
					includeEven: false,
					gradeFiltered: !showAllEntries,
					aPlusOnly: showAPlusOnly,
				},
			});
			setEdgeStatsGradeMix(result.mix ?? null);
		} catch (error) {
			console.error("Failed to load edge stats grade mix:", error);
		} finally {
			setEdgeStatsGradeMixLoading(false);
		}
	}, [showAllEntries]);

	useEffect(() => {
		if (!showEdgeStats) return;
		loadEdgeStatsHistory();
		loadEdgeStatsGradeMix();
		const interval = setInterval(
			() => {
				loadEdgeStatsHistory();
				loadEdgeStatsGradeMix();
			},
			5 * 60 * 1000,
		);
		return () => clearInterval(interval);
	}, [loadEdgeStatsHistory, loadEdgeStatsGradeMix, showEdgeStats]);

	useEffect(() => {
		if (typeof window === "undefined") return;
		const stored = window.localStorage.getItem("polywhaler:showEdgeStats");
		if (stored === "false" || stored === "true") {
			setShowEdgeStats(stored === "true");
		} else {
			const isMobile = window.matchMedia("(max-width: 640px)").matches;
			if (isMobile) {
				setShowEdgeStats(false);
			}
		}
		const windowStored = window.localStorage.getItem(
			"polywhaler:edgeStatsWindowHours",
		);
		if (windowStored) {
			const parsed = Number(windowStored);
			if (Number.isFinite(parsed) && parsed > 0) {
				setEdgeStatsWindowHours(parsed);
			}
		}
	}, []);

	useEffect(() => {
		if (typeof window === "undefined") return;
		window.localStorage.setItem(
			"polywhaler:showEdgeStats",
			String(showEdgeStats),
		);
	}, [showEdgeStats]);

	useEffect(() => {
		if (typeof window === "undefined") return;
		window.localStorage.setItem(
			"polywhaler:edgeStatsWindowHours",
			String(edgeStatsWindowHours),
		);
	}, [edgeStatsWindowHours]);

	useEffect(() => {
		const interval = setInterval(() => {
			loadCache({ silent: true });
		}, 60000);
		return () => clearInterval(interval);
	}, [loadCache]);

	useEffect(() => {
		let cancelled = false;
		const loadPickStatus = async () => {
			try {
				const result = await listManualPicksFn({ data: { limit: 2000 } });
				if (cancelled) return;
				const next: Record<
					string,
					{
						status: "pending" | "win" | "loss" | "push";
						pickedAt: number;
					}
				> = {};
				for (const pick of result.picks ?? []) {
					const existing = next[pick.conditionId];
					if (!existing || pick.pickedAt > existing.pickedAt) {
						next[pick.conditionId] = {
							status: pick.status,
							pickedAt: pick.pickedAt,
						};
					}
				}
				setPickStatusByConditionId(next);
			} catch (error) {
				console.error("Failed to load pick status map:", error);
			}
		};
		void loadPickStatus();
		const interval = setInterval(() => {
			void loadPickStatus();
		}, 60000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, []);

	useEffect(() => {
		const interval = setInterval(
			() => {
				if (pipelineStatus?.inProgress) return;
				fetch("/_pipeline/trigger", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ force: false }),
				}).catch((error) => {
					console.error("Auto refresh trigger failed:", error);
				});
			},
			5 * 60 * 1000,
		);
		return () => clearInterval(interval);
	}, [pipelineStatus?.inProgress]);

	// Manual refresh - behavior depends on cache state:
	// - If cache is empty: full refresh - fetch and analyze all markets
	// - If cache has data: partial refresh - only re-fetch data for imminent cached events
	const handleRefresh = useCallback(async () => {
		setIsRefreshing(true);
		try {
			await fetch("/_pipeline/trigger", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ force: true }),
			});
			await loadPipelineStatus();
			await loadCache({ silent: true });
		} catch (error) {
			console.error("Failed to refresh:", error);
		} finally {
			setIsRefreshing(false);
		}
	}, [loadCache, loadPipelineStatus]);

	useEffect(() => {
		isRefreshingRef.current = isRefreshing;
	}, [isRefreshing]);

	useEffect(() => {
		handleRefreshRef.current = handleRefresh;
	}, [handleRefresh]);

	useEffect(() => {
		if (typeof window === "undefined") return;

		const getScrollTop = () => {
			const doc = document.documentElement;
			return window.scrollY || doc.scrollTop || document.body.scrollTop || 0;
		};

		const handleTouchStart = (event: TouchEvent) => {
			if (event.touches.length !== 1) return;
			if (getScrollTop() > 0) return;
			pullStartYRef.current = event.touches[0].clientY;
			pullActiveRef.current = true;
		};

		const handleTouchMove = (event: TouchEvent) => {
			if (!pullActiveRef.current || pullStartYRef.current === null) return;
			const delta = event.touches[0].clientY - pullStartYRef.current;
			if (delta <= 0) {
				if (pullDistanceRef.current !== 0) {
					resetPullState();
				}
				return;
			}
			if (isRefreshingRef.current) return;
			event.preventDefault();
			setIsPulling(true);
			setPullDistanceSafe(Math.min(delta, PULL_MAX));
		};

		const handleTouchEnd = () => {
			if (!pullActiveRef.current) return;
			const shouldRefresh = pullDistanceRef.current >= PULL_THRESHOLD;
			resetPullState();
			if (shouldRefresh && !isRefreshingRef.current) {
				window.location.reload();
			}
		};

		window.addEventListener("touchstart", handleTouchStart, { passive: true });
		window.addEventListener("touchmove", handleTouchMove, { passive: false });
		window.addEventListener("touchend", handleTouchEnd, { passive: true });
		window.addEventListener("touchcancel", handleTouchEnd, { passive: true });

		return () => {
			window.removeEventListener("touchstart", handleTouchStart);
			window.removeEventListener("touchmove", handleTouchMove);
			window.removeEventListener("touchend", handleTouchEnd);
			window.removeEventListener("touchcancel", handleTouchEnd);
		};
	}, [resetPullState, setPullDistanceSafe]);

	const handleRefreshEntry = useCallback(
		async (entry: SharpMoneyCacheEntry) => {
			if (refreshingEntryId) return;
			setRefreshingEntryId(entry.id);
			try {
				await refreshMarketSharpnessFn({
					data: {
						conditionId: entry.conditionId,
						marketTitle: entry.marketTitle,
						marketSlug: entry.marketSlug,
						eventSlug: entry.eventSlug,
						sportSeriesId: entry.sportSeriesId,
						endDate: entry.eventTime,
						marketVolume: entry.marketVolume,
						marketLiquidity: entry.marketLiquidity,
					},
				});
				await loadCache({ silent: true });
			} catch (error) {
				console.error("Failed to refresh entry:", error);
			} finally {
				setRefreshingEntryId(null);
			}
		},
		[loadCache, refreshingEntryId],
	);

	useEffect(() => {
		if (!pipelineStatus?.inProgress) {
			return;
		}

		const interval = setInterval(async () => {
			await loadPipelineStatus();
			await loadCache({ silent: true });
		}, 5000);

		return () => clearInterval(interval);
	}, [pipelineStatus?.inProgress, loadPipelineStatus, loadCache]);

	// Toggle market expansion
	const loadHistory = useCallback(
		async (entry: SharpMoneyCacheEntry) => {
			if (historyByConditionId[entry.conditionId]) {
				return;
			}
			setHistoryLoading((prev) => {
				const next = new Set(prev);
				next.add(entry.conditionId);
				return next;
			});
			try {
				const result = await getSharpMoneyHistoryFn({
					data: { conditionId: entry.conditionId, windowHours: 24 },
				});
				setHistoryByConditionId((prev) => ({
					...prev,
					[entry.conditionId]: result.history ?? [],
				}));
			} catch (error) {
				console.error("Failed to load history:", error);
			} finally {
				setHistoryLoading((prev) => {
					const next = new Set(prev);
					next.delete(entry.conditionId);
					return next;
				});
			}
		},
		[historyByConditionId],
	);

	const toggleMarket = (entry: SharpMoneyCacheEntry) => {
		setExpandedMarkets((prev) => {
			const next = new Set(prev);
			if (next.has(entry.id)) {
				next.delete(entry.id);
			} else {
				next.add(entry.id);
				void loadHistory(entry);
			}
			return next;
		});
	};

	// Filter entries by sport, grade cutoff, and hide started games
	const readyEntries = useMemo(() => entries.filter(isEntryReady), [entries]);
	const baseEntries = readyEntries;
	const signalScoreByConditionId = useMemo(() => {
		const map: Record<string, number> = {};
		for (const entry of baseEntries) {
			const serverGrade = gradesByConditionId[entry.conditionId];
			if (serverGrade) {
				map[entry.conditionId] = serverGrade.signalScore;
				continue;
			}
			const recentSignalHistory = signalHistoryByConditionId[entry.conditionId];
			const fallbackHistory = historyByConditionId[entry.conditionId];
			const history =
				recentSignalHistory && recentSignalHistory.length > 0
					? recentSignalHistory
					: selectRecentHistory(fallbackHistory, 60);
			map[entry.conditionId] = computeSignalScoreFromHistory(
				entry,
				history,
				MIN_EDGE_RATING,
			);
		}
		return map;
	}, [
		baseEntries,
		signalHistoryByConditionId,
		historyByConditionId,
		gradesByConditionId,
	]);

	useEffect(() => {
		if (showAllEntries) {
			setBotAlignedError(null);
			setBotAlignedConditionOrder([]);
			return;
		}
		if (!botDefaults) {
			setBotAlignedError(null);
			setBotAlignedConditionOrder([]);
			return;
		}
		if (baseEntries.length === 0) {
			setBotAlignedError(null);
			setBotAlignedConditionOrder([]);
			return;
		}
		let cancelled = false;
		(async () => {
			const result = await getBotCandidatesFn({
				data: {
					minGrade: botDefaults.minGrade,
					windowMinutes: botDefaults.windowMinutes,
					minMinutesToStart: botDefaults.minMinutesToStart,
					maxMinutesToStart: botDefaults.maxMinutesToStart,
					requireReady: botDefaults.requireReady,
					includeStarted: botDefaults.includeStarted,
					requireMicrostructure: botDefaults.requireMicrostructure,
					marketQualityThreshold: botDefaults.marketQualityThreshold,
					limit: 500,
				},
			});
			if (cancelled) return;
			if ("error" in result && result.error) {
				setBotAlignedError(String(result.error));
				setBotAlignedConditionOrder([]);
				return;
			}
			const orderedIds = (result.candidates ?? []).map(
				(candidate) => candidate.entry.conditionId,
			);
			setBotAlignedError(null);
			setBotAlignedConditionOrder(orderedIds);
		})().catch((error) => {
			if (cancelled) return;
			setBotAlignedError(
				error instanceof Error ? error.message : "bot_candidates_failed",
			);
			setBotAlignedConditionOrder([]);
		});
		return () => {
			cancelled = true;
		};
	}, [showAllEntries, baseEntries, botDefaults]);

	const { filteredEntries, dimmedEntries } = useMemo(() => {
		const now = new Date();
		const cutoff = new Date(
			now.getTime() + UPCOMING_WINDOW_HOURS * 60 * 60 * 1000,
		);
		const botSyncCutoff = new Date(
			now.getTime() + (botDefaults?.maxMinutesToStart ?? 60) * 60 * 1000,
		);
		const startBufferMs = START_TIME_BUFFER_MINUTES * 60 * 1000;
		const minGradeWeight = gradeWeight(botDefaults?.minGrade ?? "A");
		const rankByConditionId = new Map<string, number>();
		for (const [index, conditionId] of botAlignedConditionOrder.entries()) {
			rankByConditionId.set(conditionId, index);
		}

		// Hard filters: never show these regardless of showAllEntries.
		// Includes not-bettable (EVEN, no_price_edge), time-window boundaries,
		// A+-only mode, and explicit sport selection.
		const passesHardFilters = (e: SharpMoneyCacheEntry): boolean => {
			if (e.sharpSide === "EVEN") return false;
			const gameTime = parseEventTime(e.eventTime);
			if (gameTime) {
				if (gameTime.getTime() < now.getTime() - startBufferMs) return false;
				if (gameTime > cutoff) return false;
				if (showAPlusOnly) {
					const minutesToStart = (gameTime.getTime() - now.getTime()) / 60000;
					const isStartingSoon =
						minutesToStart >= -START_TIME_BUFFER_MINUTES &&
						minutesToStart <= STARTING_SOON_MINUTES;
					if (!isStartingSoon) return false;
				}
			} else if (showAPlusOnly) {
				return false;
			}
			const gradeWarnings = gradesByConditionId[e.conditionId]?.warnings ?? [];
			if (gradeWarnings.includes("no_price_edge")) return false;
			if (
				selectedSeriesId !== "all" &&
				e.sportSeriesId !== Number(selectedSeriesId)
			) {
				return false;
			}
			if (showAPlusOnly) {
				const signalScore =
					signalScoreByConditionId[e.conditionId] ?? e.edgeRating;
				const signalGrade =
					gradesByConditionId[e.conditionId]?.grade ??
					signalScoreToGradeLabel(signalScore, {
						edgeRating: e.edgeRating,
						scoreDifferential: e.scoreDifferential,
					});
				if (signalGrade !== "A+") return false;
			}
			return true;
		};

		// Policy filters: applied on top of hard. Failing entries become the
		// "dimmed" set when showAllEntries is false — they stay visible so the
		// user can see near-misses, but at reduced opacity. When showAllEntries
		// is true every hard-passing entry counts as passing (no dim bucket).
		const passesPolicyFilters = (e: SharpMoneyCacheEntry): boolean => {
			if (showAllEntries) return true;
			if (getMarketTypeLabel(e.marketTitle) === "other") return false;
			const gameTime = parseEventTime(e.eventTime);
			if (gameTime && gameTime > botSyncCutoff) return false;
			const signalScore =
				signalScoreByConditionId[e.conditionId] ?? e.edgeRating;
			const signalGrade =
				gradesByConditionId[e.conditionId]?.grade ??
				signalScoreToGradeLabel(signalScore, {
					edgeRating: e.edgeRating,
					scoreDifferential: e.scoreDifferential,
				});
			if (gradeWeight(signalGrade) < minGradeWeight) return false;
			if (!rankByConditionId.has(e.conditionId)) return false;
			return true;
		};

		const hardPass = baseEntries.filter(passesHardFilters);
		const passingRaw = hardPass.filter(passesPolicyFilters);
		const dimmedRaw = showAllEntries
			? []
			: hardPass.filter((e) => !passesPolicyFilters(e));

		const dedupByGroup = (
			entries: SharpMoneyCacheEntry[],
		): SharpMoneyCacheEntry[] => {
			const deduped = new Map<string, SharpMoneyCacheEntry>();
			for (const entry of entries) {
				const key = getMarketGroupKey(entry);
				const existing = deduped.get(key);
				if (!existing) {
					deduped.set(key, entry);
					continue;
				}
				const entryScore =
					signalScoreByConditionId[entry.conditionId] ?? entry.edgeRating;
				const existingScore =
					signalScoreByConditionId[existing.conditionId] ?? existing.edgeRating;
				const entryGrade =
					gradesByConditionId[entry.conditionId]?.grade ??
					signalScoreToGradeLabel(entryScore, {
						edgeRating: entry.edgeRating,
						scoreDifferential: entry.scoreDifferential,
					});
				const existingGrade =
					gradesByConditionId[existing.conditionId]?.grade ??
					signalScoreToGradeLabel(existingScore, {
						edgeRating: existing.edgeRating,
						scoreDifferential: existing.scoreDifferential,
					});
				const entryWeight = gradeWeight(entryGrade);
				const existingWeight = gradeWeight(existingGrade);
				if (entryWeight > existingWeight) {
					deduped.set(key, entry);
					continue;
				}
				if (entryWeight < existingWeight) continue;
				if (entryScore > existingScore) {
					deduped.set(key, entry);
					continue;
				}
				if (entryScore < existingScore) continue;
				if (entry.edgeRating > existing.edgeRating) {
					deduped.set(key, entry);
					continue;
				}
				if (entry.edgeRating < existing.edgeRating) continue;
				if ((entry.scoreDifferential ?? 0) > (existing.scoreDifferential ?? 0)) {
					deduped.set(key, entry);
					continue;
				}
				const entryTime = parseEventTime(entry.eventTime)?.getTime() ?? 0;
				const existingTime = parseEventTime(existing.eventTime)?.getTime() ?? 0;
				if (entryTime > 0 && existingTime > 0 && entryTime < existingTime) {
					deduped.set(key, entry);
				}
			}
			return [...deduped.values()];
		};

		let passing: SharpMoneyCacheEntry[];
		if (!showAllEntries) {
			// Bot-aligned order is already unique per condition — no dedup needed.
			passing = passingRaw
				.slice()
				.sort(
					(a, b) =>
						(rankByConditionId.get(a.conditionId) ?? Number.MAX_SAFE_INTEGER) -
						(rankByConditionId.get(b.conditionId) ?? Number.MAX_SAFE_INTEGER),
				);
		} else {
			passing = dedupByGroup(passingRaw);
		}
		const dimmed = dedupByGroup(dimmedRaw);
		return { filteredEntries: passing, dimmedEntries: dimmed };
	}, [
		baseEntries,
		showAllEntries,
		botAlignedConditionOrder,
		signalScoreByConditionId,
		gradesByConditionId,
		botDefaults?.maxMinutesToStart,
		botDefaults?.minGrade,
	]);

	const debugInfoById = useMemo(() => {
		if (!showRefreshDebug) return {};
		const now = new Date();
		const cutoff = new Date(
			now.getTime() + UPCOMING_WINDOW_HOURS * 60 * 60 * 1000,
		);
		const info: Record<
			string,
			{
				ready: boolean;
				grade: string;
				score: number;
				edge: number;
				diff: number | null;
				timeOk: boolean;
				even: boolean;
			}
		> = {};
		for (const entry of baseEntries) {
			const score =
				signalScoreByConditionId[entry.conditionId] ?? entry.edgeRating;
			const grade =
				gradesByConditionId[entry.conditionId]?.grade ??
				signalScoreToGradeLabel(score, {
					edgeRating: entry.edgeRating,
					scoreDifferential: entry.scoreDifferential,
				});
			const gameTime = parseEventTime(entry.eventTime);
			const timeOk = !gameTime || (gameTime >= now && gameTime <= cutoff);
			info[entry.id] = {
				ready: isEntryReady(entry),
				grade,
				score,
				edge: entry.edgeRating,
				diff: entry.scoreDifferential ?? null,
				timeOk,
				even: entry.sharpSide === "EVEN",
			};
		}
		return info;
	}, [
		baseEntries,
		showRefreshDebug,
		signalScoreByConditionId,
		gradesByConditionId,
	]);

	const statsEntries = useMemo(() => {
		return filteredEntries;
	}, [filteredEntries]);

	const edgeStats = useMemo(() => {
		if (statsEntries.length === 0) return null;
		const values = statsEntries
			.map((entry) => entry.edgeRating)
			.filter((value) => Number.isFinite(value))
			.sort((a, b) => a - b);
		if (values.length === 0) return null;
		const total = values.length;
		const average = values.reduce((sum, value) => sum + value, 0) / total;
		const pickPercentile = (percent: number) => {
			const index = Math.round((percent / 100) * (total - 1));
			return values[Math.max(0, Math.min(total - 1, index))];
		};
		const passingCount = values.filter(
			(value) => value >= MIN_EDGE_RATING,
		).length;
		let aPlusCount = 0;
		let aPlusOrACount = 0;
		for (const entry of statsEntries) {
			const score =
				signalScoreByConditionId[entry.conditionId] ?? entry.edgeRating;
			if (!Number.isFinite(score)) continue;
			const grade =
				gradesByConditionId[entry.conditionId]?.grade ??
				signalScoreToGradeLabel(score, {
					edgeRating: entry.edgeRating,
					scoreDifferential: entry.scoreDifferential,
				});
			if (grade === "A+") {
				aPlusCount += 1;
				aPlusOrACount += 1;
			} else if (grade === "A") {
				aPlusOrACount += 1;
			}
		}
		const passingRate = passingCount / total;
		const aPlusRate = aPlusCount / total;
		const aPlusOrARate = aPlusOrACount / total;
		return {
			total,
			passing: passingCount,
			passingRate,
			aPlusCount,
			aPlusRate,
			aPlusOrACount,
			aPlusOrARate,
			average: Math.round(average),
			p50: pickPercentile(50),
			p75: pickPercentile(75),
			p90: pickPercentile(90),
			max: values[values.length - 1],
		};
	}, [statsEntries, gradesByConditionId, signalScoreByConditionId]);

	const isEdgeStatsDaily = edgeStatsWindowHours > 24;
	const edgeStatsHistoryView = useMemo(() => {
		if (edgeStatsHistory.length === 0) return [];
		const limit = isEdgeStatsDaily ? 7 : 24;
		return edgeStatsHistory.slice(-limit);
	}, [edgeStatsHistory, isEdgeStatsDaily]);

	const edgeStatsCurrentMix = useMemo(
		() =>
			buildGradeMix(
				filteredEntries,
				gradesByConditionId,
				signalScoreByConditionId,
			),
		[filteredEntries, gradesByConditionId, signalScoreByConditionId],
	);
	const refreshSignalHistory = useCallback(async () => {
		const historyCandidates = baseEntries.filter(
			(entry) => entry.sharpSide !== "EVEN",
		);
		if (historyCandidates.length === 0) {
			if (!isLoading) {
				setIsInitialSortReady(true);
			}
			return;
		}
		const now = Date.now();
		const targets = historyCandidates
			.filter((entry) => {
				const lastFetched = signalHistoryFetchedAt[entry.conditionId] ?? 0;
				return now - lastFetched > 2 * 60 * 1000;
			})
			.slice(0, 20);

		if (targets.length === 0) {
			setIsInitialSortReady(true);
			return;
		}
		const results = await Promise.all(
			targets.map(async (entry) => {
				try {
					const result = await getSharpMoneyHistoryFn({
						data: { conditionId: entry.conditionId, windowHours: 1 },
					});
					return {
						conditionId: entry.conditionId,
						history: result.history ?? [],
					};
				} catch (error) {
					console.error("Failed to load signal history:", error);
					return null;
				}
			}),
		);

		const nextFetchedAt = Date.now();
		setSignalHistoryByConditionId((prev) => {
			const next = { ...prev };
			for (const result of results) {
				if (!result) continue;
				next[result.conditionId] = result.history;
			}
			return next;
		});
		setSignalHistoryFetchedAt((prev) => {
			const next = { ...prev };
			for (const result of results) {
				if (!result) continue;
				next[result.conditionId] = nextFetchedAt;
			}
			return next;
		});
		setIsInitialSortReady(true);
	}, [baseEntries, isLoading, signalHistoryFetchedAt]);

	const refreshGrades = useCallback(async () => {
		if (baseEntries.length === 0) return;
		const conditionIds = baseEntries.map((entry) => entry.conditionId);
		try {
			const result = await getSharpMoneyGradesFn({
				data: {
					conditionIds,
				},
			});
			const next: Record<
				string,
				{
					grade: string;
					signalScore: number;
					warnings: string[];
					historyUpdatedAt?: number;
				}
			> = {};
			for (const gradeResult of result.results ?? []) {
				if (gradeResult.error || !gradeResult.grade) continue;
				next[gradeResult.conditionId] = {
					grade: gradeResult.grade,
					signalScore: gradeResult.signalScore ?? 0,
					warnings: gradeResult.warnings ?? [],
					historyUpdatedAt: gradeResult.historyUpdatedAt,
				};
			}
			setGradesByConditionId(next);
		} catch (error) {
			console.error("Failed to refresh grades:", error);
		}
	}, [baseEntries]);

	const refreshHealth = useCallback(async () => {
		try {
			const result = await getRuntimeMarketStatsFn({
				data: { minimal: true, freshnessWindowHours: 24 },
			});
			const stats = result.stats;
			if (!stats) {
				setHealthStatus({ label: "Unknown", detail: "no runtime stats" });
				return;
			}
			const freshness = stats.cacheFreshness;
			if (!freshness || freshness.total === 0) {
				setHealthStatus({ label: "Unknown", detail: "no freshness stats" });
				return;
			}
			// D1-backed signals only: in-memory fetch metrics (pagination caps,
			// retries) live in the DO isolate and are invisible here. Mirror the
			// cron staleness alarm so page badge and server logs always agree.
			const newestHistory = freshness.newestHistory;
			const ageMinutes = newestHistory
				? Math.round(Date.now() / 1000 / 60 - newestHistory / 60)
				: null;
			if (ageMinutes === null) {
				setHealthStatus({ label: "Warn", detail: "no history rows" });
				return;
			}
			if (ageMinutes > 30) {
				setHealthStatus({ label: "Warn", detail: `updated ${ageMinutes}m ago` });
				return;
			}
			const staleRatio = freshness.staleHistory / freshness.total;
			if (staleRatio > 0.1) {
				setHealthStatus({
					label: "Warn",
					detail: `${Math.round(staleRatio * 100)}% stale`,
				});
				return;
			}
			setHealthStatus({
				label: "Good",
				detail: `updated ${ageMinutes}m ago`,
			});
		} catch (error) {
			console.error("Failed to load health stats:", error);
			setHealthStatus({ label: "Unknown", detail: "error" });
		}
	}, []);

	const ensureHealthStats = useCallback(async () => {
		try {
			const result = await getRuntimeMarketStatsFn({ data: {} });
			if (!result.stats) {
				await fetchTrendingSportsMarketsFn({
					data: { limit: 50, includeLowVolume: true },
				});
			}
		} catch (error) {
			console.error("Failed to warm runtime stats:", error);
		}
	}, []);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			if (cancelled) return;
			await refreshSignalHistory();
			await refreshGrades();
			await ensureHealthStats();
			await refreshHealth();
		})();
		return () => {
			cancelled = true;
		};
	}, [refreshSignalHistory, refreshGrades, ensureHealthStats, refreshHealth]);

	useEffect(() => {
		const interval = setInterval(() => {
			void refreshSignalHistory();
			void refreshGrades();
			void refreshHealth();
		}, 60_000);
		return () => clearInterval(interval);
	}, [refreshSignalHistory, refreshGrades, refreshHealth]);

	const sortByComposite = useCallback(
		(entries: SharpMoneyCacheEntry[]) => {
			const out = [...entries];
			out.sort((a, b) => {
				const signalA = signalScoreByConditionId[a.conditionId] ?? 0;
				const signalB = signalScoreByConditionId[b.conditionId] ?? 0;
				const gradeA =
					gradesByConditionId[a.conditionId]?.grade ??
					signalScoreToGradeLabel(signalA, {
						edgeRating: a.edgeRating,
						scoreDifferential: a.scoreDifferential,
					});
				const gradeB =
					gradesByConditionId[b.conditionId]?.grade ??
					signalScoreToGradeLabel(signalB, {
						edgeRating: b.edgeRating,
						scoreDifferential: b.scoreDifferential,
					});
				const compositeA = gradeWeight(gradeA) + signalA;
				const compositeB = gradeWeight(gradeB) + signalB;
				if (compositeA !== compositeB) return compositeB - compositeA;
				return b.edgeRating - a.edgeRating;
			});
			return out;
		},
		[signalScoreByConditionId, gradesByConditionId],
	);

	const sortedEntries = useMemo(
		() => sortByComposite(filteredEntries),
		[sortByComposite, filteredEntries],
	);

	const sortedDimmedEntries = useMemo(
		() => sortByComposite(dimmedEntries),
		[sortByComposite, dimmedEntries],
	);

	const isSortingHold = !isInitialSortReady;
	const displayEntries = !isSortingHold ? sortedEntries : [];
	const displayDimmedEntries = !isSortingHold ? sortedDimmedEntries : [];
	const showSortingState = !isLoading && isSortingHold;
	const showProcessingState =
		!isLoading &&
		!showSortingState &&
		displayEntries.length === 0 &&
		displayDimmedEntries.length === 0 &&
		(pipelineStatus?.inProgress ||
			(entries.length > 0 && readyEntries.length === 0));

	// Volume bar denominator — use the full cache, not the filtered list.
	// Using `displayEntries` would make a single-shown card peg to 100% since
	// it becomes its own "max"; toggling Show All then jitters every bar.
	const maxVolume = useMemo(() => {
		if (entries.length === 0) return 1;
		return Math.max(...entries.map((e) => getEntryMarketVolume(e)), 1);
	}, [entries]);
	const pullReady = pullDistance >= PULL_THRESHOLD;
	const pullIndicatorOffset = Math.min(pullDistance, PULL_MAX);
	const showPullIndicator = pullIndicatorOffset > 0 || isRefreshing;

	if (marketDepthMatch) {
		return <Outlet />;
	}

	return (
		<AuthGate>
			<div className="min-h-screen bg-ink-00">
				{showPullIndicator && (
					<div
						className="pointer-events-none fixed left-0 right-0 top-0 z-[60] flex justify-center"
						style={{
							transform: `translateY(${pullIndicatorOffset}px)`,
							opacity: showPullIndicator ? 1 : 0,
							transition: isPulling
								? "none"
								: "transform 180ms ease, opacity 180ms ease",
							paddingTop: "calc(env(safe-area-inset-top, 0px) + 0.5rem)",
						}}
					>
						<div className="flex items-center gap-2 rounded-full bg-ink-10 ring-1 ring-inset ring-ink-25 px-3 py-1 font-mono text-xxs font-medium uppercase tracking-wider text-ink-85">
							<RefreshCw
								className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : pullReady ? "rotate-180 transition-transform" : ""}`}
							/>
							<span>
								{isRefreshing
									? "refreshing…"
									: pullReady
										? "release to reload"
										: "pull to reload"}
							</span>
						</div>
					</div>
				)}
				{/* Header */}
				<header
					className="sticky top-0 z-50 w-full border-b border-ink-15 bg-ink-05"
					style={{
						paddingTop: "max(1rem, env(safe-area-inset-top, 0px) + 1rem)",
					}}
				>
					<div className="mx-auto max-w-7xl px-4 py-4">
						<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
							<div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
								<div className="flex min-w-0 flex-col gap-1">
									<div className="flex min-w-0 items-center gap-3">
										<img
											src="/logo-trans.png"
											alt=""
											className="h-10 w-auto flex-shrink-0 sm:h-18"
										/>
										<h1 className="font-sans text-2xl font-bold uppercase leading-tight tracking-wider text-ink-95 sm:whitespace-nowrap sm:text-4xl">
											Polywhaler
										</h1>
										<span
											className={`rounded-full px-2 py-0.5 font-mono text-xxs font-semibold uppercase tracking-[0.2em] ${
												healthStatus.label === "Good"
													? "bg-signal-pos/10 text-signal-pos"
													: healthStatus.label === "Warn"
														? "bg-signal-warn/10 text-signal-warn"
														: "bg-ink-15 text-ink-70"
											}`}
											title={healthStatus.detail ?? ""}
										>
											{healthStatus.label}
										</span>
									</div>
								</div>
							</div>
							<div className="flex w-full flex-shrink-0 items-center justify-between gap-1.5 sm:w-auto sm:justify-end sm:gap-2">
								<span className="font-mono text-xxs tabular-nums text-ink-55 sm:text-xs">
									updated{" "}
									{cacheStats?.newestEntry
										? formatRelativeTime(cacheStats.newestEntry)
										: "—"}
								</span>
								<a
									href="/stats"
									className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 font-mono text-xxs font-semibold uppercase tracking-wider text-ink-85 ring-1 ring-inset ring-ink-25 transition-colors hover:bg-ink-15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
								>
									stats
								</a>
							</div>
						</div>
					</div>
				</header>

				{/* Main Content */}
				<main className="mx-auto max-w-7xl px-4 py-6">
					{isLoading && entries.length === 0 && (
						<div className="mb-6 flex items-center justify-center gap-2 rounded-md bg-ink-05 px-4 py-6 ring-1 ring-inset ring-ink-15 font-mono text-sm text-ink-70">
							<Loader2 className="h-4 w-4 animate-spin text-brand-blue" />
							loading sharp data…
						</div>
					)}
					{showSortingState && (
						<div className="mb-6 flex items-center justify-center gap-2 rounded-md bg-ink-05 px-4 py-6 ring-1 ring-inset ring-ink-15 font-mono text-sm text-ink-70">
							<Loader2 className="h-4 w-4 animate-spin text-brand-blue" />
							preparing rankings…
						</div>
					)}
					{!showAllEntries && botAlignedError && (
						<div className="mb-6 rounded-md bg-signal-warn/10 px-4 py-3 text-sm text-signal-warn ring-1 ring-inset ring-signal-warn/30">
							Bot-aligned candidate sync failed: {botAlignedError}
						</div>
					)}

					{showEdgeStats && edgeStats && (
						<section
							aria-labelledby="edge-stats-heading"
							className="mb-6 rounded-md bg-ink-05 px-4 py-3 ring-1 ring-inset ring-ink-15"
						>
							<div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
								<h2
									id="edge-stats-heading"
									className="font-mono text-xxs font-semibold uppercase tracking-[0.2em] text-ink-55"
								>
									Edge Stats
								</h2>
								<div className="font-mono text-xxs text-ink-55">
									{showAllEntries
										? "all ready markets"
										: formatBotPolicySummary(botDefaults)}
								</div>
							</div>

							{/* Top metric strip — flattened (no nested cards), tab-num so columns align */}
							<div className="grid grid-cols-3 gap-x-4 gap-y-2 sm:grid-cols-6">
								<EdgeStatCell label="Markets" value={edgeStats.total} />
								<EdgeStatCell
									label={`≥ ${MIN_EDGE_RATING}`}
									value={edgeStats.passing}
									tone="brand"
								/>
								<EdgeStatCell label="Avg" value={edgeStats.average} />
								<EdgeStatCell label="P50" value={edgeStats.p50} />
								<EdgeStatCell label="P75" value={edgeStats.p75} />
								<EdgeStatCell
									label="P90/Max"
									value={`${edgeStats.p90}/${edgeStats.max}`}
								/>
							</div>

							{/* Share block — flat, no card-in-card. 3 stacked rows, grid on wide */}
							<div className="mt-4 grid gap-x-6 gap-y-2 border-t border-ink-15 pt-3 sm:grid-cols-3">
								<EdgeShareRow
									label="A+ share"
									current={edgeStatsCurrentMix?.aPlusRate}
									sevenDay={edgeStatsGradeMix?.aPlusRate}
									sevenDayLoading={
										edgeStatsGradeMixLoading && !edgeStatsGradeMix
									}
									target={EDGE_TARGETS.aPlus}
								/>
								<EdgeShareRow
									label="A/A+ share"
									current={edgeStatsCurrentMix?.aPlusOrARate}
									sevenDay={edgeStatsGradeMix?.aPlusOrARate}
									sevenDayLoading={
										edgeStatsGradeMixLoading && !edgeStatsGradeMix
									}
									target={EDGE_TARGETS.aPlusOrA}
								/>
								<EdgeShareRow
									label={`≥ ${MIN_EDGE_RATING}`}
									current={edgeStatsCurrentMix?.passingRate}
									sevenDay={edgeStatsGradeMix?.passingRate}
									sevenDayLoading={
										edgeStatsGradeMixLoading && !edgeStatsGradeMix
									}
									target={EDGE_TARGETS.minEdge}
								/>
							</div>

							{/* Edge distribution table */}
							<div className="mt-4 border-t border-ink-15 pt-3">
								<div className="mb-2 flex flex-wrap items-center justify-between gap-2">
									<h3 className="font-mono text-xxs font-semibold uppercase tracking-[0.2em] text-ink-55">
										Edge Distribution (
										{edgeStatsWindowHours === 24
											? "24h"
											: `${Math.round(edgeStatsWindowHours / 24)}d`}
										)
									</h3>
									<div className="flex items-center gap-2">
										<div className="flex items-center gap-0.5 rounded-md bg-ink-10 p-0.5 ring-1 ring-inset ring-ink-15">
											<button
												type="button"
												onClick={() => setEdgeStatsWindowHours(24)}
												aria-pressed={edgeStatsWindowHours === 24}
												className={`inline-flex h-7 items-center rounded px-2.5 font-mono text-xxs font-semibold uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue ${
													edgeStatsWindowHours === 24
														? "bg-brand-blue text-ink-00"
														: "text-ink-70 hover:text-ink-95"
												}`}
											>
												24h
											</button>
											<button
												type="button"
												onClick={() => setEdgeStatsWindowHours(24 * 7)}
												aria-pressed={edgeStatsWindowHours === 24 * 7}
												className={`inline-flex h-7 items-center rounded px-2.5 font-mono text-xxs font-semibold uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue ${
													edgeStatsWindowHours === 24 * 7
														? "bg-brand-blue text-ink-00"
														: "text-ink-70 hover:text-ink-95"
												}`}
											>
												7d
											</button>
										</div>
										{edgeStatsHistoryLoading && (
											<span className="flex items-center gap-1.5 font-mono text-xxs text-ink-55">
												<Loader2 className="h-3 w-3 animate-spin" />
												loading
											</span>
										)}
									</div>
								</div>
								{edgeStatsHistory.length === 0 && !edgeStatsHistoryLoading ? (
									<div className="font-mono text-xs text-ink-55">
										no history snapshots yet.
									</div>
								) : (
									<div
										className="overflow-x-auto"
										style={{
											maskImage:
												"linear-gradient(to right, black 0, black calc(100% - 24px), transparent 100%)",
											WebkitMaskImage:
												"linear-gradient(to right, black 0, black calc(100% - 24px), transparent 100%)",
										}}
									>
										<table className="w-full min-w-[520px] text-left text-xs">
											<thead className="font-mono text-xxs uppercase tracking-wider text-ink-55">
												<tr>
													<th scope="col" className="py-1.5 pr-3 font-normal">
														{isEdgeStatsDaily ? "day" : "hour"}
													</th>
													<th scope="col" className="py-1.5 pr-3 font-normal">
														count
													</th>
													<th scope="col" className="py-1.5 pr-3 font-normal">
														avg
													</th>
													<th scope="col" className="py-1.5 pr-3 font-normal">
														p50
													</th>
													<th scope="col" className="py-1.5 pr-3 font-normal">
														p75
													</th>
													<th scope="col" className="py-1.5 font-normal">
														p90
													</th>
												</tr>
											</thead>
											<tbody className="font-mono tabular-nums text-ink-70">
												{edgeStatsHistoryView.map((bucket, idx) => (
													<tr
														key={bucket.start}
														className={idx % 2 === 1 ? "bg-ink-10/50" : ""}
													>
														<td className="py-1.5 pr-3 text-ink-55">
															{isEdgeStatsDaily
																? formatDayLabel(bucket.start)
																: formatHourLabel(bucket.start)}
														</td>
														<td className="py-1.5 pr-3 text-ink-85">
															{bucket.count}
														</td>
														<td className="py-1.5 pr-3 text-ink-85">
															{bucket.average}
														</td>
														<td className="py-1.5 pr-3 text-ink-85">
															{bucket.p50}
														</td>
														<td className="py-1.5 pr-3 text-ink-85">
															{bucket.p75}
														</td>
														<td className="py-1.5 text-ink-85">{bucket.p90}</td>
													</tr>
												))}
											</tbody>
										</table>
										{edgeStatsHistory.length > edgeStatsHistoryView.length && (
											<div className="mt-2 font-mono text-xxs text-ink-55">
												last {edgeStatsHistoryView.length}{" "}
												{isEdgeStatsDaily ? "days" : "hours"} of{" "}
												{edgeStatsWindowHours === 24 ? "24h" : "7d"} history
											</div>
										)}
									</div>
								)}
							</div>
						</section>
					)}
					{edgeStats && (
						<div className="mb-6 flex justify-end">
							<button
								type="button"
								onClick={() => setShowEdgeStats((prev) => !prev)}
								aria-pressed={showEdgeStats}
								className="inline-flex h-8 items-center gap-2 rounded-md px-3 font-mono text-xxs font-semibold uppercase tracking-wider text-ink-70 ring-1 ring-inset ring-ink-25 transition-colors hover:bg-ink-15 hover:text-ink-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
							>
								{showEdgeStats ? (
									<EyeOff className="h-3.5 w-3.5" />
								) : (
									<Eye className="h-3.5 w-3.5" />
								)}
								{showEdgeStats ? "hide edge stats" : "show edge stats"}
							</button>
						</div>
					)}

					{/* Loading State */}
					{isLoading && (
						<div className="flex items-center justify-center py-20">
							<Loader2 className="h-8 w-8 animate-spin text-brand-blue" />
						</div>
					)}

					{pipelineStatus?.inProgress && !isLoading && entries.length === 0 && (
						<div className="mb-4 flex items-center gap-2 rounded-md bg-ink-10 px-3 py-2 ring-1 ring-inset ring-brand-blue/30 font-mono text-xs text-ink-85">
							<Loader2 className="h-3 w-3 animate-spin text-brand-blue" />
							<span>
								analyzing markets
								{pipelineStatus.totalQueued
									? ` (${pipelineStatus.processed ?? 0}/${pipelineStatus.totalQueued})`
									: ""}
								. first results will appear shortly.
							</span>
						</div>
					)}
					{pipelineStatus?.inProgress && !isLoading && entries.length > 0 && (
						<div className="mb-4 flex items-center justify-end gap-1.5 font-mono text-xxs text-ink-55">
							<Loader2 className="h-3 w-3 animate-spin" />
							<span>
								updating
								{pipelineStatus.totalQueued
									? ` (${pipelineStatus.processed ?? 0}/${pipelineStatus.totalQueued})`
									: ""}
							</span>
						</div>
					)}
					{showRefreshDebug && (
						<div className="mb-4 rounded-md bg-ink-05 px-3 py-2 ring-1 ring-inset ring-ink-15 font-mono text-xxs tabular-nums text-ink-70">
							<div className="text-ink-55">refreshDebug=1</div>
							<div>isLoading: {String(isLoading)}</div>
							<div>isRefreshing: {String(isRefreshing)}</div>
							<div>
								pipeline.inProgress:{" "}
								{String(pipelineStatus?.inProgress ?? false)}
							</div>
							<div>entries: {entries.length}</div>
							<div>filteredEntries: {filteredEntries.length}</div>
							<div>
								cacheStats.totalEntries: {cacheStats?.totalEntries ?? "null"}
							</div>
							<div>
								cacheStats.newestEntry: {cacheStats?.newestEntry ?? "null"}
							</div>
							<div>
								pipeline.startedAt: {pipelineStatus?.startedAt ?? "null"}
							</div>
							<div>
								pipeline.updatedAt: {pipelineStatus?.updatedAt ?? "null"}
							</div>
							<div>
								pipeline.totalQueued: {pipelineStatus?.totalQueued ?? "null"}
							</div>
							<div>
								pipeline.processed: {pipelineStatus?.processed ?? "null"}
							</div>
							<div>lastCacheFetchAt: {lastCacheFetchAt ?? "null"}</div>
						</div>
					)}
					{showRefreshDebug && entries.length > 0 && (
						<div className="mb-4 rounded-md bg-ink-05 px-3 py-2 ring-1 ring-inset ring-ink-15 font-mono text-xs text-ink-70">
							<h3 className="mb-2 font-mono text-xxs font-semibold uppercase tracking-[0.2em] text-ink-55">
								Not Ready Diagnostics
							</h3>
							{entries.filter((entry) => !isEntryReady(entry)).length === 0 ? (
								<div className="text-ink-55">all entries are ready.</div>
							) : (
								entries
									.filter((entry) => !isEntryReady(entry))
									.map((entry) => {
										const minHolderCount = Math.min(
											entry.sideA.holderCount,
											entry.sideB.holderCount,
										);
										const pnlCoverage =
											entry.pnlCoverage ??
											Math.min(
												getPnlCoverage(entry.sideA.topHolders),
												getPnlCoverage(entry.sideB.topHolders),
											);
										const reasons: string[] = [];
										if (minHolderCount < MIN_READY_HOLDER_COUNT) {
											reasons.push(
												`holders ${minHolderCount}/${MIN_READY_HOLDER_COUNT}`,
											);
										}
										if (pnlCoverage < MIN_READY_PNL_COVERAGE) {
											reasons.push(`pnl ${(pnlCoverage * 100).toFixed(0)}%`);
										}
										return (
											<div key={entry.id} className="mb-2">
												<div className="text-ink-85">{entry.marketTitle}</div>
												<div className="text-ink-55">
													not ready: {reasons.join(" • ")}
												</div>
											</div>
										);
									})
							)}
						</div>
					)}

					{/* Empty state — text-forward, no large decorative icon */}
					{!showProcessingState &&
						!showSortingState &&
						!isLoading &&
						displayEntries.length === 0 &&
						displayDimmedEntries.length === 0 && (
							<div className="rounded-md bg-ink-05 px-4 py-6 ring-1 ring-inset ring-ink-15">
								<h2 className="font-sans text-base font-semibold text-ink-95">
									{entries.length > 0
										? "No actionable markets right now"
										: "No sharp money data yet"}
								</h2>
								<p className="mt-1.5 max-w-prose font-sans text-sm text-ink-70">
									{entries.length > 0
										? "All current markets have already started, fall outside the upcoming window, or lack a price edge."
										: "Run a refresh to scan top sports markets and surface where sharp money is flowing."}
								</p>
							</div>
						)}

					{/* Processing state — text-forward with inline spinner, no 48×48 hero icon */}
					{showProcessingState && (
						<div className="rounded-md bg-ink-05 px-4 py-6 ring-1 ring-inset ring-ink-15">
							<div className="flex items-center gap-2">
								<Loader2 className="h-4 w-4 animate-spin text-brand-blue" />
								<h2 className="font-sans text-base font-semibold text-ink-95">
									Warming up sharp grades
								</h2>
							</div>
							<p className="mt-1.5 max-w-prose font-sans text-sm text-ink-70">
								Fetching top holders and PnL. This usually takes a few refresh
								cycles after a reset. Results will appear once all markets have
								full PnL coverage.
							</p>
							{entries.length > 0 && (
								<div className="mt-3 font-mono text-xxs uppercase tracking-[0.2em] tabular-nums text-ink-55">
									ready {readyEntries.length} / {entries.length}
								</div>
							)}
							{!pipelineStatus?.inProgress && (
								<button
									type="button"
									onClick={handleRefresh}
									disabled={isRefreshing}
									className="mt-3 inline-flex h-9 items-center gap-2 rounded-md bg-brand-blue px-4 font-mono text-xs font-semibold uppercase tracking-wider text-ink-00 transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue disabled:opacity-50"
								>
									<RefreshCw
										className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
									/>
									Refresh cache
								</button>
							)}
						</div>
					)}

					{/* Market Cards */}
					{!showProcessingState &&
						!showSortingState &&
						!isLoading &&
						(displayEntries.length > 0 ||
							displayDimmedEntries.length > 0) && (
							<div className="space-y-4">
								{/* Show counts */}
								{(entries.length > displayEntries.length || showAllEntries) && (
									<div className="flex items-center justify-end gap-2 font-mono text-xxs tabular-nums text-ink-55">
										<span>
											{displayEntries.length}/{entries.length} passing
											{displayDimmedEntries.length > 0
												? ` · ${displayDimmedEntries.length} near-miss`
												: ""}
										</span>
									</div>
								)}
								{displayEntries.map((entry) => (
									<SharpMoneyCard
										key={entry.id}
										entry={entry}
										pickMeta={pickStatusByConditionId[entry.conditionId]}
										isExpanded={expandedMarkets.has(entry.id)}
										onToggle={() => toggleMarket(entry)}
										history={historyByConditionId[entry.conditionId]}
										isHistoryLoading={historyLoading.has(entry.conditionId)}
										signalScore={signalScoreByConditionId[entry.conditionId]}
										gradeData={gradesByConditionId[entry.conditionId]}
										onRefresh={() => handleRefreshEntry(entry)}
										isRefreshing={refreshingEntryId === entry.id}
										disableRefresh={Boolean(pipelineStatus?.inProgress)}
										maxVolume={maxVolume}
										debugInfo={debugInfoById[entry.id]}
										showDebug={showRefreshDebug}
									/>
								))}
								{displayDimmedEntries.length > 0 && (
									<>
										<div
											className="flex items-center gap-3 pt-2 font-mono text-xxs uppercase tracking-wider text-ink-40"
											aria-label="Near-miss section"
										>
											<span className="h-px flex-1 bg-ink-15" aria-hidden />
											<span>near-misses · below criteria</span>
											<span className="h-px flex-1 bg-ink-15" aria-hidden />
										</div>
										{displayDimmedEntries.map((entry) => (
											<SharpMoneyCard
												key={entry.id}
												entry={entry}
												pickMeta={pickStatusByConditionId[entry.conditionId]}
												isExpanded={expandedMarkets.has(entry.id)}
												onToggle={() => toggleMarket(entry)}
												history={historyByConditionId[entry.conditionId]}
												isHistoryLoading={historyLoading.has(entry.conditionId)}
												signalScore={signalScoreByConditionId[entry.conditionId]}
												gradeData={gradesByConditionId[entry.conditionId]}
												onRefresh={() => handleRefreshEntry(entry)}
												isRefreshing={refreshingEntryId === entry.id}
												disableRefresh={Boolean(pipelineStatus?.inProgress)}
												maxVolume={maxVolume}
												debugInfo={debugInfoById[entry.id]}
												showDebug={showRefreshDebug}
												dimmed
											/>
										))}
									</>
								)}
							</div>
						)}
				</main>
			</div>
		</AuthGate>
	);
}

const CAVEAT_LABELS: Record<string, string> = {
	low_holders: "low holders",
	low_pnl_coverage: "low pnl coverage",
	not_ready: "not ready",
	no_edge: "no edge",
	low_conviction: "low conviction",
	high_concentration: "high concentration",
	stale_data: "stale data",
	low_roi: "low roi",
};

type GradeTone = {
	text: string;
	surface: string;
	ring: string;
};

function toneForGrade(grade: string): GradeTone {
	switch (grade) {
		case "A+":
			return {
				text: "text-brand-cyan",
				surface: "bg-brand-cyan/10",
				ring: "ring-brand-cyan/35",
			};
		case "A":
			return {
				text: "text-signal-pos",
				surface: "bg-signal-pos/10",
				ring: "ring-signal-pos/30",
			};
		case "B":
			return {
				text: "text-ink-85",
				surface: "bg-ink-15",
				ring: "ring-ink-25",
			};
		case "C":
			return {
				text: "text-signal-warn",
				surface: "bg-signal-warn/10",
				ring: "ring-signal-warn/25",
			};
		default:
			return {
				text: "text-ink-55",
				surface: "bg-ink-10",
				ring: "ring-ink-25",
			};
	}
}

function SharpMoneyCard({
	entry,
	pickMeta,
	isExpanded,
	onToggle,
	history,
	isHistoryLoading,
	signalScore,
	gradeData,
	onRefresh,
	isRefreshing,
	disableRefresh,
	maxVolume,
	debugInfo,
	showDebug,
	dimmed,
}: {
	entry: SharpMoneyCacheEntry;
	pickMeta?: {
		status: "pending" | "win" | "loss" | "push";
		pickedAt: number;
	};
	isExpanded: boolean;
	onToggle: () => void;
	history?: SharpMoneyHistoryEntry[];
	isHistoryLoading: boolean;
	signalScore?: number;
	gradeData?: {
		grade: string;
		signalScore: number;
		warnings: string[];
		historyUpdatedAt?: number;
	};
	onRefresh: () => void;
	isRefreshing: boolean;
	disableRefresh: boolean;
	maxVolume: number;
	debugInfo?: {
		ready: boolean;
		grade: string;
		score: number;
		edge: number;
		diff: number | null;
		timeOk: boolean;
		even: boolean;
	};
	showDebug?: boolean;
	dimmed?: boolean;
}) {
	const [botInspectLoading, setBotInspectLoading] = useState(false);
	const [botInspectError, setBotInspectError] = useState<string | null>(null);
	const [botInspectResult, setBotInspectResult] =
		useState<BotInspectResult | null>(null);
	const [botInspectTouched, setBotInspectTouched] = useState(false);
	const polymarketUrl = buildPolymarketUrl(entry.eventSlug, entry.marketSlug);
	const sideAOdds = formatAmericanOdds(entry.sideA.price);
	const sideBOdds = formatAmericanOdds(entry.sideB.price);
	const sharpSideData = entry.sharpSide === "A" ? entry.sideA : entry.sideB;
	const historyUpdatedAt =
		gradeData?.historyUpdatedAt ?? entry.historyUpdatedAt ?? entry.updatedAt;
	const historyAgeSeconds =
		typeof historyUpdatedAt === "number"
			? Math.floor(Date.now() / 1000) - historyUpdatedAt
			: null;
	const isHistoryStale =
		historyAgeSeconds !== null &&
		historyAgeSeconds > STALE_HISTORY_MINUTES * 60;
	const gradeWarnings = gradeData?.warnings ?? [];
	const pickStatusLabel =
		pickMeta?.status === "pending"
			? "placed"
			: pickMeta?.status === "win"
				? "won"
				: pickMeta?.status === "loss"
					? "lost"
					: pickMeta?.status === "push"
						? "push"
						: null;
	const pickPillTone =
		pickMeta?.status === "pending"
			? "text-signal-pos border-signal-pos/35"
			: pickMeta?.status === "win"
				? "text-signal-pos border-signal-pos/45 bg-signal-pos/8"
				: pickMeta?.status === "loss"
					? "text-signal-bad border-signal-bad/45 bg-signal-bad/8"
					: pickMeta?.status === "push"
						? "text-ink-55 border-ink-25"
						: "";

	const marketVolume = getEntryMarketVolume(entry);
	const volumePercent = getVolumePercentLogScaled(marketVolume, maxVolume);

	const scoreForGrade = signalScore ?? entry.edgeRating;
	const betGradeLabel =
		gradeData?.grade ??
		signalScoreToGradeLabel(scoreForGrade, {
			edgeRating: entry.edgeRating,
			scoreDifferential: entry.scoreDifferential,
		});
	const gradeTone = toneForGrade(betGradeLabel);
	const compositeScoreDisplay = (
		gradeWeight(betGradeLabel) + scoreForGrade
	).toFixed(1);
	const activeCaveats = gradeWarnings
		.map((key) => ({ key, label: CAVEAT_LABELS[key] }))
		.filter(
			(c): c is { key: string; label: string } => typeof c.label === "string",
		);

	const historyEntries = history ?? [];
	const historyFirst = historyEntries[0];
	const historyLast = historyEntries[historyEntries.length - 1];
	const historySlice = historyEntries.slice(-12);
	const formatOddsLine = (snapshot: SharpMoneyHistoryEntry) => {
		const sideA = formatAmericanOdds(snapshot.sideA.price);
		const sideB = formatAmericanOdds(snapshot.sideB.price);
		if (!sideA && !sideB) return "—";
		return `${snapshot.sideA.label} ${sideA ?? "—"} • ${snapshot.sideB.label} ${sideB ?? "—"}`;
	};
	const eventDate = parseEventTime(entry.eventTime);
	const minutesToStart = eventDate
		? (eventDate.getTime() - Date.now()) / 60000
		: null;
	const isStartingSoon =
		minutesToStart !== null &&
		minutesToStart >= -START_TIME_BUFFER_MINUTES &&
		minutesToStart <= STARTING_SOON_MINUTES;

	const edgeTickPercent = Math.max(0, Math.min(100, entry.edgeRating));
	const diffTickPercent = Math.max(
		0,
		Math.min(100, (entry.scoreDifferential / 60) * 100),
	);

	const historyWindows = useMemo(() => {
		const map = new Map<number, SharpMoneyHistoryEntry[]>();
		for (const snapshot of historySlice) {
			const windowStart = snapshot.recordedAt - 60 * 60;
			map.set(
				snapshot.recordedAt,
				historyEntries.filter(
					(e) =>
						e.recordedAt >= windowStart && e.recordedAt <= snapshot.recordedAt,
				),
			);
		}
		return map;
	}, [historyEntries, historySlice]);

	const stopPropagation = useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
	}, []);

	const handleRefreshClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onRefresh();
		},
		[onRefresh],
	);

	const inspectBotDecision = useCallback(async () => {
		setBotInspectTouched(true);
		setBotInspectLoading(true);
		setBotInspectError(null);
		setBotInspectResult({ stage: "checking" });
		try {
			const { defaults } = await getBotInspectDefaultsFn();
			const response = await getBotCandidateInspectFn({
				data: {
					conditionId: entry.conditionId,
					minGrade: defaults.minGrade,
					windowMinutes: defaults.windowMinutes,
					minMinutesToStart: defaults.minMinutesToStart,
					maxMinutesToStart: defaults.maxMinutesToStart,
					requireReady: defaults.requireReady,
					includeStarted: defaults.includeStarted,
					requireMicrostructure: defaults.requireMicrostructure,
					marketQualityThreshold: defaults.marketQualityThreshold,
					limit: defaults.candidateLimit,
				},
			});
			if ("error" in response && response.error) {
				setBotInspectError(String(response.error));
				setBotInspectResult(null);
				return;
			}
			const inspect = response.inspect as BotInspectResult | undefined;
			setBotInspectResult(inspect ?? { stage: "no_inspect_data" });
		} catch (error) {
			setBotInspectError(
				error instanceof Error ? error.message : "bot_inspect_failed",
			);
			setBotInspectResult(null);
		} finally {
			setBotInspectLoading(false);
		}
	}, [entry.conditionId]);
	const botInspectStatus = formatBotInspectStatus(botInspectResult);
	const botInspectToneClass =
		botInspectStatus.tone === "good"
			? "text-signal-pos"
			: botInspectStatus.tone === "bad"
				? "text-signal-bad"
				: "text-signal-warn";

	const panelId = `sharp-card-panel-${entry.id}`;

	return (
		<article
			className={`@container overflow-hidden rounded-lg bg-ink-05 ring-1 ring-inset ring-ink-15 transition-opacity ${dimmed ? "opacity-40 hover:opacity-70 focus-within:opacity-100" : ""}`}
			aria-label={dimmed ? "Near-miss market (below filter criteria)" : undefined}
		>
			{showDebug && debugInfo && (
				<div className="flex flex-wrap gap-x-3 gap-y-0.5 bg-ink-10 px-3 py-1.5 font-mono text-xxs uppercase tracking-wider tabular-nums text-ink-55">
					<span className="text-ink-55">debug</span>
					<span>ready {debugInfo.ready ? "y" : "n"}</span>
					<span>grade {debugInfo.grade}</span>
					<span>score {Math.round(debugInfo.score)}</span>
					<span>edge {debugInfo.edge}</span>
					<span>diff {debugInfo.diff ?? "—"}</span>
					<span>time {debugInfo.timeOk ? "ok" : "bad"}</span>
					<span>even {debugInfo.even ? "y" : "n"}</span>
				</div>
			)}

			{/* Header row — non-interactive container, holds meta + action icons.
			    Not wrapped in the expand button so its nested links/buttons stay semantically valid. */}
			<div className="flex items-center justify-between gap-2 px-3 pt-2.5 @[480px]:px-4 @[480px]:pt-3">
				<div className="flex min-w-0 flex-1 items-baseline gap-1.5 text-xs">
					{entry.sportSeriesId && (
						<span className="font-mono text-xxs font-medium uppercase tracking-wider text-ink-70">
							{getSeriesLabel(entry.sportSeriesId)}
						</span>
					)}
					{entry.eventTime && (
						<>
							<span className="text-ink-40" aria-hidden>
								·
							</span>
							<span className="truncate font-mono tabular-nums text-ink-85">
								{formatEventTime(entry.eventTime)}
							</span>
						</>
					)}
					{isStartingSoon && (
						<span className="shrink-0 rounded bg-signal-bad/10 px-1.5 py-0.5 font-mono text-xxs font-medium uppercase tracking-wider text-signal-bad">
							starting
						</span>
					)}
					{isHistoryStale && (
						<span className="shrink-0 rounded bg-signal-bad/10 px-1.5 py-0.5 font-mono text-xxs font-medium uppercase tracking-wider text-signal-bad">
							stale
						</span>
					)}
				</div>

				<div className="flex shrink-0 items-center gap-1 text-ink-55">
					<a
						href={`/sharp/market/${entry.conditionId}`}
						onClick={stopPropagation}
						aria-label="Open market depth view"
						className="inline-flex h-8 w-8 items-center justify-center rounded text-ink-55 transition-colors hover:bg-ink-15 hover:text-brand-blue focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
					>
						<Target className="h-4 w-4" />
					</a>
					{polymarketUrl && (
						<a
							href={polymarketUrl}
							target="_blank"
							rel="noopener noreferrer"
							onClick={stopPropagation}
							aria-label="Open on Polymarket"
							className="inline-flex h-8 w-8 items-center justify-center rounded text-ink-55 transition-colors hover:bg-ink-15 hover:text-brand-blue focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
						>
							<ExternalLink className="h-4 w-4" />
						</a>
					)}
					{!disableRefresh && (
						<button
							type="button"
							onClick={handleRefreshClick}
							aria-label="Refresh this market"
							className="inline-flex h-8 w-8 items-center justify-center rounded text-ink-55 transition-colors hover:bg-ink-15 hover:text-brand-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue disabled:opacity-40"
							disabled={isRefreshing}
						>
							<RefreshCw
								className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
							/>
						</button>
					)}
				</div>
			</div>

			{/* Main expand trigger — contains only non-interactive content.
			    Valid <button> semantics, keyboard-accessible, screen-reader-friendly. */}
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={isExpanded}
				aria-controls={panelId}
				className="block w-full cursor-pointer text-left transition-colors hover:bg-ink-10/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-blue"
			>
				{/* Title + grade */}
				<div className="grid grid-cols-[1fr_auto] items-start gap-3 px-3 pt-2 pb-2.5 @[480px]:px-4 @[480px]:pb-3">
					<div className="min-w-0">
						<h3 className="font-sans text-base font-semibold leading-tight tracking-[-0.01em] text-ink-95 @[480px]:text-lg">
							{entry.marketTitle}
						</h3>
						<div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0 font-mono text-xxs tabular-nums text-ink-55">
							<span>
								<span className="text-ink-55">updated</span>{" "}
								<span className="text-ink-70">
									{formatRelativeTime(historyUpdatedAt)}
								</span>
							</span>
							{pickMeta && pickStatusLabel && pickPillTone && (
								<span
									className={`rounded border px-1.5 py-0 uppercase tracking-wider ${pickPillTone}`}
									title={`Pick ${pickStatusLabel} ${formatRelativeTime(pickMeta.pickedAt)}`}
								>
									{pickStatusLabel}
								</span>
							)}
						</div>
						{entry.sharpSide !== "EVEN" && (
							<div className="mt-1.5 flex items-baseline gap-2 text-sm">
								<span className="font-mono text-xxs font-medium uppercase tracking-[0.2em] text-ink-55">
									bet
								</span>
								<span className="font-sans font-semibold text-ink-95">
									{sharpSideData.label}
								</span>
							</div>
						)}
						{activeCaveats.length > 0 && (
							<div className="mt-1.5 flex flex-wrap items-baseline gap-x-1 gap-y-0.5 font-mono text-xxs tracking-wide">
								<span className="uppercase tracking-wider text-ink-55">
									caveats
								</span>
								{activeCaveats.map((c) => (
									<span key={c.key} className="flex items-baseline gap-1">
										<span className="text-ink-40" aria-hidden>
											·
										</span>
										<span
											className={
												c.key === "stale_data"
													? "text-signal-bad"
													: "text-signal-warn"
											}
										>
											{c.label}
										</span>
									</span>
								))}
							</div>
						)}
					</div>

					<div
						className={`flex min-w-[3.25rem] shrink-0 flex-col items-center justify-center rounded-md px-2.5 py-1.5 ring-1 ring-inset ${gradeTone.surface} ${gradeTone.ring}`}
					>
						<span
							className={`font-sans text-2xl font-bold leading-none tabular-nums ${gradeTone.text}`}
						>
							{betGradeLabel}
						</span>
						<span className="mt-1 font-mono text-xxs tabular-nums tracking-wider text-ink-55">
							{compositeScoreDisplay}
						</span>
					</div>
				</div>

				{/* Metrics row */}
				{entry.sharpSide !== "EVEN" && (
					<div className="px-3 pb-3 @[480px]:px-4">
						<div className="grid grid-cols-3 gap-4 @[480px]:gap-6">
							<Metric
								label="edge"
								value={String(entry.edgeRating)}
								tickPercent={edgeTickPercent}
							/>
							<Metric
								label="diff"
								value={String(Math.round(entry.scoreDifferential))}
								tickPercent={diffTickPercent}
							/>
							<Metric
								label="volume"
								value={formatUsdCompact(marketVolume)}
								tickPercent={volumePercent}
							/>
						</div>
					</div>
				)}

				{/* Edge bar */}
				<div className="px-3 pb-3 @[480px]:px-4 @[480px]:pb-4">
					<UnifiedEdgeBar
						sideA={entry.sideA}
						sideB={entry.sideB}
						sharpSide={entry.sharpSide}
						sideAOdds={sideAOdds}
						sideBOdds={sideBOdds}
					/>
				</div>
			</button>

			{/* Expanded body */}
			{isExpanded && (
				<div id={panelId} className="border-t border-ink-15 bg-ink-00/60">
					<div className="flex items-center justify-between gap-3 px-3 pt-3 pb-1.5 @[480px]:px-4">
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								void inspectBotDecision();
							}}
							className="font-mono text-xxs font-medium uppercase tracking-wider text-ink-55 transition-colors hover:text-brand-blue disabled:opacity-40"
							disabled={botInspectLoading}
							title="Inspect bot candidate logic for this market"
						>
							{botInspectLoading ? "checking bot…" : "check bot decision"}
						</button>
						{(botInspectTouched || botInspectError || botInspectResult) && (
							<span
								className={`text-right font-mono text-xxs uppercase tracking-wider ${
									botInspectError
										? "text-signal-bad"
										: botInspectLoading
											? "text-brand-blue"
											: botInspectToneClass
								}`}
							>
								{botInspectError
									? `failed: ${botInspectError}`
									: botInspectStatus.message}
							</span>
						)}
					</div>
					{!botInspectError && botInspectStatus.detail && (
						<div className="px-3 pb-2 font-mono text-xxs text-ink-55 @[480px]:px-4">
							{botInspectStatus.detail}
						</div>
					)}

					<div className="px-3 pb-4 @[480px]:px-4">
						<div className="grid gap-3 @[600px]:grid-cols-2">
							<SideDetails
								side={entry.sideA}
								isSharp={entry.sharpSide === "A"}
							/>
							<SideDetails
								side={entry.sideB}
								isSharp={entry.sharpSide === "B"}
							/>
						</div>

						<div className="mt-4 rounded-md bg-ink-05 ring-1 ring-inset ring-ink-15">
							<div className="flex items-center justify-between px-3 pt-3 @[480px]:px-4">
								<div className="font-mono text-xxs uppercase tracking-wider text-ink-55">
									history · 24h
								</div>
								{isHistoryLoading && (
									<div className="flex items-center gap-1.5 font-mono text-xxs text-ink-55">
										<Loader2 className="h-3 w-3 animate-spin" />
										loading
									</div>
								)}
							</div>

							{!isHistoryLoading && historyEntries.length === 0 && (
								<div className="px-3 py-4 font-mono text-xs text-ink-55 @[480px]:px-4">
									no history recorded yet.
								</div>
							)}

							{historyFirst && historyLast && (
								<>
									<div className="grid gap-x-6 gap-y-1 px-3 pt-2 pb-3 text-xs @[480px]:grid-cols-2 @[480px]:px-4">
										<HistoryDelta
											label="grade"
											from={signalScoreToGradeLabel(
												computeSignalScoreFromWindow(
													historyFirst,
													[historyFirst],
													MIN_EDGE_RATING,
												),
												{
													edgeRating: historyFirst.edgeRating,
													scoreDifferential: historyFirst.scoreDifferential,
												},
											)}
											to={signalScoreToGradeLabel(
												computeSignalScoreFromWindow(
													historyLast,
													historyEntries,
													MIN_EDGE_RATING,
												),
												{
													edgeRating: historyLast.edgeRating,
													scoreDifferential: historyLast.scoreDifferential,
												},
											)}
										/>
										<HistoryDelta
											label="edge"
											from={String(historyFirst.edgeRating)}
											to={String(historyLast.edgeRating)}
										/>
										<HistoryDelta
											label="diff"
											from={String(Math.round(historyFirst.scoreDifferential))}
											to={String(Math.round(historyLast.scoreDifferential))}
										/>
										<HistoryDelta
											label="holder"
											from={formatUsdCompact(
												historyFirst.sideA.totalValue +
													historyFirst.sideB.totalValue,
											)}
											to={formatUsdCompact(
												historyLast.sideA.totalValue +
													historyLast.sideB.totalValue,
											)}
										/>
										<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono tabular-nums @[480px]:col-span-2">
											<span className="text-xxs uppercase tracking-wider text-ink-55">
												odds
											</span>
											<span className="text-ink-70">
												{formatOddsLine(historyFirst)}
											</span>
											<span className="text-ink-40">→</span>
											<span className="text-ink-85">
												{formatOddsLine(historyLast)}
											</span>
										</div>
									</div>
									<div
										className="relative overflow-x-auto px-3 pb-3 @[480px]:px-4"
										style={{
											maskImage:
												"linear-gradient(to right, black 0, black calc(100% - 24px), transparent 100%)",
											WebkitMaskImage:
												"linear-gradient(to right, black 0, black calc(100% - 24px), transparent 100%)",
										}}
									>
										<table className="w-full min-w-[460px] text-left text-xs">
											<thead className="font-mono text-xxs uppercase tracking-wider text-ink-55">
												<tr>
													<th scope="col" className="py-1.5 pr-3 font-normal">
														time
													</th>
													<th scope="col" className="py-1.5 pr-3 font-normal">
														grade
													</th>
													<th
														scope="col"
														className="py-1.5 pr-3 text-right font-normal"
													>
														edge
													</th>
													<th
														scope="col"
														className="py-1.5 pr-3 text-right font-normal"
													>
														diff
													</th>
													<th
														scope="col"
														className="py-1.5 pr-3 text-right font-normal"
													>
														holder
													</th>
													<th scope="col" className="py-1.5 font-normal">
														odds
													</th>
												</tr>
											</thead>
											<tbody className="font-mono tabular-nums text-ink-70">
												{historySlice.map((snapshot, idx) => {
													const window =
														historyWindows.get(snapshot.recordedAt) ?? [];
													const grade = signalScoreToGradeLabel(
														computeSignalScoreFromWindow(
															snapshot,
															window,
															MIN_EDGE_RATING,
														),
														{
															edgeRating: snapshot.edgeRating,
															scoreDifferential: snapshot.scoreDifferential,
														},
													);
													return (
														<tr
															key={snapshot.recordedAt}
															className={idx % 2 === 1 ? "bg-ink-10/50" : ""}
														>
															<td className="py-1.5 pr-3 text-ink-55">
																{formatRelativeTime(snapshot.recordedAt)}
															</td>
															<td className="py-1.5 pr-3 text-ink-85">
																{grade}
															</td>
															<td className="py-1.5 pr-3 text-right text-ink-85">
																{snapshot.edgeRating}
															</td>
															<td className="py-1.5 pr-3 text-right text-ink-85">
																{Math.round(snapshot.scoreDifferential)}
															</td>
															<td className="py-1.5 pr-3 text-right text-ink-85">
																{formatUsdCompact(
																	snapshot.sideA.totalValue +
																		snapshot.sideB.totalValue,
																)}
															</td>
															<td className="py-1.5 text-ink-70">
																{formatOddsLine(snapshot)}
															</td>
														</tr>
													);
												})}
											</tbody>
										</table>
									</div>
									{historyEntries.length > historySlice.length && (
										<div className="px-3 pb-3 font-mono text-xxs uppercase tracking-wider tabular-nums text-ink-55 @[480px]:px-4">
											last {historySlice.length} of {historyEntries.length}{" "}
											snapshots
										</div>
									)}
								</>
							)}
						</div>
					</div>
				</div>
			)}
		</article>
	);
}

function Metric({
	label,
	value,
	tickPercent,
}: {
	label: string;
	value: string;
	tickPercent: number;
}) {
	const ratio = Math.max(0, Math.min(100, tickPercent)) / 100;
	return (
		<div className="min-w-0">
			<div className="font-sans text-lg font-semibold leading-none tabular-nums text-ink-95">
				{value}
			</div>
			<div className="mt-1.5 h-[2px] w-full overflow-hidden rounded-full bg-ink-15">
				<div
					className="h-full w-full origin-left bg-brand-blue/70 transition-transform duration-500 ease-out"
					style={{ transform: `scaleX(${ratio})` }}
				/>
			</div>
			<div className="mt-1 font-mono text-xxs uppercase tracking-wider text-ink-55">
				{label}
			</div>
		</div>
	);
}

function HistoryDelta({
	label,
	from,
	to,
}: {
	label: string;
	from: string;
	to: string;
}) {
	return (
		<div className="flex items-baseline gap-2 font-mono tabular-nums">
			<span className="text-xxs uppercase tracking-wider text-ink-55">
				{label}
			</span>
			<span className="text-ink-70">{from}</span>
			<span className="text-ink-40">→</span>
			<span className="text-ink-85">{to}</span>
		</div>
	);
}

function EdgeStatCell({
	label,
	value,
	tone = "default",
}: {
	label: string;
	value: string | number;
	tone?: "default" | "brand";
}) {
	return (
		<div className="min-w-0">
			<div className="font-mono text-xxs uppercase tracking-wider text-ink-55">
				{label}
			</div>
			<div
				className={`mt-0.5 font-mono text-base font-semibold tabular-nums ${
					tone === "brand" ? "text-brand-blue" : "text-ink-95"
				}`}
			>
				{value}
			</div>
		</div>
	);
}

function EdgeShareRow({
	label,
	current,
	sevenDay,
	sevenDayLoading,
	target,
}: {
	label: string;
	current: number | null | undefined;
	sevenDay: number | null | undefined;
	sevenDayLoading: boolean;
	target: { min: number; max: number };
}) {
	const currentTone =
		typeof current === "number"
			? getTargetToneClass(current, target)
			: "text-ink-40";
	const sevenDayTone =
		typeof sevenDay === "number"
			? getTargetToneClass(sevenDay, target)
			: "text-ink-40";
	return (
		<div className="min-w-0">
			<div className="flex items-baseline justify-between gap-2">
				<span className="font-mono text-xxs uppercase tracking-wider text-ink-55">
					{label}
				</span>
				<span className="font-mono text-xxs tabular-nums text-ink-40">
					{formatPercent(target.min)}–{formatPercent(target.max)}
				</span>
			</div>
			<div className="mt-1 flex items-baseline justify-between gap-2 font-mono tabular-nums">
				<span className="flex items-baseline gap-1.5">
					<span className="text-xxs uppercase tracking-wider text-ink-40">
						now
					</span>
					<span className={`text-sm font-semibold ${currentTone}`}>
						{typeof current === "number" ? formatPercent(current) : "—"}
					</span>
				</span>
				<span className="flex items-baseline gap-1.5">
					<span className="text-xxs uppercase tracking-wider text-ink-40">
						7d
					</span>
					<span className={`text-sm font-semibold ${sevenDayTone}`}>
						{sevenDayLoading ? (
							<Loader2 className="inline h-3 w-3 animate-spin text-ink-55" />
						) : typeof sevenDay === "number" ? (
							formatPercent(sevenDay)
						) : (
							"—"
						)}
					</span>
				</span>
			</div>
		</div>
	);
}

function UnifiedEdgeBar({
	sideA,
	sideB,
	sharpSide,
	sideAOdds,
	sideBOdds,
}: {
	sideA: SharpMoneyCacheEntry["sideA"];
	sideB: SharpMoneyCacheEntry["sideB"];
	sharpSide: "A" | "B" | "EVEN";
	sideAOdds?: string | null;
	sideBOdds?: string | null;
}) {
	const totalValue = sideA.totalValue + sideB.totalValue;
	const sideAMoneyPercent =
		totalValue > 0 ? (sideA.totalValue / totalValue) * 100 : 50;
	const sideBMoneyPercent = 100 - sideAMoneyPercent;
	const isSharpA = sharpSide === "A";
	const sharpPct = isSharpA ? sideAMoneyPercent : sideBMoneyPercent;

	if (sharpSide === "EVEN") {
		return (
			<div className="space-y-1.5">
				<div className="flex items-center justify-between text-sm">
					<div className="flex items-baseline gap-1.5">
						<span className="font-sans font-medium text-ink-55">
							{sideA.label}
						</span>
						<span className="font-mono text-xxs tabular-nums text-ink-55">
							{Math.round(sideA.sharpScore)}
						</span>
					</div>
					<div className="flex items-baseline gap-1.5">
						<span className="font-mono text-xxs tabular-nums text-ink-55">
							{Math.round(sideB.sharpScore)}
						</span>
						<span className="font-sans font-medium text-ink-55">
							{sideB.label}
						</span>
					</div>
				</div>
				<div className="relative h-7 overflow-hidden rounded-md bg-ink-10 ring-1 ring-inset ring-ink-15">
					<div className="absolute inset-0 flex items-center justify-center font-mono text-xxs uppercase tracking-wider text-ink-55">
						no clear edge · split
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-1.5">
			<div className="flex items-center justify-between gap-2 text-sm">
				<div className="flex min-w-0 items-center gap-1.5">
					<span
						className={`font-sans font-semibold ${isSharpA ? "text-ink-95" : "text-ink-55"}`}
					>
						{sideA.label}
					</span>
					<span
						className={`font-mono text-xxs tabular-nums ${isSharpA ? "text-ink-70" : "text-ink-55"}`}
					>
						{Math.round(sideA.sharpScore)}
					</span>
					{sideAOdds && (
						<span
							className={`rounded px-1 py-0.5 font-mono text-xs tabular-nums ${isSharpA ? "bg-ink-15 text-ink-95" : "bg-ink-10 text-ink-55"}`}
						>
							{sideAOdds}
						</span>
					)}
				</div>
				<div className="flex min-w-0 items-center gap-1.5">
					{sideBOdds && (
						<span
							className={`rounded px-1 py-0.5 font-mono text-xs tabular-nums ${!isSharpA ? "bg-ink-15 text-ink-95" : "bg-ink-10 text-ink-55"}`}
						>
							{sideBOdds}
						</span>
					)}
					<span
						className={`font-mono text-xxs tabular-nums ${!isSharpA ? "text-ink-70" : "text-ink-55"}`}
					>
						{Math.round(sideB.sharpScore)}
					</span>
					<span
						className={`font-sans font-semibold ${!isSharpA ? "text-ink-95" : "text-ink-55"}`}
					>
						{sideB.label}
					</span>
				</div>
			</div>

			<div className="relative flex h-7 overflow-hidden rounded-md bg-ink-10 ring-1 ring-inset ring-ink-15">
				<div
					className={`flex h-full min-w-[60px] items-center justify-center ${
						isSharpA ? "bg-brand-blue/85 text-ink-00" : "bg-ink-15 text-ink-70"
					}`}
					style={{ width: `${Math.max(sideAMoneyPercent, 15)}%` }}
				>
					<span className="font-mono text-xs font-semibold tabular-nums">
						{formatUsdCompact(sideA.totalValue)}
					</span>
				</div>
				<div className="w-px bg-ink-00" />
				<div
					className={`flex h-full min-w-[60px] items-center justify-center ${
						!isSharpA ? "bg-brand-blue/85 text-ink-00" : "bg-ink-15 text-ink-70"
					}`}
					style={{ width: `${Math.max(sideBMoneyPercent, 15)}%` }}
				>
					<span className="font-mono text-xs font-semibold tabular-nums">
						{formatUsdCompact(sideB.totalValue)}
					</span>
				</div>
			</div>

			<div className="flex items-center justify-center gap-2 font-mono text-xxs uppercase tracking-wider">
				<span className="text-ink-55">conviction</span>
				<span
					className={`tabular-nums ${
						sharpPct >= 40 && sharpPct <= 60
							? "text-signal-pos"
							: sharpPct >= 30 && sharpPct <= 70
								? "text-signal-warn"
								: "text-ink-70"
					}`}
				>
					{Math.round(sharpPct)}%
				</span>
			</div>
		</div>
	);
}

function SideDetails({
	side,
	isSharp,
}: {
	side: SharpMoneyCacheEntry["sideA"] | SharpMoneyCacheEntry["sideB"];
	isSharp: boolean;
}) {
	return (
		<div
			className={`@container rounded-md p-3 ring-1 ring-inset @[480px]:p-4 ${
				isSharp
					? "bg-brand-blue/10 ring-brand-blue/30"
					: "bg-ink-05 ring-ink-15"
			}`}
		>
			<div className="mb-3 flex items-center justify-between gap-2">
				<div className="flex min-w-0 items-center gap-2">
					<h4
						className={`truncate font-sans font-semibold ${isSharp ? "text-ink-95" : "text-ink-85"}`}
					>
						{side.label}
					</h4>
					{isSharp && (
						<span className="flex items-center gap-1 font-mono text-xxs font-medium uppercase tracking-wider text-brand-cyan">
							<Zap className="h-3 w-3" /> sharp
						</span>
					)}
				</div>
				<span
					className={`font-mono text-lg font-semibold tabular-nums ${isSharp ? "text-ink-95" : "text-ink-70"}`}
				>
					{Math.round(side.sharpScore)}
				</span>
			</div>

			<div className="mb-3 flex items-baseline gap-2 font-mono tabular-nums">
				<span className="text-xxs uppercase tracking-wider text-ink-55">
					holder value
				</span>
				<span className="font-semibold text-ink-85">
					{formatUsdCompact(side.totalValue)}
				</span>
			</div>

			<div>
				<h5 className="mb-2 font-mono text-xxs uppercase tracking-wider text-ink-55">
					top holders
				</h5>
				<div className="mb-1 grid grid-cols-[18px_20px_minmax(0,1fr)_46px_36px_36px_46px] items-center gap-1 font-mono text-xxs uppercase tracking-wider text-ink-55 @[340px]:grid-cols-[20px_24px_minmax(0,1fr)_58px_42px_42px_58px]">
					<span />
					<span />
					<span>holder</span>
					<span className="text-right">pnl $</span>
					<span className="text-right">pnl u</span>
					<span className="text-right">stk u</span>
					<span className="text-right">stk $</span>
				</div>
				<ul className="space-y-1">
					{side.topHolders.map((holder, idx) => (
						<li
							key={holder.proxyWallet}
							className="grid grid-cols-[18px_20px_minmax(0,1fr)_46px_36px_36px_46px] items-center gap-1 text-xs @[340px]:grid-cols-[20px_24px_minmax(0,1fr)_58px_42px_42px_58px]"
						>
							<span className="pr-1 text-right font-mono tabular-nums text-ink-55">
								{idx + 1}.
							</span>
							{holder.profileImage ? (
								<img
									src={holder.profileImage}
									alt=""
									loading="lazy"
									width={20}
									height={20}
									className="h-4 w-4 rounded-full object-cover @[340px]:h-5 @[340px]:w-5"
								/>
							) : (
								<div className="flex h-4 w-4 items-center justify-center rounded-full bg-ink-15 @[340px]:h-5 @[340px]:w-5">
									<User className="h-2.5 w-2.5 text-ink-55 @[340px]:h-3 @[340px]:w-3" />
								</div>
							)}
							<a
								href={buildPolymarketProfileUrl(holder.proxyWallet)}
								target="_blank"
								rel="noopener noreferrer"
								className="truncate text-ink-70 transition-colors hover:text-brand-blue"
								onClick={(e) => e.stopPropagation()}
							>
								{truncateWalletName(holder.name || holder.pseudonym) ||
									`${holder.proxyWallet.slice(0, 6)}…${holder.proxyWallet.slice(-4)}`}
							</a>
							<div className="flex justify-end">
								{holder.pnlAll === null || holder.pnlAll === undefined ? (
									<span className="font-mono text-xxs text-ink-40">—</span>
								) : (
									<PnlBadge pnlAll={holder.pnlAll} />
								)}
							</div>
							<div className="flex justify-end">
								{holder.pnlAllUnits === null ||
								holder.pnlAllUnits === undefined ? (
									<span className="font-mono text-xxs text-ink-40">—</span>
								) : (
									<UnitBadge
										pnlUnits={holder.pnlAllUnits}
										unitSize={holder.unitSize}
									/>
								)}
							</div>
							<div className="flex justify-end">
								{holder.unitSize === null ||
								holder.unitSize === undefined ||
								holder.unitSize <= 0 ? (
									<span className="font-mono text-xxs text-ink-40">—</span>
								) : (
									<StakeUnitBadge
										stakeUsd={holder.amount}
										unitSize={holder.unitSize}
									/>
								)}
							</div>
							<span className="text-right font-mono text-xxs tabular-nums text-ink-70">
								{formatUsdCompact(holder.amount)}
							</span>
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}

function PnlBadge({ pnlAll }: { pnlAll?: number | null }) {
	if (pnlAll === null || pnlAll === undefined) {
		return null;
	}
	const isPositive = pnlAll >= 0;
	return (
		<span
			className={`inline-flex rounded px-1 py-0.5 font-mono text-xxs font-medium tabular-nums ${
				isPositive
					? "bg-signal-pos/10 text-signal-pos"
					: "bg-signal-bad/15 text-signal-bad"
			}`}
		>
			{formatUsdCompact(Math.abs(pnlAll))}
		</span>
	);
}

function UnitBadge({
	pnlUnits,
	unitSize,
}: {
	pnlUnits?: number | null;
	unitSize?: number | null;
}) {
	const formatted = formatUnits(
		pnlUnits === null || pnlUnits === undefined ? null : Math.abs(pnlUnits),
	);
	if (!formatted) {
		return null;
	}
	const isPositive = (pnlUnits ?? 0) >= 0;
	const title =
		unitSize && Number.isFinite(unitSize)
			? `${formatted}u • unit size ${formatUsdCompact(unitSize)}`
			: `${formatted}u`;
	return (
		<span
			title={title}
			className={`inline-flex rounded px-1 py-0.5 font-mono text-xxs font-medium tabular-nums ${
				isPositive
					? "bg-signal-pos/10 text-signal-pos"
					: "bg-signal-bad/10 text-signal-bad"
			}`}
		>
			{formatted}u
		</span>
	);
}

function StakeUnitBadge({
	stakeUsd,
	unitSize,
}: {
	stakeUsd: number;
	unitSize?: number | null;
}) {
	if (!unitSize || unitSize <= 0) {
		return null;
	}
	const stakeUnits = stakeUsd / unitSize;
	if (!Number.isFinite(stakeUnits)) {
		return null;
	}
	const formatted = formatUnits(Math.abs(stakeUnits));
	if (!formatted) {
		return null;
	}
	const title = `${formatted}x typical stake • unit size ${formatUsdCompact(unitSize)}`;
	const tone =
		stakeUnits < 0.5
			? "bg-ink-10 text-ink-55"
			: stakeUnits <= 2
				? "bg-signal-warn/10 text-signal-warn"
				: "bg-signal-pos/10 text-signal-pos";
	return (
		<span
			title={title}
			className={`inline-flex rounded px-1 py-0.5 font-mono text-xxs font-medium tabular-nums ${tone}`}
		>
			{formatted}x
		</span>
	);
}
