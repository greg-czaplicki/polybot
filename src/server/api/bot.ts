import { createServerFn } from "@tanstack/react-start";
import type { GradeLabel } from "@/lib/sharp-grade";
import {
	EDGE_RATING_DEAD_ZONE_MAX,
	EDGE_RATING_DEAD_ZONE_MIN,
	EDGE_RATING_SATURATION_FLOOR,
	MIN_SCORE_DIFFERENTIAL,
	isAcceptableEdgeRating,
	isAcceptablePriceEdge,
	isAcceptableSignalScore,
} from "@/lib/sharp-grade";
import { detectSportTagFromSeriesId } from "@/lib/sports";
import { deriveSnapshotType } from "../api/canonical-analytics";
import type { Db } from "../db/client";
import { extractSideFeatures } from "../domain/canonical-features";
import { scoreOpportunity } from "../domain/opportunity-scoring";
import type { Env } from "../env";
import { buildStrategyVersion, getDb, nowUnixSeconds } from "../env";
import {
	extractSpreadFromTitle,
	extractTotalFromTitle,
	identifySpreadTeamPosition,
} from "../pipeline/line-ingestion";
import {
	deriveFavDogRole,
	extractSpreadPickedLabel,
	resolvePickedSide,
} from "../pipeline/pick-enrichment-helpers";
import {
	parseTeamsFromTitle,
	resolveSingleTeam,
} from "../pipeline/team-seeder";
import {
	insertBotCandidateSnapshot,
	listBotCandidateSnapshots,
} from "../repositories/bot-candidate-snapshots";
import { listDailyStatsSnapshots } from "../repositories/daily-stats-snapshots";
import {
	createManualPick,
	type ManualPickStatus,
	settleManualPick,
	updateManualPickExecution,
} from "../repositories/manual-picks";
import {
	getSharpMoneyCacheByConditionId,
	getSharpMoneyCacheFreshnessStats,
	listSharpMoneyCache,
} from "../repositories/sharp-money";
import { getLatestTeamTrendSnapshot } from "../repositories/team-trend-snapshots";
import {
	computeHedgingMetrics,
	computePriceEdgeFromEntry,
	computeSharpMoneyGrades,
	type SharpGradePayload,
} from "./sharp-money";

const DEFAULT_CACHE_LIMIT = 200;
const DEFAULT_CACHE_WINDOW_HOURS = 24;
const DEFAULT_CANDIDATE_WINDOW_MINUTES = 60;
const MAX_CANDIDATE_LIMIT = 500;
const DEFAULT_MIN_MINUTES_TO_START = 15;
const DEFAULT_MARKET_QUALITY_THRESHOLD = 0.9;
const DEFAULT_BOT_MIN_GRADE: GradeLabel = "A";
const DEFAULT_BOT_REQUIRE_READY = true;
const DEFAULT_BOT_INCLUDE_STARTED = false;
const DEFAULT_BOT_REQUIRE_MICROSTRUCTURE = true;
const DEFAULT_BOT_MARKET_QUALITY_THRESHOLD = 0.9;
const NBA_SPORT_SERIES_ID = 10345;
const GRADE_RANK: Record<GradeLabel, number> = {
	"A+": 5,
	A: 4,
	B: 3,
	C: 2,
	D: 1,
};

type ResolvedTeam = Awaited<ReturnType<typeof resolveSingleTeam>>;
type TrendSnapshot = Awaited<ReturnType<typeof getLatestTeamTrendSnapshot>>;
type CanonicalScoreCache = {
	teamByAlias: Map<string, Promise<ResolvedTeam>>;
	snapshotByKey: Map<string, Promise<TrendSnapshot>>;
};

type BotCandidateDebugInspect = {
	conditionId: string;
	foundInEntries: boolean;
	stage: string;
	reason?: string;
	dedupGroupKey?: string;
	wonDedup?: boolean;
};

type BotCandidateNearMiss = {
	reason: string;
	conditionId: string;
	marketTitle: string;
	sportSeriesId?: number;
	marketType: BotCandidateMarketType;
	sharpSide: "A" | "B" | "EVEN";
	sharpSidePrice: number | null;
	grade?: GradeLabel;
	policyMinGrade?: GradeLabel;
	signalScore?: number;
	marketQualityScore?: number;
	minutesToStart?: number | null;
};

type BotCandidatesDebug = {
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
	nearMisses: BotCandidateNearMiss[];
	inspect?: BotCandidateDebugInspect;
};

type BotCandidatesOptions = {
	minGrade: GradeLabel;
	windowMinutes?: number;
	minMinutesToStart?: number;
	maxMinutesToStart?: number;
	limit?: number;
	requireReady?: boolean;
	includeStarted?: boolean;
	requireMicrostructure?: boolean;
	marketQualityThreshold?: number;
	inspectConditionId?: string | null;
};

type BotCandidatesResult = {
	candidates: Array<{
		entry: ReturnType<typeof toSlimCandidate>;
		grade: {
			grade: GradeLabel;
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
			priceEdge?: number | null;
			fairPrice?: number | null;
			minPriceEdge?: number | null;
			hedgedWalletCount?: number | null;
			maxHedgeRatio?: number | null;
			hedgedValueShareSharpSide?: number | null;
			totalHedgedFraction?: number | null;
			isReady?: boolean;
			warnings?: string[];
			computedAt?: number;
			historyUpdatedAt?: number;
		};
	}>;
	requested: number;
	returned: number;
	truncated: boolean;
	computedAt: number;
	debug: BotCandidatesDebug;
};

type BotCandidate = BotCandidatesResult["candidates"][number];
type BotCandidateMarketType = ReturnType<typeof getMarketTypeLabel>;
type BotCandidatePolicy = {
	minGrade: GradeLabel;
	marketQualityThreshold: number;
	segmentKey: string;
	segmentLabel: string;
	rankingAdjustment: number;
	notes: string[];
	reject?: boolean;
	rejectReason?: string;
};

