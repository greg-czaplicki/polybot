import { Outlet, createFileRoute, useMatchRoute } from "@tanstack/react-router";
import {
	CheckCircle2,
	ChevronDown,
	ChevronUp,
	ExternalLink,
	Eye,
	EyeOff,
	Loader2,
	RefreshCw,
	Target,
	Trash2,
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
import {
	clearSharpMoneyCacheFn,
	fetchTrendingSportsMarketsFn,
	getSharpMoneyCacheFn,
	getSharpMoneyCacheStatsFn,
	getSharpMoneyEdgeStatsHistoryFn,
	getSharpMoneyGradeMixFn,
	getSharpMoneyGradesFn,
	getRuntimeMarketStatsFn,
	getSharpMoneyHistoryFn,
	refreshMarketSharpnessFn,
	type SharpMoneyCacheEntry,
	type SharpMoneyHistoryEntry,
	type SharpMoneyGradeMix,
	type TopHolderPnlData,
} from "../server/api/sharp-money";
import { getBotCandidatesFn } from "../server/api/bot";

export const Route = createFileRoute("/sharp")({
	component: SharpMoneyPage,
});

// Sport filter options
const SPORT_FILTERS = [
	{ value: "all", label: "All Sports" },
	{ value: "10187", label: "NFL" },
	{ value: "10345", label: "NBA" },
	{ value: "10210", label: "College Football" },
	{ value: "10470", label: "College Basketball" },
	{ value: "3", label: "MLB" },
	{ value: "10346", label: "NHL" },
	{ value: "10188", label: "Premier League" },
];

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

const VOLUME_COLOR_ANCHORS = {
	low: 15_000,
	mid: 650_000,
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
		entry.marketVolume ??
		entry.marketLiquidity ??
		getEntryHolderVolume(entry)
	);
}

function getVolumePercentLogScaled(
	volume: number,
	maxVolume: number,
): number {
	if (!Number.isFinite(volume) || volume <= 0) return 0;
	if (!Number.isFinite(maxVolume) || maxVolume <= 0) return 0;
	const safeVolume = Math.max(0, volume);
	const safeMax = Math.max(1, maxVolume);
	const numerator = Math.log10(safeVolume + 1);
	const denominator = Math.log10(safeMax + 1);
	if (denominator <= 0) return 0;
	return Math.min((numerator / denominator) * 100, 100);
}

