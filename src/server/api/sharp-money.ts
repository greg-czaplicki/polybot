import { createServerFn } from "@tanstack/react-start";
import type { Db } from "../db/client";
import { all, run } from "../db/client";
import type { Env } from "../env";
import { getDb, nowUnixSeconds } from "../env";
import {
	clearAllSharpMoneyCache,
	getSharpMoneyCacheByConditionId,
	getSharpMoneyCacheStats,
	getSharpMoneyCacheFreshnessStats,
	backfillSharpMoneyHistory,
	insertSharpMoneyHistory,
	listSharpMoneyCache,
	listSharpMoneyCacheByConditionIds,
	listSharpMoneyHistory,
	listSharpMoneyHistoryByConditionIds,
	listSharpMoneyHistoryLatest,
	listSharpMoneyHistoryWindow,
	type SharpMoneyHistoryEntry,
	type TopHolderPnlData,
	type SharpMoneyHistoryEntryByConditionId,
	type UpsertSharpMoneyCacheInput,
	upsertSharpMoneyCache,
} from "../repositories/sharp-money";
import {
	computeSignalScoreFromHistory,
	MIN_EDGE_RATING,
	signalScoreToGradeLabel,
	type GradeLabel,
} from "../../lib/sharp-grade";

// Re-export types for frontend use
export type {
	SharpMoneyCacheEntry,
	SharpMoneyHistoryEntry,
	TopHolderPnlData,
} from "../repositories/sharp-money";

const POLYMARKET_GAMMA_API = "https://gamma-api.polymarket.com";
const POLYMARKET_DATA_API = "https://data-api.polymarket.com";

// Sport tags we want to track for sharp money
const SPORTS_SERIES_IDS: Partial<Record<string, number>> = {
	ncaab: 10470,
	epl: 10188,
	mlb: 3,
	cfb: 10210,
	nfl: 10187,
	nba: 10345,
	nhl: 10346,
	atp: 10365,
	mma: 10500,
};

const GAME_BETS_TAG_ID = 100639;

// Minimum volume to show in sharp money (filters out low-liquidity games)
const MIN_VOLUME_USD = 10_000;
const START_TIME_BUFFER_MINUTES = 10;
const MAX_SUBREQUESTS = 50;
const UNIT_SIZE_CACHE_TTL_SEC = 6 * 60 * 60;
const UNIT_SIZE_SAMPLE_LIMIT = 50;
const UNIT_SIZE_POSITION_LIMIT = 100;
const MIN_UNIT_SIZE_SAMPLES = 3;
const UNIT_SIZE_TOP_SAMPLE = 10;
const GAMMA_EVENTS_PAGE_LIMIT = 200;
const GAMMA_EVENTS_MAX_PAGES = 6;
const GAMMA_RETRY_LIMIT = 3;
const GAMMA_RETRY_BASE_MS = 250;
const MIN_READY_HOLDER_COUNT = 10;
const MIN_READY_PNL_COVERAGE = 0.6;
// -250 implied probability ≈ 0.7142857
const LOW_ROI_PRICE_THRESHOLD = 0.7143;
const MIN_MICROSTRUCTURE_SCORE = 0.58;

const TARGET_SPORT_SERIES_IDS = [10187, 10345, 10210, 10470, 3, 10346, 10188];

export type TrendingSportsPayload = {
	limit?: number;
	seriesIds?: number[];
	includeAllMarkets?: boolean;
	includeLowVolume?: boolean;
	windowHours?: number;
	minVolumeUsd?: number;
};

export type TrendingSportsMarket = {
	id: string;
	conditionId: string;
	title: string;
	slug?: string;
	eventSlug?: string;
	sportSeriesId?: number;
	volume: number;
	liquidity: number;
	outcomes: string[];
	bestBid?: number;
	bestAsk?: number;
	endDate?: string;
};

const DEFAULT_HISTORY_WINDOW_MINUTES = 60;
const DEFAULT_STALE_THRESHOLD_MINUTES = 15;
const DEFAULT_FRESHNESS_WINDOW_HOURS = 24;
const MAX_GRADE_REQUEST_ITEMS = 200;

export type SharpGradePayload = {
	conditionIds: string[];
	historyWindowMinutes?: number;
	staleThresholdMinutes?: number;
};

export type SharpGradeResult = {
	conditionId: string;
	grade: GradeLabel | null;
	signalScore?: number;
	edgeRating?: number;
	scoreDifferential?: number;
	microstructureScore?: number;
	isReady?: boolean;
	warnings: string[];
	computedAt: number;
	historyUpdatedAt?: number;
	error?: "not_found";
};

export type SharpGradeComputeResult = {
	results: SharpGradeResult[];
	requested: number;
	returned: number;
	truncated: boolean;
	computedAt: number;
	error?: "conditionIds_required";
};

export type SharpAnalysisPayload = {
	conditionId: string;
	marketTitle: string;
	marketSlug?: string;
	eventSlug?: string;
	sportSeriesId?: number;
	outcomes?: string[];
	bestBid?: number;
	bestAsk?: number;
	endDate?: string;
	marketVolume?: number;
	marketLiquidity?: number;
	includeDebug?: boolean;
};

export type SharpMoneyGradeMix = {
	total: number;
	passing: number;
	passingRate: number;
	aPlusCount: number;
	aPlusRate: number;
	aPlusOrACount: number;
	aPlusOrARate: number;
};

const SERIES_ID_TO_TAG = new Map<number, string>(
	Object.entries(SPORTS_SERIES_IDS)
		.filter(([, id]) => typeof id === "number")
		.map(([tag, id]) => [id as number, tag]),
);

function isTargetSeriesId(seriesId?: number | null): boolean {
	if (seriesId === null || seriesId === undefined) return false;
	return TARGET_SPORT_SERIES_IDS.includes(seriesId);
}

type RuntimeMarketStats = {
	fetchedAt: number;
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
		oldestHistory?: number;
		newestHistory?: number;
		oldestComputed?: number;
		newestComputed?: number;
		cutoff: number;
	};
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
	expandedEventCount: number;
	expandedMarketCount: number;
	totalMarkets: number;
};

let lastRuntimeMarketStats: RuntimeMarketStats | null = null;
const runtimeFetchMetrics = {
	totalRuns: 0,
	totalRetries: 0,
	totalFailures: 0,
};

/**
 * Parse outcomes from Gamma API - can be JSON array string or comma-separated
 */
function parseOutcomes(outcomes: string | undefined | null): string[] {
	if (!outcomes) return ["Yes", "No"];

	// Try parsing as JSON array first (e.g., '["Patriots", "Jets"]')
	if (outcomes.startsWith("[")) {
		try {
			const parsed = JSON.parse(outcomes);
			if (Array.isArray(parsed)) {
				return parsed.map((o) => String(o).trim());
			}
		} catch {
			// Fall through to comma split
		}
	}

	// Fall back to comma-separated (e.g., 'Yes, No')
	return outcomes.split(",").map((o) => o.trim());
}

function parseEventTime(endDate?: string | null): Date | null {
	if (!endDate) return null;
	// Handle date-only strings by assuming end of day UTC.
	if (/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
		return new Date(`${endDate}T23:59:59Z`);
	}
	const parsed = new Date(endDate);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getEasternDateString(date: Date): string {
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone: "America/New_York",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	return formatter.format(date);
}

type ClosedPosition = {
	conditionId?: string;
	title?: string;
	avgPrice?: number;
	totalBought: number;
	realizedPnl: number;
	timestamp?: number;
	outcome?: string;
};

type OpenPosition = {
	conditionId?: string;
	title?: string;
	avgPrice?: number;
	initialValue?: number;
	size?: number;
	totalBought?: number;
	timestamp?: number;
	outcome?: string;
};

function calculateMedian(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 0) {
		return (sorted[mid - 1] + sorted[mid]) / 2;
	}
	return sorted[mid];
}

function calculateMedianTopHalf(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const start = Math.floor(sorted.length / 2);
	const topHalf = sorted.slice(start);
	return calculateMedian(topHalf);
}

function calculateMedianTopN(
	values: number[],
	count: number,
): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => b - a);
	const top = sorted.slice(0, Math.max(1, Math.min(count, sorted.length)));
	return calculateMedian(top);
}

function normalizePnl(
	pnl: number | null | undefined,
	unitSize: number | null | undefined,
): number | null {
	if (pnl === null || pnl === undefined) return null;
	if (!unitSize || unitSize <= 0) return null;
	return pnl / unitSize;
}

function calculateStakeUnitWeight(
	stakeUnits: number | null | undefined,
): number {
	if (
		stakeUnits === null ||
		stakeUnits === undefined ||
		!Number.isFinite(stakeUnits)
	) {
		return 1.0;
	}

	const clampedUnits = Math.max(stakeUnits, 0);
	const raw = Math.sqrt(clampedUnits);
	return Math.min(2.0, Math.max(0.25, raw));
}

/**
 * Market data from Gamma API
 */
export interface GammaMarket {
	id: string;
	question: string;
	conditionId: string;
	slug: string;
	event_slug?: string;
	startTime?: string;
	seriesId?: number;
	resolutionSource?: string;
	endDate?: string;
	liquidity?: number;
	volume?: number;
	volumeNum?: number;
	liquidityNum?: number;
	outcomes?: string;
	outcomePrices?: string;
	bestBid?: number;
	bestAsk?: number;
	active?: boolean;
	closed?: boolean;
	marketMakerAddress?: string;
	createdAt?: string;
	updatedAt?: string;
	// Event data
	groupItemTitle?: string;
	eventSlug?: string;
	enableOrderBook?: boolean;
}

interface GammaEvent {
	id: string;
	slug?: string;
	title?: string;
	startTime?: string;
	markets?: GammaMarket[];
}

function getEventSlug(market: GammaMarket): string | undefined {
	return market.eventSlug ?? market.event_slug ?? undefined;
}

function isPlayerPropTitle(title: string): boolean {
	const normalized = title.toLowerCase();
	if (!normalized.includes(":")) return false;
	return /:\s*(points|rebounds|assists|threes|three pointers|goals|shots|saves|strikeouts|hits|rbis|home runs|yards|touchdowns|completions|passing|rushing|receiving)\b/i.test(
		title,
	);
}

function isMainMarketTitle(title: string): boolean {
	const normalized = title.toLowerCase();
	if (isPlayerPropTitle(title)) return false;
	if (normalized.includes("spread:")) return true;
	if (normalized.includes("o/u") || normalized.includes("over/under"))
		return true;
	return /\bvs\.?\b|\bvs\b|\bat\b|@/i.test(title);
}

function parseGammaNumber(value?: string | number | null): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return undefined;
}

async function fetchWithRetry(
	url: string,
	options?: RequestInit,
	maxRetries: number = GAMMA_RETRY_LIMIT,
): Promise<{ response: Response; retries: number } | null> {
	let attempt = 0;
	while (attempt <= maxRetries) {
		try {
			const response = await fetch(url, options);
			if (response.ok) return { response, retries: attempt };
			if (response.status < 500 && response.status !== 429) {
				return null;
			}
		} catch {
			// retry below
		}
		attempt += 1;
		if (attempt > maxRetries) break;
		const backoffMs = GAMMA_RETRY_BASE_MS * 2 ** (attempt - 1);
		await new Promise((resolve) => setTimeout(resolve, backoffMs));
	}
	return null;
}

/**
 * Holder with multi-period PnL data
 */
export interface HolderWithPnl {
	proxyWallet: string;
	name?: string;
	pseudonym?: string;
	profileImage?: string;
	amount: number;
	outcomeIndex: number;
	pnlDay?: number | null;
	pnlWeek?: number | null;
	pnlMonth?: number | null;
	pnlAll?: number | null;
	volume?: number;
}

/**
 * Multi-period PnL result
 */
export interface MultiPeriodPnl {
	day: number | null;
	week: number | null;
	month: number | null;
	all: number | null;
	volume?: number;
}

/**
 * Sharp analysis result for a single market
 */
export interface SharpAnalysisResult {
	conditionId: string;
	marketTitle: string;
	marketSlug?: string;
	eventSlug?: string;
	sportSeriesId?: number;
	eventTime?: string; // ISO date string for when the event starts/ends
	marketVolume?: number;
	marketLiquidity?: number;
	pnlCoverage?: number;
	sideA: {
		label: string;
		totalValue: number;
		sharpScore: number;
		holderCount: number;
		price?: number | null;
		topHolders: TopHolderPnlData[];
	};
	sideB: {
		label: string;
		totalValue: number;
		sharpScore: number;
		holderCount: number;
		price?: number | null;
		topHolders: TopHolderPnlData[];
	};
	sharpSide: "A" | "B" | "EVEN";
	confidence: "HIGH" | "MEDIUM" | "LOW";
	scoreDifferential: number;
	sharpSideValueRatio?: number; // 0-1, what % of total value is on the sharp side
	edgeRating: number; // 0-100, single ranking score for prioritizing bets
}

