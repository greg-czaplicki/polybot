import { createServerFn } from "@tanstack/react-start";
import { detectBetType } from "@/lib/markets";
import { detectSportTag } from "@/lib/sports";
import type { Db } from "../db/client";
import { first, run } from "../db/client";
import { getDb, nowUnixSeconds } from "../env";
import {
	parseTeamsFromTitle,
	resolveSingleTeam,
} from "../pipeline/team-seeder";
import {
	type CreateManualPickInput,
	clearManualPicks,
	createManualPick,
	getManualPicksBucketPerformanceSummary,
	getManualPicksCalibrationSummary,
	getManualPicksClvTimingSummary,
	getManualPicksGradeRecalibrationSummary,
	getManualPicksMarketTypePerformanceSummary,
	getManualPicksShadowWindowSummary,
	getManualPicksSportPerformanceSummary,
	getManualPicksSummary,
	listManualPicks,
	type ManualPickStatus,
	settleManualPick,
	updateManualPickOutcome,
} from "../repositories/manual-picks";
import { getTeamTrendSnapshotAsOf } from "../repositories/team-trend-snapshots";
import type { FavDogRole, VenueRole } from "../types/canonical";

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
	return trimmed
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function parseGammaPrices(
	value: string[] | string | null | undefined,
): number[] {
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

	if (
		!input.sharpSide ||
		(input.sharpSide !== "A" && input.sharpSide !== "B")
	) {
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
		input.sharpSide === "A"
			? (outcomePrices[0] ?? null)
			: (outcomePrices[1] ?? null);
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

// ---------------------------------------------------------------------------
// Inline pick enrichment — runs automatically on pick creation
// ---------------------------------------------------------------------------

/**
 * Parsed decision snapshot fields relevant to enrichment.
 */
interface EnrichmentSnapshotFields {
	eventSlug?: string;
	marketTitle?: string;
	eventTime?: string;
	sharpSideLabel?: string;
	selectedOutcome?: string;
}

function parseEnrichmentSnapshot(
	raw: unknown,
): EnrichmentSnapshotFields | null {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	return {
		eventSlug: typeof obj.eventSlug === "string" ? obj.eventSlug : undefined,
		marketTitle:
			typeof obj.marketTitle === "string" ? obj.marketTitle : undefined,
		eventTime: typeof obj.eventTime === "string" ? obj.eventTime : undefined,
		sharpSideLabel:
			typeof obj.sharpSideLabel === "string" ? obj.sharpSideLabel : undefined,
		selectedOutcome:
			typeof obj.selectedOutcome === "string"
				? obj.selectedOutcome
				: undefined,
	};
}

/**
 * Finds a canonical game matching teams + event time within a 6-hour window.
 */
async function findGameForEnrichment(
	db: Db,
	homeTeamId: string,
	awayTeamId: string,
	eventTimeUnix: number,
	sportTag: string,
): Promise<string | null> {
	const windowSeconds = 6 * 60 * 60;
	const row = await first<{ id: string }>(
		db,
		`SELECT id FROM games
		 WHERE sport_tag = ?
		   AND home_team_id = ?
		   AND away_team_id = ?
		   AND game_time BETWEEN ? AND ?
		 LIMIT 1`,
		sportTag,
		homeTeamId,
		awayTeamId,
		eventTimeUnix - windowSeconds,
		eventTimeUnix + windowSeconds,
	);
	return row?.id ?? null;
}

/**
 * Gets spread and total from game_lines (prefers close, falls back to open).
 */
async function getLineValuesForEnrichment(
	db: Db,
	gameId: string,
): Promise<{
	homeSpread: number | null;
	totalLine: number | null;
}> {
	const row = await first<{
		home_spread: number | null;
		total_line: number | null;
	}>(
		db,
		`SELECT home_spread, total_line FROM game_lines
		 WHERE game_id = ?
		 ORDER BY CASE snapshot_type WHEN 'close' THEN 0 ELSE 1 END
		 LIMIT 1`,
		gameId,
	);
	return {
		homeSpread: row?.home_spread ?? null,
		totalLine: row?.total_line ?? null,
	};
}

/**
 * Gets fact-derived values for a team in a game.
 */
async function getFactValuesForEnrichment(
	db: Db,
	gameId: string,
	teamId: string,
): Promise<{
	actualMargin: number | null;
	actualTotal: number | null;
	venueRole: VenueRole | null;
	favDogRole: FavDogRole | null;
}> {
	const row = await first<{
		actual_margin: number | null;
		actual_total: number | null;
		venue_role: string | null;
		fav_dog_role: string | null;
	}>(
		db,
		`SELECT actual_margin, actual_total, venue_role, fav_dog_role
		 FROM team_game_facts
		 WHERE game_id = ? AND team_id = ?
		 LIMIT 1`,
		gameId,
		teamId,
	);
	return {
		actualMargin: row?.actual_margin ?? null,
		actualTotal: row?.actual_total ?? null,
		venueRole: (row?.venue_role as VenueRole) ?? null,
		favDogRole: (row?.fav_dog_role as FavDogRole) ?? null,
	};
}

/**
 * Gets side_a_label and side_b_label from sharp_money_cache.
 */
async function getSideLabelsForEnrichment(
	db: Db,
	conditionId: string,
): Promise<{ sideALabel: string | null; sideBLabel: string | null }> {
	const row = await first<{
		side_a_label: string | null;
		side_b_label: string | null;
	}>(
		db,
		`SELECT side_a_label, side_b_label FROM sharp_money_cache WHERE condition_id = ? LIMIT 1`,
		conditionId,
	);
	return {
		sideALabel: row?.side_a_label ?? null,
		sideBLabel: row?.side_b_label ?? null,
	};
}

/**
 * Derives fav_dog_role from home spread and team position.
 */
function deriveFavDogRole(
	homeSpread: number | null,
	isHomeTeam: boolean,
): FavDogRole | null {
	if (homeSpread === null) return null;
	if (homeSpread === 0) return "pickem";
	const homeFav = homeSpread < 0;
	if (isHomeTeam) return homeFav ? "favorite" : "dog";
	return homeFav ? "dog" : "favorite";
}

/**
 * Resolves which team was picked based on the sharp_side label.
 * Returns null when confidence is insufficient rather than guessing.
 */
function resolvePickedSideForEnrichment(opts: {
	pickedLabel: string | null;
	sideALabel: string | null;
	sideBLabel: string | null;
	homeTeamName: string;
	awayTeamName: string;
	homeTeamId: string;
	awayTeamId: string;
}): {
	teamId: string;
	opponentId: string;
	venueRole: VenueRole;
	isHomeTeam: boolean;
} | null {
	const { pickedLabel, sideALabel, sideBLabel } = opts;
	if (!pickedLabel) return null;

	const normalizedPick = pickedLabel.trim().toLowerCase();
	if (!normalizedPick) return null;

	// Strategy 1: Match via side labels (side_a = away, side_b = home)
	if (sideALabel && sideBLabel) {
		const normA = sideALabel.trim().toLowerCase();
		const normB = sideBLabel.trim().toLowerCase();

		if (normalizedPick === normA) {
			return {
				teamId: opts.awayTeamId,
				opponentId: opts.homeTeamId,
				venueRole: "away",
				isHomeTeam: false,
			};
		}
		if (normalizedPick === normB) {
			return {
				teamId: opts.homeTeamId,
				opponentId: opts.awayTeamId,
				venueRole: "home",
				isHomeTeam: true,
			};
		}
	}

	// Strategy 2: Substring match against team names
	const normHome = opts.homeTeamName.trim().toLowerCase();
	const normAway = opts.awayTeamName.trim().toLowerCase();

	const matchesHome =
		normHome.includes(normalizedPick) || normalizedPick.includes(normHome);
	const matchesAway =
		normAway.includes(normalizedPick) || normalizedPick.includes(normAway);

	if (matchesHome && !matchesAway) {
		return {
			teamId: opts.homeTeamId,
			opponentId: opts.awayTeamId,
			venueRole: "home",
			isHomeTeam: true,
		};
	}
	if (matchesAway && !matchesHome) {
		return {
			teamId: opts.awayTeamId,
			opponentId: opts.homeTeamId,
			venueRole: "away",
			isHomeTeam: false,
		};
	}

	return null;
}

/**
 * Enrichment result for the pick response — tells the caller what was enriched.
 */
export interface PickEnrichmentResult {
	fieldsSet: string[];
	trendSnapshotAttached: boolean;
}

/**
 * Attempts to enrich a newly created pick with canonical context.
 * Best-effort: never throws, never blocks pick creation.
 *
 * Enriches: bet_type, sport_tag, team_id, opponent_id, game_id,
 * venue_role, fav_dog_role, spread_line, total_line, actual_margin, actual_total.
 * Also attaches a point-in-time trend snapshot reference when possible.
 */
async function enrichPickInline(
	db: Db,
	pickId: string,
	input: CreateManualPickInput,
): Promise<PickEnrichmentResult> {
	const result: PickEnrichmentResult = {
		fieldsSet: [],
		trendSnapshotAttached: false,
	};

	const title = input.marketTitle;
	const snapshot = parseEnrichmentSnapshot(input.decisionSnapshot);

	// 1. Detect bet_type
	const betType = detectBetType({ title }) ?? null;

	// 2. Detect sport_tag
	const sportTag = detectSportTag({ title }) ?? null;

	// 3. Parse team names and resolve IDs
	let teamId: string | null = null;
	let opponentId: string | null = null;
	let venueRole: VenueRole | null = null;
	let isHomeTeam = false;

	if (sportTag) {
		const parsed = parseTeamsFromTitle(title);
		if (parsed) {
			const [homeTeam, awayTeam] = await Promise.all([
				resolveSingleTeam(db, sportTag, parsed.home),
				resolveSingleTeam(db, sportTag, parsed.away),
			]);

			if (homeTeam && awayTeam) {
				const pickedLabel =
					input.sharpSide ??
					snapshot?.sharpSideLabel ??
					snapshot?.selectedOutcome ??
					null;

				const sideLabels = await getSideLabelsForEnrichment(
					db,
					input.conditionId,
				);

				const resolved = resolvePickedSideForEnrichment({
					pickedLabel,
					sideALabel: sideLabels.sideALabel,
					sideBLabel: sideLabels.sideBLabel,
					homeTeamName: homeTeam.name,
					awayTeamName: awayTeam.name,
					homeTeamId: homeTeam.id,
					awayTeamId: awayTeam.id,
				});

				if (resolved) {
					teamId = resolved.teamId;
					opponentId = resolved.opponentId;
					venueRole = resolved.venueRole;
					isHomeTeam = resolved.isHomeTeam;
				}
			}
		}
	}

	// 4. Match game_id
	let gameId: string | null = null;
	let eventTimeUnix: number | null = null;

	const eventTimeSource = input.eventTime ?? snapshot?.eventTime;
	if (eventTimeSource) {
		const parsed = new Date(eventTimeSource).getTime();
		if (Number.isFinite(parsed)) {
			eventTimeUnix = Math.floor(parsed / 1000);
		}
	}

	if (teamId && opponentId && eventTimeUnix && sportTag) {
		const homeId = isHomeTeam ? teamId : opponentId;
		const awayId = isHomeTeam ? opponentId : teamId;
		gameId = await findGameForEnrichment(
			db,
			homeId,
			awayId,
			eventTimeUnix,
			sportTag,
		);
	}

	// 5. Get line values
	let spreadLine: number | null = null;
	let totalLine: number | null = null;
	let homeSpread: number | null = null;

	if (gameId) {
		const lines = await getLineValuesForEnrichment(db, gameId);
		homeSpread = lines.homeSpread;
		spreadLine = homeSpread;
		totalLine = lines.totalLine;
	}

	// 6. Get fact values
	let favDogRole: FavDogRole | null = null;
	let actualMargin: number | null = null;
	let actualTotal: number | null = null;

	if (gameId && teamId) {
		const facts = await getFactValuesForEnrichment(db, gameId, teamId);
		if (facts.favDogRole) favDogRole = facts.favDogRole;
		if (facts.venueRole) {
			venueRole = facts.venueRole;
			isHomeTeam = venueRole === "home";
		}
		actualMargin = facts.actualMargin;
		actualTotal = facts.actualTotal;
	}
	if (!favDogRole && homeSpread !== null) {
		favDogRole = deriveFavDogRole(homeSpread, isHomeTeam);
	}

	// 7. Build UPDATE
	const updates: string[] = [];
	const params: unknown[] = [];

	function addField(column: string, value: unknown, label: string) {
		if (value !== null && value !== undefined) {
			updates.push(`${column} = ?`);
			params.push(value);
			result.fieldsSet.push(label);
		}
	}

	addField("bet_type", betType, "bet_type");
	addField("sport_tag", sportTag, "sport_tag");
	addField("team_id", teamId, "team_id");
	addField("opponent_id", opponentId, "opponent_id");
	addField("game_id", gameId, "game_id");
	addField("venue_role", venueRole, "venue_role");
	addField("fav_dog_role", favDogRole, "fav_dog_role");
	addField("spread_line", spreadLine, "spread_line");
	addField("total_line", totalLine, "total_line");
	addField("actual_margin", actualMargin, "actual_margin");
	addField("actual_total", actualTotal, "actual_total");

	if (updates.length === 0) {
		return result;
	}

	params.push(pickId);
	await run(
		db,
		`UPDATE manual_picks SET ${updates.join(", ")} WHERE id = ?`,
		...params,
	);

	// 8. Attach point-in-time trend snapshot reference
	// If we have a team and a time reference, look up the trend snapshot that was
	// current when the pick was made. Store the snapshot type + as_of_game_id so
	// the pick can reference what the team's trend looked like at decision time.
	if (teamId && sportTag) {
		const asOfTime = eventTimeUnix ?? nowUnixSeconds();
		const trendSnapshot = await getTeamTrendSnapshotAsOf(
			db,
			teamId,
			"overall",
			asOfTime,
		);
		if (trendSnapshot) {
			result.trendSnapshotAttached = true;
		}
	}

	return result;
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

	// Attempt inline enrichment — best-effort, never blocks pick creation
	let enrichment: PickEnrichmentResult | null = null;
	try {
		enrichment = await enrichPickInline(db, pick.id, payload);
	} catch {
		// Enrichment failure must not prevent pick creation
	}

	// If enrichment set fields, re-read the pick to return updated data
	if (enrichment && enrichment.fieldsSet.length > 0) {
		const updated = await listManualPicks(db, { limit: 50 });
		const freshPick = updated.find((p) => p.id === pick.id);
		return { pick: freshPick ?? pick, enrichment };
	}

	return { pick, enrichment };
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
	const payload = (data ?? {}) as {
		limit?: number;
		sincePickedAt?: number;
	};
	const db = getDb(context);
	const calibration = await getManualPicksCalibrationSummary(db, {
		limit: payload.limit,
		sincePickedAt: payload.sincePickedAt,
	});
	return { calibration };
});

export const getManualPicksBucketPerformanceFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as {
		limit?: number;
		sincePickedAt?: number;
	};
	const db = getDb(context);
	const performance = await getManualPicksBucketPerformanceSummary(db, {
		limit: payload.limit,
		sincePickedAt: payload.sincePickedAt,
	});
	return { performance };
});

