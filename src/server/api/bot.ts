import type { Env } from "../env";
import { nowUnixSeconds } from "../env";
import {
	getSharpMoneyCacheFreshnessStats,
	getSharpMoneyCacheByConditionId,
	listSharpMoneyCache,
} from "../repositories/sharp-money";
import {
	createManualPick,
	settleManualPick,
	updateManualPickExecution,
	type ManualPickStatus,
} from "../repositories/manual-picks";
import { computeBotEval } from "./bot-eval";
import {
	computeSharpMoneyGrades,
	computePriceEdgeFromEntry,
	type GradeLabel,
	type SharpGradePayload,
} from "./sharp-money";

const DEFAULT_CACHE_LIMIT = 200;
const DEFAULT_CACHE_WINDOW_HOURS = 24;
const DEFAULT_CANDIDATE_WINDOW_MINUTES = 5;
const MAX_CANDIDATE_LIMIT = 500;
const DEFAULT_MARKET_QUALITY_THRESHOLD = 0.72;
const GRADE_RANK: Record<GradeLabel, number> = {
	"A+": 5,
	"A": 4,
	"B": 3,
	"C": 2,
	"D": 1,
};

function clampUnit(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function normalizeMarketPrice(price?: number | null): number | null {
	if (typeof price !== "number" || !Number.isFinite(price)) return null;
	if (price <= 0 || price >= 1) return null;
	return price;
}

function computeMarketQualityScoreFromCacheEntry(input: {
	sharpSide?: string;
	sideA?: { price?: number | null };
	sideB?: { price?: number | null };
	marketVolume?: number;
	marketLiquidity?: number;
}): number | null {
	if (!input.sharpSide || (input.sharpSide !== "A" && input.sharpSide !== "B")) {
		return null;
	}
	const sideAPrice = normalizeMarketPrice(input.sideA?.price);
	const sideBPrice = normalizeMarketPrice(input.sideB?.price);
	const hasBothPrices = sideAPrice !== null && sideBPrice !== null;
	const complementGap = hasBothPrices
		? Math.abs(sideAPrice + sideBPrice - 1)
		: 0.08;
	const complementScore = hasBothPrices ? clampUnit(1 - complementGap / 0.08) : 0.45;
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
			response: jsonResponse(
				{ error: "bot_api_key_missing" },
				{ status: 401 },
			),
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

function getMarketTypeLabel(
	marketTitle: string,
): "total" | "spread" | "moneyline" | "other" {
	const lower = marketTitle.toLowerCase();
	if (
		lower.includes("o/u") ||
		lower.includes("over/under") ||
		lower.includes("total")
	) {
		return "total";
	}
	if (lower.includes("spread")) return "spread";
	if (!marketTitle.includes(":") && marketTitle.includes(" vs "))
		return "moneyline";
	if (lower.includes("moneyline") || lower.includes("ml")) return "moneyline";
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
			const values = value.filter((entry): entry is string => typeof entry === "string");
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
}): Record<string, unknown> {
	const marketTitle = input.marketTitle || input.cacheEntry?.marketTitle || "";
	const eventTime = input.eventTime ?? input.cacheEntry?.eventTime;
	const eventTimeMs = eventTime ? new Date(eventTime).getTime() : Number.NaN;
	const minutesToStartAtPick =
		Number.isFinite(eventTimeMs)
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
		candidateComputedAt: input.candidateComputedAt ?? null,
		l2Imbalance: input.l2Imbalance ?? null,
		l2ImbalanceNearMid: input.l2ImbalanceNearMid ?? null,
		l2Spread: input.l2Spread ?? null,
		l2Disagreement: input.l2Disagreement ?? null,
	};
	if (!isPlainObject(input.payloadSnapshot)) {
		return defaultSnapshot;
	}
	return {
		...defaultSnapshot,
		...input.payloadSnapshot,
	};
}

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
			const limitParam = Number(url.searchParams.get("limit"));
			const requireReady = url.searchParams.get("requireReady");
			const includeStarted = url.searchParams.get("includeStarted");
			const requireMicrostructure = url.searchParams.get("requireMicrostructure");
			const marketQualityThresholdParam = Number(
				url.searchParams.get("marketQualityThreshold"),
			);
			const windowMinutes =
				Number.isFinite(windowMinutesParam) && windowMinutesParam > 0
					? windowMinutesParam
					: DEFAULT_CANDIDATE_WINDOW_MINUTES;
		const limit =
			Number.isFinite(limitParam) && limitParam > 0
				? Math.min(limitParam, MAX_CANDIDATE_LIMIT)
				: DEFAULT_CACHE_LIMIT;
		const shouldRequireReady =
			requireReady === null || requireReady.toLowerCase() === "true";
			const shouldRequireMicrostructure =
				requireMicrostructure === null ||
				requireMicrostructure.toLowerCase() === "true";
			const marketQualityThreshold =
				Number.isFinite(marketQualityThresholdParam) &&
				marketQualityThresholdParam >= 0 &&
				marketQualityThresholdParam <= 1
					? marketQualityThresholdParam
					: DEFAULT_MARKET_QUALITY_THRESHOLD;
			const allowStarted = includeStarted?.toLowerCase() === "true";
		const windowHours = Math.max(1, Math.ceil(windowMinutes / 60));
		const now = Date.now();
		const cutoffMs = windowMinutes * 60 * 1000;

		const entries = await listSharpMoneyCache(env.POLYWHALER_DB, {
			limit,
			windowHours,
		});
		const upcomingEntries = entries.filter((entry) => {
			const marketType = getMarketTypeLabel(entry.marketTitle);
			if (marketType === "other") return false;
			if (shouldRequireReady && !entry.isReady) return false;
			const eventTime = parseEventTime(entry.eventTime);
			if (!eventTime) return false;
			const diffMs = eventTime.getTime() - now;
			if (!allowStarted && diffMs < 0) return false;
			if (allowStarted && diffMs < -cutoffMs) return false;
			return diffMs <= cutoffMs;
		});
		if (upcomingEntries.length === 0) {
			return jsonResponse({
				candidates: [],
				requested: 0,
				returned: 0,
				truncated: false,
				computedAt: nowUnixSeconds(),
			});
		}
		const gradesResult = await computeSharpMoneyGrades(env.POLYWHALER_DB, {
			conditionIds: upcomingEntries.map((entry) => entry.conditionId),
		});
		if (gradesResult.error) {
			return jsonResponse({ error: gradesResult.error }, { status: 400 });
		}
		const gradeByConditionId = new Map(
			gradesResult.results.map((result) => [result.conditionId, result]),
		);
		const candidates = upcomingEntries
			.map((entry) => {
				const grade = gradeByConditionId.get(entry.conditionId) ?? null;
				if (!grade?.grade) return null;
				if (GRADE_RANK[grade.grade] < GRADE_RANK[minGrade]) return null;
					if ((grade.warnings ?? []).includes("no_price_edge")) return null;
					if (
						shouldRequireMicrostructure &&
						(grade.microstructureScore ?? 0) < marketQualityThreshold
					) {
						return null;
					}
				return {
					entry: toSlimCandidate(entry),
					grade: {
						grade: grade.grade,
						signalScore: grade.signalScore,
						edgeRating: grade.edgeRating,
						scoreDifferential: grade.scoreDifferential,
						microstructureScore: grade.microstructureScore,
						isReady: grade.isReady,
						warnings: grade.warnings,
						computedAt: grade.computedAt,
						historyUpdatedAt: grade.historyUpdatedAt,
					},
				};
			})
			.filter((candidate) => candidate !== null);
		const deduped = new Map<string, (typeof candidates)[number]>();
		for (const candidate of candidates) {
			if (!candidate) continue;
			const key = getMarketGroupKey(candidate.entry);
			const existing = deduped.get(key);
			if (!existing) {
				deduped.set(key, candidate);
				continue;
			}
			const candidateGrade = candidate.grade.grade;
			const existingGrade = existing.grade.grade;
			const candidateRank = GRADE_RANK[candidateGrade];
			const existingRank = GRADE_RANK[existingGrade];
			if (candidateRank > existingRank) {
				deduped.set(key, candidate);
				continue;
			}
			if (candidateRank < existingRank) {
				continue;
			}
			const candidateScore = candidate.grade.signalScore ?? 0;
			const existingScore = existing.grade.signalScore ?? 0;
			if (candidateScore > existingScore) {
				deduped.set(key, candidate);
				continue;
			}
			if (candidateScore < existingScore) {
				continue;
			}
			const candidateEdge = candidate.grade.edgeRating ?? 0;
			const existingEdge = existing.grade.edgeRating ?? 0;
			if (candidateEdge > existingEdge) {
				deduped.set(key, candidate);
				continue;
			}
			if (candidateEdge < existingEdge) {
				continue;
			}
			const candidateMicrostructure = candidate.grade.microstructureScore ?? 0;
			const existingMicrostructure = existing.grade.microstructureScore ?? 0;
			if (candidateMicrostructure > existingMicrostructure) {
				deduped.set(key, candidate);
				continue;
			}
			if (candidateMicrostructure < existingMicrostructure) {
				continue;
			}
			const candidateDiff = candidate.grade.scoreDifferential ?? 0;
			const existingDiff = existing.grade.scoreDifferential ?? 0;
			if (candidateDiff > existingDiff) {
				deduped.set(key, candidate);
				continue;
			}
			const candidateTime =
				parseEventTime(candidate.entry.eventTime)?.getTime() ?? 0;
			const existingTime =
				parseEventTime(existing.entry.eventTime)?.getTime() ?? 0;
			if (candidateTime > 0 && existingTime > 0 && candidateTime < existingTime) {
				deduped.set(key, candidate);
			}
		}
		const dedupedCandidates = [...deduped.values()];
		return jsonResponse({
			candidates: dedupedCandidates,
			requested: gradesResult.requested,
			returned: dedupedCandidates.length,
			truncated: gradesResult.truncated,
			computedAt: gradesResult.computedAt,
		});
	}

	if (url.pathname === "/api/bot/eval") {
		if (request.method !== "POST") {
			return jsonResponse({ error: "method_not_allowed" }, { status: 405 });
		}
		const payload = await parseJson<{
			windowHours?: number;
			horizonMinutes?: number;
			historyWindowMinutes?: number;
			minGrade?: string;
			includeStarted?: boolean;
			limit?: number;
			sweepThresholds?: number[];
		}>(request);
		const minGrade = parseMinGrade(payload?.minGrade ?? null);
		if (!minGrade) {
			return jsonResponse({ error: "invalid_minGrade" }, { status: 400 });
		}
		const result = await computeBotEval(env.POLYWHALER_DB, {
			...(payload ?? {}),
			minGrade,
		});
		return jsonResponse(result);
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
				? cacheEntry?.sideA.price ?? undefined
				: sharpSide === "B"
					? cacheEntry?.sideB.price ?? undefined
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
			extractSnapshotNumber(snapshot, ["marketQualityScore", "microstructureScore"]) ??
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
			extractSnapshotNumber(snapshot, ["l2ImbalanceNearMid", "imbalanceNearMid"]) ??
			undefined;
		const l2Spread =
			payload.l2Spread ??
			extractSnapshotNumber(snapshot, ["l2Spread", "spread"]) ??
			undefined;
		const l2Disagreement =
			payload.l2Disagreement ??
			extractSnapshotBoolean(snapshot, ["l2Disagreement", "imbalanceDisagree"]) ??
			undefined;
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
				l2Imbalance,
				l2ImbalanceNearMid,
				l2Spread,
				l2Disagreement,
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
				strategyVersion: payload.strategyVersion,
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