export interface SharpAnalysisDebug {
	inputs: {
		conditionId: string;
		marketTitle: string;
		marketSlug?: string;
		eventSlug?: string;
		sportSeriesId?: number;
		outcomes?: string[];
		endDate?: string;
		marketVolume?: number;
		marketLiquidity?: number;
	};
	prices: {
		sideA: number;
		sideB: number;
	};
	holders: {
		sideA: number;
		sideB: number;
	};
	tokenHolders?: Array<{
		token: string;
		count: number;
	}>;
	topHolders: {
		sideA: TopHolderPnlData[];
		sideB: TopHolderPnlData[];
	};
	totals: {
		sideAValue: number;
		sideBValue: number;
		holderMarketValue: number;
		marketVolume: number;
	};
	rawScores: {
		sideA: number;
		sideB: number;
	};
	fadeBoosts: {
		fromSideA: number;
		fromSideB: number;
	};
	sharpScores: {
		sideA: number;
		sideB: number;
	};
	scoreDifferential: number;
	sharpSide: "A" | "B" | "EVEN";
	sharpSideValueRatio: number;
	pnlCoverage: {
		sideA: number;
		sideB: number;
		min: number;
	};
	concentration: {
		top1Share: number;
		top3Share: number;
	};
	warnings: string[];
	confidence: {
		base: "HIGH" | "MEDIUM" | "LOW";
		adjusted: "HIGH" | "MEDIUM" | "LOW";
	};
	edgeRating: {
		base: number;
		adjusted: number;
		penalty: number;
		diffScore: number;
		volumeBonus: number;
		qualityBonus: number;
	};
}

/**
 * Extract team names from market title
 */
function extractTeamNames(title: string): [string, string] | null {
	const vsMatch = title.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s*\?.*)?$/i);
	if (vsMatch) {
		return [vsMatch[1].trim(), vsMatch[2].trim()];
	}
	const atMatch = title.match(/^(.+?)\s+@\s+(.+?)(?:\s*\?.*)?$/i);
	if (atMatch) {
		return [atMatch[1].trim(), atMatch[2].trim()];
	}
	return null;
}

/**
 * Enhance market title for display - adds game context for generic O/U and Spread titles
 * Uses slug to extract team info when title is generic
 * e.g., "O/U 43.5" with slug "cfb-nmx-minnst-2025-12-26-total-43pt5" → "New Mexico vs. Minnesota: O/U 43.5"
 */
function enhanceMarketTitle(title: string, slug?: string): string {
	// Only enhance generic O/U or Spread titles
	const isGenericOU = /^O\/U\s+[\d.]+$/i.test(title);
	const isGenericSpread = /^Spread:\s+/i.test(title) && !title.includes(" vs");

	if (!slug || (!isGenericOU && !isGenericSpread)) {
		return title;
	}

	// Extract game info from slug
	// Format: {sport}-{team1}-{team2}-{date}-{type}
	// e.g., cfb-nmx-minnst-2025-12-26-total-43pt5, nba-cha-orl-2025-12-26-total-230pt5
	const slugMatch = slug.match(
		/^(?:cfb|nfl|nba|nhl|mlb|ncaab|epl)-([a-z0-9]+)-([a-z0-9]+)-\d{4}-\d{2}-\d{2}/i,
	);

	if (!slugMatch) {
		return title;
	}

	const team1Code = slugMatch[1].toUpperCase();
	const team2Code = slugMatch[2].toUpperCase();

	// Build enhanced title
	return `${team1Code} vs ${team2Code}: ${title}`;
}

function resolvePriceForLabel(
	label: string,
	fallbackIndex: number,
	tokenOutcomes: Array<{ outcome: string; price: number | null }>,
	fallbackPrices: [number, number],
): number | null {
	const normalized = label.trim().toLowerCase();
	const exact = tokenOutcomes.find((token) => token.outcome === normalized);
	if (exact?.price) return exact.price;
	const prefix = tokenOutcomes.find((token) =>
		token.outcome.startsWith(normalized),
	);
	if (prefix?.price) return prefix.price;
	return fallbackPrices[fallbackIndex] ?? null;
}

function clamp01(value: number): number {
	return Math.max(0.01, Math.min(0.99, value));
}