function getVolumeColorPercent(
	volume: number,
	maxVolume: number,
): number {
	if (!Number.isFinite(volume) || volume <= 0) return 0;
	const low = VOLUME_COLOR_ANCHORS.low;
	const mid = VOLUME_COLOR_ANCHORS.mid;
	if (volume <= low) {
		const base = Math.log10(volume + 1) / Math.log10(low + 1);
		return Math.min(base * 75, 75);
	}
	if (volume <= mid) {
		const base = Math.log10(volume / low) / Math.log10(mid / low);
		return 75 + Math.min(Math.max(base, 0), 1) * 15;
	}
	const safeMax = Math.max(mid, maxVolume);
	if (safeMax === mid) return 90;
	const base = Math.log10(volume / mid) / Math.log10(safeMax / mid);
	return Math.min(90 + Math.min(Math.max(base, 0), 1) * 10, 100);
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
	if (tone === "ok") return "text-emerald-300";
	if (tone === "low") return "text-amber-300";
	return "text-rose-300";
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
		const score = signalScoreByConditionId[entry.conditionId] ?? entry.edgeRating;
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
const BOT_SYNC_WINDOW_MINUTES = 60;
const BOT_SYNC_MIN_GRADE = "A";
const BOT_SYNC_MARKET_QUALITY_THRESHOLD = 0.72;
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

function getMarketTypeLabel(marketTitle: string): string {
	const lower = marketTitle.toLowerCase();
	if (
		lower.includes("o/u") ||
		lower.includes("over/under") ||
		lower.includes("total")
	) {
		return "total";
	}
	if (lower.includes("spread")) return "spread";
	if (lower.includes("moneyline") || lower.includes("ml")) return "moneyline";
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
};

function formatBotInspectMessage(result: BotInspectResult | null): string {
	if (!result) return "No bot debug data";
	if (result.stage === "not_found_in_entries") {
		return "Not in bot cache input";
	}
	if (result.stage === "filtered_pre") {
		return `Excluded pre-filter: ${result.reason ?? "unknown"}`;
	}
	if (result.stage === "filtered_grade") {
		return `Excluded grade-filter: ${result.reason ?? "unknown"}`;
	}
	if (result.stage === "dedup_lost") {
		return `Dedup dropped: ${result.reason ?? "unknown"}`;
	}
	if (result.stage === "dedup_seed" || result.wonDedup) {
		return "Bot-eligible (won dedup)";
	}
	if (result.stage === "entries" || result.foundInEntries) {
		return "In bot candidate pool";
	}
	return `Bot stage: ${result.stage ?? "unknown"}`;
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
	const [selectedSeriesId, setSelectedSeriesId] = useState("all");
	const [expandedMarkets, setExpandedMarkets] = useState<Set<string>>(
		new Set(),
	);
	const [showAllEntries, setShowAllEntries] = useState(false);
	const [showEdgeStats, setShowEdgeStats] = useState(true);
	const [showAPlusOnly, setShowAPlusOnly] = useState(false);
	const [botAlignedConditionOrder, setBotAlignedConditionOrder] = useState<string[]>(
		[],
	);
	const [botAlignedError, setBotAlignedError] = useState<string | null>(null);
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
	const [gradeStatus, setGradeStatus] = useState<{
		updatedAt?: number;
		total?: number;
		withWarnings?: number;
		warningCounts?: Record<string, number>;
	}>({});
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
	const loadCache = useCallback(
		async (options?: { silent?: boolean }) => {
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
								selectedSeriesId === "all"
									? undefined
									: Number(selectedSeriesId),
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
		},
		[selectedSeriesId],
	);

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

	// Initial load
	useEffect(() => {
		loadCache();
	}, [loadCache]);

	useEffect(() => {
		loadPipelineStatus();
	}, [loadPipelineStatus]);

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
	}, [selectedSeriesId, showAllEntries, showAPlusOnly]);

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

	// Clear cache handler
	const handleClearCache = async () => {
		if (!confirm("Reset all stored sharp data?")) return;
		try {
			await clearSharpMoneyCacheFn({ data: {} });
			setEntries([]);
			setCacheStats(null);
			await handleRefresh();
		} catch (error) {
			console.error("Failed to clear cache:", error);
		}
	};

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
	}, [baseEntries, signalHistoryByConditionId, historyByConditionId, gradesByConditionId]);

	useEffect(() => {
		if (showAllEntries) {
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
					minGrade: BOT_SYNC_MIN_GRADE,
					windowMinutes: BOT_SYNC_WINDOW_MINUTES,
					requireReady: true,
					includeStarted: false,
					requireMicrostructure: true,
					marketQualityThreshold: BOT_SYNC_MARKET_QUALITY_THRESHOLD,
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
			setBotAlignedError(error instanceof Error ? error.message : "bot_candidates_failed");
			setBotAlignedConditionOrder([]);
		});
		return () => {
			cancelled = true;
		};
	}, [showAllEntries, baseEntries]);

	const filteredEntries = useMemo(() => {
		const now = new Date();
		const cutoff = new Date(
			now.getTime() + UPCOMING_WINDOW_HOURS * 60 * 60 * 1000,
		);
		const botSyncCutoff = new Date(
			now.getTime() + BOT_SYNC_WINDOW_MINUTES * 60 * 1000,
		);
		const startBufferMs = START_TIME_BUFFER_MINUTES * 60 * 1000;
		let filtered = baseEntries.filter((e) => {
			if (e.sharpSide === "EVEN") return false;
			if (!showAllEntries && getMarketTypeLabel(e.marketTitle) === "other") {
				return false;
			}
			// Hide games that have already started (with buffer)
			const gameTime = parseEventTime(e.eventTime);
			if (gameTime) {
				if (gameTime.getTime() < now.getTime() - startBufferMs) return false;
				if (gameTime > cutoff) return false;
				if (!showAllEntries && gameTime > botSyncCutoff) return false;
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
			if (!showAllEntries) {
				const signalScore =
					signalScoreByConditionId[e.conditionId] ?? e.edgeRating;
				const signalGrade =
					gradesByConditionId[e.conditionId]?.grade ??
					signalScoreToGradeLabel(signalScore, {
						edgeRating: e.edgeRating,
						scoreDifferential: e.scoreDifferential,
					});
				if (gradeWeight(signalGrade) < gradeWeight(BOT_SYNC_MIN_GRADE)) {
					return false;
				}
				if (showAPlusOnly && signalGrade !== "A+") return false;
			}
			const gradeWarnings = gradesByConditionId[e.conditionId]?.warnings ?? [];
			if (gradeWarnings.includes("no_price_edge")) return false;
			return true;
		});
		if (selectedSeriesId !== "all") {
			filtered = filtered.filter(
				(e) => e.sportSeriesId === Number(selectedSeriesId),
			);
		}
		if (!showAllEntries) {
			const rankByConditionId = new Map<string, number>();
			for (const [index, conditionId] of botAlignedConditionOrder.entries()) {
				rankByConditionId.set(conditionId, index);
			}
			filtered = filtered
				.filter((entry) => rankByConditionId.has(entry.conditionId))
				.sort(
					(a, b) =>
						(rankByConditionId.get(a.conditionId) ?? Number.MAX_SAFE_INTEGER) -
						(rankByConditionId.get(b.conditionId) ?? Number.MAX_SAFE_INTEGER),
				);
			return filtered;
		}
		const deduped = new Map<string, SharpMoneyCacheEntry>();
		for (const entry of filtered) {
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
			if (entryWeight < existingWeight) {
				continue;
			}
			if (entryScore > existingScore) {
				deduped.set(key, entry);
				continue;
			}
			if (entryScore < existingScore) {
				continue;
			}
			if (entry.edgeRating > existing.edgeRating) {
				deduped.set(key, entry);
				continue;
			}
			if (entry.edgeRating < existing.edgeRating) {
				continue;
			}
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
	}, [
		baseEntries,
		selectedSeriesId,
		showAllEntries,
		showAPlusOnly,
		botAlignedConditionOrder,
		signalScoreByConditionId,
		gradesByConditionId,
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
	}, [baseEntries, showRefreshDebug, signalScoreByConditionId, gradesByConditionId]);

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
		const average =
			values.reduce((sum, value) => sum + value, 0) / total;
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
			let warningsCount = 0;
			const warningCounts: Record<string, number> = {};
			for (const gradeResult of result.results ?? []) {
				if (gradeResult.error || !gradeResult.grade) continue;
				next[gradeResult.conditionId] = {
					grade: gradeResult.grade,
					signalScore: gradeResult.signalScore ?? 0,
					warnings: gradeResult.warnings ?? [],
					historyUpdatedAt: gradeResult.historyUpdatedAt,
				};
				if ((gradeResult.warnings ?? []).length > 0) {
					warningsCount += 1;
					for (const warning of gradeResult.warnings ?? []) {
						warningCounts[warning] = (warningCounts[warning] ?? 0) + 1;
					}
				}
			}
			setGradesByConditionId(next);
			setGradeStatus({
				updatedAt: Date.now(),
				total: Object.keys(next).length,
				withWarnings: warningsCount,
				warningCounts,
			});
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
			if ((stats.paginationCapHits ?? []).length > 0) {
				setHealthStatus({ label: "Warn", detail: "pagination cap" });
				return;
			}
			if ((stats.retryCount ?? 0) > 0) {
				setHealthStatus({ label: "Warn", detail: "retries" });
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
				detail: `${Math.round(staleRatio * 100)}% stale`,
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
	}, [
		refreshSignalHistory,
		refreshGrades,
		ensureHealthStats,
		refreshHealth,
	]);

	useEffect(() => {
		const interval = setInterval(() => {
			void refreshSignalHistory();
			void refreshGrades();
			void refreshHealth();
		}, 60_000);
		return () => clearInterval(interval);
	}, [refreshSignalHistory, refreshGrades, refreshHealth]);

	const sortedEntries = useMemo(() => {
		const entriesToSort = [...filteredEntries];
		entriesToSort.sort((a, b) => {
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
		return entriesToSort;
	}, [filteredEntries, signalScoreByConditionId, gradesByConditionId]);

	const isSortingHold = !isInitialSortReady;
	const displayEntries = !isSortingHold ? sortedEntries : [];
	const showSortingState = !isLoading && isSortingHold;
	const showProcessingState =
		!isLoading &&
		!showSortingState &&
		displayEntries.length === 0 &&
		(pipelineStatus?.inProgress ||
			(entries.length > 0 && readyEntries.length === 0));

	// Calculate max volume for scale
	const maxVolume = useMemo(() => {
		if (displayEntries.length === 0) return 1;
		return Math.max(
			...displayEntries.map((e) => getEntryMarketVolume(e)),
			1,
		);
	}, [displayEntries]);
	const pullReady = pullDistance >= PULL_THRESHOLD;
	const pullIndicatorOffset = Math.min(pullDistance, PULL_MAX);
	const showPullIndicator = pullIndicatorOffset > 0 || isRefreshing;

	if (marketDepthMatch) {
		return <Outlet />;
	}

	return (
		<AuthGate>
			<div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
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
						<div className="flex items-center gap-2 rounded-full border border-slate-700/70 bg-slate-950/90 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-slate-200 shadow">
							<RefreshCw
								className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : pullReady ? "rotate-180 transition-transform" : ""}`}
							/>
							<span>
								{isRefreshing
									? "Refreshing..."
									: pullReady
										? "Release to reload"
										: "Pull to reload"}
							</span>
						</div>
					</div>
				)}
				{/* Header */}
				<header
					className="sticky top-0 z-50 w-full border-b border-slate-800/50 bg-slate-950/80 backdrop-blur-sm"
					style={{
						paddingTop: "max(1rem, env(safe-area-inset-top, 0px) + 1rem)",
					}}
				>
					<div className="mx-auto max-w-7xl px-4 py-4">
						<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
							<div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
								<div className="flex flex-col gap-1 min-w-0">
									<div className="flex items-center gap-3 min-w-0">
										<img
											src="/logo-trans.png"
											alt="Polywhaler"
											className="h-10 w-auto flex-shrink-0 sm:h-18"
										/>
										<h1 className="text-2xl sm:text-4xl font-bold text-white uppercase tracking-wider whitespace-normal sm:whitespace-nowrap leading-tight">
											Poly<span className="text-cyan-400">whaler</span>
										</h1>
										<span
											className={`rounded-full px-2 py-0.5 text-[0.55rem] font-semibold uppercase tracking-[0.2em] ${
												healthStatus.label === "Good"
													? "bg-emerald-500/15 text-emerald-200"
													: healthStatus.label === "Warn"
														? "bg-amber-500/15 text-amber-200"
														: "bg-slate-800/60 text-slate-300"
											}`}
											title={healthStatus.detail ?? ""}
										>
											{healthStatus.label}
										</span>
									</div>
									<div className="hidden text-[0.55rem] text-gray-500">
										Updated{" "}
										{cacheStats?.newestEntry
											? formatRelativeTime(cacheStats.newestEntry)
											: "—"}
									</div>
								</div>
							</div>
							<div className="flex w-full items-center justify-between gap-1.5 sm:w-auto sm:justify-end sm:gap-2 flex-shrink-0">
								<div className="sm:hidden text-[0.6rem] text-gray-500">
									Updated{" "}
									{cacheStats?.newestEntry
										? formatRelativeTime(cacheStats.newestEntry)
										: "—"}
								</div>
								<div className="hidden sm:flex items-center text-xs text-gray-500">
									Updated{" "}
									{cacheStats?.newestEntry
										? formatRelativeTime(cacheStats.newestEntry)
										: "—"}
								</div>
								<button
									type="button"
									onClick={handleClearCache}
									className="flex items-center gap-1 sm:gap-2 rounded-lg bg-red-500/10 px-2 py-2 sm:px-3 text-sm font-medium text-red-400 hover:bg-red-500/20 transition-colors"
									title="Reset stored data"
								>
									<Trash2 className="h-4 w-4" />
									<span className="hidden sm:inline">Reset Data</span>
								</button>
								<a
									href="/stats"
									className="flex items-center gap-1 sm:gap-2 rounded-lg border border-slate-700/60 bg-slate-900/60 px-2 py-2 sm:px-3 text-sm font-medium text-slate-200 hover:bg-slate-800/60 transition-colors"
								>
									<span className="hidden sm:inline">Stats</span>
									<span className="sm:hidden">Stats</span>
								</a>
							</div>
						</div>
					</div>
				</header>

				{/* Main Content */}
				<main className="mx-auto max-w-7xl px-4 py-6">
					{isLoading && entries.length === 0 && (
						<div className="mb-6 flex items-center justify-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-6 text-sm text-slate-200">
							<Loader2 className="h-4 w-4 animate-spin text-cyan-300" />
							Loading sharp data...
						</div>
					)}
					{showSortingState && (
						<div className="mb-6 flex items-center justify-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-6 text-sm text-slate-200">
							<Loader2 className="h-4 w-4 animate-spin text-cyan-300" />
							Preparing rankings...
						</div>
					)}
					{/* Sport Filter */}
					<div className="mb-6">
						<div className="sm:hidden">
							<label
								htmlFor="sharp-sport-filter"
								className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500"
							>
								Sport filter
							</label>
							<select
								id="sharp-sport-filter"
								value={selectedSeriesId}
								onChange={(event) => setSelectedSeriesId(event.target.value)}
								className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
							>
								{SPORT_FILTERS.map((filter) => (
									<option key={filter.value} value={filter.value}>
										{filter.label}
									</option>
								))}
							</select>
							<button
								type="button"
								onClick={() => setShowAPlusOnly((prev) => !prev)}
								className={`mt-3 w-full rounded-lg px-3 py-2 text-sm font-semibold uppercase tracking-wide transition-colors ${
									showAPlusOnly
										? "bg-emerald-500 text-white"
										: "bg-slate-800/60 text-slate-200 hover:bg-slate-800"
								}`}
							>
								A+ only {showAPlusOnly ? "on" : "off"}
							</button>
						</div>
					<div className="hidden flex-wrap gap-2 sm:flex">
						{SPORT_FILTERS.map((filter) => (
							<button
								type="button"
								key={filter.value}
								onClick={() => setSelectedSeriesId(filter.value)}
								className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
									selectedSeriesId === filter.value
										? "bg-cyan-500 text-white"
										: "bg-slate-800/50 text-gray-400 hover:bg-slate-800 hover:text-white"
								}`}
							>
								{filter.label}
							</button>
						))}
						<button
							type="button"
							onClick={() => setShowAPlusOnly((prev) => !prev)}
							className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
								showAPlusOnly
									? "bg-emerald-500 text-white"
									: "bg-slate-800/50 text-gray-400 hover:bg-slate-800 hover:text-white"
							}`}
						>
							A+ only
						</button>
					</div>
					</div>

					{!showAllEntries && botAlignedError && (
						<div className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
							Bot-aligned candidate sync failed: {botAlignedError}
						</div>
					)}

					{showEdgeStats && edgeStats && (
						<div className="mb-6 rounded-xl border border-slate-800/70 bg-slate-900/40 px-4 py-3">
							<div className="mb-2 flex flex-wrap items-center justify-between gap-2">
								<div className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
									Edge Stats
								</div>
								<div className="text-[0.65rem] text-slate-500">
									{showAllEntries
										? "All ready markets"
										: `Bot-aligned (${BOT_SYNC_MIN_GRADE}, ${BOT_SYNC_WINDOW_MINUTES}m)`}
								</div>
							</div>
							<div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-6">
								<div className="rounded-lg border border-slate-800/70 bg-slate-950/40 px-3 py-2">
									<div className="text-[0.65rem] uppercase text-slate-500">
										Markets
									</div>
									<div className="text-base font-semibold text-slate-100">
										{edgeStats.total}
									</div>
								</div>
								<div className="rounded-lg border border-slate-800/70 bg-slate-950/40 px-3 py-2">
									<div className="text-[0.65rem] uppercase text-slate-500">
										≥ {MIN_EDGE_RATING}
									</div>
									<div className="text-base font-semibold text-cyan-300">
										{edgeStats.passing}
									</div>
								</div>
								<div className="rounded-lg border border-slate-800/70 bg-slate-950/40 px-3 py-2">
									<div className="text-[0.65rem] uppercase text-slate-500">
										Avg
									</div>
									<div className="text-base font-semibold text-slate-100">
										{edgeStats.average}
									</div>
								</div>
								<div className="rounded-lg border border-slate-800/70 bg-slate-950/40 px-3 py-2">
									<div className="text-[0.65rem] uppercase text-slate-500">
										P50
									</div>
									<div className="text-base font-semibold text-slate-100">
										{edgeStats.p50}
									</div>
								</div>
								<div className="rounded-lg border border-slate-800/70 bg-slate-950/40 px-3 py-2">
									<div className="text-[0.65rem] uppercase text-slate-500">
										P75
									</div>
									<div className="text-base font-semibold text-slate-100">
										{edgeStats.p75}
									</div>
								</div>
								<div className="rounded-lg border border-slate-800/70 bg-slate-950/40 px-3 py-2">
									<div className="text-[0.65rem] uppercase text-slate-500">
										P90/Max
									</div>
									<div className="text-base font-semibold text-slate-100">
										{edgeStats.p90}/{edgeStats.max}
									</div>
								</div>
							</div>
							<div className="mt-3 grid gap-2 text-[0.65rem] sm:grid-cols-3">
								<div className="rounded-lg border border-slate-800/70 bg-slate-950/40 px-3 py-2">
									<div className="uppercase text-slate-500">A+ share</div>
									<div className="mt-1 flex items-center justify-between text-[0.6rem] uppercase text-slate-500">
										<span>Current</span>
										<span>7d</span>
									</div>
									<div className="mt-1 flex items-center justify-between">
										<span
											className={`text-sm font-semibold ${
												edgeStatsCurrentMix
													? getTargetToneClass(
															edgeStatsCurrentMix.aPlusRate,
															EDGE_TARGETS.aPlus,
														)
													: "text-slate-500"
											}`}
										>
											{edgeStatsCurrentMix
												? formatPercent(edgeStatsCurrentMix.aPlusRate)
												: "—"}
										</span>
										<span
											className={`text-sm font-semibold ${
												edgeStatsGradeMix
													? getTargetToneClass(
															edgeStatsGradeMix.aPlusRate,
															EDGE_TARGETS.aPlus,
														)
													: "text-slate-500"
											}`}
										>
											{edgeStatsGradeMixLoading && !edgeStatsGradeMix ? (
												<Loader2 className="h-3 w-3 animate-spin text-slate-500" />
											) : edgeStatsGradeMix ? (
												formatPercent(edgeStatsGradeMix.aPlusRate)
											) : (
												"—"
											)}
										</span>
									</div>
									<div className="mt-1 text-[0.6rem] text-slate-500">
										Target {formatPercent(EDGE_TARGETS.aPlus.min)}–
										{formatPercent(EDGE_TARGETS.aPlus.max)}
									</div>
								</div>
								<div className="rounded-lg border border-slate-800/70 bg-slate-950/40 px-3 py-2">
									<div className="uppercase text-slate-500">A/A+ share</div>
									<div className="mt-1 flex items-center justify-between text-[0.6rem] uppercase text-slate-500">
										<span>Current</span>
										<span>7d</span>
									</div>
									<div className="mt-1 flex items-center justify-between">
										<span
											className={`text-sm font-semibold ${
												edgeStatsCurrentMix
													? getTargetToneClass(
															edgeStatsCurrentMix.aPlusOrARate,
															EDGE_TARGETS.aPlusOrA,
														)
													: "text-slate-500"
											}`}
										>
											{edgeStatsCurrentMix
												? formatPercent(edgeStatsCurrentMix.aPlusOrARate)
												: "—"}
										</span>
										<span
											className={`text-sm font-semibold ${
												edgeStatsGradeMix
													? getTargetToneClass(
															edgeStatsGradeMix.aPlusOrARate,
															EDGE_TARGETS.aPlusOrA,
														)
													: "text-slate-500"
											}`}
										>
											{edgeStatsGradeMixLoading && !edgeStatsGradeMix ? (
												<Loader2 className="h-3 w-3 animate-spin text-slate-500" />
											) : edgeStatsGradeMix ? (
												formatPercent(edgeStatsGradeMix.aPlusOrARate)
											) : (
												"—"
											)}
										</span>
									</div>
									<div className="mt-1 text-[0.6rem] text-slate-500">
										Target {formatPercent(EDGE_TARGETS.aPlusOrA.min)}–
										{formatPercent(EDGE_TARGETS.aPlusOrA.max)}
									</div>
								</div>
								<div className="rounded-lg border border-slate-800/70 bg-slate-950/40 px-3 py-2">
									<div className="uppercase text-slate-500">≥ {MIN_EDGE_RATING}</div>
									<div className="mt-1 flex items-center justify-between text-[0.6rem] uppercase text-slate-500">
										<span>Current</span>
										<span>7d</span>
									</div>
									<div className="mt-1 flex items-center justify-between">
										<span
											className={`text-sm font-semibold ${
												edgeStatsCurrentMix
													? getTargetToneClass(
															edgeStatsCurrentMix.passingRate,
															EDGE_TARGETS.minEdge,
														)
													: "text-slate-500"
											}`}
										>
											{edgeStatsCurrentMix
												? formatPercent(edgeStatsCurrentMix.passingRate)
												: "—"}
										</span>
										<span
											className={`text-sm font-semibold ${
												edgeStatsGradeMix
													? getTargetToneClass(
															edgeStatsGradeMix.passingRate,
															EDGE_TARGETS.minEdge,
														)
													: "text-slate-500"
											}`}
										>
											{edgeStatsGradeMixLoading && !edgeStatsGradeMix ? (
												<Loader2 className="h-3 w-3 animate-spin text-slate-500" />
											) : edgeStatsGradeMix ? (
												formatPercent(edgeStatsGradeMix.passingRate)
											) : (
												"—"
											)}
										</span>
									</div>
									<div className="mt-1 text-[0.6rem] text-slate-500">
										Target {formatPercent(EDGE_TARGETS.minEdge.min)}–
										{formatPercent(EDGE_TARGETS.minEdge.max)}
									</div>
								</div>
							</div>
							<div className="mt-4 border-t border-slate-800/60 pt-3">
								<div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[0.65rem] uppercase tracking-[0.2em] text-slate-500">
									<span>
										Edge Distribution (
										{edgeStatsWindowHours === 24
											? "24h"
											: `${Math.round(edgeStatsWindowHours / 24)}d`}
										)
									</span>
									<div className="flex items-center gap-2">
										<div className="flex items-center gap-1 rounded-full border border-slate-700/60 bg-slate-900 px-1 py-0.5">
											<button
												type="button"
												onClick={() => setEdgeStatsWindowHours(24)}
												className={`rounded-full px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wider ${
													edgeStatsWindowHours === 24
														? "bg-cyan-500 text-white"
														: "text-slate-400 hover:text-white"
												}`}
											>
												24h
											</button>
											<button
												type="button"
												onClick={() => setEdgeStatsWindowHours(24 * 7)}
												className={`rounded-full px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wider ${
													edgeStatsWindowHours === 24 * 7
														? "bg-cyan-500 text-white"
														: "text-slate-400 hover:text-white"
												}`}
											>
												7d
											</button>
										</div>
										{edgeStatsHistoryLoading && (
											<span className="flex items-center gap-2 text-[0.6rem] text-slate-500">
												<Loader2 className="h-3 w-3 animate-spin" />
												Loading
											</span>
										)}
									</div>
								</div>
								{edgeStatsHistory.length === 0 && !edgeStatsHistoryLoading ? (
									<div className="text-xs text-slate-500">
										No history snapshots yet.
									</div>
								) : (
									<div className="overflow-x-auto">
										<table className="w-full min-w-[520px] text-left text-xs text-slate-300">
											<thead className="text-[0.6rem] uppercase tracking-wider text-slate-500">
												<tr>
													<th className="py-2 pr-3">
														{isEdgeStatsDaily ? "Day" : "Hour"}
													</th>
													<th className="py-2 pr-3">Count</th>
													<th className="py-2 pr-3">Avg</th>
													<th className="py-2 pr-3">P50</th>
													<th className="py-2 pr-3">P75</th>
													<th className="py-2">P90</th>
												</tr>
											</thead>
											<tbody>
												{edgeStatsHistoryView.map((bucket) => (
													<tr
														key={bucket.start}
														className="border-t border-slate-800/60"
													>
														<td className="py-2 pr-3 text-slate-400">
															{isEdgeStatsDaily
																? formatDayLabel(bucket.start)
																: formatHourLabel(bucket.start)}
														</td>
														<td className="py-2 pr-3">{bucket.count}</td>
														<td className="py-2 pr-3">{bucket.average}</td>
														<td className="py-2 pr-3">{bucket.p50}</td>
														<td className="py-2 pr-3">{bucket.p75}</td>
														<td className="py-2">{bucket.p90}</td>
													</tr>
												))}
											</tbody>
										</table>
										{edgeStatsHistory.length > edgeStatsHistoryView.length && (
											<div className="mt-2 text-[0.65rem] text-slate-500">
												Showing last{" "}
												{edgeStatsHistoryView.length}{" "}
												{isEdgeStatsDaily ? "days" : "hours"} of{" "}
												{edgeStatsWindowHours === 24 ? "24h" : "7d"} history.
											</div>
										)}
									</div>
								)}
							</div>
						</div>
					)}
					{edgeStats && (
						<div className="mb-6 flex justify-end">
							<button
								type="button"
								onClick={() => setShowEdgeStats((prev) => !prev)}
								className="flex items-center gap-2 rounded-md border border-slate-700/60 px-3 py-1.5 text-[0.65rem] font-semibold uppercase tracking-wide text-slate-300 hover:bg-slate-800/60"
							>
								{showEdgeStats ? (
									<EyeOff className="h-3 w-3" />
								) : (
									<Eye className="h-3 w-3" />
								)}
								{showEdgeStats ? "Hide Edge Stats" : "Show Edge Stats"}
							</button>
						</div>
					)}

					{/* Loading State */}
					{isLoading && (
						<div className="flex items-center justify-center py-20">
							<Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
						</div>
					)}

					{pipelineStatus?.inProgress && !isLoading && (
						<div className="mb-4 flex items-center gap-2 rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">
							<Loader2 className="h-3 w-3 animate-spin text-cyan-200" />
							<span>
								Analyzing markets
								{pipelineStatus.totalQueued
									? ` (${pipelineStatus.processed ?? 0}/${pipelineStatus.totalQueued})`
									: ""}
								. This can take a few minutes on first run.
							</span>
						</div>
					)}
					{gradeStatus.updatedAt && (
						<div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 text-[0.65rem] text-slate-300">
							<span className="uppercase tracking-[0.2em] text-slate-400">
								Grades
							</span>
							<span>
								{gradeStatus.total ?? 0} loaded
							</span>
							{typeof gradeStatus.withWarnings === "number" && (
								<span>
									{gradeStatus.withWarnings} with warnings
								</span>
							)}
							{gradeStatus.warningCounts && (
								<span className="text-slate-400">
									{Object.entries(gradeStatus.warningCounts)
										.map(([key, value]) => `${key}:${value}`)
										.join(" ")}
								</span>
							)}
							<span>
								Updated {formatRelativeTime(Math.floor(gradeStatus.updatedAt / 1000))}
							</span>
						</div>
					)}
					{showRefreshDebug && (
						<div className="mb-4 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 text-[0.65rem] text-slate-300">
							<div>refreshDebug=1</div>
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
						<div className="mb-4 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 text-[0.7rem] text-slate-300">
							<div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
								Not Ready Diagnostics
							</div>
							{entries.filter((entry) => !isEntryReady(entry)).length === 0 ? (
								<div>All entries are ready.</div>
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
												<div className="text-slate-100">
													{entry.marketTitle}
												</div>
												<div className="text-slate-500">
													Not ready: {reasons.join(" • ")}
												</div>
											</div>
										);
									})
							)}
						</div>
					)}

					{/* Empty State */}
					{!showProcessingState &&
						!showSortingState &&
						!isLoading &&
						displayEntries.length === 0 && (
							<div className="flex flex-col items-center justify-center py-20 text-center">
								<Target className="h-12 w-12 text-gray-600 mb-4" />
								<h2 className="text-lg font-semibold text-white mb-2">
									No Sharp Money Data
								</h2>
								<p className="text-gray-400 mb-4 max-w-md">
									{entries.length > 0
										? "No bets with Signal Grade ≥ B. Lower quality signals are hidden."
										: "Click the Refresh button to analyze top sports markets and identify where the sharp money is flowing."}
								</p>
								{!pipelineStatus?.inProgress &&
									entries.length > 0 &&
									!showAllEntries && (
										<button
											type="button"
											onClick={() => setShowAllEntries(true)}
											className="mb-4 flex items-center gap-2 rounded-lg border border-slate-700/60 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800/60"
										>
											<Eye className="h-4 w-4" />
											Show all {entries.length} markets (including filtered)
										</button>
									)}
							</div>
						)}

					{showProcessingState && (
						<div className="flex flex-col items-center justify-center py-20 text-center">
							<Loader2 className="h-10 w-10 animate-spin text-cyan-400 mb-4" />
							<h2 className="text-lg font-semibold text-white mb-2">
								Warming Up Sharp Grades
							</h2>
							<p className="text-gray-400 mb-4 max-w-md">
								We are fetching top holders and PnL. This usually takes a few
								refresh cycles after a reset. Results will appear once all
								markets have full PnL coverage.
							</p>
							{entries.length > 0 && (
								<div className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
									Ready {readyEntries.length} / {entries.length}
								</div>
							)}
							{!pipelineStatus?.inProgress && (
								<button
									type="button"
									onClick={handleRefresh}
									disabled={isRefreshing}
									className="flex items-center gap-2 rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-600 disabled:opacity-50 transition-colors"
								>
									<RefreshCw
										className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
									/>
									Refresh Cache
								</button>
							)}
						</div>
					)}

					{/* Market Cards */}
					{!showProcessingState &&
						!showSortingState &&
						!isLoading &&
						displayEntries.length > 0 && (
							<div className="space-y-4">
								{/* Show count of hidden entries */}
								{(entries.length > displayEntries.length || showAllEntries) && (
									<div className="flex items-center justify-end gap-2 text-xs text-gray-500">
										<span>
											{displayEntries.length}/{entries.length} shown •{" "}
											{entries.length - displayEntries.length} filtered
										</span>
										<button
											type="button"
											onClick={() => setShowAllEntries((prev) => !prev)}
											className="flex items-center gap-1 rounded-md border border-slate-700/60 px-2 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-slate-300 hover:bg-slate-800/60"
											title={
												showAllEntries
													? "Hide filtered entries"
													: "Show filtered entries"
											}
										>
											{showAllEntries ? (
												<EyeOff className="h-3 w-3" />
											) : (
												<Eye className="h-3 w-3" />
											)}
											{showAllEntries ? "Filtered" : "Show All"}
										</button>
									</div>
								)}
								{displayEntries.map((entry) => (
									<SharpMoneyCard
										key={entry.id}
										entry={entry}
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
							</div>
						)}
				</main>
			</div>
		</AuthGate>
	);
}

function SharpMoneyCard({
	entry,
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
}: {
	entry: SharpMoneyCacheEntry;
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
}) {
	const [botInspectLoading, setBotInspectLoading] = useState(false);
	const [botInspectError, setBotInspectError] = useState<string | null>(null);
	const [botInspectResult, setBotInspectResult] = useState<BotInspectResult | null>(
		null,
	);
	const polymarketUrl = buildPolymarketUrl(entry.eventSlug, entry.marketSlug);
	const sideAOdds = formatAmericanOdds(entry.sideA.price);
	const sideBOdds = formatAmericanOdds(entry.sideB.price);
	// Determine which side is "sharp"
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

	// Calculate volume percentage and get heat map color
	const marketVolume = getEntryMarketVolume(entry);
	const volumePercent = getVolumePercentLogScaled(marketVolume, maxVolume);
	const volumeColorPercent = getVolumeColorPercent(marketVolume, maxVolume);
	const getVolumeColor = (percent: number) => {
		if (percent >= 80) return "bg-gradient-to-r from-red-500 to-orange-500"; // Hot - high volume
		if (percent >= 60) return "bg-gradient-to-r from-orange-500 to-amber-500"; // Warm - medium-high
		if (percent >= 40) return "bg-gradient-to-r from-amber-500 to-yellow-500"; // Medium
		if (percent >= 20) return "bg-gradient-to-r from-cyan-500 to-blue-500"; // Cool - medium-low
		return "bg-gradient-to-r from-blue-500 to-indigo-500"; // Cold - low volume
	};

	const getBetGrade = (
		grade: "A+" | "A" | "B" | "C" | "D",
	): { grade: string; color: string; bgColor: string; borderColor: string } => {
		switch (grade) {
			case "A+":
				return {
					grade: "A+",
					color: "text-emerald-400",
					bgColor: "bg-emerald-500/20",
					borderColor: "border-emerald-500/50",
				};
			case "A":
				return {
					grade: "A",
					color: "text-emerald-400",
					bgColor: "bg-emerald-500/15",
					borderColor: "border-emerald-500/40",
				};
			case "B":
				return {
					grade: "B",
					color: "text-cyan-400",
					bgColor: "bg-cyan-500/15",
					borderColor: "border-cyan-500/40",
				};
			case "C":
				return {
					grade: "C",
					color: "text-amber-400",
					bgColor: "bg-amber-500/15",
					borderColor: "border-amber-500/40",
				};
			default:
				return {
					grade: "D",
					color: "text-gray-400",
					bgColor: "bg-slate-800/50",
					borderColor: "border-slate-700",
				};
		}
	};

	const scoreForGrade = signalScore ?? entry.edgeRating;
	const betGradeLabel =
		gradeData?.grade ??
		signalScoreToGradeLabel(scoreForGrade, {
			edgeRating: entry.edgeRating,
			scoreDifferential: entry.scoreDifferential,
		});
	const betGrade = getBetGrade(betGradeLabel);
	const compositeScoreDisplay = (
		gradeWeight(betGradeLabel) + scoreForGrade
	).toFixed(1);
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

	const inspectBotDecision = useCallback(async () => {
		setBotInspectLoading(true);
		setBotInspectError(null);
		try {
			const response = await getBotCandidatesFn({
				data: {
					minGrade: BOT_SYNC_MIN_GRADE,
					windowMinutes: BOT_SYNC_WINDOW_MINUTES,
					requireReady: true,
					includeStarted: false,
					requireMicrostructure: true,
					marketQualityThreshold: BOT_SYNC_MARKET_QUALITY_THRESHOLD,
					inspectConditionId: entry.conditionId,
					limit: 500,
				},
			});
			if ("error" in response && response.error) {
				setBotInspectError(String(response.error));
				setBotInspectResult(null);
				return;
			}
			const inspect = response.debug?.inspect as BotInspectResult | undefined;
			setBotInspectResult(inspect ?? null);
		} catch (error) {
			setBotInspectError(
				error instanceof Error ? error.message : "bot_inspect_failed",
			);
			setBotInspectResult(null);
		} finally {
			setBotInspectLoading(false);
		}
	}, [entry.conditionId]);

	return (
		<div className="rounded-xl border border-slate-800/60 bg-slate-900/50 overflow-hidden">
			{showDebug && debugInfo && (
				<div className="border-b border-slate-800/60 bg-slate-950/70 px-3 py-2 text-[0.6rem] uppercase tracking-wide text-slate-400">
					<span className="mr-2">debug</span>
					<span className="mr-2">ready:{debugInfo.ready ? "y" : "n"}</span>
					<span className="mr-2">grade:{debugInfo.grade}</span>
					<span className="mr-2">score:{Math.round(debugInfo.score)}</span>
					<span className="mr-2">edge:{debugInfo.edge}</span>
					<span className="mr-2">diff:{debugInfo.diff ?? "—"}</span>
					<span className="mr-2">time:{debugInfo.timeOk ? "ok" : "bad"}</span>
					<span>even:{debugInfo.even ? "y" : "n"}</span>
				</div>
			)}
			{/* Card Header */}
			{/* biome-ignore lint/a11y/useSemanticElements: The header includes nested actionable controls, so wrapping as a button is invalid. */}
			<div
				className="w-full text-left cursor-pointer hover:bg-slate-800/30 transition-colors"
				role="button"
				tabIndex={0}
				onClick={onToggle}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						onToggle();
					}
				}}
			>
				{/* Mobile: Stacked layout */}
				<div className="block sm:hidden">
					{/* Top Row - League, Time, Actions */}
					<div className="flex items-center justify-between p-3 pb-2">
						<div className="flex items-center gap-1.5 flex-wrap">
							{entry.sportSeriesId && (
								<span className="text-[0.65rem] font-semibold uppercase tracking-wider text-gray-500 bg-slate-800/50 px-1.5 py-0.5 rounded">
									{getSeriesLabel(entry.sportSeriesId)}
								</span>
							)}
							{entry.eventTime && (
								<>
									<span className="text-[0.65rem] font-medium text-cyan-400/80 bg-cyan-900/30 px-1.5 py-0.5 rounded">
										{formatEventTime(entry.eventTime)}
									</span>
									{isStartingSoon && (
										<span className="text-[0.6rem] font-semibold uppercase tracking-wide text-red-200 bg-red-500/15 border border-red-500/40 px-1.5 py-0.5 rounded">
											Starting soon
										</span>
									)}
								</>
							)}
						</div>
							<div className="flex items-center gap-1">
								<span className="text-[0.6rem] text-gray-500">
									History {formatRelativeTime(historyUpdatedAt)}
								</span>
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										void inspectBotDecision();
									}}
									className="px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide text-amber-200 bg-amber-500/15 border border-amber-500/40 rounded hover:bg-amber-500/25 transition-colors disabled:opacity-60"
									disabled={botInspectLoading}
									title="Inspect why this market is included/excluded by bot candidate logic"
								>
									{botInspectLoading ? "Checking..." : "Bot check"}
								</button>
								<a
									href={`/sharp/market/${entry.conditionId}`}
									className="px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide text-cyan-300 bg-cyan-500/15 border border-cyan-500/40 rounded hover:bg-cyan-500/25 transition-colors"
									onClick={(e) => e.stopPropagation()}
								>
									Depth
								</a>
								{isHistoryStale && (
									<span className="text-[0.6rem] font-semibold uppercase tracking-wide text-red-200 bg-red-500/15 border border-red-500/40 px-1 py-0.5 rounded">
										Stale
									</span>
							)}
							{polymarketUrl && (
								<a
									href={polymarketUrl}
									target="_blank"
									rel="noopener noreferrer"
									className="p-1.5 text-gray-400 hover:text-cyan-400 transition-colors flex-shrink-0"
									onClick={(e) => e.stopPropagation()}
								>
									<ExternalLink className="h-4 w-4" />
								</a>
							)}
							{!disableRefresh && (
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										onRefresh();
									}}
									className="p-1.5 text-gray-400 hover:text-cyan-400 transition-colors flex-shrink-0 disabled:opacity-50"
									disabled={isRefreshing}
									title="Refresh this market"
								>
									<RefreshCw
										className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
									/>
								</button>
							)}
							{isExpanded ? (
								<ChevronUp className="h-5 w-5 text-gray-400 flex-shrink-0" />
							) : (
								<ChevronDown className="h-5 w-5 text-gray-400 flex-shrink-0" />
							)}
						</div>
					</div>

					{/* Title and Sharp Indicator */}
					<div className="px-3 pb-2">
						{(botInspectError || botInspectResult) && (
							<div className="mb-2 text-[0.65rem] font-semibold tracking-wide text-amber-200">
								{botInspectError
									? `Bot check failed: ${botInspectError}`
									: formatBotInspectMessage(botInspectResult)}
							</div>
						)}
						<div className="flex items-start justify-between gap-3 mb-1">
							<div className="flex-1 min-w-0">
								<h3 className="text-base font-semibold text-white leading-tight pb-2">
									{entry.marketTitle}
								</h3>
								{entry.sharpSide !== "EVEN" && (
									<div className="flex items-center gap-2 mt-1 flex-wrap">
										<div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/20 border border-emerald-500/40">
											<CheckCircle2 className="h-4 w-4 text-emerald-400" />
											<span className="text-sm font-bold text-emerald-400 uppercase tracking-wide">
												Bet: {sharpSideData.label}
											</span>
										</div>
										{gradeWarnings.includes("low_holders") && (
											<div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-500/15 border border-amber-500/40">
												<span className="text-[0.65rem] font-semibold text-amber-300 uppercase tracking-wide">
													Low holders
												</span>
											</div>
										)}
										{gradeWarnings.includes("low_pnl_coverage") && (
											<div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-500/15 border border-amber-500/40">
												<span className="text-[0.65rem] font-semibold text-amber-300 uppercase tracking-wide">
													Low PnL coverage
												</span>
											</div>
										)}
										{gradeWarnings.includes("not_ready") && (
											<div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-500/15 border border-amber-500/40">
												<span className="text-[0.65rem] font-semibold text-amber-300 uppercase tracking-wide">
													Not ready
												</span>
											</div>
										)}
										{gradeWarnings.includes("no_edge") && (
											<div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-slate-800/60 border border-slate-600/60">
												<span className="text-[0.65rem] font-semibold text-slate-300 uppercase tracking-wide">
													No edge
												</span>
											</div>
										)}
										{gradeWarnings.includes("low_conviction") && (
											<div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-500/15 border border-amber-500/40">
												<span className="text-[0.65rem] font-semibold text-amber-300 uppercase tracking-wide">
													Low conviction
												</span>
											</div>
										)}
										{gradeWarnings.includes("high_concentration") && (
											<div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-500/15 border border-amber-500/40">
												<span className="text-[0.65rem] font-semibold text-amber-300 uppercase tracking-wide">
													High concentration
												</span>
											</div>
										)}
										{gradeWarnings.includes("stale_data") && (
											<div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-red-500/15 border border-red-500/40">
												<span className="text-[0.65rem] font-semibold text-red-200 uppercase tracking-wide">
													Stale data
												</span>
											</div>
										)}
										{gradeWarnings.includes("low_roi") && (
											<div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-500/15 border border-amber-500/40">
												<span className="text-[0.65rem] font-semibold text-amber-300 uppercase tracking-wide">
													Low ROI
												</span>
											</div>
										)}
									</div>
								)}
							</div>
							{/* Bet Grade - Right of event name and bet side */}
							<div
								className={`flex flex-col items-center justify-center gap-0.5 px-2.5 py-1.5 rounded-lg border-2 ${betGrade.bgColor} ${betGrade.borderColor} flex-shrink-0 h-[56px] w-[50px]`}
							>
								<span className={`text-xl font-black ${betGrade.color}`}>
									{betGrade.grade}
								</span>
								<span className="text-[0.5rem] font-semibold text-slate-400 leading-none">
									{compositeScoreDisplay}
								</span>
							</div>
						</div>
					</div>

					{/* Metrics Row - Mobile */}
					<div className="px-3 pb-3 flex items-center justify-between">
						{/* Edge Rating - PRIMARY */}
						<div className="flex flex-col items-center justify-center flex-1 h-[56px]">
							<span
								className={`text-lg font-bold ${
									entry.edgeRating >= 80
										? "text-emerald-400"
										: entry.edgeRating >= 75
											? "text-emerald-400"
											: entry.edgeRating >= 66
												? "text-cyan-400"
												: entry.edgeRating >= 60
													? "text-amber-400"
													: entry.edgeRating >= 50
														? "text-gray-300"
														: "text-gray-500"
								}`}
							>
								{entry.edgeRating}
							</span>
							<span className="text-[0.6rem] text-gray-500 uppercase tracking-wider">
								Edge
							</span>
						</div>
						{entry.sharpSide !== "EVEN" && (
							<>
								{/* Diff - Secondary */}
								<div className="flex flex-col items-center justify-center flex-1 h-[56px]">
									<span
										className={`text-lg font-bold ${
											entry.scoreDifferential >= 40
												? "text-emerald-400"
												: entry.scoreDifferential >= 30
													? "text-emerald-400"
													: entry.scoreDifferential >= 20
														? "text-amber-400"
														: "text-gray-400"
										}`}
									>
										{entry.scoreDifferential.toFixed(0)}
									</span>
									<span className="text-[0.6rem] text-gray-500 uppercase tracking-wider">
										Diff
									</span>
								</div>
								{/* Volume - Tertiary */}
								<div className="flex flex-col items-center justify-center flex-1 h-[56px]">
									<span className="text-lg font-bold text-gray-400 mb-1">
										{formatUsdCompact(marketVolume)}
									</span>
									<div className="w-full h-1 bg-slate-800 rounded-full overflow-hidden mb-0.5">
										<div
											className={`h-full ${getVolumeColor(volumeColorPercent)} rounded-full transition-all`}
											style={{
												width: `${volumePercent}%`,
												minWidth: marketVolume > 0 ? "6px" : "0",
											}}
										/>
									</div>
									<span className="text-[0.6rem] text-gray-500 uppercase tracking-wider">
										Volume
									</span>
								</div>
							</>
						)}
					</div>
				</div>

				{/* Desktop: Horizontal layout */}
				<div className="hidden sm:block">
					{/* Top Row - League, Time, Actions */}
					<div className="flex items-center justify-between p-4 pb-2">
						<div className="flex items-center gap-2 flex-wrap">
							{entry.sportSeriesId && (
								<span className="text-[0.65rem] font-semibold uppercase tracking-wider text-gray-500 bg-slate-800/50 px-2 py-0.5 rounded">
									{getSeriesLabel(entry.sportSeriesId)}
								</span>
							)}
							{entry.eventTime && (
								<>
									<span className="text-[0.65rem] font-medium text-cyan-400/80 bg-cyan-900/30 px-2 py-0.5 rounded">
										{formatEventTime(entry.eventTime)}
									</span>
									{isStartingSoon && (
										<span className="text-[0.6rem] font-semibold uppercase tracking-wide text-red-200 bg-red-500/15 border border-red-500/40 px-2 py-0.5 rounded">
											Starting soon
										</span>
									)}
								</>
							)}
						</div>
							<div className="flex items-center gap-1">
								<span className="text-[0.6rem] text-gray-500">
									History {formatRelativeTime(historyUpdatedAt)}
								</span>
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										void inspectBotDecision();
									}}
									className="px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide text-amber-200 bg-amber-500/15 border border-amber-500/40 rounded hover:bg-amber-500/25 transition-colors disabled:opacity-60"
									disabled={botInspectLoading}
									title="Inspect why this market is included/excluded by bot candidate logic"
								>
									{botInspectLoading ? "Checking..." : "Bot check"}
								</button>
								<a
									href={`/sharp/market/${entry.conditionId}`}
									className="px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide text-cyan-300 bg-cyan-500/15 border border-cyan-500/40 rounded hover:bg-cyan-500/25 transition-colors"
									onClick={(e) => e.stopPropagation()}
								>
									Depth
								</a>
								{isHistoryStale && (
									<span className="text-[0.6rem] font-semibold uppercase tracking-wide text-red-200 bg-red-500/15 border border-red-500/40 px-1 py-0.5 rounded">
										Stale
									</span>
							)}
							{polymarketUrl && (
								<a
									href={polymarketUrl}
									target="_blank"
									rel="noopener noreferrer"
									className="p-1.5 text-gray-400 hover:text-cyan-400 transition-colors flex-shrink-0"
									onClick={(e) => e.stopPropagation()}
								>
									<ExternalLink className="h-4 w-4" />
								</a>
							)}
							{!disableRefresh && (
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										onRefresh();
									}}
									className="p-1.5 text-gray-400 hover:text-cyan-400 transition-colors flex-shrink-0 disabled:opacity-50"
									disabled={isRefreshing}
									title="Refresh this market"
								>
									<RefreshCw
										className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
									/>
								</button>
							)}
							{isExpanded ? (
								<ChevronUp className="h-5 w-5 text-gray-400 flex-shrink-0" />
							) : (
								<ChevronDown className="h-5 w-5 text-gray-400 flex-shrink-0" />
							)}
						</div>
					</div>

					{/* Content Row - Title, Bet Side, and Metrics */}
					<div className="grid grid-cols-[1fr_auto] items-start gap-4 px-4 pb-4">
						<div className="flex-1 min-w-0">
							{(botInspectError || botInspectResult) && (
								<div className="mb-2 text-[0.65rem] font-semibold tracking-wide text-amber-200">
									{botInspectError
										? `Bot check failed: ${botInspectError}`
										: formatBotInspectMessage(botInspectResult)}
								</div>
							)}
							<h3 className="text-base font-semibold text-white truncate pr-4">
								{entry.marketTitle}
							</h3>
							{entry.sharpSide !== "EVEN" && (
								<div className="flex items-center gap-2 mt-2">
									<div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/20 border border-emerald-500/40">
										<CheckCircle2 className="h-4 w-4 text-emerald-400" />
										<span className="text-sm font-bold text-emerald-400 uppercase tracking-wide">
											Bet: {sharpSideData.label}
										</span>
									</div>
									{gradeWarnings.includes("low_holders") && (
										<div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/15 border border-amber-500/40">
											<span className="text-xs font-semibold text-amber-300 uppercase tracking-wide">
												Low holders
											</span>
										</div>
									)}
									{gradeWarnings.includes("low_pnl_coverage") && (
										<div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/15 border border-amber-500/40">
											<span className="text-xs font-semibold text-amber-300 uppercase tracking-wide">
												Low PnL coverage
											</span>
										</div>
									)}
									{gradeWarnings.includes("not_ready") && (
										<div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/15 border border-amber-500/40">
											<span className="text-xs font-semibold text-amber-300 uppercase tracking-wide">
												Not ready
											</span>
										</div>
									)}
									{gradeWarnings.includes("no_edge") && (
										<div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-800/60 border border-slate-600/60">
											<span className="text-xs font-semibold text-slate-300 uppercase tracking-wide">
												No edge
											</span>
										</div>
									)}
									{gradeWarnings.includes("low_conviction") && (
										<div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/15 border border-amber-500/40">
											<span className="text-xs font-semibold text-amber-300 uppercase tracking-wide">
												Low conviction
											</span>
										</div>
									)}
									{gradeWarnings.includes("high_concentration") && (
										<div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/15 border border-amber-500/40">
											<span className="text-xs font-semibold text-amber-300 uppercase tracking-wide">
												High concentration
											</span>
										</div>
									)}
									{gradeWarnings.includes("stale_data") && (
										<div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-red-500/15 border border-red-500/40">
											<span className="text-xs font-semibold text-red-200 uppercase tracking-wide">
												Stale data
											</span>
										</div>
									)}
									{gradeWarnings.includes("low_roi") && (
										<div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/15 border border-amber-500/40">
											<span className="text-xs font-semibold text-amber-300 uppercase tracking-wide">
												Low ROI
											</span>
										</div>
									)}
								</div>
							)}
						</div>
						<div className="flex items-center gap-2.5">
							{/* Bet Grade - Single value indicator (most prominent) */}
							<div
								className={`flex flex-col items-center justify-center gap-0.5 px-3 py-2 rounded-xl border-2 ${betGrade.bgColor} ${betGrade.borderColor} flex-shrink-0 h-[60px] w-[56px]`}
							>
								<span className={`text-2xl font-black ${betGrade.color}`}>
									{betGrade.grade}
								</span>
								<span className="text-[0.5rem] font-semibold text-slate-400 leading-none">
									{compositeScoreDisplay}
								</span>
							</div>

							{/* Edge Rating - PRIMARY ranking indicator */}
							<div className="flex flex-col items-center justify-center flex-shrink-0 h-[60px] w-[48px]">
								<span
									className={`text-xl font-bold ${
										entry.edgeRating >= 80
											? "text-emerald-400"
											: entry.edgeRating >= 75
												? "text-emerald-400"
												: entry.edgeRating >= 66
													? "text-cyan-400"
													: entry.edgeRating >= 60
														? "text-amber-400"
														: entry.edgeRating >= 50
															? "text-gray-300"
															: "text-gray-500"
									}`}
								>
									{entry.edgeRating}
								</span>
								<span className="text-[0.6rem] text-gray-500 uppercase tracking-wider">
									Edge
								</span>
							</div>

							{/* Score Differential - Secondary context (signal strength) */}
							{entry.sharpSide !== "EVEN" ? (
								<div className="flex flex-col items-center justify-center flex-shrink-0 h-[60px] w-[48px]">
									<span
										className={`text-xl font-bold ${
											entry.scoreDifferential >= 40
												? "text-emerald-400"
												: entry.scoreDifferential >= 30
													? "text-emerald-400"
													: entry.scoreDifferential >= 20
														? "text-amber-400"
														: "text-gray-400"
										}`}
									>
										{entry.scoreDifferential.toFixed(0)}
									</span>
									<span className="text-[0.6rem] text-gray-500 uppercase tracking-wider">
										Diff
									</span>
								</div>
							) : (
								<div className="w-[48px] flex-shrink-0" /> // Spacer to maintain alignment
							)}

							{/* Volume indicator - Tertiary (validation) */}
							{entry.sharpSide !== "EVEN" ? (
								<div className="flex flex-col items-center justify-center flex-shrink-0 h-[60px] w-[60px]">
									<span className="text-xl font-bold text-gray-400 mb-1">
										{formatUsdCompact(marketVolume)}
									</span>
									<div
										className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden mb-0.5 flex-shrink-0"
										style={{ height: "6px", minHeight: "6px" }}
									>
										<div
											className={`h-full ${getVolumeColor(volumeColorPercent)} rounded-full transition-all`}
											style={{
												width: `${volumePercent}%`,
												minWidth: marketVolume > 0 ? "6px" : "0",
											}}
										/>
									</div>
									<span className="text-[0.6rem] text-gray-500 uppercase tracking-wider">
										Volume
									</span>
								</div>
							) : (
								<div className="w-[60px] flex-shrink-0" /> // Spacer to maintain alignment
							)}
						</div>
					</div>
				</div>
			</div>

			{/* Unified Edge Bar with Odds */}

			<div className="px-4 pb-4">
				<UnifiedEdgeBar
					sideA={entry.sideA}
					sideB={entry.sideB}
					sharpSide={entry.sharpSide}
					sideAOdds={sideAOdds}
					sideBOdds={sideBOdds}
				/>
			</div>

			{/* Expanded Content */}
			{isExpanded && (
				<div className="border-t border-slate-800/60 p-4">
					<div className="grid gap-4 md:grid-cols-2">
						{/* Side A */}
						<SideDetails side={entry.sideA} isSharp={entry.sharpSide === "A"} />
						{/* Side B */}
						<SideDetails side={entry.sideB} isSharp={entry.sharpSide === "B"} />
					</div>
					<div className="mt-4 rounded-lg border border-slate-800/70 bg-slate-950/30 p-4">
						<div className="flex items-center justify-between gap-2">
							<div className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
								History (24h)
							</div>
							{isHistoryLoading && (
								<div className="flex items-center gap-2 text-xs text-slate-400">
									<Loader2 className="h-3 w-3 animate-spin" />
									Loading
								</div>
							)}
						</div>
						{!isHistoryLoading && historyEntries.length === 0 && (
							<div className="mt-3 text-xs text-slate-400">
								No history recorded yet.
							</div>
						)}
						{historyFirst && historyLast && (
							<>
								<div className="mt-3 grid gap-2 text-xs text-slate-300 sm:grid-cols-2">
									<div>
										Grade:{" "}
										<span className="font-semibold text-slate-100">
											{signalScoreToGradeLabel(
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
										</span>{" "}
										→{" "}
										<span className="font-semibold text-slate-100">
											{signalScoreToGradeLabel(
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
										</span>
									</div>
									<div>
										Edge:{" "}
										<span className="font-semibold text-slate-100">
											{historyFirst.edgeRating}
										</span>{" "}
										→{" "}
										<span className="font-semibold text-slate-100">
											{historyLast.edgeRating}
										</span>
									</div>
									<div>
										Diff:{" "}
										<span className="font-semibold text-slate-100">
											{Math.round(historyFirst.scoreDifferential)}
										</span>{" "}
										→{" "}
										<span className="font-semibold text-slate-100">
											{Math.round(historyLast.scoreDifferential)}
										</span>
									</div>
									<div>
										Holder value:{" "}
										<span className="font-semibold text-slate-100">
											{formatUsdCompact(
												historyFirst.sideA.totalValue +
													historyFirst.sideB.totalValue,
											)}
										</span>{" "}
										→{" "}
										<span className="font-semibold text-slate-100">
											{formatUsdCompact(
												historyLast.sideA.totalValue +
													historyLast.sideB.totalValue,
											)}
										</span>
									</div>
									<div className="sm:col-span-2">
										Odds:{" "}
										<span className="font-semibold text-slate-100">
											{formatOddsLine(historyFirst)}
										</span>{" "}
										→{" "}
										<span className="font-semibold text-slate-100">
											{formatOddsLine(historyLast)}
										</span>
									</div>
								</div>
								<div className="mt-3 overflow-x-auto">
									<table className="w-full min-w-[480px] text-left text-xs text-slate-300">
										<thead className="text-[0.65rem] uppercase tracking-wider text-slate-500">
											<tr>
												<th className="py-2 pr-3">Time</th>
												<th className="py-2 pr-3">Grade</th>
												<th className="py-2 pr-3">Edge</th>
												<th className="py-2 pr-3">Diff</th>
												<th className="py-2 pr-3">Holder value</th>
												<th className="py-2">Odds</th>
											</tr>
										</thead>
										<tbody>
											{historySlice.map((snapshot) => {
												const windowStart = snapshot.recordedAt - 60 * 60;
												const window = historyEntries.filter(
													(entry) =>
														entry.recordedAt >= windowStart &&
														entry.recordedAt <= snapshot.recordedAt,
												);
												return (
													<tr
														key={snapshot.recordedAt}
														className="border-t border-slate-800/60"
													>
														<td className="py-2 pr-3 text-slate-400">
															{formatRelativeTime(snapshot.recordedAt)}
														</td>
														<td className="py-2 pr-3 font-semibold text-slate-100">
															{signalScoreToGradeLabel(
																computeSignalScoreFromWindow(
																	snapshot,
																	window,
																	MIN_EDGE_RATING,
																),
																{
																	edgeRating: snapshot.edgeRating,
																	scoreDifferential: snapshot.scoreDifferential,
																},
															)}
														</td>
														<td className="py-2 pr-3">{snapshot.edgeRating}</td>
														<td className="py-2 pr-3">
															{Math.round(snapshot.scoreDifferential)}
														</td>
														<td className="py-2 pr-3">
															{formatUsdCompact(
																snapshot.sideA.totalValue +
																	snapshot.sideB.totalValue,
															)}
														</td>
														<td className="py-2">{formatOddsLine(snapshot)}</td>
													</tr>
												);
											})}
										</tbody>
									</table>
								</div>
								{historyEntries.length > historySlice.length && (
									<div className="mt-2 text-[0.65rem] text-slate-500">
										Showing last {historySlice.length} of{" "}
										{historyEntries.length} snapshots.
									</div>
								)}
							</>
						)}
					</div>
				</div>
			)}
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
	// Calculate money split (what % of total dollars is on each side)
	const totalValue = sideA.totalValue + sideB.totalValue;
	const sideAMoneyPercent =
		totalValue > 0 ? (sideA.totalValue / totalValue) * 100 : 50;
	const sideBMoneyPercent = 100 - sideAMoneyPercent;

	const isSharpA = sharpSide === "A";
	// For EVEN, show balanced bar
	if (sharpSide === "EVEN") {
		return (
			<div className="space-y-2">
				<div className="flex items-center justify-between text-xs">
					<div>
						<span className="font-semibold text-gray-400">{sideA.label}</span>
						<span className="text-gray-600 ml-2">
							({Math.round(sideA.sharpScore)})
						</span>
					</div>
					<div>
						<span className="text-gray-600 mr-2">
							({Math.round(sideB.sharpScore)})
						</span>
						<span className="font-semibold text-gray-400">{sideB.label}</span>
					</div>
				</div>
				<div className="h-7 bg-slate-800 rounded-lg overflow-hidden relative">
					<div className="absolute inset-0 flex items-center justify-center">
						<span className="text-xs font-medium text-gray-500">
							No clear edge - money split evenly
						</span>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-2">
			{/* Labels row - sharp side highlighted with checkmark, showing scores and odds */}
			<div className="flex items-center justify-between text-sm">
				<div className="flex items-center gap-1.5">
					{isSharpA && (
						<CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
					)}
					<span
						className={`font-semibold ${isSharpA ? "text-emerald-400" : "text-gray-500"}`}
					>
						{sideA.label}
					</span>
					<span
						className={`${isSharpA ? "text-emerald-400/70" : "text-gray-600"}`}
					>
						({Math.round(sideA.sharpScore)})
					</span>
					{sideAOdds && (
						<span
							className={`rounded-md px-2 py-0.5 text-sm font-semibold ${isSharpA ? "bg-emerald-500/15 text-emerald-200" : "bg-slate-900/60 text-gray-200"}`}
						>
							{sideAOdds}
						</span>
					)}
				</div>
				<div className="flex items-center gap-1.5">
					{sideBOdds && (
						<span
							className={`rounded-md px-2 py-0.5 text-sm font-semibold ${!isSharpA ? "bg-emerald-500/15 text-emerald-200" : "bg-slate-900/60 text-gray-200"}`}
						>
							{sideBOdds}
						</span>
					)}
					<span
						className={`${!isSharpA ? "text-emerald-400/70" : "text-gray-600"}`}
					>
						({Math.round(sideB.sharpScore)})
					</span>
					<span
						className={`font-semibold ${!isSharpA ? "text-emerald-400" : "text-gray-500"}`}
					>
						{sideB.label}
					</span>
					{!isSharpA && (
						<CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
					)}
				</div>
			</div>

			{/* Money split bar - shows where the actual dollars are */}
			<div className="h-7 rounded-lg overflow-hidden relative flex border-2 border-slate-800">
				{/* Side A money bar */}
				<div
					className={`h-full transition-all duration-500 flex items-center justify-center min-w-[60px] relative ${
						isSharpA
							? "bg-gradient-to-r from-emerald-600 to-emerald-500 ring-2 ring-emerald-400 ring-offset-0"
							: "bg-slate-700"
					}`}
					style={{ width: `${Math.max(sideAMoneyPercent, 15)}%` }}
				>
					{isSharpA && (
						<div className="absolute inset-0 border-2 border-emerald-300/50 rounded-l-lg pointer-events-none" />
					)}
					<span
						className={`text-xs font-bold ${isSharpA ? "text-white drop-shadow-sm" : "text-gray-400"}`}
					>
						{formatUsdCompact(sideA.totalValue)}
					</span>
				</div>

				{/* Divider */}
				<div className="w-0.5 bg-slate-900" />

				{/* Side B money bar */}
				<div
					className={`h-full transition-all duration-500 flex items-center justify-center min-w-[60px] relative ${
						!isSharpA
							? "bg-gradient-to-l from-emerald-600 to-emerald-500 ring-2 ring-emerald-400 ring-offset-0"
							: "bg-slate-700"
					}`}
					style={{ width: `${Math.max(sideBMoneyPercent, 15)}%` }}
				>
					{!isSharpA && (
						<div className="absolute inset-0 border-2 border-emerald-300/50 rounded-r-lg pointer-events-none" />
					)}
					<span
						className={`text-xs font-bold ${!isSharpA ? "text-white drop-shadow-sm" : "text-gray-400"}`}
					>
						{formatUsdCompact(sideB.totalValue)}
					</span>
				</div>
			</div>

			{/* Summary line - Conviction */}
			<div className="flex items-center justify-center gap-2">
				<span className="text-xs text-gray-500">Conviction:</span>
				<span
					className={`text-sm font-bold ${
						(isSharpA ? sideAMoneyPercent : sideBMoneyPercent) >= 40 &&
						(isSharpA ? sideAMoneyPercent : sideBMoneyPercent) <= 60
							? "text-emerald-400"
							: (isSharpA ? sideAMoneyPercent : sideBMoneyPercent) >= 30 &&
									(isSharpA ? sideAMoneyPercent : sideBMoneyPercent) <= 70
								? "text-amber-400"
								: "text-gray-400"
					}`}
				>
					{Math.round(isSharpA ? sideAMoneyPercent : sideBMoneyPercent)}%
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
			className={`rounded-lg p-4 ${
				isSharp
					? "bg-emerald-500/10 border border-emerald-500/30"
					: "bg-slate-800/30"
			}`}
		>
			<div className="flex items-center justify-between mb-3">
				<div className="flex items-center gap-2">
					<h4
						className={`font-semibold ${isSharp ? "text-emerald-400" : "text-white"}`}
					>
						{side.label}
					</h4>
					{isSharp && (
						<span className="flex items-center gap-1 text-[0.65rem] font-semibold uppercase text-emerald-400 bg-emerald-500/20 px-2 py-0.5 rounded">
							<Zap className="h-3 w-3" /> Sharp
						</span>
					)}
				</div>
				<span
					className={`text-lg font-bold ${isSharp ? "text-emerald-400" : "text-cyan-400"}`}
				>
					{Math.round(side.sharpScore)}
				</span>
			</div>

			<div className="grid grid-cols-2 gap-2 text-sm mb-4">
				<div>
					<span className="text-gray-500">Holder Value</span>
					<p className="font-semibold text-white">
						{formatUsdCompact(side.totalValue)}
					</p>
				</div>
			</div>

			{/* Top Holders */}
			<div>
				<h5 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
					Top Holders
				</h5>
				<div className="grid grid-cols-[20px_26px_minmax(0,1fr)_52px_40px_40px_44px] sm:grid-cols-[22px_28px_minmax(0,1fr)_64px_48px_48px_64px] items-center gap-1 sm:gap-0.5 text-[0.5rem] sm:text-[0.6rem] uppercase tracking-wider text-gray-500 mb-1">
					<span />
					<span />
					<span>Holder</span>
					<span className="text-right">
						<span className="sm:hidden">PnL$</span>
						<span className="hidden sm:inline">PnL $</span>
					</span>
					<span className="text-right">
						<span className="sm:hidden">PnLu</span>
						<span className="hidden sm:inline">PnL u</span>
					</span>
					<span className="text-right">
						<span className="sm:hidden">StkU</span>
						<span className="hidden sm:inline">Stake u</span>
					</span>
					<span className="text-right">
						<span className="sm:hidden">Stk$</span>
						<span className="hidden sm:inline">Stake $</span>
					</span>
				</div>
				<ul className="space-y-1.5">
					{side.topHolders.map((holder, idx) => (
						<li
							key={holder.proxyWallet}
							className="grid grid-cols-[20px_26px_minmax(0,1fr)_52px_40px_40px_44px] sm:grid-cols-[22px_28px_minmax(0,1fr)_64px_48px_48px_64px] items-center gap-1 sm:gap-0.5 text-[0.7rem] sm:text-sm"
						>
							<span className="text-gray-500 pr-1 text-right">{idx + 1}.</span>
							{holder.profileImage ? (
								<img
									src={holder.profileImage}
									alt=""
									className="h-4 w-4 sm:h-5 sm:w-5 rounded-full object-cover ml-0.5"
								/>
							) : (
								<div className="h-4 w-4 sm:h-5 sm:w-5 rounded-full bg-slate-700 flex items-center justify-center ml-0.5">
									<User className="h-2.5 w-2.5 sm:h-3 sm:w-3 text-gray-400" />
								</div>
							)}
							<a
								href={buildPolymarketProfileUrl(holder.proxyWallet)}
								target="_blank"
								rel="noopener noreferrer"
								className="flex-1 truncate text-gray-300 hover:text-emerald-400 transition-colors cursor-pointer"
								onClick={(e) => e.stopPropagation()}
							>
								{truncateWalletName(holder.name || holder.pseudonym) ||
									`${holder.proxyWallet.slice(0, 6)}...${holder.proxyWallet.slice(-4)}`}
							</a>
							<div className="flex justify-end">
								{holder.pnlAll === null || holder.pnlAll === undefined ? (
									<span className="text-gray-600 text-[0.55rem] sm:text-xs">
										—
									</span>
								) : (
									<PnlBadge pnlAll={holder.pnlAll} />
								)}
							</div>
							<div className="flex justify-end">
								{holder.pnlAllUnits === null ||
								holder.pnlAllUnits === undefined ? (
									<span className="text-gray-600 text-[0.55rem] sm:text-xs">
										—
									</span>
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
									<span className="text-gray-600 text-[0.55rem] sm:text-xs">
										—
									</span>
								) : (
									<StakeUnitBadge
										stakeUsd={holder.amount}
										unitSize={holder.unitSize}
									/>
								)}
							</div>
							<span className="text-gray-400 text-[0.55rem] sm:text-xs text-right">
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
			className={`inline-flex items-center gap-0.5 text-[0.55rem] sm:text-[0.6rem] font-semibold px-1 sm:px-1.5 py-0.5 rounded ${
				isPositive
					? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
					: "bg-rose-500/20 text-rose-400 border border-rose-500/30"
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
			className={`inline-flex items-center gap-0.5 text-[0.55rem] sm:text-[0.6rem] font-semibold px-1 sm:px-1.5 py-0.5 rounded ${
				isPositive
					? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/20"
					: "bg-rose-500/10 text-rose-300 border border-rose-500/20"
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
			? "bg-slate-500/10 text-slate-300 border border-slate-500/20"
			: stakeUnits <= 2
				? "bg-amber-500/10 text-amber-300 border border-amber-500/20"
				: "bg-emerald-500/10 text-emerald-300 border border-emerald-500/20";

	return (
		<span
			title={title}
			className={`inline-flex items-center gap-0.5 text-[0.55rem] sm:text-[0.6rem] font-semibold px-1 sm:px-1.5 py-0.5 rounded ${tone}`}
		>
			{formatted}x
		</span>
	);
}