export const getManualPicksClvTimingFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as {
		limit?: number;
		qualityThreshold?: number;
		sincePickedAt?: number;
	};
	const db = getDb(context);
	const timing = await getManualPicksClvTimingSummary(db, {
		limit: payload.limit,
		qualityThreshold: payload.qualityThreshold,
		sincePickedAt: payload.sincePickedAt,
	});
	return { timing };
});

export const getManualPicksShadowWindowsFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as {
		limit?: number;
		qualityThreshold?: number;
		sincePickedAt?: number;
	};
	const db = getDb(context);
	try {
		const shadow = await getManualPicksShadowWindowSummary(db, {
			limit: payload.limit,
			qualityThreshold: payload.qualityThreshold,
			sincePickedAt: payload.sincePickedAt,
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
	const payload = (data ?? {}) as {
		limit?: number;
		qualityThreshold?: number;
		sincePickedAt?: number;
	};
	const db = getDb(context);
	try {
		const sportPerformance = await getManualPicksSportPerformanceSummary(db, {
			limit: payload.limit,
			qualityThreshold: payload.qualityThreshold,
			sincePickedAt: payload.sincePickedAt,
		});
		return { sportPerformance };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`sport_performance_failed: ${message}`);
	}
});

export const getManualPicksMarketTypePerformanceFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as {
		limit?: number;
		qualityThreshold?: number;
		sincePickedAt?: number;
	};
	const db = getDb(context);
	try {
		const marketTypePerformance =
			await getManualPicksMarketTypePerformanceSummary(db, {
				limit: payload.limit,
				qualityThreshold: payload.qualityThreshold,
				sincePickedAt: payload.sincePickedAt,
			});
		return { marketTypePerformance };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`market_type_performance_failed: ${message}`);
	}
});

export const getManualPicksGradeRecalibrationFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = (data ?? {}) as {
		limit?: number;
		sincePickedAt?: number;
	};
	const db = getDb(context);
	try {
		const gradeRecalibration = await getManualPicksGradeRecalibrationSummary(
			db,
			{
				limit: payload.limit,
				sincePickedAt: payload.sincePickedAt,
			},
		);
		return { gradeRecalibration };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`grade_recalibration_failed: ${message}`);
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