function clampUnit(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function normalizeMarketPrice(price?: number | null): number | null {
	if (typeof price !== "number" || !Number.isFinite(price)) return null;
	if (price <= 0 || price >= 1) return null;
	return price;
}

function computeMicrostructureScoreFromEntry(entry: {
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

function minPriceEdgeForConfidence(
	confidence: "HIGH" | "MEDIUM" | "LOW",
	edgeRating: number,
): number {
	const base =
		confidence === "HIGH" ? 0.02 : confidence === "MEDIUM" ? 0.03 : 0.04;
	const edgeBoost = Math.max(0, Math.min((edgeRating - 70) / 30, 1)) * 0.01;
	return Math.max(0.01, base - edgeBoost);
}

export function computePriceEdgeFromEntry(entry: {
	sharpSide: "A" | "B" | "EVEN";
	confidence: "HIGH" | "MEDIUM" | "LOW";
	edgeRating: number;
	sideA: { sharpScore: number; price?: number | null };
	sideB: { sharpScore: number; price?: number | null };
}): {
	fairPrice: number | null;
	marketPrice: number | null;
	priceEdge: number | null;
	minPriceEdge: number | null;
} {
	if (entry.sharpSide === "EVEN") {
		return {
			fairPrice: null,
			marketPrice: null,
			priceEdge: null,
			minPriceEdge: null,
		};
	}
	const totalScore = entry.sideA.sharpScore + entry.sideB.sharpScore;
	if (!Number.isFinite(totalScore) || totalScore <= 0) {
		return {
			fairPrice: null,
			marketPrice: null,
			priceEdge: null,
			minPriceEdge: minPriceEdgeForConfidence(
				entry.confidence,
				entry.edgeRating,
			),
		};
	}
	const fairPriceA = clamp01(entry.sideA.sharpScore / totalScore);
	const fairPriceB = clamp01(entry.sideB.sharpScore / totalScore);
	const fairPrice = entry.sharpSide === "A" ? fairPriceA : fairPriceB;
	const marketPrice =
		entry.sharpSide === "A" ? entry.sideA.price ?? null : entry.sideB.price ?? null;
	if (marketPrice === null || !Number.isFinite(marketPrice)) {
		return {
			fairPrice,
			marketPrice: null,
			priceEdge: null,
			minPriceEdge: minPriceEdgeForConfidence(
				entry.confidence,
				entry.edgeRating,
			),
		};
	}
	const priceEdge = fairPrice - marketPrice;
	return {
		fairPrice,
		marketPrice,
		priceEdge,
		minPriceEdge: minPriceEdgeForConfidence(entry.confidence, entry.edgeRating),
	};
}

/**
 * Fetch sports markets via Gamma API.
 */
export async function fetchTrendingSportsMarkets(
	payload: TrendingSportsPayload,
) {
	console.log("[sharp-money] fetchTrendingSportsMarkets called");
	const limit = payload.limit;
	const includeAllMarkets = payload.includeAllMarkets ?? false;
	const includeLowVolume = payload.includeLowVolume ?? false;
	const windowHours =
		typeof payload.windowHours === "number" && payload.windowHours > 0
			? payload.windowHours
			: 24;
	const minVolumeUsd =
		typeof payload.minVolumeUsd === "number" && payload.minVolumeUsd >= 0
			? payload.minVolumeUsd
			: MIN_VOLUME_USD;
	const seriesIds =
		payload.seriesIds && payload.seriesIds.length > 0
			? payload.seriesIds
			: TARGET_SPORT_SERIES_IDS;
	console.log(
		"[sharp-money] Received seriesIds:",
		payload.seriesIds,
		"→ Using:",
		seriesIds,
	);

	// Use Gamma API with tag_id filtering for sports markets
	try {
		const now = new Date();
		const endWindowMs = now.getTime() + windowHours * 60 * 60 * 1000;
		const endWindowDate = new Date(endWindowMs);
		const easternToday = getEasternDateString(now);
		const easternEnd = getEasternDateString(endWindowDate);

		console.log(
			`[sharp-money] Fetching games for ${easternToday} -> ${easternEnd} (Eastern)`,
		);
		console.log(
			`[sharp-money] Fetching markets for series IDs: ${seriesIds.join(", ")}`,
		);

		// Fetch markets for each sport series via events
		const allSportsMarkets: GammaMarket[] = [];
		const tagStats: RuntimeMarketStats["tagStats"] = [];
		const eventStats: RuntimeMarketStats["eventStats"] = [];
		const eventDetails: RuntimeMarketStats["eventDetails"] = [];
		const paginationCapHits: RuntimeMarketStats["paginationCapHits"] = [];
		let retryCount = 0;
		let failureCount = 0;
		runtimeFetchMetrics.totalRuns += 1;

		const CONCURRENCY = 3;
		const seriesQueue = [...seriesIds];
		const fetchSeries = async (seriesId: number) => {
			const tag = SERIES_ID_TO_TAG.get(seriesId) ?? `series-${seriesId}`;
			const tagMarkets: GammaMarket[] = [];

			if (!seriesId) {
				console.warn(`[sharp-money] Missing series_id for ${tag}`);
				tagStats.push({ tag, seriesId: -1, count: 0, markets: [] });
				eventStats.push({ tag, seriesId: -1, eventCount: 0, marketCount: 0 });
				return;
			}

			let expandedCount = 0;
			let eventCount = 0;
			try {
				for (let page = 0; page < GAMMA_EVENTS_MAX_PAGES; page += 1) {
					const eventsUrl = new URL("/events", POLYMARKET_GAMMA_API);
					eventsUrl.searchParams.set("series_id", seriesId.toString());
					eventsUrl.searchParams.set("tag_id", GAME_BETS_TAG_ID.toString());
					eventsUrl.searchParams.set("active", "true");
					eventsUrl.searchParams.set("closed", "false");
					eventsUrl.searchParams.set("order", "startTime");
					eventsUrl.searchParams.set("ascending", "false");
					eventsUrl.searchParams.set(
						"limit",
						GAMMA_EVENTS_PAGE_LIMIT.toString(),
					);
					eventsUrl.searchParams.set(
						"offset",
						String(page * GAMMA_EVENTS_PAGE_LIMIT),
					);

					const responseResult = await fetchWithRetry(eventsUrl.toString());
					if (!responseResult) {
						failureCount += 1;
						runtimeFetchMetrics.totalFailures += 1;
						break;
					}
					retryCount += responseResult.retries;
					if (responseResult.retries > 0) {
						runtimeFetchMetrics.totalRetries += responseResult.retries;
					}

					const events = (await responseResult.response.json()) as GammaEvent[];
					if (events.length === 0) {
						break;
					}

					eventCount += events.length;

					for (const event of events) {
						const rawMarkets = event.markets ?? [];
						if (rawMarkets.length === 0) {
							continue;
						}

						if (event.startTime) {
							const eventStart = new Date(event.startTime);
							if (Number.isNaN(eventStart.getTime())) continue;
							if (eventStart.getTime() < now.getTime()) continue;
							if (eventStart.getTime() > endWindowMs) continue;
						}

						const normalizedMarkets = rawMarkets.map((market) => ({
							...market,
							event_slug: event.slug ?? market.event_slug,
							seriesId,
							startTime: event.startTime ?? market.startTime,
						}));
						tagMarkets.push(...normalizedMarkets);
						expandedCount += normalizedMarkets.length;
						eventDetails.push({
							tag,
							seriesId,
							eventSlug: event.slug ?? "unknown",
							eventTitle: event.title ?? event.slug ?? "unknown",
							marketCount: normalizedMarkets.length,
							rawMarketCount: rawMarkets.length,
						});
					}

				}

				if (eventCount >= GAMMA_EVENTS_PAGE_LIMIT * GAMMA_EVENTS_MAX_PAGES) {
					console.warn(
						`[sharp-money] Event pagination cap hit for ${tag}. ` +
							`Fetched ${eventCount} events (${GAMMA_EVENTS_MAX_PAGES} pages).`,
					);
					paginationCapHits.push({
						tag,
						seriesId,
						eventCount,
					});
				}

				eventStats.push({
					tag,
					seriesId,
					eventCount,
					marketCount: expandedCount,
				});

				const filteredTagMarkets = tagMarkets.filter((market) => {
					const marketVolume = market.volumeNum ?? market.volume ?? 0;
					if (!includeLowVolume && marketVolume < minVolumeUsd) return false;
					return isMainMarketTitle(market.question ?? "");
				});

				tagStats.push({
					tag,
					seriesId,
					count: filteredTagMarkets.length,
					markets: filteredTagMarkets.map((market) => ({
						title: market.question ?? "",
						volume: market.volumeNum ?? market.volume ?? 0,
						eventSlug: getEventSlug(market),
						slug: market.slug ?? undefined,
					})),
				});

				allSportsMarkets.push(...tagMarkets);
			} catch (error) {
				console.warn(`[sharp-money] Failed to fetch events for ${tag}:`, error);
				tagStats.push({ tag, seriesId, count: 0, markets: [] });
				eventStats.push({ tag, seriesId, eventCount: 0, marketCount: 0 });
			}

			// Small delay between requests
			await new Promise((resolve) => setTimeout(resolve, 100));
		};

		const workers = Array.from({ length: CONCURRENCY }, async () => {
			while (seriesQueue.length > 0) {
				const next = seriesQueue.shift();
				if (next === undefined) break;
				await fetchSeries(next);
			}
		});
		await Promise.all(workers);

		console.log(
			`[sharp-money] Total sports markets found: ${allSportsMarkets.length}`,
		);

		const combinedMarkets = [...allSportsMarkets];
		const combinedByConditionId = new Map<string, GammaMarket>();
		for (const market of combinedMarkets) {
			if (
				market.conditionId &&
				!combinedByConditionId.has(market.conditionId)
			) {
				combinedByConditionId.set(market.conditionId, market);
			}
		}
		const uniqueCombinedMarkets = [...combinedByConditionId.values()];
		const sportsOnlyMarkets = uniqueCombinedMarkets.filter((market) =>
			isTargetSeriesId(market.seriesId),
		);
		const combinedTagMap = new Map<string, GammaMarket[]>();
		for (const market of uniqueCombinedMarkets) {
			const tag = SERIES_ID_TO_TAG.get(market.seriesId ?? -1) ?? "unknown";
			if (!combinedTagMap.has(tag)) combinedTagMap.set(tag, []);
			combinedTagMap.get(tag)?.push(market);
		}

		lastRuntimeMarketStats = {
			fetchedAt: Math.floor(Date.now() / 1000),
			retryCount,
			failureCount,
			totalRuns: runtimeFetchMetrics.totalRuns,
			totalRetries: runtimeFetchMetrics.totalRetries,
			totalFailures: runtimeFetchMetrics.totalFailures,
			paginationCapHits,
			tagStats,
			combinedTagStats: [...combinedTagMap.entries()].map(([tag, markets]) => ({
				tag,
				count: markets.length,
				markets: markets.map((market) => ({
					title: market.question ?? "",
					volume: market.volumeNum ?? market.volume ?? 0,
					eventSlug: getEventSlug(market),
					slug: market.slug ?? undefined,
				})),
			})),
			filteredTagStats: [],
			eventStats,
			eventDetails,
			expandedEventCount: eventStats.reduce(
				(sum, entry) => sum + entry.eventCount,
				0,
			),
			expandedMarketCount: eventStats.reduce(
				(sum, entry) => sum + entry.marketCount,
				0,
			),
			totalMarkets: sportsOnlyMarkets.length,
		};

		// Filter to markets with condition IDs, dedupe, exclude started games, and within 24 hours
		const seenIds = new Set<string>();
		const sportsMarkets = sportsOnlyMarkets.filter((market) => {
			if (!market.conditionId || seenIds.has(market.conditionId)) return false;
			const eventTime = market.startTime ?? market.endDate;
			if (eventTime) {
				const gameTime = parseEventTime(eventTime);
				if (gameTime) {
					const startBufferMs = START_TIME_BUFFER_MINUTES * 60 * 1000;
					if (gameTime.getTime() < now.getTime() - startBufferMs) return false;
					if (gameTime.getTime() > endWindowMs) return false;
				}
			}
			const marketVolume = market.volumeNum ?? market.volume ?? 0;
			if (!includeLowVolume && marketVolume < minVolumeUsd) return false;
			if (!includeAllMarkets && !isMainMarketTitle(market.question ?? ""))
				return false;
			seenIds.add(market.conditionId);
			return true;
		});
		const filteredTagMap = new Map<string, GammaMarket[]>();
		for (const market of sportsMarkets) {
			const tag = SERIES_ID_TO_TAG.get(market.seriesId ?? -1) ?? "unknown";
			if (!filteredTagMap.has(tag)) filteredTagMap.set(tag, []);
			filteredTagMap.get(tag)?.push(market);
		}
		lastRuntimeMarketStats.filteredTagStats = [...filteredTagMap.entries()].map(
			([tag, markets]) => ({
				tag,
				count: markets.length,
				markets: markets.map((market) => ({
					title: market.question ?? "",
					volume: market.volumeNum ?? market.volume ?? 0,
					eventSlug: getEventSlug(market),
					slug: market.slug ?? undefined,
				})),
			}),
		);

		// Sort by volume (highest first) for consistent, quality-focused results
		const sorted = sportsMarkets.sort((a, b) => {
			const volA = a.volumeNum ?? a.volume ?? 0;
			const volB = b.volumeNum ?? b.volume ?? 0;
			return volB - volA;
		});

		if (sorted.length > 0) {
			console.log(
				`[sharp-money] Top markets by volume:`,
				sorted
					.slice(0, 5)
					.map(
						(m) =>
							`${m.question?.slice(0, 30)} ($${((m.volumeNum ?? 0) / 1000).toFixed(0)}k)`,
					),
			);
		}

		// Take top N by volume (or all if no limit)
		const limited = typeof limit === "number" ? sorted.slice(0, limit) : sorted;
		const topMarkets = limited.map((market) => ({
			id: market.id,
			conditionId: market.conditionId,
			title: enhanceMarketTitle(market.question ?? "", market.slug),
			slug: market.slug,
			eventSlug: getEventSlug(market),
			sportSeriesId: market.seriesId,
			volume: market.volumeNum ?? market.volume ?? 0,
			liquidity: market.liquidityNum ?? market.liquidity ?? 0,
			outcomes: parseOutcomes(market.outcomes),
			bestBid: parseGammaNumber(market.bestBid),
			bestAsk: parseGammaNumber(market.bestAsk),
			endDate: market.startTime ?? market.endDate,
		}));

		return { markets: topMarkets };
	} catch (error) {
		console.warn("Error fetching trending sports markets", error);
		return { markets: [] };
	}
}

export const fetchTrendingSportsMarketsFn = createServerFn({
	method: "POST",
}).handler(async ({ data }) =>
	fetchTrendingSportsMarkets((data ?? {}) as TrendingSportsPayload),
);

/**
 * Fetch PnL for a user across multiple time periods
 */
export const fetchMultiPeriodPnlFn = createServerFn({ method: "POST" }).handler(
	async ({ data }) => {
		const payload = data as { walletAddress: string };
		const walletAddress = payload.walletAddress;

		if (!walletAddress) {
			return { pnl: null };
		}

		const periods = ["DAY", "WEEK", "MONTH", "ALL"] as const;

		try {
			// Fetch all periods in parallel
			const results = await Promise.all(
				periods.map(async (period) => {
					try {
						const url = new URL("/v1/leaderboard", POLYMARKET_DATA_API);
						url.searchParams.set("user", walletAddress);
						url.searchParams.set("timePeriod", period);

						const response = await fetch(url);

						if (!response.ok) {
							return { period, pnl: null, volume: undefined };
						}

						const data = (await response.json()) as Array<{
							pnl?: number;
							vol?: number;
						}>;

						if (!Array.isArray(data) || data.length === 0) {
							return { period, pnl: null, volume: undefined };
						}

						return {
							period,
							pnl: data[0].pnl ?? null,
							volume: data[0].vol,
						};
					} catch {
						return { period, pnl: null, volume: undefined };
					}
				}),
			);

			const pnlByPeriod: MultiPeriodPnl = {
				day: null,
				week: null,
				month: null,
				all: null,
				volume: undefined,
			};

			for (const result of results) {
				switch (result.period) {
					case "DAY":
						pnlByPeriod.day = result.pnl;
						break;
					case "WEEK":
						pnlByPeriod.week = result.pnl;
						break;
					case "MONTH":
						pnlByPeriod.month = result.pnl;
						break;
					case "ALL":
						pnlByPeriod.all = result.pnl;
						pnlByPeriod.volume = result.volume;
						break;
				}
			}

			return { pnl: pnlByPeriod };
		} catch (error) {
			console.warn("Error fetching multi-period PnL", walletAddress, error);
			return { pnl: null };
		}
	},
);

/**
 * Batch fetch multi-period PnL for multiple users
 * Processes sequentially with delays to avoid rate limits
 */
export const fetchBatchMultiPeriodPnlFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = data as { walletAddresses: string[] };
	const walletAddresses = payload.walletAddresses;

	if (!walletAddresses || walletAddresses.length === 0) {
		return { results: {} as Record<string, MultiPeriodPnl> };
	}

	const db = getDb(context);
	const results: Record<string, MultiPeriodPnl> = {};
	const uniqueWallets = [...new Set(walletAddresses)];

	// Check cache first (1 hour TTL)
	const cacheExpiry = Math.floor(Date.now() / 1000) - 3600;
	const cachedResults = await all<{
		wallet_address: string;
		pnl_day: number | null;
		pnl_week: number | null;
		pnl_month: number | null;
		pnl_all: number | null;
		volume: number | null;
	}>(
		db,
		`SELECT * FROM wallet_pnl_cache WHERE wallet_address IN (${uniqueWallets.map(() => "?").join(",")}) AND fetched_at > ?`,
		...uniqueWallets,
		cacheExpiry,
	);

	// Populate results from cache
	const cachedWallets = new Set<string>();
	for (const row of cachedResults) {
		cachedWallets.add(row.wallet_address);
		results[row.wallet_address] = {
			day: row.pnl_day,
			week: row.pnl_week,
			month: row.pnl_month,
			all: row.pnl_all,
			volume: row.volume ?? undefined,
		};
	}

	// Only fetch wallets not in cache
	const walletsToFetch = uniqueWallets.filter((w) => !cachedWallets.has(w));
	console.log(
		`[sharp-money] fetchBatchMultiPeriodPnlFn: ${cachedWallets.size} cached, ${walletsToFetch.length} to fetch`,
	);

	// Fetch uncached wallets (max 10 wallets = 40 subrequests, staying under 50 limit)
	const maxToFetch = Math.min(walletsToFetch.length, 10);
	const batchSize = 2; // Process 2 wallets at a time (8 subrequests per batch)

	for (let i = 0; i < maxToFetch; i += batchSize) {
		const batch = walletsToFetch.slice(i, i + batchSize);

		await Promise.all(
			batch.map(async (walletAddress) => {
				const periods = ["DAY", "WEEK", "MONTH", "ALL"] as const;
				const pnl: MultiPeriodPnl = {
					day: null,
					week: null,
					month: null,
					all: null,
					volume: undefined,
				};
				let walletSuccess = false;

				const periodResults = await Promise.all(
					periods.map(async (period) => {
						try {
							const url = new URL("/v1/leaderboard", POLYMARKET_DATA_API);
							url.searchParams.set("user", walletAddress);
							url.searchParams.set("timePeriod", period);

							const response = await fetch(url);

							if (!response.ok) {
								return { period, pnl: null, volume: undefined };
							}

							const data = (await response.json()) as Array<{
								pnl?: number;
								vol?: number;
							}>;

							if (!Array.isArray(data) || data.length === 0) {
								return { period, pnl: null, volume: undefined };
							}

							walletSuccess = true;
							return {
								period,
								pnl: data[0].pnl ?? null,
								volume: data[0].vol,
							};
						} catch {
							return { period, pnl: null, volume: undefined };
						}
					}),
				);

				for (const result of periodResults) {
					switch (result.period) {
						case "DAY":
							pnl.day = result.pnl;
							break;
						case "WEEK":
							pnl.week = result.pnl;
							break;
						case "MONTH":
							pnl.month = result.pnl;
							break;
						case "ALL":
							pnl.all = result.pnl;
							pnl.volume = result.volume;
							break;
					}
				}

				if (walletSuccess) {
					// Cache the result
					await run(
						db,
						`INSERT OR REPLACE INTO wallet_pnl_cache (wallet_address, pnl_day, pnl_week, pnl_month, pnl_all, volume, fetched_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
						walletAddress,
						pnl.day,
						pnl.week,
						pnl.month,
						pnl.all,
						pnl.volume ?? null,
						Math.floor(Date.now() / 1000),
					);
				}

				results[walletAddress] = pnl;
			}),
		);

		// Delay between batches to avoid rate limits
		if (i + batchSize < maxToFetch) {
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}

	return { results };
});

export const fetchWalletClosedPositionsFn = createServerFn({
	method: "POST",
}).handler(async ({ data }) => {
	const payload = data as { walletAddress: string; limit?: number };
	const walletAddress = payload.walletAddress;

	if (!walletAddress) {
		return {
			positions: [] as Array<ClosedPosition & { stake: number }>,
			unitSize: null,
		};
	}

	const limit = Math.min(
		Math.max(payload.limit ?? UNIT_SIZE_SAMPLE_LIMIT, 1),
		50,
	);

	try {
		const url = new URL("/closed-positions", POLYMARKET_DATA_API);
		url.searchParams.set("user", walletAddress);
		url.searchParams.set("limit", String(limit));
		url.searchParams.set("sortBy", "TIMESTAMP");
		url.searchParams.set("sortDirection", "DESC");

		const response = await fetch(url);
		if (!response.ok) {
			return {
				positions: [] as Array<ClosedPosition & { stake: number }>,
				unitSize: null,
			};
		}

		const data = (await response.json()) as ClosedPosition[];
		if (!Array.isArray(data) || data.length === 0) {
			return {
				positions: [] as Array<ClosedPosition & { stake: number }>,
				unitSize: null,
			};
		}

		const positions = data.map((position) => ({
			...position,
			stake: (position.totalBought ?? 0) * (position.avgPrice ?? 0),
		}));

		const stakes = positions
			.map((position) => position.stake)
			.filter((value) => Number.isFinite(value) && value > 0);
		const unitSize =
			stakes.length >= MIN_UNIT_SIZE_SAMPLES
				? calculateMedianTopHalf(stakes)
				: null;

		return { positions, unitSize };
	} catch {
		return {
			positions: [] as Array<ClosedPosition & { stake: number }>,
			unitSize: null,
		};
	}
});

export const fetchWalletOpenPositionsFn = createServerFn({
	method: "POST",
}).handler(async ({ data }) => {
	const payload = data as { walletAddress: string; limit?: number };
	const walletAddress = payload.walletAddress;

	if (!walletAddress) {
		return {
			positions: [] as Array<OpenPosition & { stake: number }>,
			unitSize: null,
		};
	}

	const limit = Math.min(
		Math.max(payload.limit ?? UNIT_SIZE_SAMPLE_LIMIT, 1),
		100,
	);

	try {
		const url = new URL("/positions", POLYMARKET_DATA_API);
		url.searchParams.set("user", walletAddress);
		url.searchParams.set("sizeThreshold", "1");
		url.searchParams.set("limit", String(limit));
		url.searchParams.set("sortBy", "INITIAL");
		url.searchParams.set("sortDirection", "DESC");

		const response = await fetch(url);
		if (!response.ok) {
			return {
				positions: [] as Array<OpenPosition & { stake: number }>,
				unitSize: null,
			};
		}

		const data = (await response.json()) as OpenPosition[];
		if (!Array.isArray(data) || data.length === 0) {
			return {
				positions: [] as Array<OpenPosition & { stake: number }>,
				unitSize: null,
			};
		}

		const positions = data.map((position) => ({
			...position,
			stake:
				position.initialValue ??
				(position.size ?? position.totalBought ?? 0) * (position.avgPrice ?? 0),
		}));

		const stakes = positions
			.map((position) => position.stake)
			.filter((value) => Number.isFinite(value) && value > 0);
		const unitSize =
			stakes.length >= MIN_UNIT_SIZE_SAMPLES
				? calculateMedianTopHalf(stakes)
				: null;

		return { positions, unitSize };
	} catch {
		return {
			positions: [] as Array<OpenPosition & { stake: number }>,
			unitSize: null,
		};
	}
});

async function fetchOpenPositionStakes(
	walletAddress: string,
	limit: number,
): Promise<number[]> {
	const url = new URL("/positions", POLYMARKET_DATA_API);
	url.searchParams.set("user", walletAddress);
	url.searchParams.set("sizeThreshold", "1");
	url.searchParams.set("limit", String(limit));
	url.searchParams.set("sortBy", "INITIAL");
	url.searchParams.set("sortDirection", "DESC");

	const response = await fetch(url);
	if (!response.ok) return [];

	const data = (await response.json()) as OpenPosition[];
	if (!Array.isArray(data) || data.length === 0) return [];

	return data
		.map(
			(position) =>
				position.initialValue ??
				(position.size ?? position.totalBought ?? 0) * (position.avgPrice ?? 0),
		)
		.filter((value) => Number.isFinite(value) && value > 0);
}

async function fetchClosedPositionStakes(
	walletAddress: string,
	limit: number,
): Promise<number[]> {
	const url = new URL("/closed-positions", POLYMARKET_DATA_API);
	url.searchParams.set("user", walletAddress);
	url.searchParams.set("limit", String(limit));
	url.searchParams.set("sortBy", "TIMESTAMP");
	url.searchParams.set("sortDirection", "DESC");

	const response = await fetch(url);
	if (!response.ok) return [];

	const data = (await response.json()) as ClosedPosition[];
	if (!Array.isArray(data) || data.length === 0) return [];

	return data
		.map((position) => (position.totalBought ?? 0) * (position.avgPrice ?? 0))
		.filter((value) => Number.isFinite(value) && value > 0);
}

async function fetchWalletUnitSize(
	walletAddress: string,
): Promise<number | null> {
	try {
		const closedStakes = await fetchClosedPositionStakes(
			walletAddress,
			UNIT_SIZE_SAMPLE_LIMIT,
		);
		const openStakes = await fetchOpenPositionStakes(
			walletAddress,
			UNIT_SIZE_POSITION_LIMIT,
		);

		const hasClosed = closedStakes.length >= MIN_UNIT_SIZE_SAMPLES;
		const hasOpen = openStakes.length >= MIN_UNIT_SIZE_SAMPLES;

		const stakes = hasClosed
			? closedStakes
			: hasOpen
				? openStakes
				: [...closedStakes, ...openStakes];

		if (stakes.length < MIN_UNIT_SIZE_SAMPLES) {
			return null;
		}

		return (
			calculateMedianTopN(stakes, UNIT_SIZE_TOP_SAMPLE) ??
			calculateMedianTopHalf(stakes)
		);
	} catch {
		return null;
	}
}

/**
 * Calculate momentum weight based on recent PnL performance
 * Higher weight = hotter streak
 */
function calculateMomentumWeight(pnl: MultiPeriodPnl): number {
	const dayPositive = (pnl.day ?? 0) > 0;
	const weekPositive = (pnl.week ?? 0) > 0;
	const monthPositive = (pnl.month ?? 0) > 0;

	// Hot streak: positive day + positive week
	if (dayPositive && weekPositive) {
		return 1.5;
	}

	// Consistent: positive week + positive month
	if (weekPositive && monthPositive) {
		return 1.2;
	}

	// Recent positive
	if (dayPositive || weekPositive) {
		return 1.1;
	}

	// Neutral or mixed
	if (monthPositive) {
		return 1.0;
	}

	// Cold streak
	const dayNegative = (pnl.day ?? 0) < 0;
	const weekNegative = (pnl.week ?? 0) < 0;

	if (dayNegative && weekNegative) {
		return 0.5;
	}

	return 0.8;
}

/**
 * Calculate PnL tier weight based on all-time profitability
 * Higher weight = more profitable trader
 */
function calculatePnlTierWeight(
	pnlAll: number | null,
	pnlAllUnits?: number | null,
): number {
	const useUnits = pnlAllUnits !== null && pnlAllUnits !== undefined;
	const value = useUnits ? pnlAllUnits : pnlAll;

	if (value === null || value === undefined) {
		return 1.0;
	}

	if (useUnits) {
		// Unit-based tiers
		if (value >= 30) {
			return 2.0;
		}

		if (value >= 15) {
			return 1.7;
		}

		if (value >= 7) {
			return 1.4;
		}

		if (value >= 3) {
			return 1.2;
		}

		if (value >= 0) {
			return 1.0;
		}

		if (value >= -3) {
			return 0.9;
		}

		if (value >= -7) {
			return 0.8;
		}

		if (value >= -15) {
			return 0.7;
		}

		if (value >= -30) {
			return 0.6;
		}

		return 0.5;
	}

	// Whale sharp: >$100k profit
	if (value >= 100_000) {
		return 2.0;
	}

	// Solid sharp: $10k-$100k profit
	if (value >= 10_000) {
		return 1.5;
	}

	// Minor positive: $0-$10k profit
	if (value >= 0) {
		return 1.0;
	}

	// Losing trader: negative PnL (potential fade signal)
	if (value >= -10_000) {
		return 0.8;
	}

	// Big loser
	return 0.7;
}

/**
 * Calculate "fade boost" from anti-sharps on one side
 * Anti-sharps are big losers on cold streaks - betting against them is valuable
 * Returns a multiplier (1.0 = no boost, 1.15 = 15% boost)
 */
function calculateFadeBoost(
	holders: TopHolderPnlData[],
	totalValue: number,
): number {
	if (holders.length === 0 || totalValue <= 0) {
		return 1.0;
	}

	const effectiveTotalValue = holders.reduce(
		(sum, holder) => sum + holder.amount * (holder.stakeUnitWeight ?? 1),
		0,
	);

	let fadeBoostSum = 0;

	for (const holder of holders) {
		const hasUnitPnl =
			holder.pnlAllUnits !== null && holder.pnlAllUnits !== undefined;
		const pnlAll = hasUnitPnl
			? (holder.pnlAllUnits ?? 0)
			: (holder.pnlAll ?? 0);
		const isOnColdStreak = holder.momentumWeight <= 0.5; // Day + Week negative

		// Only count as anti-sharp if big loser AND on cold streak
		const mildLoss = hasUnitPnl ? -7 : -50_000;
		const moderateLoss = hasUnitPnl ? -15 : -100_000;
		const severeLoss = hasUnitPnl ? -30 : -250_000;

		if (pnlAll < mildLoss && isOnColdStreak) {
			const positionWeight =
				effectiveTotalValue > 0
					? (holder.amount * (holder.stakeUnitWeight ?? 1)) /
						effectiveTotalValue
					: holder.amount / totalValue;

			// Fade boost based on how much they've lost
			let fadeMultiplier = 0;
			if (pnlAll < severeLoss) {
				fadeMultiplier = 0.18; // Severe loser: 18% boost to other side
			} else if (pnlAll < moderateLoss) {
				fadeMultiplier = 0.12; // Moderate loser: 12% boost
			} else {
				fadeMultiplier = 0.07; // Mild loser: 7% boost
			}

			// Weight by their position size (bigger position = stronger fade signal)
			fadeBoostSum += positionWeight * fadeMultiplier;
		}
	}

	// Cap total fade boost at 30%
	return 1.0 + Math.min(fadeBoostSum, 0.3);
}

/**
 * Calculate sharp score for a side
 * Returns 0-100 scale
 */
function calculateSharpScore(
	holders: TopHolderPnlData[],
	totalValue: number,
): number {
	if (holders.length === 0 || totalValue <= 0) {
		return 50; // Neutral score
	}

	const effectiveTotalValue = holders.reduce(
		(sum, holder) => sum + holder.amount * (holder.stakeUnitWeight ?? 1),
		0,
	);

	let weightedSum = 0;

	for (const holder of holders) {
		const positionWeight =
			effectiveTotalValue > 0
				? (holder.amount * (holder.stakeUnitWeight ?? 1)) / effectiveTotalValue
				: holder.amount / totalValue;
		const combinedWeight = holder.momentumWeight * holder.pnlTierWeight;
		weightedSum += positionWeight * combinedWeight;
	}

	// Normalize to 0-100 scale
	// Average weight is ~1.0, max is 3.0 (1.5 * 2.0), min is 0.25 (0.5 * 0.5)
	// Scale so that 1.0 = 50, 3.0 = 100, 0.25 = 0
	const normalized = ((weightedSum - 0.25) / (3.0 - 0.25)) * 100;
	return Math.max(0, Math.min(100, normalized));
}

/**
 * Determine confidence level based on score differential and conviction
 */
function determineConfidence(
	scoreDiff: number,
	sideAHolderCount: number,
	sideBHolderCount: number,
	sharpSideValueRatio: number, // 0-1, what % of total value is on the sharp side
): "HIGH" | "MEDIUM" | "LOW" {
	const minHolders = Math.min(sideAHolderCount, sideBHolderCount);

	// Need at least 3 holders on each side for any confidence
	if (minHolders < 3) {
		return "LOW";
	}

	// Calculate base confidence from score differential
	let baseConfidence: "HIGH" | "MEDIUM" | "LOW" = "LOW";

	if (scoreDiff >= 15 && minHolders >= 5) {
		baseConfidence = "HIGH";
	} else if (scoreDiff >= 8) {
		baseConfidence = "MEDIUM";
	}

	// Downgrade confidence if sharp side has very low conviction (< 15% of total value)
	// This catches cases like Jets: $8.8K vs Patriots: $71.8K (Jets = 10.9%)
	if (sharpSideValueRatio < 0.15) {
		if (baseConfidence === "HIGH") return "MEDIUM";
		if (baseConfidence === "MEDIUM") return "LOW";
	}
	// Also downgrade if sharp side has < 25% and trying to be HIGH
	else if (sharpSideValueRatio < 0.25 && baseConfidence === "HIGH") {
		return "MEDIUM";
	}

	return baseConfidence;
}

/**
 * Calculate Edge Rating (0-100) for ranking bets
 * Primary factor: Sharp score differential (logarithmic curve - diminishing returns)
 * Secondary: Holder quality based on recent + long-term PnL performance
 * Minimal: Volume (small bonus, mainly used for filtering - volume already indicates big holders)
 */
function calculateEdgeRatingBreakdown(
	scoreDifferential: number,
	sharpSideTopHolders: TopHolderPnlData[],
	totalVolume: number,
): {
	diffScore: number;
	volumeBonus: number;
	qualityBonus: number;
	total: number;
} {
	// Base rating from score differential using logarithmic curve (max 70 points)
	// Logarithmic scaling: early diffs matter more, higher diffs have diminishing returns
	// Formula: 70 * (1 - e^(-diff/25)) gives us:
	// - diff 10 → ~24 points
	// - diff 20 → ~42 points
	// - diff 30 → ~55 points
	// - diff 40 → ~64 points
	// - diff 50+ → ~70 points (approaching max)
	const diffScore = 70 * (1 - Math.exp(-scoreDifferential / 25));

	// Volume bonus (max 5 points) - minimal weight, mainly for filtering
	// Just a small bonus to slightly prefer higher volume events
	// $200K+ volume = max bonus, logarithmic scale
	const volumeBonus = 5 * (1 - Math.exp(-totalVolume / 100_000));

	// Holder quality bonus/penalty (-15 to +20 points)
	// Combines recent momentum (day/week/month) AND all-time performance, unit-normalized
	// Position-weighted: larger positions from better traders matter more
	let qualityBonus = 0;
	if (sharpSideTopHolders.length > 0) {
		// Calculate total position value for weighting
		const totalPositionValue = sharpSideTopHolders.reduce(
			(sum, h) => sum + h.amount * (h.stakeUnitWeight ?? 1),
			0,
		);

		if (totalPositionValue > 0) {
			let weightedQualitySum = 0;

			for (const holder of sharpSideTopHolders) {
				// Time-weighted recent performance: day 30%, week 40%, month 30%
				// Week is most reliable (less noisy than day, more current than month)
				// Day still matters but less weight since it's noisy
				const dayPnL = normalizePnl(holder.pnlDay ?? null, holder.unitSize) ?? 0;
				const weekPnL =
					normalizePnl(holder.pnlWeek ?? null, holder.unitSize) ?? 0;
				const monthPnL =
					normalizePnl(holder.pnlMonth ?? null, holder.unitSize) ?? 0;

				// Weighted recent PnL: day 30%, week 40%, month 30%
				const recentPnL = dayPnL * 0.3 + weekPnL * 0.4 + monthPnL * 0.3;

				// Long-term performance weight (60%): all-time PnL
				const longTermPnL =
					holder.pnlAllUnits ??
					normalizePnl(holder.pnlAll ?? null, holder.unitSize) ??
					0;

				// Combined quality score: 40% recent, 60% long-term
				const holderQuality = recentPnL * 0.4 + longTermPnL * 0.6;

				// Weight by position size (larger positions = more influence)
				const positionWeight =
					(holder.amount * (holder.stakeUnitWeight ?? 1)) / totalPositionValue;
				weightedQualitySum += holderQuality * positionWeight;
			}

			// Only apply quality bonus if average quality exceeds threshold (units)
			// This avoids rewarding marginal quality
			const QUALITY_THRESHOLD = 3;

			if (weightedQualitySum >= QUALITY_THRESHOLD) {
				// Positive avg: bonus up to 20 points (30+ units avg = max)
				// Logarithmic curve for diminishing returns
				qualityBonus =
					20 * (1 - Math.exp(-Math.min(weightedQualitySum, 30) / 15));
			} else if (weightedQualitySum < 0) {
				// Negative avg: penalty up to -15 points (-15 units or worse = max penalty)
				// Linear penalty for negative performance
				qualityBonus = Math.max(weightedQualitySum, -15);
			}
			// If between 0 and threshold, no bonus/penalty (neutral)
		}
	}

	const total = diffScore + volumeBonus + qualityBonus;
	return { diffScore, volumeBonus, qualityBonus, total };
}

function getPnlCoverage(holders: TopHolderPnlData[]): number {
	if (holders.length === 0) return 0;
	const withPnl = holders.filter((holder) => {
		return (
			holder.pnlDay !== null ||
			holder.pnlWeek !== null ||
			holder.pnlMonth !== null ||
			holder.pnlAll !== null
		);
	}).length;
	return withPnl / holders.length;
}

function downgradeConfidence(
	confidence: "HIGH" | "MEDIUM" | "LOW",
): "HIGH" | "MEDIUM" | "LOW" {
	if (confidence === "HIGH") return "MEDIUM";
	if (confidence === "MEDIUM") return "LOW";
	return "LOW";
}

function getConcentration(
	holders: TopHolderPnlData[],
	totalValue: number,
): { top1Share: number; top3Share: number } {
	if (holders.length === 0 || totalValue <= 0) {
		return { top1Share: 0, top3Share: 0 };
	}
	const sorted = holders.slice().sort((a, b) => b.amount - a.amount);
	const top1 = sorted[0]?.amount ?? 0;
	const top3 = sorted
		.slice(0, 3)
		.reduce((sum, holder) => sum + holder.amount, 0);
	return {
		top1Share: top1 / totalValue,
		top3Share: top3 / totalValue,
	};
}

/**
 * Analyze sharp money for a single market
 */
export async function analyzeMarketSharpness(
	env: Env,
	payload: SharpAnalysisPayload,
) {
	console.log("[sharp-money] analyzeMarketSharpness called");
	const db = env.POLYWHALER_DB;

	const {
		conditionId,
		marketTitle,
		marketSlug,
		eventSlug,
		sportSeriesId,
		outcomes,
		bestBid,
		bestAsk,
		endDate,
		marketVolume,
		marketLiquidity,
		includeDebug,
	} = payload;
	console.log("[sharp-money] Analyzing:", { conditionId, marketTitle });

	if (!conditionId) {
		return { analysis: null, error: "No condition ID provided" };
	}

	try {
		// Step 1: Fetch market prices and holders in parallel
		console.log("[sharp-money] Fetching market prices and holders...");

		const holdersUrl = new URL("/holders", POLYMARKET_DATA_API);
		holdersUrl.searchParams.set("market", conditionId);
		holdersUrl.searchParams.set("limit", "200"); // Higher limit to reduce side imbalance after grouping
		holdersUrl.searchParams.set("minBalance", "1");

		// Use CLOB API for accurate prices (Gamma API condition_id lookup is unreliable)
		const clobMarketUrl = `https://clob.polymarket.com/markets/${conditionId}`;

		const [holdersResponse, clobResponse] = await Promise.all([
			fetch(holdersUrl),
			fetch(clobMarketUrl),
		]);

		if (!holdersResponse.ok) {
			return {
				analysis: null,
				error: `Failed to fetch holders: ${holdersResponse.status}`,
			};
		}

		const normalizeOutcome = (value?: string | null) =>
			value?.trim().toLowerCase() ?? "";
		const normalizePrice = (value: unknown): number | null => {
			if (typeof value !== "number" || !Number.isFinite(value)) {
				return null;
			}
			if (value <= 0 || value >= 1) {
				return null;
			}
			return value;
		};

		const pickValuePrice = (token: {
			price?: number;
			bestAsk?: number;
			best_ask?: number;
		}) =>
			normalizePrice(token.price) ??
			normalizePrice(token.bestAsk) ??
			normalizePrice(token.best_ask);

		const pickDisplayPrice = (token: {
			bestAsk?: number;
			best_ask?: number;
			price?: number;
		}) =>
			normalizePrice(token.bestAsk) ??
			normalizePrice(token.best_ask) ??
			normalizePrice(token.price);

		// Parse market prices from CLOB API (prices are 0-1, e.g. 0.65 = $0.65 per share)
		let valuePrices: [number, number] = [1, 1]; // For USD conversion of holder size
		let displayPrices: [number, number] = [1, 1]; // For odds display
		const tokenOutcomes: Array<{ outcome: string; price: number | null }> = [];
		let hasOrderbookPrices = false;

		const normalizedBestAsk = normalizePrice(bestAsk);
		const normalizedBestBid = normalizePrice(bestBid);
		const orderbookPrices = (() => {
			if (normalizedBestAsk && normalizedBestBid) {
				return {
					priceA: normalizedBestAsk,
					priceB: normalizePrice(1 - normalizedBestBid),
				};
			}
			if (normalizedBestAsk) {
				return {
					priceA: normalizedBestAsk,
					priceB: normalizePrice(1 - normalizedBestAsk),
				};
			}
			if (normalizedBestBid) {
				return {
					priceA: normalizedBestBid,
					priceB: normalizePrice(1 - normalizedBestBid),
				};
			}
			return null;
		})();

		if (orderbookPrices?.priceA && orderbookPrices?.priceB) {
			displayPrices = [orderbookPrices.priceA, orderbookPrices.priceB];
			valuePrices = [orderbookPrices.priceA, orderbookPrices.priceB];
			hasOrderbookPrices = true;
			if (outcomes && outcomes.length >= 2) {
				tokenOutcomes.push(
					{ outcome: normalizeOutcome(outcomes[0]), price: displayPrices[0] },
					{ outcome: normalizeOutcome(outcomes[1]), price: displayPrices[1] },
				);
			}
		}
		if (clobResponse.ok) {
			const clobData = (await clobResponse.json()) as {
				tokens?: Array<{
					outcome: string;
					price?: number;
					bestAsk?: number;
					best_ask?: number;
				}>;
			};
			if (clobData?.tokens && clobData.tokens.length >= 2) {
				const parsedTokens = clobData.tokens.map((token) => ({
					outcome: token.outcome,
					valuePrice: pickValuePrice(token),
					displayPrice: pickDisplayPrice(token),
				}));

				valuePrices = [
					parsedTokens[0]?.valuePrice ?? valuePrices[0],
					parsedTokens[1]?.valuePrice ?? valuePrices[1],
				];
				if (!hasOrderbookPrices) {
					displayPrices = [
						parsedTokens[0]?.displayPrice ?? valuePrices[0],
						parsedTokens[1]?.displayPrice ?? valuePrices[1],
					];
				}
				if (tokenOutcomes.length === 0) {
					parsedTokens.forEach((token) => {
						tokenOutcomes.push({
							outcome: normalizeOutcome(token.outcome),
							price: token.displayPrice ?? token.valuePrice ?? null,
						});
					});
				}
				console.log("[sharp-money] Prices:", displayPrices);
			}
		}

		let holdersData = (await holdersResponse.json()) as Array<{
			token: string;
			holders: Array<{
				proxyWallet: string;
				name?: string;
				pseudonym?: string;
				amount: number;
				outcomeIndex: number;
				profileImage?: string;
				profileImageOptimized?: string;
			}>;
		}>;

		if (!holdersData || holdersData.length === 0) {
			return { analysis: null, error: "No holders data" };
		}

			// Re-fetch holders per token to avoid market-level limit skewing sides
			const tokenIds = holdersData
				.map((tokenData) => tokenData.token)
				.filter(Boolean);
			type TokenHolder = {
				proxyWallet: string;
				name?: string;
				pseudonym?: string;
				amount: number;
				outcomeIndex?: number;
				profileImage?: string;
				profileImageOptimized?: string;
			};
			let tokenHoldersCounts: Array<{ token: string; count: number }> | undefined;
			if (tokenIds.length > 0) {
				const tokenHoldersResults = await Promise.all(
				tokenIds.map(async (tokenId) => {
					try {
						const tokenUrl = new URL("/holders", POLYMARKET_DATA_API);
						tokenUrl.searchParams.set("token", tokenId);
							tokenUrl.searchParams.set("limit", "100");
							tokenUrl.searchParams.set("minBalance", "1");
							const tokenResponse = await fetch(tokenUrl);
							if (!tokenResponse.ok) return null;
							const tokenResponseData = (await tokenResponse.json()) as {
								holders?: TokenHolder[];
							};
						if (
							!tokenResponseData.holders ||
							tokenResponseData.holders.length === 0
						)
							return null;
						return { token: tokenId, holders: tokenResponseData.holders };
					} catch (error) {
						console.warn(
							`[sharp-money] Failed to fetch holders for token ${tokenId}:`,
							error,
						);
						return null;
					}
				}),
			);

				const filteredResults = tokenHoldersResults.filter(
					(result): result is { token: string; holders: TokenHolder[] } =>
						Boolean(result),
				);

			if (filteredResults.length > 0) {
				holdersData = filteredResults;
				tokenHoldersCounts = filteredResults.map((result) => ({
					token: result.token,
					count: result.holders.length,
				}));
				console.log(
					`[sharp-money] Using per-token holders: ${filteredResults.length} tokens`,
				);
			}
		}

		// The API returns holders grouped by token, but limit applies to total across all tokens
		// Sort holders within each token group by amount (descending) and take top 50 per token
		for (const tokenData of holdersData) {
			tokenData.holders.sort((a, b) => b.amount - a.amount);
			tokenData.holders = tokenData.holders.slice(0, 50); // Take top 50 per token
		}

		// Step 2: Group holders by outcomeIndex (0 or 1) for consistent assignment
		// outcomeIndex 0 = first outcome (typically Yes or first team)
		// outcomeIndex 1 = second outcome (typically No or second team)
		// Convert shares to USD using market prices
		const sideAHolders: HolderWithPnl[] = [];
		const sideBHolders: HolderWithPnl[] = [];
		const allWallets = new Set<string>();

		// Flatten all holders and group by outcomeIndex
		for (const tokenData of holdersData) {
			for (const holder of tokenData.holders) {
				allWallets.add(holder.proxyWallet);

				// Convert shares to USD: shares * price
				const priceForOutcome = valuePrices[holder.outcomeIndex] ?? 1;
				const usdValue = holder.amount * priceForOutcome;

				const holderData: HolderWithPnl = {
					proxyWallet: holder.proxyWallet,
					name: holder.name,
					pseudonym: holder.pseudonym,
					profileImage: holder.profileImageOptimized || holder.profileImage,
					amount: usdValue, // Now in USD instead of shares
					outcomeIndex: holder.outcomeIndex,
				};

				// Use outcomeIndex to determine side (0 = sideA, 1 = sideB)
				if (holder.outcomeIndex === 0) {
					sideAHolders.push(holderData);
				} else {
					sideBHolders.push(holderData);
				}
			}
		}

		// Step 3: Sort holders by position size (descending) before taking top 20
		sideAHolders.sort((a, b) => b.amount - a.amount);
		sideBHolders.sort((a, b) => b.amount - a.amount);

		// Fetch PnL for top holders on each side (top 20 each for scoring = 40 wallets)
		const topWallets = [
			...sideAHolders.slice(0, 20).map((h) => h.proxyWallet),
			...sideBHolders.slice(0, 20).map((h) => h.proxyWallet),
		];

		const uniqueWallets = [...new Set(topWallets)];
		const pnlResults: Record<string, MultiPeriodPnl> = {};

		// Check cache first (1 hour TTL) - this doesn't count as subrequests
		const cacheExpiry = Math.floor(Date.now() / 1000) - 3600;
		const cachedResults = await all<{
			wallet_address: string;
			pnl_day: number | null;
			pnl_week: number | null;
			pnl_month: number | null;
			pnl_all: number | null;
			volume: number | null;
		}>(
			db,
			`SELECT * FROM wallet_pnl_cache WHERE wallet_address IN (${uniqueWallets.map(() => "?").join(",")}) AND fetched_at > ?`,
			...uniqueWallets,
			cacheExpiry,
		);

		// Populate results from cache
		const cachedWallets = new Set<string>();
		for (const row of cachedResults) {
			cachedWallets.add(row.wallet_address);
			pnlResults[row.wallet_address] = {
				day: row.pnl_day,
				week: row.pnl_week,
				month: row.pnl_month,
				all: row.pnl_all,
				volume: row.volume ?? undefined,
			};
		}

		// Only fetch wallets not in cache
		const walletsToFetch = uniqueWallets.filter((w) => !cachedWallets.has(w));
		console.log(
			`[sharp-money] PnL: ${cachedWallets.size} cached, ${walletsToFetch.length} to fetch`,
		);

		// Fetch uncached wallets in batches with a mix of full-period and ALL-only requests.
		// We have 2 subrequests used for market data (holders + CLOB).
		const FULL_PNL_WALLET_COUNT = 6;
		const ALL_PNL_WALLET_COUNT = 20;
		const maxWalletsByBudget =
			Math.max(0, MAX_SUBREQUESTS - 2 - FULL_PNL_WALLET_COUNT * 4) +
			FULL_PNL_WALLET_COUNT;
		const totalWalletsToFetch = Math.min(
			walletsToFetch.length,
			ALL_PNL_WALLET_COUNT,
			maxWalletsByBudget,
		);
		const walletsToFetchAll = walletsToFetch.slice(0, totalWalletsToFetch);
		const walletsFullPnl = walletsToFetchAll.slice(
			0,
			Math.min(FULL_PNL_WALLET_COUNT, walletsToFetchAll.length),
		);
		const walletsAllOnly = walletsToFetchAll.slice(walletsFullPnl.length);

		console.log(
			`[sharp-money] PnL fetch plan: ${walletsFullPnl.length} full, ${walletsAllOnly.length} all-time only`,
		);

		const fullBatchSize = 3; // Process 3 wallets at a time (12 subrequests per batch)
		for (let i = 0; i < walletsFullPnl.length; i += fullBatchSize) {
			const batch = walletsFullPnl.slice(i, i + fullBatchSize);

			await Promise.all(
				batch.map(async (wallet) => {
					const periods = ["DAY", "WEEK", "MONTH", "ALL"] as const;
					const pnl: MultiPeriodPnl = {
						day: null,
						week: null,
						month: null,
						all: null,
					};
					let walletSuccess = false;

					await Promise.all(
						periods.map(async (period) => {
							try {
								const url = new URL("/v1/leaderboard", POLYMARKET_DATA_API);
								url.searchParams.set("user", wallet);
								url.searchParams.set("timePeriod", period);

								const response = await fetch(url);
								if (!response.ok) return;

								const data = (await response.json()) as Array<{
									pnl?: number;
									vol?: number;
								}>;
								if (!Array.isArray(data) || data.length === 0) return;

								walletSuccess = true;
								switch (period) {
									case "DAY":
										pnl.day = data[0].pnl ?? null;
										break;
									case "WEEK":
										pnl.week = data[0].pnl ?? null;
										break;
									case "MONTH":
										pnl.month = data[0].pnl ?? null;
										break;
									case "ALL":
										pnl.all = data[0].pnl ?? null;
										pnl.volume = data[0].vol;
										break;
								}
							} catch (err) {
								console.log(
									`[sharp-money] PnL error ${wallet.slice(0, 10)} ${period}:`,
									err,
								);
							}
						}),
					);

					if (walletSuccess) {
						// Cache the result
						await run(
							db,
							`INSERT OR REPLACE INTO wallet_pnl_cache (wallet_address, pnl_day, pnl_week, pnl_month, pnl_all, volume, fetched_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
							wallet,
							pnl.day,
							pnl.week,
							pnl.month,
							pnl.all,
							pnl.volume ?? null,
							Math.floor(Date.now() / 1000),
						);
					}
					pnlResults[wallet] = pnl;
				}),
			);

			// Delay between batches
			if (i + fullBatchSize < walletsFullPnl.length) {
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
		}

		const allOnlyBatchSize = 6;
		for (let i = 0; i < walletsAllOnly.length; i += allOnlyBatchSize) {
			const batch = walletsAllOnly.slice(i, i + allOnlyBatchSize);

			await Promise.all(
				batch.map(async (wallet) => {
					const pnl: MultiPeriodPnl = {
						day: null,
						week: null,
						month: null,
						all: null,
					};
					try {
						const url = new URL("/v1/leaderboard", POLYMARKET_DATA_API);
						url.searchParams.set("user", wallet);
						url.searchParams.set("timePeriod", "ALL");

						const response = await fetch(url);
						if (!response.ok) return;

						const data = (await response.json()) as Array<{
							pnl?: number;
							vol?: number;
						}>;
						if (!Array.isArray(data) || data.length === 0) return;

						pnl.all = data[0].pnl ?? null;
						pnl.volume = data[0].vol;

						await run(
							db,
							`INSERT OR REPLACE INTO wallet_pnl_cache (wallet_address, pnl_day, pnl_week, pnl_month, pnl_all, volume, fetched_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
							wallet,
							null,
							null,
							null,
							pnl.all,
							pnl.volume ?? null,
							Math.floor(Date.now() / 1000),
						);
					} catch (err) {
						console.log(
							`[sharp-money] PnL error ${wallet.slice(0, 10)} ALL:`,
							err,
						);
					}
					pnlResults[wallet] = pnl;
				}),
			);

			if (i + allOnlyBatchSize < walletsAllOnly.length) {
				await new Promise((resolve) => setTimeout(resolve, 150));
			}
		}

		// For wallets we couldn't fetch this time, use null PnL (they'll be cached next refresh)
		for (const wallet of uniqueWallets) {
			if (!pnlResults[wallet]) {
				pnlResults[wallet] = { day: null, week: null, month: null, all: null };
			}
		}

		const pnlSubrequestsUsed =
			walletsFullPnl.length * 4 + walletsAllOnly.length;
		console.log(
			`[sharp-money] PnL fetch: ${walletsToFetchAll.length} fetched, ${cachedWallets.size} from cache, ${uniqueWallets.length - walletsToFetchAll.length - cachedWallets.size} will be cached next refresh`,
		);

		const unitSizeByWallet: Record<string, number | null> = {};
		const unitSizeCacheExpiry =
			Math.floor(Date.now() / 1000) - UNIT_SIZE_CACHE_TTL_SEC;
		const cachedUnitSizeRows = await all<{
			wallet_address: string;
			unit_size: number | null;
		}>(
			db,
			`SELECT wallet_address, unit_size FROM wallet_unit_size_cache WHERE wallet_address IN (${uniqueWallets.map(() => "?").join(",")}) AND fetched_at > ?`,
			...uniqueWallets,
			unitSizeCacheExpiry,
		);

		const cachedUnitWallets = new Set<string>();
		for (const row of cachedUnitSizeRows) {
			cachedUnitWallets.add(row.wallet_address);
			unitSizeByWallet[row.wallet_address] = row.unit_size ?? null;
		}

		const walletsWithPnlAll = uniqueWallets.filter((wallet) => {
			const pnl = pnlResults[wallet];
			return pnl?.all !== null && pnl?.all !== undefined;
		});

		const unitSizeBudget = Math.max(
			0,
			MAX_SUBREQUESTS - 2 - pnlSubrequestsUsed,
		);
		const walletsMissingUnitSize = walletsWithPnlAll.filter(
			(wallet) => !cachedUnitWallets.has(wallet),
		);
		const walletsToFetchUnitSize = walletsMissingUnitSize.slice(
			0,
			unitSizeBudget,
		);
		const unitBatchSize = 4;

		for (let i = 0; i < walletsToFetchUnitSize.length; i += unitBatchSize) {
			const batch = walletsToFetchUnitSize.slice(i, i + unitBatchSize);

			await Promise.all(
				batch.map(async (wallet) => {
					const unitSize = await fetchWalletUnitSize(wallet);
					await run(
						db,
						`INSERT OR REPLACE INTO wallet_unit_size_cache (wallet_address, unit_size, fetched_at)
               VALUES (?, ?, ?)`,
						wallet,
						unitSize,
						Math.floor(Date.now() / 1000),
					);
					unitSizeByWallet[wallet] = unitSize;
				}),
			);

			if (i + unitBatchSize < walletsToFetchUnitSize.length) {
				await new Promise((resolve) => setTimeout(resolve, 150));
			}
		}

		// Step 4: Calculate weights and build top holder data (top 20 for scoring, display top 5)
		const processHolders = (holders: HolderWithPnl[]): TopHolderPnlData[] => {
			return holders.slice(0, 20).map((holder) => {
				const pnl = pnlResults[holder.proxyWallet] ?? {
					day: null,
					week: null,
					month: null,
					all: null,
				};

				const momentumWeight = calculateMomentumWeight(pnl);
				const unitSize = unitSizeByWallet[holder.proxyWallet] ?? null;
				const pnlAllUnits = normalizePnl(pnl.all, unitSize);
				const pnlTierWeight = calculatePnlTierWeight(pnl.all, pnlAllUnits);
				const stakeUnits = normalizePnl(holder.amount, unitSize);
				const stakeUnitWeight = calculateStakeUnitWeight(stakeUnits);

				return {
					proxyWallet: holder.proxyWallet,
					name: holder.name,
					pseudonym: holder.pseudonym,
					profileImage: holder.profileImage,
					amount: holder.amount,
					pnlDay: pnl.day,
					pnlWeek: pnl.week,
					pnlMonth: pnl.month,
					pnlAll: pnl.all,
					pnlAllUnits,
					unitSize,
					stakeUnits,
					stakeUnitWeight,
					volume: pnl.volume,
					momentumWeight,
					pnlTierWeight,
				};
			});
		};

		const sideATopHolders = processHolders(sideAHolders);
		const sideBTopHolders = processHolders(sideBHolders);

		// Step 5: Calculate totals and scores
		const sideATotalValue = sideAHolders.reduce((sum, h) => sum + h.amount, 0);
		const sideBTotalValue = sideBHolders.reduce((sum, h) => sum + h.amount, 0);
		const holderMarketValue = sideATotalValue + sideBTotalValue;
		const marketVolumeForBonus = Math.max(
			0,
			marketLiquidity ?? marketVolume ?? holderMarketValue,
		);

		// Calculate raw sharp scores
		const sideARawScore = calculateSharpScore(sideATopHolders, sideATotalValue);
		const sideBRawScore = calculateSharpScore(sideBTopHolders, sideBTotalValue);

		// Calculate fade boosts (anti-sharps on one side boost the other side)
		const fadeBoostFromSideA = calculateFadeBoost(
			sideATopHolders,
			sideATotalValue,
		);
		const fadeBoostFromSideB = calculateFadeBoost(
			sideBTopHolders,
			sideBTotalValue,
		);

		// Apply fade boosts: anti-sharps on A boost B's score, and vice versa
		const sideASharpScore = Math.min(100, sideARawScore * fadeBoostFromSideB);
		const sideBSharpScore = Math.min(100, sideBRawScore * fadeBoostFromSideA);

		const scoreDifferential = Math.abs(sideASharpScore - sideBSharpScore);

		// Determine labels
		// Check for special market types first
		const isOverUnder = /O\/U|Over\/Under|over\/under/i.test(marketTitle);
		const isSpread = /Spread:/i.test(marketTitle);

		let sideALabel: string;
		let sideBLabel: string;

		if (isOverUnder) {
			// O/U markets: use Over/Under labels
			sideALabel = "Over";
			sideBLabel = "Under";
		} else if (isSpread) {
			// Spread markets: use the outcomes from API (e.g., "Patriots", "Jets")
			sideALabel = outcomes?.[0] ?? "Yes";
			sideBLabel = outcomes?.[1] ?? "No";
		} else {
			// Regular game markets: extract team names from title
			const teamNames = extractTeamNames(marketTitle);
			sideALabel = teamNames ? teamNames[0] : (outcomes?.[0] ?? "Yes");
			sideBLabel = teamNames ? teamNames[1] : (outcomes?.[1] ?? "No");
		}

		// Determine sharp side
		let sharpSide: "A" | "B" | "EVEN" = "EVEN";
		if (sideASharpScore > sideBSharpScore + 5) {
			sharpSide = "A";
		} else if (sideBSharpScore > sideASharpScore + 5) {
			sharpSide = "B";
		}

		// Calculate sharp side's value ratio (conviction)
		let sharpSideValueRatio = 0.5; // Default to 50% if even
		if (sharpSide === "A" && holderMarketValue > 0) {
			sharpSideValueRatio = sideATotalValue / holderMarketValue;
		} else if (sharpSide === "B" && holderMarketValue > 0) {
			sharpSideValueRatio = sideBTotalValue / holderMarketValue;
		}

		const confidence = determineConfidence(
			scoreDifferential,
			sideAHolders.length,
			sideBHolders.length,
			sharpSideValueRatio,
		);

		const pnlCoverage = Math.min(
			getPnlCoverage(sideATopHolders),
			getPnlCoverage(sideBTopHolders),
		);
		let adjustedConfidence = confidence;
		let edgePenalty = 1.0;
		const warnings: string[] = [];

		if (pnlCoverage < 0.4) {
			adjustedConfidence = "LOW";
			edgePenalty = 0.7;
			warnings.push("low_pnl_coverage");
		} else if (pnlCoverage < 0.6) {
			adjustedConfidence = downgradeConfidence(adjustedConfidence);
			edgePenalty = 0.85;
			warnings.push("low_pnl_coverage");
		}

		const minHolderCount = Math.min(sideAHolders.length, sideBHolders.length);
		if (minHolderCount < 10) {
			adjustedConfidence = "LOW";
			edgePenalty *= 0.75;
			warnings.push("low_holder_count");
		} else if (minHolderCount < 15) {
			adjustedConfidence = downgradeConfidence(adjustedConfidence);
			edgePenalty *= 0.9;
			warnings.push("low_holder_count");
		}

		if (sharpSideValueRatio < 0.25) {
			adjustedConfidence = "LOW";
			edgePenalty *= 0.85;
			warnings.push("low_conviction");
		} else if (sharpSideValueRatio < 0.35) {
			adjustedConfidence = downgradeConfidence(adjustedConfidence);
			edgePenalty *= 0.9;
			warnings.push("low_conviction");
		}

		const hasEdge = sharpSide !== "EVEN";
		let concentration = { top1Share: 0, top3Share: 0 };

		if (!hasEdge) {
			adjustedConfidence = "LOW";
			warnings.push("no_edge");
		} else {
			const sharpSideTopHolders =
				sharpSide === "A" ? sideATopHolders : sideBTopHolders;
			const sharpSideTotalValue =
				sharpSide === "A" ? sideATotalValue : sideBTotalValue;
			concentration = getConcentration(
				sharpSideTopHolders,
				sharpSideTotalValue,
			);
			if (concentration.top1Share >= 0.6 || concentration.top3Share >= 0.8) {
				adjustedConfidence = downgradeConfidence(adjustedConfidence);
				edgePenalty *= 0.85;
				warnings.push("high_concentration");
			}
		}

		if (edgePenalty < 1.0) {
			console.warn(
				`[sharp-money] Low PnL coverage (${(pnlCoverage * 100).toFixed(0)}%) for ${conditionId}. ` +
					`Confidence ${confidence} -> ${adjustedConfidence}. Edge penalty ${edgePenalty}.`,
			);
		}

		const edgeBreakdown = hasEdge
			? calculateEdgeRatingBreakdown(
					scoreDifferential,
					sharpSide === "A" ? sideATopHolders : sideBTopHolders,
					marketVolumeForBonus,
				)
			: { diffScore: 0, volumeBonus: 0, qualityBonus: 0, total: 0 };

		// Calculate Edge Rating for ranking
		const baseEdgeRating = Math.round(
			Math.max(0, Math.min(100, edgeBreakdown.total)),
		);
		const edgeRating = hasEdge
			? Math.max(0, Math.min(100, Math.round(baseEdgeRating * edgePenalty)))
			: 0;

		if (includeDebug) {
			const debug: SharpAnalysisDebug = {
				inputs: {
					conditionId,
					marketTitle,
					marketSlug,
					eventSlug,
					sportSeriesId,
					outcomes,
					endDate,
					marketVolume,
					marketLiquidity,
				},
				prices: {
					sideA: displayPrices[0],
					sideB: displayPrices[1],
				},
				holders: {
					sideA: sideAHolders.length,
					sideB: sideBHolders.length,
				},
				tokenHolders: tokenHoldersCounts,
				topHolders: {
					sideA: sideATopHolders,
					sideB: sideBTopHolders,
				},
				totals: {
					sideAValue: sideATotalValue,
					sideBValue: sideBTotalValue,
					holderMarketValue,
					marketVolume: marketVolumeForBonus,
				},
				rawScores: {
					sideA: sideARawScore,
					sideB: sideBRawScore,
				},
				fadeBoosts: {
					fromSideA: fadeBoostFromSideA,
					fromSideB: fadeBoostFromSideB,
				},
				sharpScores: {
					sideA: sideASharpScore,
					sideB: sideBSharpScore,
				},
				scoreDifferential,
				sharpSide,
				sharpSideValueRatio,
				pnlCoverage: {
					sideA: getPnlCoverage(sideATopHolders),
					sideB: getPnlCoverage(sideBTopHolders),
					min: pnlCoverage,
				},
				concentration,
				warnings,
				confidence: {
					base: confidence,
					adjusted: adjustedConfidence,
				},
				edgeRating: {
					base: baseEdgeRating,
					adjusted: edgeRating,
					penalty: edgePenalty,
					diffScore: edgeBreakdown.diffScore,
					volumeBonus: edgeBreakdown.volumeBonus,
					qualityBonus: edgeBreakdown.qualityBonus,
				},
			};

			const analysis: SharpAnalysisResult = {
				conditionId,
				marketTitle,
				marketSlug,
				eventSlug,
				sportSeriesId,
				eventTime: endDate,
				marketVolume,
				marketLiquidity,
				pnlCoverage,
				sideA: {
					label: sideALabel,
					totalValue: sideATotalValue,
					sharpScore: sideASharpScore,
					holderCount: sideAHolders.length,
					price: resolvePriceForLabel(
						sideALabel,
						0,
						tokenOutcomes,
						displayPrices,
					),
					topHolders: sideATopHolders,
				},
				sideB: {
					label: sideBLabel,
					totalValue: sideBTotalValue,
					sharpScore: sideBSharpScore,
					holderCount: sideBHolders.length,
					price: resolvePriceForLabel(
						sideBLabel,
						1,
						tokenOutcomes,
						displayPrices,
					),
					topHolders: sideBTopHolders,
				},
				sharpSide,
				confidence: adjustedConfidence,
				scoreDifferential,
				sharpSideValueRatio,
				edgeRating,
			};

			return { analysis, debug, allWalletAddresses: uniqueWallets };
		}

		const analysis: SharpAnalysisResult = {
			conditionId,
			marketTitle,
			marketSlug,
			eventSlug,
			sportSeriesId,
			eventTime: endDate,
			marketVolume,
			marketLiquidity,
			pnlCoverage,
			sideA: {
				label: sideALabel,
				totalValue: sideATotalValue,
				sharpScore: sideASharpScore,
				holderCount: sideAHolders.length,
				price: resolvePriceForLabel(
					sideALabel,
					0,
					tokenOutcomes,
					displayPrices,
				),
				topHolders: sideATopHolders,
			},
			sideB: {
				label: sideBLabel,
				totalValue: sideBTotalValue,
				sharpScore: sideBSharpScore,
				holderCount: sideBHolders.length,
				price: resolvePriceForLabel(
					sideBLabel,
					1,
					tokenOutcomes,
					displayPrices,
				),
				topHolders: sideBTopHolders,
			},
			sharpSide,
			confidence: adjustedConfidence,
			scoreDifferential,
			sharpSideValueRatio,
			edgeRating,
		};

		return { analysis, allWalletAddresses: uniqueWallets };
	} catch (error) {
		console.error("Error analyzing market sharpness", conditionId, error);
		return { analysis: null, error: "Analysis failed" };
	}
}

export const analyzeMarketSharpnessFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	if (!context?.env) {
		throw new Error("Environment not available");
	}
	return analyzeMarketSharpness(
		context.env,
		(data ?? {}) as SharpAnalysisPayload,
	);
});

/**
 * Get cached sharp money data
 */
export const getSharpMoneyCacheFn = createServerFn({ method: "POST" }).handler(
	async ({ context, data }) => {
		const payload = data as {
			sportSeriesId?: number;
			limit?: number;
			windowHours?: number;
		};
		const db = getDb(context);

		const entries = await listSharpMoneyCache(db, {
			sportSeriesId: payload.sportSeriesId,
			limit: payload.limit ?? 50,
			windowHours: payload.windowHours ?? 24,
		});

		return { entries };
	},
);

/**
 * Get a single cache entry for debug
 */
export const getSharpMoneyCacheEntryFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = data as { conditionId: string };
	const db = getDb(context);

	if (!payload.conditionId) {
		return { entry: null, error: "No condition ID provided" };
	}

	const entry = await getSharpMoneyCacheByConditionId(db, payload.conditionId);
	return { entry };
});

/**
 * Get cache stats
 */
export const getSharpMoneyCacheStatsFn = createServerFn({
	method: "POST",
}).handler(async ({ context }) => {
	const db = getDb(context);
	const stats = await getSharpMoneyCacheStats(db);
	return { stats };
});

export const getSharpMoneyHistoryFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = data as { conditionId: string; windowHours?: number };
	const db = getDb(context);
	if (!payload.conditionId) {
		return {
			history: [] as SharpMoneyHistoryEntry[],
			error: "No condition ID provided",
		};
	}
	const windowHours =
		payload.windowHours && payload.windowHours > 0
			? Math.min(payload.windowHours, 24 * 7)
			: 24;
	const cutoff = Math.floor(Date.now() / 1000) - windowHours * 60 * 60;
	const history = await listSharpMoneyHistory(db, payload.conditionId, cutoff);
	return { history };
});

export const getSharpMoneyEdgeStatsHistoryFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const db = getDb(context);
	const payload = (data ?? {}) as { windowHours?: number; bucketHours?: number };
	const now = Math.floor(Date.now() / 1000);
	const windowHours =
		payload.windowHours && payload.windowHours > 0
			? Math.min(payload.windowHours, 24 * 30)
			: 7 * 24;
	const bucketHours =
		payload.bucketHours && payload.bucketHours > 0
			? Math.min(payload.bucketHours, 24)
			: 1;
	const since = now - windowHours * 60 * 60;
	const rows = await listSharpMoneyHistoryWindow(db, since);
	const buckets = new Map<number, number[]>();

	for (const row of rows) {
		const bucketStart =
			row.recordedAt - (row.recordedAt % (bucketHours * 3600));
		if (!buckets.has(bucketStart)) {
			buckets.set(bucketStart, []);
		}
		buckets.get(bucketStart)?.push(row.edgeRating);
	}

	const percentile = (values: number[], percent: number) => {
		if (values.length === 0) return 0;
		const sorted = [...values].sort((a, b) => a - b);
		const index = Math.round((percent / 100) * (sorted.length - 1));
		return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
	};

	const bucketList = [...buckets.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([bucketStart, values]) => {
			const count = values.length;
			const average =
				count > 0
					? Math.round(values.reduce((sum, value) => sum + value, 0) / count)
					: 0;
			return {
				start: bucketStart,
				count,
				average,
				p50: percentile(values, 50),
				p75: percentile(values, 75),
				p90: percentile(values, 90),
				max: values.length > 0 ? Math.max(...values) : 0,
			};
		});

	return { buckets: bucketList };
});

export const getSharpMoneyGradeMixFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const db = getDb(context);
	const payload = (data ?? {}) as {
		windowHours?: number;
		sportSeriesId?: number;
		includeEven?: boolean;
		gradeFiltered?: boolean;
		aPlusOnly?: boolean;
	};
	const now = Math.floor(Date.now() / 1000);
	const windowHours =
		payload.windowHours && payload.windowHours > 0
			? Math.min(payload.windowHours, 24 * 30)
			: 7 * 24;
	const since = now - windowHours * 60 * 60;
	const rows = await listSharpMoneyHistoryLatest(
		db,
		since,
		payload.sportSeriesId,
	);

	let total = 0;
	let passing = 0;
	let aPlusCount = 0;
	let aPlusOrACount = 0;

	for (const row of rows) {
		const sharpSide = row.sharpSide ?? "EVEN";
		if (!payload.includeEven && sharpSide === "EVEN") {
			continue;
		}
		const edgeRating = row.edgeRating ?? 0;
		const scoreDifferential = row.scoreDifferential ?? 0;
		const signalScore = computeSignalScoreFromHistory(
			{ edgeRating, scoreDifferential },
			undefined,
			MIN_EDGE_RATING,
		);
		const grade = signalScoreToGradeLabel(signalScore, {
			edgeRating,
			scoreDifferential,
		}) as GradeLabel;

		if (payload.gradeFiltered && (grade === "C" || grade === "D")) {
			continue;
		}
		if (payload.aPlusOnly && grade !== "A+") {
			continue;
		}

		total += 1;
		if (edgeRating >= MIN_EDGE_RATING) passing += 1;
		if (grade === "A+") {
			aPlusCount += 1;
			aPlusOrACount += 1;
		} else if (grade === "A") {
			aPlusOrACount += 1;
		}
	}

	const mix: SharpMoneyGradeMix = {
		total,
		passing,
		passingRate: total > 0 ? passing / total : 0,
		aPlusCount,
		aPlusRate: total > 0 ? aPlusCount / total : 0,
		aPlusOrACount,
		aPlusOrARate: total > 0 ? aPlusOrACount / total : 0,
	};

	return { mix };
});

