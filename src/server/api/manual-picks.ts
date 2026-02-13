import { createServerFn } from "@tanstack/react-start";
import type { Db } from "../db/client";
import { getDb } from "../env";
import {
	createManualPick,
	clearManualPicks,
	getManualPicksBucketPerformanceSummary,
	getManualPicksCalibrationSummary,
	getManualPicksClvTimingSummary,
	getManualPicksShadowWindowSummary,
	getManualPicksSportPerformanceSummary,
	getManualPicksSummary,
	listManualPicks,
	settleManualPick,
	updateManualPickOutcome,
	type CreateManualPickInput,
	type ManualPickStatus,
} from "../repositories/manual-picks";

const POLYMARKET_GAMMA_API = "https://gamma-api.polymarket.com";

type GammaResolutionMarket = {
	conditionId?: string;
	resolved?: boolean;
	resolution?: string | number | null;
	umaResolutionStatus?: string | null;
	outcomes?: string[] | string | null;
	outcomePrices?: string[] | string | null;
	closed?: boolean;
};

function parseGammaList(value: string[] | string | null | undefined): string[] {
	if (!value) return [];
	if (Array.isArray(value)) return value;
	const trimmed = value.trim();
	if (!trimmed) return [];
	if (trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed);
			return Array.isArray(parsed) ? parsed.map(String) : [];
		} catch {
			return [];
		}
	}
	return trimmed.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseGammaPrices(value: string[] | string | null | undefined): number[] {
	return parseGammaList(value)
		.map((entry) => Number(entry))
		.filter((entry) => Number.isFinite(entry));
}

async function fetchGammaMarket(
	conditionId: string,
): Promise<GammaResolutionMarket | null> {
	try {
		const url = new URL("/markets", POLYMARKET_GAMMA_API);
		url.searchParams.set("condition_ids", conditionId);
		url.searchParams.set("limit", "1");
		const response = await fetch(url);
		if (!response.ok) return null;
		const data = (await response.json()) as GammaResolutionMarket[];
		if (!Array.isArray(data) || data.length === 0) return null;
		const target = conditionId.toLowerCase();
		const exact = data.find(
			(market) => (market.conditionId ?? "").toLowerCase() === target,
		);
		return exact ?? null;
	} catch {
		return null;
	}
}

export async function settlePendingManualPicks(
	db: Db,
	options?: { limit?: number },
): Promise<{ checked: number; updated: number }> {
	const limit =
		typeof options?.limit === "number" && options.limit > 0
			? Math.min(options.limit, 100)
			: 25;
	const picks = await listManualPicks(db, { status: "pending", limit });
	if (picks.length === 0) {
		return { checked: 0, updated: 0 };
	}

	let updated = 0;
	const now = Date.now();
	for (const pick of picks) {
		if (pick.eventTime) {
			const eventTime = new Date(pick.eventTime).getTime();
			if (Number.isFinite(eventTime) && eventTime > now - 15 * 60 * 1000) {
				continue;
			}
		}
		const market = await fetchGammaMarket(pick.conditionId);
		if (!market) continue;
		const resolution = resolvePickResult({
			sharpSide: pick.sharpSide,
			entryPrice: pick.price,
			market,
		});
		if (!resolution) continue;
		await settleManualPick(db, {
			id: pick.id,
			status: resolution.status,
			resolvedOutcome: resolution.resolvedOutcome ?? null,
			closePrice: resolution.closePrice ?? null,
			roi: resolution.roi ?? null,
			clv: resolution.clv ?? null,
		});
		updated += 1;
	}

	return { checked: picks.length, updated };
}

function normalizeOutcome(value: string): string {
	return value.trim().toLowerCase();
}