export type BotInspectDefaults = {
	minGrade: GradeLabel;
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

function parseBooleanEnv(
	value: string | undefined,
	fallback: boolean,
): boolean {
	if (!value) return fallback;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return fallback;
}

function parseNumberEnv(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function getBotControlHeaders(env: Env): Headers {
	const headers = new Headers();
	if (env.BOT_CONTROL_TOKEN) {
		headers.set("Authorization", `Bearer ${env.BOT_CONTROL_TOKEN}`);
	}
	if (env.BOT_CONTROL_ACCESS_ID && env.BOT_CONTROL_ACCESS_SECRET) {
		headers.set("CF-Access-Client-Id", env.BOT_CONTROL_ACCESS_ID);
		headers.set("CF-Access-Client-Secret", env.BOT_CONTROL_ACCESS_SECRET);
	}
	return headers;
}

async function loadBotInspectDefaults(env: Env): Promise<BotInspectDefaults> {
	const defaults: BotInspectDefaults = {
		minGrade: DEFAULT_BOT_MIN_GRADE,
		windowMinutes: DEFAULT_CANDIDATE_WINDOW_MINUTES,
		minMinutesToStart: DEFAULT_MIN_MINUTES_TO_START,
		maxMinutesToStart: DEFAULT_CANDIDATE_WINDOW_MINUTES,
		maxBets: 5,
		candidateLimit: 15,
		requireReady: DEFAULT_BOT_REQUIRE_READY,
		includeStarted: DEFAULT_BOT_INCLUDE_STARTED,
		requireMicrostructure: DEFAULT_BOT_REQUIRE_MICROSTRUCTURE,
		marketQualityThreshold: DEFAULT_BOT_MARKET_QUALITY_THRESHOLD,
	};

	if (!env.BOT_CONTROL_URL) {
		return defaults;
	}

	try {
		const upstreamUrl = new URL("/env", env.BOT_CONTROL_URL);
		const response = await fetch(upstreamUrl.toString(), {
			method: "GET",
			headers: getBotControlHeaders(env),
		});
		if (!response.ok) {
			return defaults;
		}

		const payload = (await response.json()) as {
			env?: Record<string, string>;
		};
		const botEnv = payload.env ?? {};
		const minGrade = parseMinGrade(botEnv.BOT_MIN_GRADE ?? null);
		const maxBets = Math.max(
			1,
			Math.floor(parseNumberEnv(botEnv.BOT_MAX_BETS, defaults.maxBets)),
		);

		return {
			minGrade: minGrade ?? defaults.minGrade,
			windowMinutes: parseNumberEnv(
				botEnv.BOT_WINDOW_MINUTES,
				defaults.windowMinutes,
			),
			minMinutesToStart: parseNumberEnv(
				botEnv.BOT_MIN_MINUTES_TO_START,
				defaults.minMinutesToStart,
			),
			maxMinutesToStart: parseNumberEnv(
				botEnv.BOT_MAX_MINUTES_TO_START,
				defaults.maxMinutesToStart,
			),
			maxBets,
			candidateLimit: Math.min(maxBets * 3, MAX_CANDIDATE_LIMIT),
			requireReady: parseBooleanEnv(
				botEnv.BOT_REQUIRE_READY,
				defaults.requireReady,
			),
			includeStarted: parseBooleanEnv(
				botEnv.BOT_INCLUDE_STARTED,
				defaults.includeStarted,
			),
			requireMicrostructure: parseBooleanEnv(
				botEnv.BOT_REQUIRE_MICROSTRUCTURE,
				defaults.requireMicrostructure,
			),
			marketQualityThreshold: parseNumberEnv(
				botEnv.BOT_MARKET_QUALITY_THRESHOLD,
				defaults.marketQualityThreshold,
			),
		};
	} catch {
		return defaults;
	}
}

function clampUnit(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function stricterGrade(left: GradeLabel, right: GradeLabel): GradeLabel {
	return GRADE_RANK[left] >= GRADE_RANK[right] ? left : right;
}

function looserGrade(left: GradeLabel, right: GradeLabel): GradeLabel {
	return GRADE_RANK[left] <= GRADE_RANK[right] ? left : right;
}

function normalizeMarketPrice(price?: number | null): number | null {
	if (typeof price !== "number" || !Number.isFinite(price)) return null;
	if (price <= 0 || price >= 1) return null;
	return price;
}

function pushNearMiss(
	debug: BotCandidatesDebug,
	nearMiss: BotCandidateNearMiss,
): void {
	debug.nearMisses.push(nearMiss);
	debug.nearMisses.sort((left, right) => {
		const leftSignal = left.signalScore ?? Number.NEGATIVE_INFINITY;
		const rightSignal = right.signalScore ?? Number.NEGATIVE_INFINITY;
		if (rightSignal !== leftSignal) return rightSignal - leftSignal;
		const leftQuality = left.marketQualityScore ?? Number.NEGATIVE_INFINITY;
		const rightQuality = right.marketQualityScore ?? Number.NEGATIVE_INFINITY;
		return rightQuality - leftQuality;
	});
	if (debug.nearMisses.length > 10) {
		debug.nearMisses.length = 10;
	}
}

function computeMarketQualityScoreFromCacheEntry(input: {
	sharpSide?: string;
	sideA?: { price?: number | null };
	sideB?: { price?: number | null };
	marketVolume?: number;
	marketLiquidity?: number;
}): number | null {
	if (
		!input.sharpSide ||
		(input.sharpSide !== "A" && input.sharpSide !== "B")
	) {
		return null;
	}
	const sideAPrice = normalizeMarketPrice(input.sideA?.price);
	const sideBPrice = normalizeMarketPrice(input.sideB?.price);
	const hasBothPrices = sideAPrice !== null && sideBPrice !== null;
	const complementGap = hasBothPrices
		? Math.abs(sideAPrice + sideBPrice - 1)
		: 0.08;
	const complementScore = hasBothPrices
		? clampUnit(1 - complementGap / 0.08)
		: 0.45;
	const sharpSidePrice = input.sharpSide === "A" ? sideAPrice : sideBPrice;
	const priceBandScore =
		sharpSidePrice === null
			? 0.5
			: clampUnit(1 - Math.abs(sharpSidePrice - 0.5) / 0.4);
	let depthScore = 0.5;
	if (
		typeof input.marketLiquidity === "number" &&
		Number.isFinite(input.marketLiquidity) &&
		input.marketLiquidity > 0 &&
		typeof input.marketVolume === "number" &&
		Number.isFinite(input.marketVolume) &&
		input.marketVolume > 0
	) {
		const depthRatio = input.marketLiquidity / Math.max(input.marketVolume, 1);
		depthScore = clampUnit(depthRatio / 0.35);
	} else if (
		typeof input.marketLiquidity === "number" &&
		Number.isFinite(input.marketLiquidity) &&
		input.marketLiquidity > 0
	) {
		depthScore = clampUnit(input.marketLiquidity / 200_000);
	}
	return clampUnit(
		complementScore * 0.45 + depthScore * 0.35 + priceBandScore * 0.2,
	);
}

function parseClobNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function normalizeOutcomeLabel(value: string): string {
	return value.trim().toLowerCase();
}

async function fetchL2SignalsForPick(input: {
	conditionId: string;
	sharpSide?: string;
	sideALabel?: string;
	sideBLabel?: string;
}): Promise<{
	l2Imbalance?: number;
	l2ImbalanceNearMid?: number;
	l2Spread?: number;
	l2Disagreement?: boolean;
}> {
	if (
		!input.sharpSide ||
		(input.sharpSide !== "A" && input.sharpSide !== "B")
	) {
		console.warn("[l2] skipped: invalid sharpSide", {
			conditionId: input.conditionId,
			sharpSide: input.sharpSide,
		});
		return {};
	}
	try {
		const marketResponse = await fetch(
			`https://clob.polymarket.com/markets/${input.conditionId}`,
		);
		if (!marketResponse.ok) {
			console.warn("[l2] market fetch not ok", {
				conditionId: input.conditionId,
				status: marketResponse.status,
			});
			return {};
		}
		const market = (await marketResponse.json()) as {
			tokens?: Array<{
				token_id?: string;
				tokenId?: string;
				clobTokenId?: string;
				id?: string;
				outcome?: string;
			}>;
		};
		const tokens = (market.tokens ?? [])
			.map((token, index) => {
				const tokenId =
					token.token_id ?? token.tokenId ?? token.clobTokenId ?? token.id;
				const outcome = token.outcome?.trim();
				if (!tokenId || !outcome) return null;
				return { tokenId: String(tokenId), outcome, index };
			})
			.filter(
				(token): token is { tokenId: string; outcome: string; index: number } =>
					Boolean(token),
			);
		if (tokens.length === 0) {
			console.warn("[l2] no tokens after filter", {
				conditionId: input.conditionId,
				rawTokenCount: market.tokens?.length ?? 0,
			});
			return {};
		}
		const targetLabel =
			input.sharpSide === "A"
				? (input.sideALabel ?? "")
				: (input.sideBLabel ?? "");
		const targetByLabel = targetLabel
			? tokens.find(
					(token) =>
						normalizeOutcomeLabel(token.outcome) ===
						normalizeOutcomeLabel(targetLabel),
				)
			: null;
		const targetByIndex = tokens.find((token) =>
			input.sharpSide === "A" ? token.index === 0 : token.index === 1,
		);
		const targetToken = targetByLabel ?? targetByIndex ?? null;
		if (!targetToken) {
			console.warn("[l2] no target token", {
				conditionId: input.conditionId,
				sharpSide: input.sharpSide,
				targetLabel,
				tokenOutcomes: tokens.map((t) => t.outcome),
			});
			return {};
		}

		const bookUrl = new URL("https://clob.polymarket.com/book");
		bookUrl.searchParams.set("token_id", targetToken.tokenId);
		const bookResponse = await fetch(bookUrl.toString());
		if (!bookResponse.ok) {
			console.warn("[l2] book fetch not ok", {
				conditionId: input.conditionId,
				tokenId: targetToken.tokenId,
				status: bookResponse.status,
			});
			return {};
		}
		const rawBook = (await bookResponse.json()) as {
			bids?: Array<{ price?: string | number; size?: string | number }>;
			asks?: Array<{ price?: string | number; size?: string | number }>;
		};

		const bids = (rawBook.bids ?? [])
			.map((level) => {
				const price = parseClobNumber(level.price);
				const size = parseClobNumber(level.size);
				if (
					price === null ||
					size === null ||
					price <= 0 ||
					price >= 1 ||
					size <= 0
				) {
					return null;
				}
				return { price, size, notional: price * size };
			})
			.filter(
				(level): level is { price: number; size: number; notional: number } =>
					Boolean(level),
			)
			.sort((a, b) => b.price - a.price);
		const asks = (rawBook.asks ?? [])
			.map((level) => {
				const price = parseClobNumber(level.price);
				const size = parseClobNumber(level.size);
				if (
					price === null ||
					size === null ||
					price <= 0 ||
					price >= 1 ||
					size <= 0
				) {
					return null;
				}
				return { price, size, notional: price * size };
			})
			.filter(
				(level): level is { price: number; size: number; notional: number } =>
					Boolean(level),
			)
			.sort((a, b) => a.price - b.price);

		const bestBid = bids[0]?.price ?? null;
		const bestAsk = asks[0]?.price ?? null;
		const mid =
			bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
		const spread =
			bestBid !== null && bestAsk !== null
				? Math.max(0, bestAsk - bestBid)
				: null;
		const bidNotional = bids.reduce((sum, level) => sum + level.notional, 0);
		const askNotional = asks.reduce((sum, level) => sum + level.notional, 0);
		const imbalance =
			bidNotional + askNotional > 0
				? (bidNotional - askNotional) / (bidNotional + askNotional)
				: null;
		const nearMidBand = 0.05;
		const nearMidBidNotional =
			mid === null
				? 0
				: bids
						.filter((level) => Math.abs(level.price - mid) <= nearMidBand)
						.reduce((sum, level) => sum + level.notional, 0);
		const nearMidAskNotional =
			mid === null
				? 0
				: asks
						.filter((level) => Math.abs(level.price - mid) <= nearMidBand)
						.reduce((sum, level) => sum + level.notional, 0);
		const imbalanceNearMid =
			nearMidBidNotional + nearMidAskNotional > 0
				? (nearMidBidNotional - nearMidAskNotional) /
					(nearMidBidNotional + nearMidAskNotional)
				: null;
		const l2Disagreement =
			imbalanceNearMid === null ? undefined : imbalanceNearMid < -0.05;
		const result = {
			l2Imbalance: imbalance ?? undefined,
			l2ImbalanceNearMid: imbalanceNearMid ?? undefined,
			l2Spread: spread ?? undefined,
			l2Disagreement,
		};
		console.log("[l2] computed", {
			conditionId: input.conditionId,
			tokenId: targetToken.tokenId,
			bidLevels: bids.length,
			askLevels: asks.length,
			...result,
		});
		return result;
	} catch (error) {
		console.error("[l2] threw", {
			conditionId: input.conditionId,
			error: error instanceof Error ? error.message : String(error),
		});
		return {};
	}
}

type BotAuthResult = { ok: true } | { ok: false; response: Response };

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: {
			"Content-Type": "application/json",
			...(init?.headers ?? {}),
		},
	});
}

function requireBotAuth(request: Request, env: Env): BotAuthResult {
	const apiKey = env.BOT_API_KEY;
	if (!apiKey) {
		return {
			ok: false,
			response: jsonResponse({ error: "bot_api_key_missing" }, { status: 401 }),
		};
	}

	const authorization = request.headers.get("authorization") ?? "";
	let token = "";
	if (authorization.toLowerCase().startsWith("bearer ")) {
		token = authorization.slice(7).trim();
	} else {
		token = request.headers.get("x-bot-api-key") ?? "";
	}

	if (!token || token !== apiKey) {
		return {
			ok: false,
			response: jsonResponse({ error: "unauthorized" }, { status: 401 }),
		};
	}

	return { ok: true };
}

async function parseJson<T>(request: Request): Promise<T | null> {
	try {
		return (await request.json()) as T;
	} catch {
		return null;
	}
}