/**
 * Get runtime market fetch stats (for /runtime)
 */
export const getRuntimeMarketStatsFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const db = getDb(context);
	const payload = (data ?? {}) as {
		minimal?: boolean;
		freshnessWindowHours?: number;
	};
	const freshnessWindowHours =
		payload.freshnessWindowHours && payload.freshnessWindowHours > 0
			? Math.min(payload.freshnessWindowHours, 24 * 7)
			: DEFAULT_FRESHNESS_WINDOW_HOURS;
	const cacheFreshness = await getSharpMoneyCacheFreshnessStats(
		db,
		15 * 60,
		freshnessWindowHours * 60 * 60,
	);

	if (!lastRuntimeMarketStats) {
		if (payload.minimal) {
			return { stats: { cacheFreshness } };
		}
		return { stats: null };
	}

	return { stats: { ...lastRuntimeMarketStats, cacheFreshness } };
});

export const backfillSharpMoneyHistoryFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const db = getDb(context);
	const payload = (data ?? {}) as { limit?: number };
	const limit =
		payload.limit && payload.limit > 0 ? Math.min(payload.limit, 1000) : 100;
	const updated = await backfillSharpMoneyHistory(db, limit);
	return { updated };
});

export async function computeSharpMoneyGrades(
	db: Db,
	payload: SharpGradePayload,
): Promise<SharpGradeComputeResult> {
	const conditionIds = Array.isArray(payload.conditionIds)
		? payload.conditionIds.filter((id) => typeof id === "string")
		: [];
	if (conditionIds.length === 0) {
		return {
			results: [],
			requested: 0,
			returned: 0,
			truncated: false,
			computedAt: nowUnixSeconds(),
			error: "conditionIds_required",
		};
	}
	const uniqueRequested = Array.from(new Set(conditionIds));
	const truncated = uniqueRequested.length > MAX_GRADE_REQUEST_ITEMS;
	const uniqueConditionIds = uniqueRequested.slice(0, MAX_GRADE_REQUEST_ITEMS);
	const now = nowUnixSeconds();
	const historyWindowMinutes =
		payload.historyWindowMinutes &&
		payload.historyWindowMinutes > 0 &&
		Number.isFinite(payload.historyWindowMinutes)
			? payload.historyWindowMinutes
			: DEFAULT_HISTORY_WINDOW_MINUTES;
	const staleThresholdMinutes =
		payload.staleThresholdMinutes &&
		payload.staleThresholdMinutes > 0 &&
		Number.isFinite(payload.staleThresholdMinutes)
			? payload.staleThresholdMinutes
			: DEFAULT_STALE_THRESHOLD_MINUTES;
	const historyCutoff = now - historyWindowMinutes * 60;

	const [cacheEntries, historyByConditionId] = await Promise.all([
		listSharpMoneyCacheByConditionIds(db, uniqueConditionIds),
		listSharpMoneyHistoryByConditionIds(db, uniqueConditionIds, historyCutoff),
	]);
	const cacheByConditionId = new Map(
		cacheEntries.map((entry) => [entry.conditionId, entry]),
	);

	const results: SharpGradeResult[] = uniqueConditionIds.map((conditionId) => {
		const entry = cacheByConditionId.get(conditionId);
		if (!entry) {
			return {
				conditionId,
				grade: null,
				warnings: [],
				computedAt: now,
				error: "not_found",
			};
		}
		const history =
			(historyByConditionId as SharpMoneyHistoryEntryByConditionId)[
				conditionId
			] ?? [];
		const signalScore = computeSignalScoreFromHistory(
			{
				edgeRating: entry.edgeRating,
				scoreDifferential: entry.scoreDifferential,
			},
			history,
			MIN_EDGE_RATING,
		);
		const grade = signalScoreToGradeLabel(signalScore, {
			edgeRating: entry.edgeRating,
			scoreDifferential: entry.scoreDifferential,
		});
		const historyUpdatedAt = entry.historyUpdatedAt ?? entry.updatedAt;
		const isHistoryStale =
			typeof historyUpdatedAt === "number" &&
			now - historyUpdatedAt > staleThresholdMinutes * 60;
		const microstructureScore = computeMicrostructureScoreFromEntry({
			sharpSide: entry.sharpSide,
			sideA: { price: entry.sideA.price },
			sideB: { price: entry.sideB.price },
			marketVolume: entry.marketVolume,
			marketLiquidity: entry.marketLiquidity,
		});
		const warnings: string[] = [];
		const minHolderCount = Math.min(
			entry.sideA.holderCount,
			entry.sideB.holderCount,
		);
		if (minHolderCount < MIN_READY_HOLDER_COUNT) {
			warnings.push("low_holders");
		}
		if (
			typeof entry.pnlCoverage === "number" &&
			entry.pnlCoverage < MIN_READY_PNL_COVERAGE
		) {
			warnings.push("low_pnl_coverage");
		}
		if (entry.sharpSide === "EVEN") warnings.push("no_edge");
		if (!entry.isReady) warnings.push("not_ready");
		if (entry.sharpSide !== "EVEN") {
			const sharpSideData = entry.sharpSide === "A" ? entry.sideA : entry.sideB;
			const sharpSidePrice = sharpSideData.price;
			if (
				typeof sharpSidePrice === "number" &&
				Number.isFinite(sharpSidePrice) &&
				sharpSidePrice >= LOW_ROI_PRICE_THRESHOLD
			) {
				warnings.push("low_roi");
			}
		}
		if (entry.sharpSide !== "EVEN") {
			const priceEdge = computePriceEdgeFromEntry({
				sharpSide: entry.sharpSide,
				confidence: entry.confidence,
				edgeRating: entry.edgeRating,
				sideA: { sharpScore: entry.sideA.sharpScore, price: entry.sideA.price },
				sideB: { sharpScore: entry.sideB.sharpScore, price: entry.sideB.price },
			});
			if (
				priceEdge.priceEdge === null ||
				priceEdge.minPriceEdge === null ||
				priceEdge.priceEdge < priceEdge.minPriceEdge
			) {
				warnings.push("no_price_edge");
			}
		}
		if ((entry.sharpSideValueRatio ?? 0.5) < 0.35) {
			warnings.push("low_conviction");
		}
		if (microstructureScore < MIN_MICROSTRUCTURE_SCORE) {
			warnings.push("weak_microstructure");
		}
		if (entry.sharpSide !== "EVEN") {
			const sharpSideData = entry.sharpSide === "A" ? entry.sideA : entry.sideB;
			const sharpSideTopHolders = sharpSideData.topHolders
				.slice()
				.sort((a, b) => b.amount - a.amount);
			const sharpTop1 = sharpSideTopHolders[0]?.amount ?? 0;
			const sharpTop3 = sharpSideTopHolders
				.slice(0, 3)
				.reduce((sum, holder) => sum + holder.amount, 0);
			const sharpSideTotal = sharpSideData.totalValue;
			if (
				sharpSideTotal > 0 &&
				(sharpTop1 / sharpSideTotal >= 0.6 || sharpTop3 / sharpSideTotal >= 0.8)
			) {
				warnings.push("high_concentration");
			}
		}
		if (isHistoryStale) warnings.push("stale_data");

		return {
			conditionId,
			grade,
			signalScore,
			edgeRating: entry.edgeRating,
			scoreDifferential: entry.scoreDifferential,
			microstructureScore,
			isReady: entry.isReady,
			warnings,
			computedAt: now,
			historyUpdatedAt,
		};
	});

	return {
		results,
		requested: uniqueRequested.length,
		returned: results.length,
		truncated,
		computedAt: now,
	};
}

