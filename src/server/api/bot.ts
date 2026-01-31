import type { Env } from "../env";
import { nowUnixSeconds } from "../env";
import {
	getSharpMoneyCacheFreshnessStats,
	listSharpMoneyCache,
} from "../repositories/sharp-money";
import {
	computeSharpMoneyGrades,
	type GradeLabel,
	type SharpGradePayload,
} from "./sharp-money";

const DEFAULT_CACHE_LIMIT = 200;
const DEFAULT_CACHE_WINDOW_HOURS = 24;
const DEFAULT_CANDIDATE_WINDOW_MINUTES = 5;
const MAX_CANDIDATE_LIMIT = 500;
const GRADE_RANK: Record<GradeLabel, number> = {
	"A+": 5,
	"A": 4,
	"B": 3,
	"C": 2,
	"D": 1,
};

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
	return {
		conditionId: entry.conditionId,
		marketTitle: entry.marketTitle,
		marketSlug: entry.marketSlug,
		eventSlug: entry.eventSlug,
		sportSeriesId: entry.sportSeriesId,
		eventTime: entry.eventTime,
		sharpSide: entry.sharpSide,
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
		const allowStarted = includeStarted?.toLowerCase() === "true";
		const windowHours = Math.max(1, Math.ceil(windowMinutes / 60));
		const now = Date.now();
		const cutoffMs = windowMinutes * 60 * 1000;

		const entries = await listSharpMoneyCache(env.POLYWHALER_DB, {
			limit,
			windowHours,
		});
		const upcomingEntries = entries.filter((entry) => {
			if (shouldRequireReady && !entry.isReady) return false;
			const eventTime = parseEventTime(entry.eventTime);
			if (!eventTime) return false;
			const diffMs = eventTime.getTime() - now;
			if (!allowStarted && diffMs < 0) return false;
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
				return {
					entry: toSlimCandidate(entry),
					grade: {
						grade: grade.grade,
						signalScore: grade.signalScore,
						isReady: grade.isReady,
						warnings: grade.warnings,
						computedAt: grade.computedAt,
						historyUpdatedAt: grade.historyUpdatedAt,
					},
				};
			})
			.filter((candidate) => candidate !== null);
		return jsonResponse({
			candidates,
			requested: gradesResult.requested,
			returned: candidates.length,
			truncated: gradesResult.truncated,
			computedAt: gradesResult.computedAt,
		});
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

	return jsonResponse({ error: "not_found" }, { status: 404 });
}