function parseEventTime(value?: string | null): Date | null {
	if (!value) return null;
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return new Date(`${value}T23:59:59Z`);
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseMinGrade(value: string | null): GradeLabel | null {
	if (!value) return "A";
	const normalized = value.toUpperCase();
	if (
		normalized === "A+" ||
		normalized === "A" ||
		normalized === "B" ||
		normalized === "C" ||
		normalized === "D"
	) {
		return normalized as GradeLabel;
	}
	return null;
}

function incrementCounter(record: Record<string, number>, key: string): void {
	record[key] = (record[key] ?? 0) + 1;
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

function getMarketTypeLabel(
	marketTitle: string,
): "total" | "spread" | "moneyline" | "prop" | "other" {
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

function getMarketGroupKey(entry: {
	marketTitle: string;
	eventSlug?: string;
	sportSeriesId?: number;
}): string {
	const base = entry.eventSlug ?? normalizeMatchupTitle(entry.marketTitle);
	const type = getMarketTypeLabel(entry.marketTitle);
	const sport = entry.sportSeriesId ?? "na";
	return `${sport}|${base}|${type}`;
}

function getCandidateMinutesToStart(candidate: BotCandidate): number | null {
	const eventTime = parseEventTime(candidate.entry.eventTime);
	if (!eventTime) return null;
	return (eventTime.getTime() - Date.now()) / 60_000;
}

function getTimingPreferenceScore(minutesToStart: number | null): number {
	if (minutesToStart === null || !Number.isFinite(minutesToStart)) return -1;
	if (minutesToStart >= 15 && minutesToStart <= 60) return 4;
	if (minutesToStart > 60 && minutesToStart <= 180) return 3;
	if (minutesToStart > 180) return 2;
	if (minutesToStart >= 0) return 0;
	return -1;
}

export function resolveTimingBucket(
	minutesToStart: number | null,
): "0-15m" | "15-60m" | "1-3h" | "3h+" | "unknown" {
	if (minutesToStart === null || !Number.isFinite(minutesToStart))
		return "unknown";
	if (minutesToStart < 15) return "0-15m";
	if (minutesToStart <= 60) return "15-60m";
	if (minutesToStart <= 180) return "1-3h";
	return "3h+";
}

function getSportPolicyKey(sportSeriesId?: number): string {
	if (sportSeriesId === NBA_SPORT_SERIES_ID) return "nba";
	if (sportSeriesId === 3) return "mlb";
	if (sportSeriesId === 10470) return "ncaab";
	if (sportSeriesId === 10346) return "nhl";
	return "default";
}

function buildPolicy(
	input: {
		sportSeriesId?: number;
		marketType: BotCandidateMarketType;
		timingBucket: ReturnType<typeof resolveTimingBucket>;
		baseMinGrade: GradeLabel;
		baseMarketQualityThreshold: number;
	},
	override: Partial<BotCandidatePolicy> = {},
): BotCandidatePolicy {
	const sportKey = getSportPolicyKey(input.sportSeriesId);
	return {
		minGrade: input.baseMinGrade,
		marketQualityThreshold: input.baseMarketQualityThreshold,
		segmentKey: `${sportKey}|${input.marketType}|${input.timingBucket}`,
		segmentLabel: `${sportKey.toUpperCase()} ${input.marketType} ${input.timingBucket}`,
		rankingAdjustment: 0,
		notes: [],
		...override,
	};
}

export function getBotCandidatePolicy(input: {
	marketType: BotCandidateMarketType;
	sportSeriesId?: number;
	minutesToStart: number | null;
	baseMinGrade: GradeLabel;
	baseMarketQualityThreshold: number;
}): BotCandidatePolicy {
	const timingBucket = resolveTimingBucket(input.minutesToStart);
	if (timingBucket === "0-15m") {
		return buildPolicy(
			{
				...input,
				timingBucket,
			},
			{
				minGrade: "A",
				marketQualityThreshold: 1,
				segmentLabel: "All markets 0-15m",
				rankingAdjustment: -100,
				notes: ["late_window"],
				reject: true,
				rejectReason: "0-15m_timing_excluded",
			},
		);
	}

	if (input.sportSeriesId === 10346) {
		return buildPolicy(
			{
				...input,
				timingBucket,
			},
			{
				minGrade: "A",
				marketQualityThreshold: 1,
				segmentLabel: "NHL excluded",
				rankingAdjustment: -100,
				notes: ["sport_excluded"],
				reject: true,
				rejectReason: "nhl_sport_excluded",
			},
		);
	}

	// NBA: our 1-3h sharp signal is anti-correlated with outcome — 27 of 33
	// historical NBA picks landed in the 90+min window with -22% to -100% ROI.
	// The 60-90min slice was roughly break-even. Tighten NBA to <=90 min only.
	if (
		input.sportSeriesId === 10345 &&
		input.minutesToStart !== null &&
		input.minutesToStart > 90
	) {
		return buildPolicy(
			{
				...input,
				timingBucket,
			},
			{
				minGrade: "A",
				marketQualityThreshold: 1,
				segmentLabel: "NBA >90m excluded",
				rankingAdjustment: -100,
				notes: ["nba_timing_excluded"],
				reject: true,
				rejectReason: "nba_timing_excluded",
			},
		);
	}

	if (input.sportSeriesId === 10470 && input.marketType === "spread") {
		return buildPolicy(
			{
				...input,
				timingBucket,
			},
			{
				minGrade: "A",
				marketQualityThreshold: 1,
				segmentLabel: "NCAAB spread excluded",
				rankingAdjustment: -100,
				notes: ["sport_market_excluded"],
				reject: true,
				rejectReason: "ncaab_spread_excluded",
			},
		);
	}

	if (input.marketType === "spread") {
		return buildPolicy(
			{
				...input,
				timingBucket,
			},
			{
				minGrade: "A",
				marketQualityThreshold: 1,
				segmentLabel: "Spread excluded",
				rankingAdjustment: -100,
				notes: ["spread_excluded"],
				reject: true,
				rejectReason: "spread_market_excluded",
			},
		);
	}

	let policy = buildPolicy({
		...input,
		timingBucket,
	});

	if (input.marketType === "moneyline") {
		policy = {
			...policy,
			minGrade: looserGrade(stricterGrade(policy.minGrade, "B"), "B"),
			marketQualityThreshold: Math.max(policy.marketQualityThreshold, 0.9),
			rankingAdjustment: policy.rankingAdjustment + 6,
			notes: [...policy.notes, "moneyline_bias"],
		};
	}

	if (input.marketType === "total") {
		policy = {
			...policy,
			minGrade: looserGrade(stricterGrade(policy.minGrade, "B"), "B"),
			marketQualityThreshold: Math.max(policy.marketQualityThreshold, 0.9),
			rankingAdjustment: policy.rankingAdjustment + 4,
			notes: [...policy.notes, "total_bias"],
		};
	}

	if (timingBucket === "15-60m") {
		policy = {
			...policy,
			minGrade: stricterGrade(policy.minGrade, "A"),
			marketQualityThreshold: Math.max(policy.marketQualityThreshold, 0.75),
			rankingAdjustment:
				policy.rankingAdjustment +
				(input.marketType === "moneyline" ? -8 : -22),
			notes: [...policy.notes, "late_window_penalty"],
		};
	}

	if (timingBucket === "1-3h") {
		policy = {
			...policy,
			rankingAdjustment: policy.rankingAdjustment + 10,
			notes: [...policy.notes, "preferred_window"],
		};
	}

	if (timingBucket === "3h+") {
		policy = {
			...policy,
			rankingAdjustment: policy.rankingAdjustment - 4,
			notes: [...policy.notes, "early_window_penalty"],
		};
	}

	if (input.sportSeriesId === NBA_SPORT_SERIES_ID) {
		if (timingBucket === "1-3h" && input.marketType === "moneyline") {
			policy = {
				...policy,
				minGrade: looserGrade(stricterGrade(policy.minGrade, "B"), "B"),
				marketQualityThreshold: Math.max(policy.marketQualityThreshold, 0.9),
				rankingAdjustment: policy.rankingAdjustment + 22,
				notes: [...policy.notes, "nba_moneyline_core"],
			};
		}
		if (timingBucket === "1-3h" && input.marketType === "total") {
			policy = {
				...policy,
				minGrade: looserGrade(stricterGrade(policy.minGrade, "B"), "B"),
				marketQualityThreshold: Math.max(policy.marketQualityThreshold, 0.9),
				rankingAdjustment: policy.rankingAdjustment + 18,
				notes: [...policy.notes, "nba_total_core"],
			};
		}
	}

	if (input.sportSeriesId === 3) {
		if (timingBucket === "1-3h" && input.marketType === "moneyline") {
			policy = {
				...policy,
				minGrade: looserGrade(stricterGrade(policy.minGrade, "B"), "B"),
				marketQualityThreshold: Math.max(policy.marketQualityThreshold, 0.9),
				rankingAdjustment: policy.rankingAdjustment + 14,
				notes: [...policy.notes, "mlb_moneyline_preferred"],
			};
		}
		if (timingBucket === "1-3h" && input.marketType === "total") {
			policy = {
				...policy,
				minGrade: looserGrade(stricterGrade(policy.minGrade, "B"), "B"),
				marketQualityThreshold: Math.max(policy.marketQualityThreshold, 0.9),
				rankingAdjustment: policy.rankingAdjustment + 10,
				notes: [...policy.notes, "mlb_total_preferred"],
			};
		}
	}

	if (input.sportSeriesId === 10470) {
		policy = {
			...policy,
			marketQualityThreshold: Math.max(policy.marketQualityThreshold, 0.75),
			rankingAdjustment: policy.rankingAdjustment - 18,
			notes: [...policy.notes, "ncaab_penalty"],
		};
		if (timingBucket === "1-3h" && input.marketType === "total") {
			policy = {
				...policy,
				minGrade: stricterGrade(policy.minGrade, "A"),
				marketQualityThreshold: Math.max(policy.marketQualityThreshold, 0.78),
				rankingAdjustment: policy.rankingAdjustment - 12,
				notes: [...policy.notes, "ncaab_total_caution"],
			};
		}
		if (input.marketType === "moneyline") {
			policy = {
				...policy,
				minGrade: stricterGrade(policy.minGrade, "A"),
				rankingAdjustment: policy.rankingAdjustment - 12,
				notes: [...policy.notes, "ncaab_moneyline_caution"],
			};
		}
	}

	return {
		...policy,
		minGrade: policy.minGrade === "A+" ? "A" : policy.minGrade,
		marketQualityThreshold: Math.min(0.95, policy.marketQualityThreshold),
		notes: Array.from(new Set(policy.notes)),
	};
}

function getBotCandidatePolicyKey(input: {
	policy: BotCandidatePolicy;
	marketType: BotCandidateMarketType;
	sportSeriesId?: number;
	minutesToStart: number | null;
}): string {
	const timingBucket = resolveTimingBucket(input.minutesToStart);
	const sportKey =
		input.sportSeriesId === 10470
			? "ncaab"
			: input.sportSeriesId === 10346
				? "nhl"
				: "default";
	return `${sportKey}|${input.marketType}|${timingBucket}|${input.policy.minGrade}|q${input.policy.marketQualityThreshold.toFixed(2)}`;
}

function getCompressedGradeRank(grade: GradeLabel): number {
	switch (grade) {
		case "A+":
		case "A":
			return 3;
		case "B":
			return 2;
		case "C":
			return 1;
		default:
			return 0;
	}
}

function getCandidatePriceValueScore(candidate: BotCandidate): number {
	const price = candidate.entry.sharpSidePrice;
	if (typeof price !== "number" || !Number.isFinite(price)) return 0;
	return 1 - price;
}

async function computeCanonicalBotCandidateScore(
	db: Db,
	cache: CanonicalScoreCache,
	entry: {
		marketTitle: string;
		sportSeriesId?: number;
		sharpSide: "A" | "B" | "EVEN";
		sideA: { label: string; price?: number | null };
		sideB: { label: string; price?: number | null };
	},
): Promise<{
	totalScore: number;
	snapshotType: string;
	warnings: string[];
} | null> {
	const sportTag = detectSportTagFromSeriesId(entry.sportSeriesId);
	if (!sportTag) return null;
	const marketType = getMarketTypeLabel(entry.marketTitle);
	if (
		marketType !== "spread" &&
		marketType !== "moneyline" &&
		marketType !== "total"
	) {
		return null;
	}
	if (entry.sharpSide !== "A" && entry.sharpSide !== "B") return null;

	const matchupTitle = entry.marketTitle.split(":", 1)[0]?.trim() ?? "";
	const parsedTeams = parseTeamsFromTitle(matchupTitle);
	if (!parsedTeams) return null;

	const getCachedTeam = (alias: string) => {
		const cacheKey = `${sportTag}:${alias.trim().toLowerCase()}`;
		const existing = cache.teamByAlias.get(cacheKey);
		if (existing) return existing;
		const pending = resolveSingleTeam(db, sportTag, alias);
		cache.teamByAlias.set(cacheKey, pending);
		return pending;
	};
	const [homeTeam, awayTeam] = await Promise.all([
		getCachedTeam(parsedTeams.home),
		getCachedTeam(parsedTeams.away),
	]);
	if (!homeTeam || !awayTeam) return null;

	const getCachedSnapshot = (teamId: string, candidateSnapshotType: string) => {
		const cacheKey = `${teamId}:${candidateSnapshotType}`;
		const existing = cache.snapshotByKey.get(cacheKey);
		if (existing) return existing;
		const pending = getLatestTeamTrendSnapshot(db, {
			teamId,
			snapshotType: candidateSnapshotType,
		});
		cache.snapshotByKey.set(cacheKey, pending);
		return pending;
	};

	if (marketType === "total") {
		const totalLine = extractTotalFromTitle(entry.marketTitle);
		const [homeOverall, homeVenue, awayOverall, awayVenue] = await Promise.all(
			[
				getCachedSnapshot(homeTeam.id, "overall"),
				getCachedSnapshot(homeTeam.id, "home"),
				getCachedSnapshot(awayTeam.id, "overall"),
				getCachedSnapshot(awayTeam.id, "away"),
			],
		);

		const team = extractSideFeatures(homeOverall, homeVenue);
		const opponent = extractSideFeatures(awayOverall, awayVenue);
		// O/U markets: sharp-money.ts sets sideA="Over", sideB="Under".
		const pickedDirection: "over" | "under" | null =
			entry.sharpSide === "A"
				? "over"
				: entry.sharpSide === "B"
					? "under"
					: null;
		const score = scoreOpportunity({
			sportTag,
			betType: "total",
			venueRole: "home",
			favDogRole: null,
			spreadLine: null,
			totalLine,
			pickedDirection,
			team,
			opponent,
			matchupAtsDelta:
				team.atsWinPct != null && opponent.atsWinPct != null
					? team.atsWinPct - opponent.atsWinPct
					: null,
			matchupOuDelta:
				team.ouOverPct != null && opponent.ouOverPct != null
					? team.ouOverPct - opponent.ouOverPct
					: null,
			matchupCoverMarginDelta:
				team.avgCoverMargin != null && opponent.avgCoverMargin != null
					? team.avgCoverMargin - opponent.avgCoverMargin
					: null,
			teamSnapshotFound: homeOverall !== null,
			opponentSnapshotFound: awayOverall !== null,
		});

		return {
			totalScore: score.totalScore,
			snapshotType: "home",
			warnings: score.warnings,
		};
	}

	const pickedLabel =
		extractSpreadPickedLabel(entry.marketTitle) ?? entry.sharpSide;
	const pickedSide = resolvePickedSide({
		pickedLabel,
		marketTitle: entry.marketTitle,
		sideALabel: entry.sideA.label,
		sideBLabel: entry.sideB.label,
		homeTeamName: homeTeam.name,
		awayTeamName: awayTeam.name,
		homeTeamId: homeTeam.id,
		awayTeamId: awayTeam.id,
	});
	if (!pickedSide) return null;

	let homeSpread: number | null = null;
	if (marketType === "spread") {
		const parsedSpread = extractSpreadFromTitle(entry.marketTitle);
		if (parsedSpread !== null) {
			const spreadPosition = identifySpreadTeamPosition(entry.marketTitle);
			homeSpread = spreadPosition === "first" ? -parsedSpread : parsedSpread;
		}
	}

	const favDogRole =
		marketType === "spread"
			? deriveFavDogRole(homeSpread, pickedSide.isHomeTeam)
			: null;
	const venueRole = pickedSide.venueRole;
	const snapshotType = deriveSnapshotType(venueRole, favDogRole);
	const mirroredVenue =
		venueRole === "home" ? "away" : venueRole === "away" ? "home" : venueRole;
	const mirroredFavDog =
		favDogRole === "favorite"
			? "dog"
			: favDogRole === "dog"
				? "favorite"
				: favDogRole;
	const opponentSnapshotType = deriveSnapshotType(
		mirroredVenue,
		mirroredFavDog,
	);

	const [teamOverall, teamSplit, opponentOverall, opponentSplit] =
		await Promise.all([
			getCachedSnapshot(pickedSide.teamId, "overall"),
			snapshotType !== "overall"
				? getCachedSnapshot(pickedSide.teamId, snapshotType)
				: Promise.resolve(null),
			getCachedSnapshot(pickedSide.opponentId, "overall"),
			opponentSnapshotType !== "overall"
				? getCachedSnapshot(pickedSide.opponentId, opponentSnapshotType)
				: Promise.resolve(null),
		]);

	const team = extractSideFeatures(teamOverall, teamSplit);
	const opponent = extractSideFeatures(opponentOverall, opponentSplit);
	const score = scoreOpportunity({
		sportTag,
		betType: marketType,
		venueRole,
		favDogRole,
		spreadLine:
			homeSpread === null
				? null
				: pickedSide.isHomeTeam
					? homeSpread
					: -homeSpread,
		totalLine: null,
		pickedDirection: null,
		team,
		opponent,
		matchupAtsDelta:
			team.atsWinPct != null && opponent.atsWinPct != null
				? team.atsWinPct - opponent.atsWinPct
				: null,
		matchupOuDelta:
			team.ouOverPct != null && opponent.ouOverPct != null
				? team.ouOverPct - opponent.ouOverPct
				: null,
		matchupCoverMarginDelta:
			team.avgCoverMargin != null && opponent.avgCoverMargin != null
				? team.avgCoverMargin - opponent.avgCoverMargin
				: null,
		teamSnapshotFound: teamOverall !== null,
		opponentSnapshotFound: opponentOverall !== null,
	});

	return {
		totalScore: score.totalScore,
		snapshotType,
		warnings: score.warnings,
	};
}

function compareBotCandidates(left: BotCandidate, right: BotCandidate): number {
	const leftQuality = left.grade.microstructureScore ?? 0;
	const rightQuality = right.grade.microstructureScore ?? 0;
	const leftSegment = left.grade.segmentScore ?? 0;
	const rightSegment = right.grade.segmentScore ?? 0;
	if (leftSegment !== rightSegment) return rightSegment - leftSegment;
	if (leftQuality !== rightQuality) return rightQuality - leftQuality;

	const leftPriceEdge = left.grade.priceEdge ?? 0;
	const rightPriceEdge = right.grade.priceEdge ?? 0;
	if (leftPriceEdge !== rightPriceEdge)
		return rightPriceEdge - leftPriceEdge;

	const leftCanonical = left.grade.canonicalScore ?? 0;
	const rightCanonical = right.grade.canonicalScore ?? 0;
	if (leftCanonical !== rightCanonical) return rightCanonical - leftCanonical;

	const leftTiming = getTimingPreferenceScore(getCandidateMinutesToStart(left));
	const rightTiming = getTimingPreferenceScore(
		getCandidateMinutesToStart(right),
	);
	if (leftTiming !== rightTiming) return rightTiming - leftTiming;

	const leftPriceValue = getCandidatePriceValueScore(left);
	const rightPriceValue = getCandidatePriceValueScore(right);
	if (leftPriceValue !== rightPriceValue)
		return rightPriceValue - leftPriceValue;

	const leftGradeRank = getCompressedGradeRank(left.grade.grade);
	const rightGradeRank = getCompressedGradeRank(right.grade.grade);
	if (leftGradeRank !== rightGradeRank) return rightGradeRank - leftGradeRank;

	const leftSignal = left.grade.signalScore ?? 0;
	const rightSignal = right.grade.signalScore ?? 0;
	if (leftSignal !== rightSignal) return rightSignal - leftSignal;

	const leftEdge = left.grade.edgeRating ?? 0;
	const rightEdge = right.grade.edgeRating ?? 0;
	if (leftEdge !== rightEdge) return rightEdge - leftEdge;

	const leftDiff = left.grade.scoreDifferential ?? 0;
	const rightDiff = right.grade.scoreDifferential ?? 0;
	if (leftDiff !== rightDiff) return rightDiff - leftDiff;

	const leftTime =
		parseEventTime(left.entry.eventTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
	const rightTime =
		parseEventTime(right.entry.eventTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
	return leftTime - rightTime;
}

function toSlimCandidate(entry: {
	conditionId: string;
	marketTitle: string;
	marketSlug?: string;
	eventSlug?: string;
	sportSeriesId?: number;
	eventTime?: string;
	sharpSide: "A" | "B" | "EVEN";
	edgeRating: number;
	scoreDifferential: number;
	sideA: { label: string; price?: number | null };
	sideB: { label: string; price?: number | null };
}) {
	const sharpSideData = entry.sharpSide === "A" ? entry.sideA : entry.sideB;
	const marketType = getMarketTypeLabel(entry.marketTitle);
	return {
		conditionId: entry.conditionId,
		marketTitle: entry.marketTitle,
		marketSlug: entry.marketSlug,
		eventSlug: entry.eventSlug,
		sportSeriesId: entry.sportSeriesId,
		eventTime: entry.eventTime,
		sharpSide: entry.sharpSide,
		marketType,
		sideA: {
			label: entry.sideA.label,
			price: entry.sideA.price ?? null,
		},
		sideB: {
			label: entry.sideB.label,
			price: entry.sideB.price ?? null,
		},
		sharpSidePrice: sharpSideData.price ?? null,
		edgeRating: entry.edgeRating,
		scoreDifferential: entry.scoreDifferential,
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractSnapshotNumber(
	snapshot: Record<string, unknown> | null,
	keys: string[],
): number | null {
	if (!snapshot) return null;
	for (const key of keys) {
		const value = snapshot[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string") {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return null;
}

function extractSnapshotBoolean(
	snapshot: Record<string, unknown> | null,
	keys: string[],
): boolean | null {
	if (!snapshot) return null;
	for (const key of keys) {
		const value = snapshot[key];
		if (typeof value === "boolean") return value;
	}
	return null;
}

function extractSnapshotStringArray(
	snapshot: Record<string, unknown> | null,
	keys: string[],
): string[] | null {
	if (!snapshot) return null;
	for (const key of keys) {
		const value = snapshot[key];
		if (Array.isArray(value)) {
			const values = value.filter(
				(entry): entry is string => typeof entry === "string",
			);
			if (values.length > 0) return values;
		}
	}
	return null;
}

function buildDecisionSnapshot(input: {
	payloadSnapshot?: unknown;
	cacheEntry: Awaited<ReturnType<typeof getSharpMoneyCacheByConditionId>>;
	conditionId: string;
	marketTitle: string;
	eventTime?: string;
	sharpSide?: string;
	price?: number;
	grade?: string;
	signalScore?: number;
	edgeRating?: number;
	scoreDifferential?: number;
	marketQualityScore?: number;
	thresholdUsed?: number;
	warnings?: string[];
	candidateComputedAt?: number;
	l2Imbalance?: number;
	l2ImbalanceNearMid?: number;
	l2Spread?: number;
	l2Disagreement?: boolean;
	canonicalScore?: number | null;
	canonicalSnapshotType?: string | null;
	canonicalWarnings?: string[];
	hedgedWalletCount?: number | null;
	maxHedgeRatio?: number | null;
	hedgedValueShareSharpSide?: number | null;
	totalHedgedFraction?: number | null;
}): Record<string, unknown> {
	const sharpSideTopHolders =
		input.sharpSide === "A"
			? (input.cacheEntry?.sideA.topHolders ?? [])
			: input.sharpSide === "B"
				? (input.cacheEntry?.sideB.topHolders ?? [])
				: [];
	const sharpSideTotalValue =
		input.sharpSide === "A"
			? (input.cacheEntry?.sideA.totalValue ?? 0)
			: input.sharpSide === "B"
				? (input.cacheEntry?.sideB.totalValue ?? 0)
				: 0;
	const sortedSharpSideHolders = sharpSideTopHolders
		.slice()
		.sort((left, right) => right.amount - left.amount);
	const top1Share =
		sharpSideTotalValue > 0
			? (sortedSharpSideHolders[0]?.amount ?? 0) / sharpSideTotalValue
			: null;
	const top3Share =
		sharpSideTotalValue > 0
			? sortedSharpSideHolders
					.slice(0, 3)
					.reduce((sum, holder) => sum + holder.amount, 0) / sharpSideTotalValue
			: null;
	const marketTitle = input.marketTitle || input.cacheEntry?.marketTitle || "";
	const eventTime = input.eventTime ?? input.cacheEntry?.eventTime;
	const eventTimeMs = eventTime ? new Date(eventTime).getTime() : Number.NaN;
	const minutesToStartAtPick = Number.isFinite(eventTimeMs)
		? (eventTimeMs - Date.now()) / (60 * 1000)
		: null;
	const defaultSnapshot: Record<string, unknown> = {
		conditionId: input.conditionId,
		marketTitle,
		marketType: getMarketTypeLabel(marketTitle),
		marketSlug: input.cacheEntry?.marketSlug ?? null,
		eventSlug: input.cacheEntry?.eventSlug ?? null,
		sportSeriesId: input.cacheEntry?.sportSeriesId ?? null,
		eventTime: eventTime ?? null,
		minutesToStartAtPick,
		sharpSide: input.sharpSide ?? null,
		priceAtPick: input.price ?? null,
		grade: input.grade ?? null,
		signalScore: input.signalScore ?? null,
		edgeRating: input.edgeRating ?? null,
		scoreDifferential: input.scoreDifferential ?? null,
		marketQualityScore: input.marketQualityScore ?? null,
		thresholdUsed: input.thresholdUsed ?? null,
		warnings: input.warnings ?? [],
		sharpSideValueRatio: input.cacheEntry?.sharpSideValueRatio ?? null,
		pnlCoverage: input.cacheEntry?.pnlCoverage ?? null,
		sideASharpScore: input.cacheEntry?.sideA.sharpScore ?? null,
		sideBSharpScore: input.cacheEntry?.sideB.sharpScore ?? null,
		sideAHolderCount: input.cacheEntry?.sideA.holderCount ?? null,
		sideBHolderCount: input.cacheEntry?.sideB.holderCount ?? null,
		top1Share,
		top3Share,
		candidateComputedAt: input.candidateComputedAt ?? null,
		l2Imbalance: input.l2Imbalance ?? null,
		l2ImbalanceNearMid: input.l2ImbalanceNearMid ?? null,
		l2Spread: input.l2Spread ?? null,
		l2Disagreement: input.l2Disagreement ?? null,
		canonicalScore: input.canonicalScore ?? null,
		canonicalSnapshotType: input.canonicalSnapshotType ?? null,
		canonicalWarnings: input.canonicalWarnings ?? [],
		hedgedWalletCount: input.hedgedWalletCount ?? null,
		maxHedgeRatio: input.maxHedgeRatio ?? null,
		hedgedValueShareSharpSide: input.hedgedValueShareSharpSide ?? null,
		totalHedgedFraction: input.totalHedgedFraction ?? null,
	};
	if (!isPlainObject(input.payloadSnapshot)) {
		return defaultSnapshot;
	}
	// Server-computed fields win over the bot's payloadSnapshot so that fresh
	// L2 / canonical / hedging values aren't clobbered by stale or null entries
	// the bot included from its local view. Extra keys the server doesn't know
	// about still flow through from payloadSnapshot.
	return {
		...input.payloadSnapshot,
		...defaultSnapshot,
	};
}

async function listBotCandidates(
	db: D1Database,
	options: BotCandidatesOptions,
): Promise<BotCandidatesResult> {
	const windowMinutes =
		typeof options.windowMinutes === "number" && options.windowMinutes > 0
			? options.windowMinutes
			: DEFAULT_CANDIDATE_WINDOW_MINUTES;
	const limit =
		typeof options.limit === "number" && options.limit > 0
			? Math.min(options.limit, MAX_CANDIDATE_LIMIT)
			: DEFAULT_CACHE_LIMIT;
	const shouldRequireReady = options.requireReady ?? true;
	const shouldRequireMicrostructure = options.requireMicrostructure ?? true;
	const marketQualityThreshold =
		typeof options.marketQualityThreshold === "number" &&
		options.marketQualityThreshold >= 0 &&
		options.marketQualityThreshold <= 1
			? options.marketQualityThreshold
			: DEFAULT_MARKET_QUALITY_THRESHOLD;
	const inspectConditionId = options.inspectConditionId ?? null;
	const allowStarted = options.includeStarted ?? false;
	const minMinutesToStart =
		typeof options.minMinutesToStart === "number" &&
		Number.isFinite(options.minMinutesToStart) &&
		options.minMinutesToStart >= 0
			? options.minMinutesToStart
			: DEFAULT_MIN_MINUTES_TO_START;
	const maxMinutesToStart =
		typeof options.maxMinutesToStart === "number" &&
		Number.isFinite(options.maxMinutesToStart) &&
		options.maxMinutesToStart > 0
			? options.maxMinutesToStart
			: windowMinutes;
	const windowHours = Math.max(
		1,
		Math.ceil(Math.max(windowMinutes, maxMinutesToStart) / 60),
	);
	const now = Date.now();
	const maxMinutesWindow = Math.max(maxMinutesToStart, minMinutesToStart);
	const cutoffMs = maxMinutesWindow * 60 * 1000;

	const entries = await listSharpMoneyCache(db, {
		limit,
		windowHours,
	});
	const debug: BotCandidatesDebug = {
		totalEntries: entries.length,
		upcomingEntries: 0,
		candidatesBeforeDedup: 0,
		returnedAfterDedup: 0,
		excluded: {},
		dedupDropped: 0,
		dedupReasons: {},
		policyMatched: {},
		returnedByMarketType: {},
		returnedByTimingBucket: {},
		returnedBySportSeries: {},
		nearMisses: [],
	};
	const upcomingEntries = entries.filter((entry) => {
		if (inspectConditionId && entry.conditionId === inspectConditionId) {
			debug.inspect = {
				conditionId: inspectConditionId,
				foundInEntries: true,
				stage: "entries",
			};
		}
		const marketType = getMarketTypeLabel(entry.marketTitle);
		if (marketType === "other") {
			incrementCounter(debug.excluded, "market_type_other");
			if (inspectConditionId && entry.conditionId === inspectConditionId) {
				debug.inspect = {
					conditionId: inspectConditionId,
					foundInEntries: true,
					stage: "filtered_pre",
					reason: "market_type_other",
				};
			}
			return false;
		}
		if (shouldRequireReady && !entry.isReady) {
			incrementCounter(debug.excluded, "not_ready");
			if (inspectConditionId && entry.conditionId === inspectConditionId) {
				debug.inspect = {
					conditionId: inspectConditionId,
					foundInEntries: true,
					stage: "filtered_pre",
					reason: "not_ready",
				};
			}
			return false;
		}
		const eventTime = parseEventTime(entry.eventTime);
		if (!eventTime) {
			incrementCounter(debug.excluded, "missing_event_time");
			if (inspectConditionId && entry.conditionId === inspectConditionId) {
				debug.inspect = {
					conditionId: inspectConditionId,
					foundInEntries: true,
					stage: "filtered_pre",
					reason: "missing_event_time",
				};
			}
			return false;
		}
		const diffMs = eventTime.getTime() - now;
		if (!allowStarted && diffMs < 0) {
			incrementCounter(debug.excluded, "started_excluded");
			if (inspectConditionId && entry.conditionId === inspectConditionId) {
				debug.inspect = {
					conditionId: inspectConditionId,
					foundInEntries: true,
					stage: "filtered_pre",
					reason: "started_excluded",
				};
			}
			return false;
		}
		if (allowStarted && diffMs < -cutoffMs) {
			incrementCounter(debug.excluded, "started_too_old");
			if (inspectConditionId && entry.conditionId === inspectConditionId) {
				debug.inspect = {
					conditionId: inspectConditionId,
					foundInEntries: true,
					stage: "filtered_pre",
					reason: "started_too_old",
				};
			}
			return false;
		}
		const minutesToStart = diffMs / 60_000;
		if (minutesToStart < minMinutesToStart) {
			incrementCounter(debug.excluded, "too_close_to_start");
			if (inspectConditionId && entry.conditionId === inspectConditionId) {
				debug.inspect = {
					conditionId: inspectConditionId,
					foundInEntries: true,
					stage: "filtered_pre",
					reason: "too_close_to_start",
				};
			}
			return false;
		}
		const inWindow = minutesToStart <= maxMinutesToStart;
		if (!inWindow) {
			incrementCounter(debug.excluded, "outside_window");
			if (inspectConditionId && entry.conditionId === inspectConditionId) {
				debug.inspect = {
					conditionId: inspectConditionId,
					foundInEntries: true,
					stage: "filtered_pre",
					reason: "outside_window",
				};
			}
		}
		return inWindow;
	});
	debug.upcomingEntries = upcomingEntries.length;
	if (upcomingEntries.length === 0) {
		const result = {
			candidates: [],
			requested: 0,
			returned: 0,
			truncated: false,
			computedAt: nowUnixSeconds(),
			debug,
		};
		if (!inspectConditionId) {
			await insertBotCandidateSnapshot(db, {
				createdAt: result.computedAt,
				minGrade: options.minGrade,
				windowMinutes: options.windowMinutes,
				minMinutesToStart: options.minMinutesToStart,
				maxMinutesToStart: options.maxMinutesToStart,
				requireReady: shouldRequireReady,
				includeStarted: allowStarted,
				requireMicrostructure: shouldRequireMicrostructure,
				marketQualityThreshold,
				requested: result.requested,
				returned: result.returned,
				totalEntries: debug.totalEntries,
				upcomingEntries: debug.upcomingEntries,
				candidatesBeforeDedup: debug.candidatesBeforeDedup,
				returnedAfterDedup: debug.returnedAfterDedup,
				excluded: debug.excluded,
				policyMatched: debug.policyMatched,
				returnedByMarketType: debug.returnedByMarketType,
				returnedByTimingBucket: debug.returnedByTimingBucket,
				returnedBySportSeries: debug.returnedBySportSeries,
			});
		}
		return result;
	}
	const gradesResult = await computeSharpMoneyGrades(db, {
		conditionIds: upcomingEntries.map((entry) => entry.conditionId),
	});
	if (gradesResult.error) {
		throw new Error(gradesResult.error);
	}
	const gradeByConditionId = new Map(
		gradesResult.results.map((result) => [result.conditionId, result]),
	);
	const canonicalScoreCache: CanonicalScoreCache = {
		teamByAlias: new Map(),
		snapshotByKey: new Map(),
	};
	const baseCandidates = (
		await Promise.all(
			upcomingEntries.map(async (entry) => {
				const grade = gradeByConditionId.get(entry.conditionId) ?? null;
				const policyEventTime = parseEventTime(entry.eventTime);
				const policyMinutesToStart =
					policyEventTime !== null
						? (policyEventTime.getTime() - now) / 60_000
						: null;
				const policy = getBotCandidatePolicy({
					marketType: getMarketTypeLabel(entry.marketTitle),
					sportSeriesId: entry.sportSeriesId,
					minutesToStart: policyMinutesToStart,
					baseMinGrade: options.minGrade,
					baseMarketQualityThreshold: marketQualityThreshold,
				});
				const policyKey = getBotCandidatePolicyKey({
					policy,
					marketType: getMarketTypeLabel(entry.marketTitle),
					sportSeriesId: entry.sportSeriesId,
					minutesToStart: policyMinutesToStart,
				});
				incrementCounter(debug.policyMatched, policyKey);
				if (policy.reject) {
					const rejectReason = policy.rejectReason ?? "policy_rejected";
					incrementCounter(debug.excluded, rejectReason);
					pushNearMiss(debug, {
						reason: rejectReason,
						conditionId: entry.conditionId,
						marketTitle: entry.marketTitle,
						sportSeriesId: entry.sportSeriesId,
						marketType: getMarketTypeLabel(entry.marketTitle),
						sharpSide: entry.sharpSide,
						sharpSidePrice:
							entry.sharpSide === "A"
								? (entry.sideA.price ?? null)
								: entry.sharpSide === "B"
									? (entry.sideB.price ?? null)
									: null,
						grade: grade?.grade ?? undefined,
						policyMinGrade: policy.minGrade,
						signalScore: grade?.signalScore,
						marketQualityScore: grade?.microstructureScore,
						minutesToStart: policyMinutesToStart,
					});
					if (inspectConditionId && entry.conditionId === inspectConditionId) {
						debug.inspect = {
							conditionId: inspectConditionId,
							foundInEntries: true,
							stage: "filtered_policy",
							reason: rejectReason,
						};
					}
					return null;
				}
				if (!grade?.grade) {
					incrementCounter(debug.excluded, "missing_grade");
					if (inspectConditionId && entry.conditionId === inspectConditionId) {
						debug.inspect = {
							conditionId: inspectConditionId,
							foundInEntries: true,
							stage: "filtered_grade",
							reason: "missing_grade",
						};
					}
					return null;
				}
				if (GRADE_RANK[grade.grade] < GRADE_RANK[policy.minGrade]) {
					incrementCounter(debug.excluded, "below_policy_grade");
					pushNearMiss(debug, {
						reason: "below_policy_grade",
						conditionId: entry.conditionId,
						marketTitle: entry.marketTitle,
						sportSeriesId: entry.sportSeriesId,
						marketType: getMarketTypeLabel(entry.marketTitle),
						sharpSide: entry.sharpSide,
						sharpSidePrice:
							entry.sharpSide === "A"
								? (entry.sideA.price ?? null)
								: entry.sharpSide === "B"
									? (entry.sideB.price ?? null)
									: null,
						grade: grade.grade,
						policyMinGrade: policy.minGrade,
						signalScore: grade.signalScore,
						marketQualityScore: grade.microstructureScore,
						minutesToStart: policyMinutesToStart,
					});
					if (inspectConditionId && entry.conditionId === inspectConditionId) {
						debug.inspect = {
							conditionId: inspectConditionId,
							foundInEntries: true,
							stage: "filtered_grade",
							reason: "below_policy_grade",
						};
					}
					return null;
				}
				if (
					typeof entry.scoreDifferential === "number" &&
					entry.scoreDifferential < MIN_SCORE_DIFFERENTIAL
				) {
					incrementCounter(debug.excluded, "low_score_differential");
					pushNearMiss(debug, {
						reason: "low_score_differential",
						conditionId: entry.conditionId,
						marketTitle: entry.marketTitle,
						sportSeriesId: entry.sportSeriesId,
						marketType: getMarketTypeLabel(entry.marketTitle),
						sharpSide: entry.sharpSide,
						sharpSidePrice:
							entry.sharpSide === "A"
								? (entry.sideA.price ?? null)
								: entry.sharpSide === "B"
									? (entry.sideB.price ?? null)
									: null,
						grade: grade.grade,
						policyMinGrade: policy.minGrade,
						signalScore: grade.signalScore,
						marketQualityScore: grade.microstructureScore,
						minutesToStart: policyMinutesToStart,
					});
					if (inspectConditionId && entry.conditionId === inspectConditionId) {
						debug.inspect = {
							conditionId: inspectConditionId,
							foundInEntries: true,
							stage: "filtered_grade",
							reason: "low_score_differential",
						};
					}
					return null;
				}
				if (
					typeof grade.signalScore === "number" &&
					!isAcceptableSignalScore(grade.signalScore)
				) {
					incrementCounter(debug.excluded, "signal_score_saturation");
					pushNearMiss(debug, {
						reason: "signal_score_saturation",
						conditionId: entry.conditionId,
						marketTitle: entry.marketTitle,
						sportSeriesId: entry.sportSeriesId,
						marketType: getMarketTypeLabel(entry.marketTitle),
						sharpSide: entry.sharpSide,
						sharpSidePrice:
							entry.sharpSide === "A"
								? (entry.sideA.price ?? null)
								: entry.sharpSide === "B"
									? (entry.sideB.price ?? null)
									: null,
						grade: grade.grade,
						policyMinGrade: policy.minGrade,
						signalScore: grade.signalScore,
						marketQualityScore: grade.microstructureScore,
						minutesToStart: policyMinutesToStart,
					});
					if (inspectConditionId && entry.conditionId === inspectConditionId) {
						debug.inspect = {
							conditionId: inspectConditionId,
							foundInEntries: true,
							stage: "filtered_grade",
							reason: "signal_score_saturation",
						};
					}
					return null;
				}
				if (
					typeof entry.edgeRating === "number" &&
					!isAcceptableEdgeRating(entry.edgeRating)
				) {
					const reason =
						entry.edgeRating >= EDGE_RATING_SATURATION_FLOOR
							? "edge_rating_saturation"
							: entry.edgeRating >= EDGE_RATING_DEAD_ZONE_MIN &&
								  entry.edgeRating < EDGE_RATING_DEAD_ZONE_MAX
								? "edge_rating_dead_zone"
								: "edge_rating_below_floor";
					incrementCounter(debug.excluded, reason);
					pushNearMiss(debug, {
						reason,
						conditionId: entry.conditionId,
						marketTitle: entry.marketTitle,
						sportSeriesId: entry.sportSeriesId,
						marketType: getMarketTypeLabel(entry.marketTitle),
						sharpSide: entry.sharpSide,
						sharpSidePrice:
							entry.sharpSide === "A"
								? (entry.sideA.price ?? null)
								: entry.sharpSide === "B"
									? (entry.sideB.price ?? null)
									: null,
						grade: grade.grade,
						policyMinGrade: policy.minGrade,
						signalScore: grade.signalScore,
						marketQualityScore: grade.microstructureScore,
						minutesToStart: policyMinutesToStart,
					});
					if (inspectConditionId && entry.conditionId === inspectConditionId) {
						debug.inspect = {
							conditionId: inspectConditionId,
							foundInEntries: true,
							stage: "filtered_grade",
							reason,
						};
					}
					return null;
				}
				if (
					shouldRequireMicrostructure &&
					(grade.microstructureScore ?? 0) < policy.marketQualityThreshold
				) {
					incrementCounter(debug.excluded, "below_policy_microstructure");
					pushNearMiss(debug, {
						reason: "below_policy_microstructure",
						conditionId: entry.conditionId,
						marketTitle: entry.marketTitle,
						sportSeriesId: entry.sportSeriesId,
						marketType: getMarketTypeLabel(entry.marketTitle),
						sharpSide: entry.sharpSide,
						sharpSidePrice:
							entry.sharpSide === "A"
								? (entry.sideA.price ?? null)
								: entry.sharpSide === "B"
									? (entry.sideB.price ?? null)
									: null,
						grade: grade.grade,
						policyMinGrade: policy.minGrade,
						signalScore: grade.signalScore,
						marketQualityScore: grade.microstructureScore,
						minutesToStart: policyMinutesToStart,
					});
					if (inspectConditionId && entry.conditionId === inspectConditionId) {
						debug.inspect = {
							conditionId: inspectConditionId,
							foundInEntries: true,
							stage: "filtered_grade",
							reason: "below_policy_microstructure",
						};
					}
					return null;
				}
				const canonicalScore = await computeCanonicalBotCandidateScore(
					db,
					canonicalScoreCache,
					{
						marketTitle: entry.marketTitle,
						sportSeriesId: entry.sportSeriesId,
						sharpSide: entry.sharpSide,
						sideA: entry.sideA,
						sideB: entry.sideB,
					},
				);
				const priceEdgeResult =
					entry.sharpSide === "A" || entry.sharpSide === "B"
						? computePriceEdgeFromEntry({
								sharpSide: entry.sharpSide,
								confidence: entry.confidence,
								edgeRating: entry.edgeRating,
								sideA: {
									sharpScore: entry.sideA.sharpScore,
									price: entry.sideA.price ?? null,
								},
								sideB: {
									sharpScore: entry.sideB.sharpScore,
									price: entry.sideB.price ?? null,
								},
							})
						: null;
				if (
					typeof priceEdgeResult?.priceEdge === "number" &&
					!isAcceptablePriceEdge(priceEdgeResult.priceEdge)
				) {
					incrementCounter(debug.excluded, "price_edge_below_floor");
					pushNearMiss(debug, {
						reason: "price_edge_below_floor",
						conditionId: entry.conditionId,
						marketTitle: entry.marketTitle,
						sportSeriesId: entry.sportSeriesId,
						marketType: getMarketTypeLabel(entry.marketTitle),
						sharpSide: entry.sharpSide,
						sharpSidePrice:
							entry.sharpSide === "A"
								? (entry.sideA.price ?? null)
								: entry.sharpSide === "B"
									? (entry.sideB.price ?? null)
									: null,
						grade: grade.grade,
						policyMinGrade: policy.minGrade,
						signalScore: grade.signalScore,
						marketQualityScore: grade.microstructureScore,
						minutesToStart: policyMinutesToStart,
					});
					if (inspectConditionId && entry.conditionId === inspectConditionId) {
						debug.inspect = {
							conditionId: inspectConditionId,
							foundInEntries: true,
							stage: "filtered_grade",
							reason: "price_edge_below_floor",
						};
					}
					return null;
				}
				const hedgingMetrics = computeHedgingMetrics(
					entry.sideA.topHolders ?? [],
					entry.sideB.topHolders ?? [],
				);
				const hedgedValueShareSharpSide =
					entry.sharpSide === "A"
						? hedgingMetrics.hedgedValueShareA
						: entry.sharpSide === "B"
							? hedgingMetrics.hedgedValueShareB
							: null;
				return {
					entry: toSlimCandidate(entry),
					grade: {
						grade: grade.grade,
						signalScore: grade.signalScore,
						edgeRating: grade.edgeRating,
						scoreDifferential: grade.scoreDifferential,
						microstructureScore: grade.microstructureScore,
						segmentScore: policy.rankingAdjustment,
						segmentKey: policy.segmentKey,
						segmentLabel: policy.segmentLabel,
						segmentNotes: policy.notes,
						canonicalScore: canonicalScore?.totalScore ?? null,
						canonicalSnapshotType: canonicalScore?.snapshotType ?? null,
						canonicalWarnings: canonicalScore?.warnings ?? [],
						priceEdge: priceEdgeResult?.priceEdge ?? null,
						fairPrice: priceEdgeResult?.fairPrice ?? null,
						minPriceEdge: priceEdgeResult?.minPriceEdge ?? null,
						hedgedWalletCount: hedgingMetrics.hedgedWalletCount,
						maxHedgeRatio: hedgingMetrics.maxHedgeRatio,
						hedgedValueShareSharpSide,
						totalHedgedFraction: hedgingMetrics.totalHedgedFraction,
						isReady: grade.isReady,
						warnings: grade.warnings,
						computedAt: grade.computedAt,
						historyUpdatedAt: grade.historyUpdatedAt,
					},
					policy,
				};
			}),
		)
	).filter((candidate) => candidate !== null);
	const candidates = baseCandidates;
	debug.candidatesBeforeDedup = candidates.length;
	const deduped = new Map<string, (typeof candidates)[number]>();
	for (const candidate of candidates) {
		if (!candidate) continue;
		const key = getMarketGroupKey(candidate.entry);
		const existing = deduped.get(key);
		if (!existing) {
			deduped.set(key, candidate);
			if (
				inspectConditionId &&
				candidate.entry.conditionId === inspectConditionId
			) {
				debug.inspect = {
					conditionId: inspectConditionId,
					foundInEntries: true,
					stage: "dedup_seed",
					dedupGroupKey: key,
					wonDedup: true,
				};
			}
			continue;
		}
		const comparison = compareBotCandidates(candidate, existing);
		if (comparison < 0) {
			debug.dedupDropped += 1;
			incrementCounter(debug.dedupReasons, "candidate_priority");
			deduped.set(key, candidate);
			continue;
		}
		if (comparison > 0) {
			debug.dedupDropped += 1;
			incrementCounter(debug.dedupReasons, "candidate_priority");
			if (
				inspectConditionId &&
				candidate.entry.conditionId === inspectConditionId
			) {
				debug.inspect = {
					conditionId: inspectConditionId,
					foundInEntries: true,
					stage: "dedup_lost",
					reason: "candidate_priority",
					dedupGroupKey: key,
					wonDedup: false,
				};
			}
		}
	}
	const dedupedCandidates = [...deduped.values()].sort((left, right) =>
		compareBotCandidates(left, right),
	);
	for (const candidate of dedupedCandidates) {
		incrementCounter(debug.returnedByMarketType, candidate.entry.marketType);
		incrementCounter(
			debug.returnedByTimingBucket,
			resolveTimingBucket(getCandidateMinutesToStart(candidate)),
		);
		incrementCounter(
			debug.returnedBySportSeries,
			candidate.entry.sportSeriesId !== undefined
				? String(candidate.entry.sportSeriesId)
				: "unknown",
		);
	}
	debug.returnedAfterDedup = dedupedCandidates.length;
	if (inspectConditionId && !debug.inspect) {
		debug.inspect = {
			conditionId: inspectConditionId,
			foundInEntries: false,
			stage: "not_found_in_entries",
		};
	}
	const result = {
		candidates: dedupedCandidates,
		requested: gradesResult.requested,
		returned: dedupedCandidates.length,
		truncated: gradesResult.truncated,
		computedAt: gradesResult.computedAt,
		debug,
	};
	if (!inspectConditionId) {
		await insertBotCandidateSnapshot(db, {
			createdAt: result.computedAt,
			minGrade: options.minGrade,
			windowMinutes: options.windowMinutes,
			minMinutesToStart: options.minMinutesToStart,
			maxMinutesToStart: options.maxMinutesToStart,
			requireReady: shouldRequireReady,
			includeStarted: allowStarted,
			requireMicrostructure: shouldRequireMicrostructure,
			marketQualityThreshold,
			requested: result.requested,
			returned: result.returned,
			totalEntries: debug.totalEntries,
			upcomingEntries: debug.upcomingEntries,
			candidatesBeforeDedup: debug.candidatesBeforeDedup,
			returnedAfterDedup: debug.returnedAfterDedup,
			excluded: debug.excluded,
			policyMatched: debug.policyMatched,
			returnedByMarketType: debug.returnedByMarketType,
			returnedByTimingBucket: debug.returnedByTimingBucket,
			returnedBySportSeries: debug.returnedBySportSeries,
		});
	}
	return result;
}

export const getBotCandidatesFn = createServerFn({ method: "POST" }).handler(
	async ({ context, data }) => {
		const payload = (data ?? {}) as Partial<BotCandidatesOptions>;
		const minGrade = parseMinGrade(payload.minGrade ?? null);
		if (!minGrade) {
			return { error: "invalid_minGrade" as const };
		}
		try {
			const result = await listBotCandidates(getDb(context), {
				minGrade,
				windowMinutes: payload.windowMinutes,
				minMinutesToStart: payload.minMinutesToStart,
				maxMinutesToStart: payload.maxMinutesToStart,
				limit: payload.limit,
				requireReady: payload.requireReady,
				includeStarted: payload.includeStarted,
				requireMicrostructure: payload.requireMicrostructure,
				marketQualityThreshold: payload.marketQualityThreshold,
				inspectConditionId: payload.inspectConditionId ?? null,
			});
			return result;
		} catch (error) {
			return {
				error:
					error instanceof Error
						? error.message
						: ("candidate_build_failed" as const),
			};
		}
	},
);

export const getBotCandidateInspectFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as {
		conditionId?: string;
		minGrade?: GradeLabel;
		windowMinutes?: number;
		minMinutesToStart?: number;
		maxMinutesToStart?: number;
		requireReady?: boolean;
		includeStarted?: boolean;
		requireMicrostructure?: boolean;
		marketQualityThreshold?: number;
		limit?: number;
	};
	const conditionId = payload.conditionId?.trim();
	if (!conditionId) {
		return { error: "conditionId_required" as const };
	}
	const minGrade = parseMinGrade(payload.minGrade ?? null);
	if (!minGrade) {
		return { error: "invalid_minGrade" as const };
	}
	try {
		const windowMinutes =
			typeof payload.windowMinutes === "number" && payload.windowMinutes > 0
				? payload.windowMinutes
				: DEFAULT_CANDIDATE_WINDOW_MINUTES;
		const shouldRequireReady = payload.requireReady ?? true;
		const allowStarted = payload.includeStarted ?? false;
		const result = await listBotCandidates(getDb(context), {
			minGrade,
			windowMinutes,
			minMinutesToStart: payload.minMinutesToStart,
			maxMinutesToStart: payload.maxMinutesToStart,
			limit: payload.limit,
			requireReady: shouldRequireReady,
			includeStarted: payload.includeStarted,
			requireMicrostructure: payload.requireMicrostructure,
			marketQualityThreshold: payload.marketQualityThreshold,
			inspectConditionId: conditionId,
		});
		const inspect = result.debug.inspect ?? {
			conditionId,
			foundInEntries: false,
			stage: "not_found_in_entries",
		};
		if (inspect.stage === "not_found_in_entries") {
			const db = getDb(context);
			const cacheEntry = await getSharpMoneyCacheByConditionId(db, conditionId);
			if (!cacheEntry) {
				return {
					inspect: {
						...inspect,
						diagnosticReason: "not_in_cache_table",
					},
				};
			}
			const eventTime = parseEventTime(cacheEntry.eventTime);
			const now = Date.now();
			const minutesToStart =
				eventTime !== null ? (eventTime.getTime() - now) / 60_000 : null;
			const cutoffMinutes = windowMinutes;
			const inEventWindow =
				minutesToStart === null
					? false
					: minutesToStart >= 0 && minutesToStart <= cutoffMinutes;
			const recentCacheCutoffSeconds =
				nowUnixSeconds() - Math.max(1, Math.ceil(windowMinutes / 60)) * 3600;
			const inRecentCacheWindow =
				(cacheEntry.updatedAt ?? 0) >= recentCacheCutoffSeconds;
			let diagnosticReason = "not_in_recent_cache_window";
			const marketType = getMarketTypeLabel(cacheEntry.marketTitle);
			if (marketType === "other") {
				diagnosticReason = "market_type_other";
			} else if (shouldRequireReady && !cacheEntry.isReady) {
				diagnosticReason = "not_ready";
			} else if (!eventTime) {
				diagnosticReason = "missing_event_time";
			} else if (
				!allowStarted &&
				minutesToStart !== null &&
				minutesToStart < 0
			) {
				diagnosticReason = "started_excluded";
			} else if (!inEventWindow) {
				diagnosticReason = "outside_event_window";
			} else if (inRecentCacheWindow) {
				// The market exists in cache and passes the coarse window/readiness checks,
				// but it was not part of the limited candidate scan returned by
				// listSharpMoneyCache(...) for this inspect request.
				diagnosticReason = "not_in_limited_candidate_scan";
			}
			return {
				inspect: {
					...inspect,
					diagnosticReason,
					isReady: cacheEntry.isReady,
					marketType,
					minutesToStart,
					candidateWindowMinutes: cutoffMinutes,
					inEventWindow,
					inRecentCacheWindow,
					cacheUpdatedAt: cacheEntry.updatedAt,
				},
			};
		}
		return {
			inspect,
		};
	} catch (error) {
		return {
			error:
				error instanceof Error
					? error.message
					: ("candidate_inspect_failed" as const),
		};
	}
});

export const getBotInspectDefaultsFn = createServerFn({
	method: "GET",
}).handler(async ({ context }) => {
	return {
		defaults: await loadBotInspectDefaults(context.env),
	};
});

export const getBotCohortsFn = createServerFn({
	method: "GET",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as { limit?: number };
	const limit =
		typeof payload.limit === "number" && payload.limit > 0
			? Math.min(payload.limit, 100)
			: 20;
	return {
		snapshots: await listBotCandidateSnapshots(getDb(context), limit),
	};
});

export async function handleBotRequest(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const url = new URL(request.url);
	if (!url.pathname.startsWith("/api/bot/")) return null;

	const auth = requireBotAuth(request, env);
	if (!auth.ok) return auth.response;

	if (url.pathname === "/api/bot/health") {
		if (request.method !== "GET") {
			return jsonResponse({ error: "method_not_allowed" }, { status: 405 });
		}
		const db = env.POLYWHALER_DB;
		const cacheFreshness = await getSharpMoneyCacheFreshnessStats(db, 15 * 60);
		return jsonResponse({
			ok: true,
			now: nowUnixSeconds(),
			cacheFreshness,
		});
	}

	if (url.pathname === "/api/bot/cache") {
		if (request.method !== "GET") {
			return jsonResponse({ error: "method_not_allowed" }, { status: 405 });
		}
		const db = env.POLYWHALER_DB;
		const limitParam = Number(url.searchParams.get("limit"));
		const windowParam = Number(url.searchParams.get("windowHours"));
		const seriesParam = url.searchParams.get("sportSeriesId");
		const limit =
			Number.isFinite(limitParam) && limitParam > 0
				? Math.min(limitParam, 500)
				: DEFAULT_CACHE_LIMIT;
		const windowHours =
			Number.isFinite(windowParam) && windowParam > 0
				? windowParam
				: DEFAULT_CACHE_WINDOW_HOURS;
		const sportSeriesId =
			seriesParam && Number.isFinite(Number(seriesParam))
				? Number(seriesParam)
				: undefined;
		const entries = await listSharpMoneyCache(db, {
			limit,
			windowHours,
			sportSeriesId,
		});
		return jsonResponse({ entries });
	}

	if (url.pathname === "/api/bot/candidates") {
		if (request.method !== "GET") {
			return jsonResponse({ error: "method_not_allowed" }, { status: 405 });
		}
		const minGrade = parseMinGrade(url.searchParams.get("minGrade"));
		if (!minGrade) {
			return jsonResponse({ error: "invalid_minGrade" }, { status: 400 });
		}
		const windowMinutesParam = Number(url.searchParams.get("windowMinutes"));
		const minMinutesToStartParam = Number(
			url.searchParams.get("minMinutesToStart"),
		);
		const maxMinutesToStartParam = Number(
			url.searchParams.get("maxMinutesToStart"),
		);
		const limitParam = Number(url.searchParams.get("limit"));
		const requireReady = url.searchParams.get("requireReady");
		const includeStarted = url.searchParams.get("includeStarted");
		const requireMicrostructure = url.searchParams.get("requireMicrostructure");
		const includeDebug =
			url.searchParams.get("debug")?.toLowerCase() === "true";
		const inspectConditionId = url.searchParams.get("inspectConditionId");
		const marketQualityThresholdParam = Number(
			url.searchParams.get("marketQualityThreshold"),
		);
		try {
			const result = await listBotCandidates(env.POLYWHALER_DB, {
				minGrade,
				windowMinutes:
					Number.isFinite(windowMinutesParam) && windowMinutesParam > 0
						? windowMinutesParam
						: DEFAULT_CANDIDATE_WINDOW_MINUTES,
				minMinutesToStart:
					Number.isFinite(minMinutesToStartParam) && minMinutesToStartParam >= 0
						? minMinutesToStartParam
						: undefined,
				maxMinutesToStart:
					Number.isFinite(maxMinutesToStartParam) && maxMinutesToStartParam > 0
						? maxMinutesToStartParam
						: undefined,
				limit:
					Number.isFinite(limitParam) && limitParam > 0
						? Math.min(limitParam, MAX_CANDIDATE_LIMIT)
						: DEFAULT_CACHE_LIMIT,
				requireReady:
					requireReady === null || requireReady.toLowerCase() === "true",
				includeStarted: includeStarted?.toLowerCase() === "true",
				requireMicrostructure:
					requireMicrostructure === null ||
					requireMicrostructure.toLowerCase() === "true",
				marketQualityThreshold:
					Number.isFinite(marketQualityThresholdParam) &&
					marketQualityThresholdParam >= 0 &&
					marketQualityThresholdParam <= 1
						? marketQualityThresholdParam
						: DEFAULT_MARKET_QUALITY_THRESHOLD,
				inspectConditionId,
			});
			return jsonResponse({
				candidates: result.candidates,
				requested: result.requested,
				returned: result.returned,
				truncated: result.truncated,
				computedAt: result.computedAt,
				...(includeDebug ? { debug: result.debug } : {}),
			});
		} catch (error) {
			return jsonResponse(
				{
					error:
						error instanceof Error ? error.message : "candidate_build_failed",
				},
				{ status: 400 },
			);
		}
	}

	if (url.pathname === "/api/bot/cohorts") {
		if (request.method !== "GET") {
			return jsonResponse({ error: "method_not_allowed" }, { status: 405 });
		}
		const limitParam = Number(url.searchParams.get("limit"));
		const limit =
			Number.isFinite(limitParam) && limitParam > 0
				? Math.min(limitParam, 100)
				: 20;
		const snapshots = await listBotCandidateSnapshots(env.POLYWHALER_DB, limit);
		return jsonResponse({ snapshots });
	}

	if (url.pathname === "/api/bot/daily-stats") {
		if (request.method !== "GET") {
			return jsonResponse({ error: "method_not_allowed" }, { status: 405 });
		}
		const limitParam = Number(url.searchParams.get("limit"));
		const limit =
			Number.isFinite(limitParam) && limitParam > 0
				? Math.min(limitParam, 30)
				: 14;
		const snapshots = await listDailyStatsSnapshots(env.POLYWHALER_DB, limit);
		return jsonResponse({ snapshots });
	}

	if (url.pathname === "/api/bot/grades") {
		if (request.method !== "POST") {
			return jsonResponse({ error: "method_not_allowed" }, { status: 405 });
		}
		const payload = await parseJson<SharpGradePayload>(request);
		if (!payload?.conditionIds || payload.conditionIds.length === 0) {
			return jsonResponse({ error: "conditionIds_required" }, { status: 400 });
		}
		const db = env.POLYWHALER_DB;
		const result = await computeSharpMoneyGrades(db, payload);
		if (result.error) {
			return jsonResponse({ error: result.error }, { status: 400 });
		}
		return jsonResponse(result);
	}

	if (url.pathname === "/api/bot/picks") {
		if (request.method !== "POST") {
			return jsonResponse({ error: "method_not_allowed" }, { status: 405 });
		}
		const payload = await parseJson<{
			clientPickId?: string;
			conditionId?: string;
			marketTitle?: string;
			eventTime?: string;
			grade?: string;
			signalScore?: number;
			edgeRating?: number;
			scoreDifferential?: number;
			sharpSide?: string;
			price?: number;
			strategyVersion?: string;
			thresholdUsed?: number;
			marketQualityScore?: number;
			warnings?: string[];
			decisionSnapshot?: unknown;
			candidateComputedAt?: number;
			l2Imbalance?: number;
			l2ImbalanceNearMid?: number;
			l2Spread?: number;
			l2Disagreement?: boolean;
		}>(request);
		if (!payload?.conditionId || !payload?.marketTitle) {
			return jsonResponse({ error: "invalid_payload" }, { status: 400 });
		}
		const cacheEntry = await getSharpMoneyCacheByConditionId(
			env.POLYWHALER_DB,
			payload.conditionId,
		);
		const snapshot = isPlainObject(payload.decisionSnapshot)
			? payload.decisionSnapshot
			: null;
		const sharpSide = payload.sharpSide ?? cacheEntry?.sharpSide;
		const price =
			payload.price ??
			(sharpSide === "A"
				? (cacheEntry?.sideA.price ?? undefined)
				: sharpSide === "B"
					? (cacheEntry?.sideB.price ?? undefined)
					: undefined);
		const edgeRating = payload.edgeRating ?? cacheEntry?.edgeRating;
		const scoreDifferential =
			payload.scoreDifferential ?? cacheEntry?.scoreDifferential;
		const signalScore =
			payload.signalScore ??
			extractSnapshotNumber(snapshot, ["signalScore"]) ??
			undefined;
		const marketQualityScore =
			payload.marketQualityScore ??
			extractSnapshotNumber(snapshot, [
				"marketQualityScore",
				"microstructureScore",
			]) ??
			(cacheEntry
				? computeMarketQualityScoreFromCacheEntry({
						sharpSide,
						sideA: { price: cacheEntry.sideA.price ?? null },
						sideB: { price: cacheEntry.sideB.price ?? null },
						marketVolume: cacheEntry.marketVolume,
						marketLiquidity: cacheEntry.marketLiquidity,
					})
				: null) ??
			undefined;
		const thresholdUsed =
			payload.thresholdUsed ??
			extractSnapshotNumber(snapshot, ["thresholdUsed"]) ??
			undefined;
		const warnings =
			payload.warnings ??
			extractSnapshotStringArray(snapshot, ["warnings"]) ??
			undefined;
		const candidateComputedAt =
			payload.candidateComputedAt ??
			extractSnapshotNumber(snapshot, ["candidateComputedAt"]) ??
			undefined;
		const l2Imbalance =
			payload.l2Imbalance ??
			extractSnapshotNumber(snapshot, ["l2Imbalance"]) ??
			undefined;
		const l2ImbalanceNearMid =
			payload.l2ImbalanceNearMid ??
			extractSnapshotNumber(snapshot, [
				"l2ImbalanceNearMid",
				"imbalanceNearMid",
			]) ??
			undefined;
		const l2Spread =
			payload.l2Spread ??
			extractSnapshotNumber(snapshot, ["l2Spread", "spread"]) ??
			undefined;
		const l2Disagreement =
			payload.l2Disagreement ??
			extractSnapshotBoolean(snapshot, [
				"l2Disagreement",
				"imbalanceDisagree",
			]) ??
			undefined;
		const needsL2Signals =
			l2Imbalance === undefined ||
			l2ImbalanceNearMid === undefined ||
			l2Spread === undefined ||
			l2Disagreement === undefined;
		console.log("[l2] picks handler", {
			conditionId: payload.conditionId,
			sharpSide,
			needsL2Signals,
			hasCacheEntry: Boolean(cacheEntry),
			sideALabel: cacheEntry?.sideA.label,
			sideBLabel: cacheEntry?.sideB.label,
		});
		const l2Fallback = needsL2Signals
			? await fetchL2SignalsForPick({
					conditionId: payload.conditionId,
					sharpSide,
					sideALabel: cacheEntry?.sideA.label,
					sideBLabel: cacheEntry?.sideB.label,
				})
			: {};
		const finalL2Imbalance = l2Imbalance ?? l2Fallback.l2Imbalance ?? undefined;
		const finalL2ImbalanceNearMid =
			l2ImbalanceNearMid ?? l2Fallback.l2ImbalanceNearMid ?? undefined;
		const finalL2Spread = l2Spread ?? l2Fallback.l2Spread ?? undefined;
		const finalL2Disagreement =
			l2Disagreement ?? l2Fallback.l2Disagreement ?? undefined;
		const confidence = cacheEntry?.confidence;
		const priceEdgeResult =
			cacheEntry && sharpSide
				? computePriceEdgeFromEntry({
						sharpSide,
						confidence: cacheEntry.confidence,
						edgeRating: cacheEntry.edgeRating,
						sideA: {
							sharpScore: cacheEntry.sideA.sharpScore,
							price: cacheEntry.sideA.price ?? null,
						},
						sideB: {
							sharpScore: cacheEntry.sideB.sharpScore,
							price: cacheEntry.sideB.price ?? null,
						},
					})
				: null;
		const hedgingMetrics = cacheEntry
			? computeHedgingMetrics(
					cacheEntry.sideA.topHolders ?? [],
					cacheEntry.sideB.topHolders ?? [],
				)
			: null;
		const hedgedValueShareSharpSide =
			hedgingMetrics == null
				? null
				: sharpSide === "A"
					? hedgingMetrics.hedgedValueShareA
					: sharpSide === "B"
						? hedgingMetrics.hedgedValueShareB
						: null;
		const canonicalResult =
			cacheEntry && (sharpSide === "A" || sharpSide === "B")
				? await computeCanonicalBotCandidateScore(
						env.POLYWHALER_DB,
						{ teamByAlias: new Map(), snapshotByKey: new Map() },
						{
							marketTitle: cacheEntry.marketTitle,
							sportSeriesId: cacheEntry.sportSeriesId ?? undefined,
							sharpSide,
							sideA: {
								label: cacheEntry.sideA.label,
								price: cacheEntry.sideA.price ?? null,
							},
							sideB: {
								label: cacheEntry.sideB.label,
								price: cacheEntry.sideB.price ?? null,
							},
						},
					).catch((error) => {
						console.error("[bot] canonical score compute failed", error);
						return null;
					})
				: null;

		const decisionSnapshot = buildDecisionSnapshot({
			payloadSnapshot: payload.decisionSnapshot,
			cacheEntry,
			conditionId: payload.conditionId,
			marketTitle: payload.marketTitle ?? cacheEntry?.marketTitle ?? "",
			eventTime: payload.eventTime ?? cacheEntry?.eventTime,
			sharpSide,
			price,
			grade: payload.grade,
			signalScore,
			edgeRating,
			scoreDifferential,
			marketQualityScore,
			thresholdUsed,
			warnings,
			candidateComputedAt,
			l2Imbalance: finalL2Imbalance,
			l2ImbalanceNearMid: finalL2ImbalanceNearMid,
			l2Spread: finalL2Spread,
			l2Disagreement: finalL2Disagreement,
			canonicalScore: canonicalResult?.totalScore ?? null,
			canonicalSnapshotType: canonicalResult?.snapshotType ?? null,
			canonicalWarnings: canonicalResult?.warnings ?? [],
			hedgedWalletCount: hedgingMetrics?.hedgedWalletCount ?? null,
			maxHedgeRatio: hedgingMetrics?.maxHedgeRatio ?? null,
			hedgedValueShareSharpSide,
			totalHedgedFraction: hedgingMetrics?.totalHedgedFraction ?? null,
		});
		const pick = await createManualPick(env.POLYWHALER_DB, {
			clientPickId: payload.clientPickId,
			conditionId: payload.conditionId,
			marketTitle: payload.marketTitle ?? cacheEntry?.marketTitle ?? "",
			eventTime: payload.eventTime ?? cacheEntry?.eventTime,
			grade: payload.grade,
			signalScore,
			edgeRating,
			scoreDifferential,
			sharpSide,
			price,
			confidence,
			fairPrice: priceEdgeResult?.fairPrice ?? null,
			priceEdge: priceEdgeResult?.priceEdge ?? null,
			strategyVersion:
				payload.strategyVersion ?? buildStrategyVersion() ?? undefined,
			thresholdUsed,
			marketQualityScore,
			warnings,
			decisionSnapshot,
			candidateComputedAt,
		});
		return jsonResponse({ pick });
	}

	if (url.pathname === "/api/bot/picks/execution") {
		if (request.method !== "POST") {
			return jsonResponse({ error: "method_not_allowed" }, { status: 405 });
		}
		const payload = await parseJson<{
			id?: string;
			clientPickId?: string;
			executionSubmittedAt?: number;
			executionFilledAt?: number;
			fillStatus?: string;
			fillPrice?: number;
			fillSize?: number;
			fillNotional?: number;
			fillSlippageBps?: number;
			orderId?: string;
			exchangeTradeId?: string;
			executionNotes?: string;
		}>(request);
		if (!payload?.id && !payload?.clientPickId) {
			return jsonResponse({ error: "invalid_payload" }, { status: 400 });
		}
		const pick = await updateManualPickExecution(env.POLYWHALER_DB, {
			id: payload.id,
			clientPickId: payload.clientPickId,
			executionSubmittedAt: payload.executionSubmittedAt ?? null,
			executionFilledAt: payload.executionFilledAt ?? null,
			fillStatus: payload.fillStatus ?? null,
			fillPrice: payload.fillPrice ?? null,
			fillSize: payload.fillSize ?? null,
			fillNotional: payload.fillNotional ?? null,
			fillSlippageBps: payload.fillSlippageBps ?? null,
			orderId: payload.orderId ?? null,
			exchangeTradeId: payload.exchangeTradeId ?? null,
			executionNotes: payload.executionNotes ?? null,
		});
		if (!pick) {
			return jsonResponse({ error: "pick_not_found" }, { status: 404 });
		}
		return jsonResponse({ pick });
	}

	if (url.pathname === "/api/bot/picks/outcome") {
		if (request.method !== "POST") {
			return jsonResponse({ error: "method_not_allowed" }, { status: 405 });
		}
		const payload = await parseJson<{
			id?: string;
			clientPickId?: string;
			status?: ManualPickStatus;
			resolvedOutcome?: string;
			closePrice?: number;
			roi?: number;
			clv?: number;
		}>(request);
		if ((!payload?.id && !payload?.clientPickId) || !payload.status) {
			return jsonResponse({ error: "invalid_payload" }, { status: 400 });
		}
		const pick = await settleManualPick(env.POLYWHALER_DB, {
			id: payload.id,
			clientPickId: payload.clientPickId,
			status: payload.status,
			resolvedOutcome: payload.resolvedOutcome ?? null,
			closePrice: payload.closePrice ?? null,
			roi: payload.roi ?? null,
			clv: payload.clv ?? null,
		});
		if (!pick) {
			return jsonResponse({ error: "pick_not_found" }, { status: 404 });
		}
		return jsonResponse({ pick });
	}

	return jsonResponse({ error: "not_found" }, { status: 404 });
}