export const getSharpMoneyGradesFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as SharpGradePayload;
	const db = getDb(context);
	const computed = await computeSharpMoneyGrades(db, payload);
	if (computed.error) {
		return { results: [], error: computed.error };
	}
	return { results: computed.results };
});

/**
 * Clear all cached sharp money data
 */
export const clearSharpMoneyCacheFn = createServerFn({
	method: "POST",
}).handler(async ({ context }) => {
	const db = getDb(context);
	await clearAllSharpMoneyCache(db);
	await run(db, `DELETE FROM wallet_unit_size_cache`);
	await run(db, `DELETE FROM wallet_pnl_cache`);
	console.log("[sharp-money] Cache cleared");
	return { success: true };
});

/**
 * Manually refresh sharp money analysis for a specific market
 */
export async function refreshMarketSharpness(
	env: Env,
	payload: SharpAnalysisPayload,
) {
	const { sportSeriesId } = payload;
	if (sportSeriesId !== undefined && !isTargetSeriesId(sportSeriesId)) {
		console.warn(
			"[sharp-money] REJECTED - Not a target series:",
			payload.marketTitle,
			sportSeriesId,
		);
		return { success: false, error: "Not a target series" };
	}

	const { analysis, error, allWalletAddresses } = await analyzeMarketSharpness(
		env,
		payload,
	);

	if (!analysis) {
		console.warn("[sharp-money] Analysis failed:", error);
		return { success: false, error };
	}

	const computedAt = nowUnixSeconds();
	const cacheInput: UpsertSharpMoneyCacheInput = {
		conditionId: analysis.conditionId,
		marketTitle: analysis.marketTitle,
		marketSlug: analysis.marketSlug,
		eventSlug: analysis.eventSlug,
		sportSeriesId: analysis.sportSeriesId,
		eventTime: analysis.eventTime,
		pnlCoverage: analysis.pnlCoverage,
		marketVolume: analysis.marketVolume,
		marketLiquidity: analysis.marketLiquidity,
		computedAt,
		historyUpdatedAt: computedAt,
		sideA: analysis.sideA,
		sideB: analysis.sideB,
		sharpSide: analysis.sharpSide,
		confidence: analysis.confidence,
		scoreDifferential: analysis.scoreDifferential,
		sharpSideValueRatio: analysis.sharpSideValueRatio,
		edgeRating: analysis.edgeRating,
	};

	await upsertSharpMoneyCache(env.POLYWHALER_DB, cacheInput);
	await insertSharpMoneyHistory(env.POLYWHALER_DB, {
		conditionId: analysis.conditionId,
		recordedAt: computedAt,
		computedAt,
		marketTitle: analysis.marketTitle,
		eventTime: analysis.eventTime,
		sportSeriesId: analysis.sportSeriesId,
		sideA: {
			label: analysis.sideA.label,
			totalValue: analysis.sideA.totalValue,
			sharpScore: analysis.sideA.sharpScore,
			price: analysis.sideA.price ?? null,
		},
		sideB: {
			label: analysis.sideB.label,
			totalValue: analysis.sideB.totalValue,
			sharpScore: analysis.sideB.sharpScore,
			price: analysis.sideB.price ?? null,
		},
		sharpSide: analysis.sharpSide,
		confidence: analysis.confidence,
		scoreDifferential: analysis.scoreDifferential,
		sharpSideValueRatio: analysis.sharpSideValueRatio,
		edgeRating: analysis.edgeRating,
		pnlCoverage: analysis.pnlCoverage,
	});

	return { success: true, analysis, allWalletAddresses };
}