function resolvePickResult(input: {
	sharpSide?: string;
	entryPrice?: number;
	market: GammaResolutionMarket;
}): {
	status: ManualPickStatus;
	resolvedOutcome?: string | null;
	closePrice?: number | null;
	roi?: number | null;
	clv?: number | null;
} | null {
	const resolved =
		input.market.resolved === true ||
		(typeof input.market.closed === "boolean" && input.market.closed);
	const resolution = input.market.resolution;
	const umaResolutionStatus = input.market.umaResolutionStatus;
	const outcomes = parseGammaList(input.market.outcomes);
	const outcomePrices = parseGammaPrices(input.market.outcomePrices);

	if (!resolved && resolution === null) {
		return null;
	}

	if (!input.sharpSide || (input.sharpSide !== "A" && input.sharpSide !== "B")) {
		return null;
	}

	let resolvedSide: "A" | "B" | null = null;
	let resolvedOutcome: string | null = null;
	let status: ManualPickStatus = "pending";

	if (typeof resolution === "number") {
		if (resolution === 0 || resolution === 1) {
			resolvedSide = resolution === 0 ? "A" : "B";
			resolvedOutcome = outcomes[resolution] ?? null;
		}
	} else if (typeof resolution === "string") {
		const normalized = normalizeOutcome(resolution);
		if (normalized.includes("cancel") || normalized.includes("invalid")) {
			status = "push";
		} else {
			const index = outcomes.findIndex(
				(outcome) => normalizeOutcome(outcome) === normalized,
			);
			if (index === 0 || index === 1) {
				resolvedSide = index === 0 ? "A" : "B";
				resolvedOutcome = outcomes[index] ?? null;
			}
		}
	}

	// Fallback: some sports markets may have null resolution while outcome prices
	// already reflect the winner (1/0 or near-1/near-0).
	if (!resolvedSide && outcomePrices.length >= 2) {
		const priceA = outcomePrices[0] ?? 0;
		const priceB = outcomePrices[1] ?? 0;
		const winThreshold = 0.98;
		const loseThreshold = 0.02;
		if (priceA >= winThreshold && priceB <= loseThreshold) {
			resolvedSide = "A";
			resolvedOutcome = outcomes[0] ?? "A";
		} else if (priceB >= winThreshold && priceA <= loseThreshold) {
			resolvedSide = "B";
			resolvedOutcome = outcomes[1] ?? "B";
		}
	}

	if (
		status === "pending" &&
		typeof umaResolutionStatus === "string" &&
		(normalizeOutcome(umaResolutionStatus).includes("cancel") ||
			normalizeOutcome(umaResolutionStatus).includes("invalid"))
	) {
		status = "push";
	}

	if (status === "push") {
		return {
			status,
			resolvedOutcome,
			closePrice: null,
			roi: 0,
			clv: null,
		};
	}

	if (!resolvedSide) {
		return null;
	}

	status = resolvedSide === input.sharpSide ? "win" : "loss";
	const entryPrice =
		typeof input.entryPrice === "number" && input.entryPrice > 0
			? input.entryPrice
			: null;
	const closePrice =
		input.sharpSide === "A" ? outcomePrices[0] ?? null : outcomePrices[1] ?? null;
	const roi =
		entryPrice && status === "win"
			? 1 / entryPrice - 1
			: entryPrice && status === "loss"
				? -1
				: entryPrice
					? 0
					: null;
	const clv =
		entryPrice && closePrice !== null && Number.isFinite(closePrice)
			? closePrice - entryPrice
			: null;

	return {
		status,
		resolvedOutcome,
		closePrice: Number.isFinite(closePrice ?? 0) ? closePrice : null,
		roi,
		clv,
	};
}

export const createManualPickFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as CreateManualPickInput;
	if (!payload.conditionId || !payload.marketTitle) {
		return { error: "invalid_payload", pick: null };
	}
	const db = getDb(context);
	const pick = await createManualPick(db, payload);
	return { pick };
});

export const listManualPicksFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as {
		status?: ManualPickStatus;
		limit?: number;
	};
	const db = getDb(context);
	const picks = await listManualPicks(db, {
		status: payload.status,
		limit: payload.limit,
	});
	return { picks };
});

export const getManualPicksSummaryFn = createServerFn({
	method: "POST",
}).handler(async ({ context }) => {
	const db = getDb(context);
	const summary = await getManualPicksSummary(db);
	return { summary };
});

export const getManualPicksCalibrationFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as { limit?: number };
	const db = getDb(context);
	const calibration = await getManualPicksCalibrationSummary(db, {
		limit: payload.limit,
	});
	return { calibration };
});

export const getManualPicksBucketPerformanceFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as { limit?: number };
	const db = getDb(context);
	const performance = await getManualPicksBucketPerformanceSummary(db, {
		limit: payload.limit,
	});
	return { performance };
});

export const getManualPicksClvTimingFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as { limit?: number; qualityThreshold?: number };
	const db = getDb(context);
	const timing = await getManualPicksClvTimingSummary(db, {
		limit: payload.limit,
		qualityThreshold: payload.qualityThreshold,
	});
	return { timing };
});

export const getManualPicksShadowWindowsFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as { limit?: number; qualityThreshold?: number };
	const db = getDb(context);
	try {
		const shadow = await getManualPicksShadowWindowSummary(db, {
			limit: payload.limit,
			qualityThreshold: payload.qualityThreshold,
		});
		return { shadow };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`shadow_windows_failed: ${message}`);
	}
});

export const getManualPicksSportPerformanceFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as { limit?: number; qualityThreshold?: number };
	const db = getDb(context);
	try {
		const sportPerformance = await getManualPicksSportPerformanceSummary(db, {
			limit: payload.limit,
			qualityThreshold: payload.qualityThreshold,
		});
		return { sportPerformance };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`sport_performance_failed: ${message}`);
	}
});

export const updateManualPickOutcomeFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as { id: string; status: ManualPickStatus };
	if (!payload.id || !payload.status) {
		return { error: "invalid_payload", pick: null };
	}
	const db = getDb(context);
	const pick = await updateManualPickOutcome(db, payload);
	return { pick };
});

export const clearManualPicksFn = createServerFn({
	method: "POST",
}).handler(async ({ context }) => {
	const db = getDb(context);
	await clearManualPicks(db);
	return { ok: true };
});

export const settleManualPicksFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as { limit?: number };
	const db = getDb(context);
	return settlePendingManualPicks(db, { limit: payload.limit });
});