export const refreshMarketSharpnessFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	console.log("[sharp-money] refreshMarketSharpnessFn called");
	const payload = data as {
		conditionId: string;
		marketTitle: string;
		marketSlug?: string;
		eventSlug?: string;
		sportSeriesId?: number;
		outcomes?: string[];
		bestBid?: number;
		bestAsk?: number;
		endDate?: string;
		marketVolume?: number;
		marketLiquidity?: number;
	};

	// Validate this is actually a sports market before processing
	const descriptor = {
		title: payload.marketTitle,
		slug: payload.marketSlug,
		eventSlug: payload.eventSlug,
	};

	console.log("[sharp-money] Checking descriptor:", JSON.stringify(descriptor));

	console.log(
		"[sharp-money] ACCEPTED:",
		payload.marketTitle,
		"| series:",
		payload.sportSeriesId ?? "unknown",
	);
	if (!context?.env) {
		throw new Error("Environment not available");
	}
	return refreshMarketSharpness(context.env, payload);
});

/**
 * Run sharp analysis with debug details (for /debug)
 */
export const analyzeMarketSharpnessDebugFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = data as {
		conditionId: string;
		marketTitle?: string;
		marketSlug?: string;
		eventSlug?: string;
		sportSeriesId?: number;
		outcomes?: string[];
		endDate?: string;
		useCache?: boolean;
		marketVolume?: number;
		marketLiquidity?: number;
	};

	if (!payload.conditionId) {
		return { analysis: null, debug: null, error: "No condition ID provided" };
	}

	const db = getDb(context);
	const cacheEntry = payload.useCache
		? await getSharpMoneyCacheByConditionId(db, payload.conditionId)
		: null;

	const marketTitle = payload.marketTitle ?? cacheEntry?.marketTitle;
	if (!marketTitle) {
		return { analysis: null, debug: null, error: "Missing market title" };
	}

	const analysisPayload = {
		conditionId: payload.conditionId,
		marketTitle,
		marketSlug: payload.marketSlug ?? cacheEntry?.marketSlug,
		eventSlug: payload.eventSlug ?? cacheEntry?.eventSlug,
		sportSeriesId: payload.sportSeriesId ?? cacheEntry?.sportSeriesId,
		outcomes: payload.outcomes,
		endDate: payload.endDate ?? cacheEntry?.eventTime,
		marketVolume: payload.marketVolume ?? cacheEntry?.marketVolume,
		marketLiquidity: payload.marketLiquidity ?? cacheEntry?.marketLiquidity,
		includeDebug: true,
	};

	const { analysis, debug, error } = await analyzeMarketSharpness(
		context.env,
		analysisPayload,
	);

	if (!analysis || !debug) {
		return { analysis: null, debug: null, error: error ?? "Analysis failed" };
	}

	return { analysis, debug };
});
