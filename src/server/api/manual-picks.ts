import { createServerFn } from "@tanstack/react-start";
import { detectBetType } from "@/lib/markets";
import { detectSportTag, toCanonicalSportTag } from "@/lib/sports";
import { resolveSportTagFromSeriesId } from "./series-registry";
import type { Db } from "../db/client";
import { run } from "../db/client";
import { buildStrategyVersion, getDb, nowUnixSeconds } from "../env";
import {
	deriveFavDogRole,
	extractSpreadPickedLabel,
	findGameForPick,
	getFactValues,
	getLineValues,
	getSideLabels,
	mapPickedTeamToSide,
	resolvePickedSide,
} from "../pipeline/pick-enrichment-helpers";
import {
	type BookAnchor,
	captureBookAnchorForGame,
	parseMarketTotalLine,
} from "../pipeline/book-odds";
import {
	parseTeamsFromTitle,
	resolveSingleTeam,
} from "../pipeline/team-seeder";
import {
	type CreateManualPickInput,
	clearManualPicks,
	createManualPick,
	findPriceAtOrBefore,
	getManualPicksBucketPerformanceSummary,
	getManualPicksCalibrationSummary,
	getManualPicksClvTimingSummary,
	getManualPicksGradeRecalibrationSummary,
	getManualPicksMarketTypePerformanceSummary,
	getManualPicksShadowWindowSummary,
	getManualPicksSportPerformanceSummary,
	getManualPicksSummary,
	listManualPicks,
	type ManualPickEntry,
	type ManualPickStatus,
	settleManualPick,
	updateManualPickOutcome,
} from "../repositories/manual-picks";
import {
	listSharpMoneyHistoryByConditionIds,
	type SharpMoneyHistoryEntryByConditionId,
} from "../repositories/sharp-money";
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

export async function fetchGammaMarket(
	conditionId: string,
): Promise<GammaResolutionMarket | null> {
	// Gamma's default listing drops markets once they close; without the
	// closed=true retry a pick whose market closed before we first checked
	// stays pending forever.
	for (const closedParam of [null, "true"]) {
		try {
			const url = new URL("/markets", POLYMARKET_GAMMA_API);
			url.searchParams.set("condition_ids", conditionId);
			url.searchParams.set("limit", "1");
			if (closedParam) url.searchParams.set("closed", closedParam);
			const response = await fetch(url);
			if (!response.ok) continue;
			const data = (await response.json()) as GammaResolutionMarket[];
			if (!Array.isArray(data) || data.length === 0) continue;
			const target = conditionId.toLowerCase();
			const exact = data.find(
				(market) => (market.conditionId ?? "").toLowerCase() === target,
			);
			if (exact) return exact;
		} catch {
			// fall through to next attempt
		}
	}
	return null;
}

export async function settlePendingManualPicks(
	db: Db,
	options?: { limit?: number },
): Promise<{ checked: number; updated: number }> {
	const limit =
		typeof options?.limit === "number" && options.limit > 0
			? Math.min(options.limit, 100)
			: 25;
	// Over-fetch before the eligibility filter: with LIMIT applied first
	// (newest-first), a page of pending picks on games that haven't started
	// yet starves older, already-eligible picks. Gamma fetch cost is still
	// bounded by `limit` via the slice below.
	const picks = await listManualPicks(db, {
		status: "pending",
		limit: Math.min(limit * 4, 100),
	});
	if (picks.length === 0) {
		return { checked: 0, updated: 0 };
	}

	let updated = 0;
	const now = Date.now();
	const eligible = picks
		.filter((pick) => {
			if (!pick.eventTime) return true;
			const eventTime = new Date(pick.eventTime).getTime();
			return !(Number.isFinite(eventTime) && eventTime > now - 15 * 60 * 1000);
		})
		.slice(0, limit);
	if (eligible.length === 0) {
		return { checked: picks.length, updated: 0 };
	}

	// The closing price must come from pre-event history, never from the
	// resolved market's outcome prices (those are ~0/1 after resolution and
	// would make CLV a proxy for the outcome itself).
	let historyByConditionId: SharpMoneyHistoryEntryByConditionId = {};
	const eventTimesSeconds = eligible
		.map((pick) =>
			pick.eventTime
				? Math.floor(new Date(pick.eventTime).getTime() / 1000)
				: Number.NaN,
		)
		.filter((value) => Number.isFinite(value));
	if (eventTimesSeconds.length > 0) {
		try {
			historyByConditionId = await listSharpMoneyHistoryByConditionIds(
				db,
				Array.from(new Set(eligible.map((pick) => pick.conditionId))),
				Math.min(...eventTimesSeconds) - 4 * 60 * 60,
			);
		} catch (error) {
			console.warn(
				"[manual-picks] settle close-price history lookup failed; storing null closes",
				error,
			);
		}
	}

	for (const pick of eligible) {
		const market = await fetchGammaMarket(pick.conditionId);
		if (!market) continue;
		const resolution = resolvePickResult({
			sharpSide: pick.sharpSide,
			entryPrice: pick.price,
			market,
		});
		if (!resolution) continue;
		const closePrice = resolveClosingPriceFromHistory(
			pick,
			historyByConditionId,
		);
		const entryPrice =
			typeof pick.price === "number" &&
			Number.isFinite(pick.price) &&
			pick.price > 0
				? pick.price
				: null;
		const clv =
			resolution.status !== "push" && closePrice !== null && entryPrice !== null
				? closePrice - entryPrice
				: null;
		await settleManualPick(db, {
			id: pick.id,
			status: resolution.status,
			resolvedOutcome: resolution.resolvedOutcome ?? null,
			closePrice: resolution.status !== "push" ? closePrice : null,
			roi: resolution.roi ?? null,
			clv,
		});
		updated += 1;
	}

	return { checked: picks.length, updated };
}

function resolveClosingPriceFromHistory(
	pick: ManualPickEntry,
	historyByConditionId: SharpMoneyHistoryEntryByConditionId,
): number | null {
	if (!pick.eventTime) return null;
	if (pick.sharpSide !== "A" && pick.sharpSide !== "B") return null;
	const eventTimeSeconds = Math.floor(
		new Date(pick.eventTime).getTime() / 1000,
	);
	if (!Number.isFinite(eventTimeSeconds)) return null;
	const history = historyByConditionId[pick.conditionId];
	if (!history || history.length === 0) return null;
	// The pipeline samples every ~2 min while a market is active; a "close"
	// older than an hour before start is stale coverage, not a closing price.
	return findPriceAtOrBefore(history, pick.sharpSide, eventTimeSeconds, 3600);
}

function normalizeOutcome(value: string): string {
	return value.trim().toLowerCase();
}

export function resolvePickResult(input: {
	sharpSide?: string;
	entryPrice?: number;
	market: GammaResolutionMarket;
}): {
	status: ManualPickStatus;
	resolvedOutcome?: string | null;
	roi?: number | null;
} | null {
	const resolved =
		input.market.resolved === true ||
		(typeof input.market.closed === "boolean" && input.market.closed);
	const resolution = input.market.resolution;
	const umaResolutionStatus = input.market.umaResolutionStatus;
	const outcomes = parseGammaList(input.market.outcomes);
	const outcomePrices = parseGammaPrices(input.market.outcomePrices);

	// Loose == also catches undefined: live Gamma responses omit `resolved`,
	// `resolution`, and `umaResolutionStatus` entirely, so a strict null check
	// never fires and every open market would fall through to the price
	// fallback below (2026-07-23 recon P0: in-progress blowouts at >=0.98
	// settled mid-game and comebacks left permanently wrong outcomes).
	if (!resolved && resolution == null) {
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
	// already reflect the winner (1/0 or near-1/near-0). Only for closed
	// markets — a live in-game price can touch the thresholds and come back.
	if (!resolvedSide && resolved && outcomePrices.length >= 2) {
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
			roi: 0,
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
	const roi =
		entryPrice && status === "win"
			? 1 / entryPrice - 1
			: entryPrice && status === "loss"
				? -1
				: entryPrice
					? 0
					: null;

	return {
		status,
		resolvedOutcome,
		roi,
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
	sportSeriesId?: number;
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
		sportSeriesId:
			typeof obj.sportSeriesId === "number" ? obj.sportSeriesId : undefined,
		sharpSideLabel:
			typeof obj.sharpSideLabel === "string" ? obj.sharpSideLabel : undefined,
		selectedOutcome:
			typeof obj.selectedOutcome === "string" ? obj.selectedOutcome : undefined,
	};
}

/**
 * Enrichment result for the pick response — tells the caller what was enriched.
 *
 * `trendSnapshotAttached` indicates whether a trend snapshot was available for
 * the team at pick time. This is an in-memory signal only — no snapshot data
 * is persisted on the pick row. Trend snapshots are fetched on demand via
 * getPickContextFn using team_id + picked_at.
 */
export interface PickEnrichmentResult {
	fieldsSet: string[];
	trendSnapshotAttached: boolean;
	failureReasons: string[];
}

/**
 * Attempts to enrich a newly created pick with canonical context.
 * Best-effort: never throws, never blocks pick creation.
 *
 * Enriches: bet_type, sport_tag, team_id, opponent_id, game_id,
 * venue_role, fav_dog_role, spread_line, total_line, actual_margin, actual_total.
 *
 * Also checks whether a point-in-time trend snapshot exists for the team.
 * The snapshot is NOT persisted on the pick — the flag is returned to the
 * caller as `trendSnapshotAttached` so it can be surfaced in the response.
 * The canonical pick-context lookup (getPickContextFn) fetches snapshots
 * on demand at read time using the pick's team_id and picked_at timestamp.
 */
export async function enrichPickInline(
	db: Db,
	pickId: string,
	input: CreateManualPickInput,
): Promise<PickEnrichmentResult> {
	const result: PickEnrichmentResult = {
		fieldsSet: [],
		trendSnapshotAttached: false,
		failureReasons: [],
	};

	const title = input.marketTitle;
	const snapshot = parseEnrichmentSnapshot(input.decisionSnapshot);

	// 1. Detect bet_type
	const betType = detectBetType({ title }) ?? null;

	// 2. Detect sport_tag (canonicalized: epl/mls store as "soccer", matching
	// teams/games sport_tag so resolution works)
	const detectedSportTag =
		resolveSportTagFromSeriesId(snapshot?.sportSeriesId) ??
		detectSportTag({ title }) ??
		null;
	const sportTag = detectedSportTag
		? toCanonicalSportTag(detectedSportTag)
		: null;

	// 3. Parse team names and resolve IDs
	let teamId: string | null = null;
	let opponentId: string | null = null;
	let venueRole: VenueRole | null = null;
	let isHomeTeam = false;
	let homeTeamId: string | null = null;
	let awayTeamId: string | null = null;

	// Totals/prop sides (Over/Under, BTTS) are not teams; we still resolve the
	// matchup's team IDs for game matching, but assign no picked-team linkage.
	const teamSidedMarket = betType !== "total" && betType !== "prop";

	if (sportTag) {
		const parsed = parseTeamsFromTitle(title, sportTag);
		if (parsed) {
			const [homeTeam, awayTeam] = await Promise.all([
				resolveSingleTeam(db, sportTag, parsed.home),
				resolveSingleTeam(db, sportTag, parsed.away),
			]);

			if (homeTeam && awayTeam) {
				homeTeamId = homeTeam.id;
				awayTeamId = awayTeam.id;
				const pickedLabel =
					input.sharpSide ??
					snapshot?.sharpSideLabel ??
					snapshot?.selectedOutcome ??
					null;

				const sideLabels = teamSidedMarket
					? await getSideLabels(db, input.conditionId)
					: { sideALabel: null, sideBLabel: null };

				const resolved = teamSidedMarket
					? resolvePickedSide({
							pickedLabel,
							marketTitle: title,
							sideALabel: sideLabels.sideALabel,
							sideBLabel: sideLabels.sideBLabel,
							homeTeamName: homeTeam.name,
							awayTeamName: awayTeam.name,
							homeTeamId: homeTeam.id,
							awayTeamId: awayTeam.id,
							betType,
						})
					: null;

				if (resolved) {
					teamId = resolved.teamId;
					opponentId = resolved.opponentId;
					venueRole = resolved.venueRole;
					isHomeTeam = resolved.isHomeTeam;
				} else if (teamSidedMarket) {
					const explicitPickedLabel = extractSpreadPickedLabel(title);
					const resolvedPickedTeam = explicitPickedLabel
						? await resolveSingleTeam(db, sportTag, explicitPickedLabel)
						: null;
					const mappedPickedTeam = mapPickedTeamToSide({
						pickedTeamId: resolvedPickedTeam?.id ?? null,
						homeTeamId: homeTeam.id,
						awayTeamId: awayTeam.id,
					});
					if (mappedPickedTeam) {
						teamId = mappedPickedTeam.teamId;
						opponentId = mappedPickedTeam.opponentId;
						venueRole = mappedPickedTeam.venueRole;
						isHomeTeam = mappedPickedTeam.isHomeTeam;
					} else {
						result.failureReasons.push("picked_side_ambiguous");
					}
				}
			} else {
				result.failureReasons.push("team_alias_not_found");
			}
		} else {
			result.failureReasons.push("teams_parse_failed");
		}
	} else {
		result.failureReasons.push("sport_tag_unknown");
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

	if (eventTimeUnix && sportTag) {
		const homeId =
			teamId && opponentId ? (isHomeTeam ? teamId : opponentId) : homeTeamId;
		const awayId =
			teamId && opponentId ? (isHomeTeam ? opponentId : teamId) : awayTeamId;
		gameId = await findGameForPick(db, {
			homeTeamId: homeId,
			awayTeamId: awayId,
			eventTime: eventTimeUnix,
			sportTag,
		});
		if (!gameId && homeId && awayId) {
			result.failureReasons.push("game_match_failed");
		}
	}

	// 5. Get line values
	let spreadLine: number | null = null;
	let totalLine: number | null = null;
	let homeSpread: number | null = null;

	if (gameId) {
		const lines = await getLineValues(db, gameId);
		homeSpread = lines.homeSpread;
		spreadLine = homeSpread;
		totalLine = lines.totalLine;
	}

	// 6. Get fact values
	let favDogRole: FavDogRole | null = null;
	let actualMargin: number | null = null;
	let actualTotal: number | null = null;

	if (gameId && teamId) {
		const facts = await getFactValues(db, gameId, teamId);
		if (facts.favDogRole) favDogRole = facts.favDogRole;
		if (facts.venueRole) {
			venueRole = facts.venueRole;
			isHomeTeam = venueRole === "home";
		}
		actualMargin = facts.actualMargin;
		actualTotal = facts.actualTotal;
	} else if (gameId && betType === "total" && (homeTeamId || awayTeamId)) {
		// Totals picks have no picked team, but actual_total is a property of
		// the game — read it via either participant's fact row.
		const facts = await getFactValues(
			db,
			gameId,
			(homeTeamId ?? awayTeamId) as string,
		);
		actualTotal = facts.actualTotal;
	}
	// fav/dog is relative to a picked team; without one it's meaningless.
	if (!favDogRole && homeSpread !== null && teamId) {
		favDogRole = deriveFavDogRole(homeSpread, isHomeTeam);
	}

	// 6b. Capture the sportsbook anchor (de-vigged DraftKings via ESPN) at
	// pick time. Best-effort: a failed fetch must not block enrichment.
	let bookAnchor: BookAnchor | null = null;
	if (gameId) {
		try {
			bookAnchor = await captureBookAnchorForGame(db, {
				gameId,
				venueRole,
				betType,
				entryPrice:
					typeof input.price === "number" &&
					Number.isFinite(input.price) &&
					input.price > 0
						? input.price
						: null,
				// Totals picks: side + the market's own line so the anchor can
				// de-vig side-aware (only when the book prices the same line)
				sideLabel:
					input.sharpSide ??
					snapshot?.sharpSideLabel ??
					snapshot?.selectedOutcome ??
					null,
				marketTotalLine: parseMarketTotalLine(title),
			});
		} catch {
			result.failureReasons.push("book_anchor_failed");
		}
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
	if (bookAnchor) {
		addField("book_source", bookAnchor.source, "book_source");
		addField("book_captured_at", bookAnchor.capturedAt, "book_captured_at");
		addField("book_ml_side", bookAnchor.mlSide, "book_ml_side");
		addField("book_ml_opp", bookAnchor.mlOpp, "book_ml_opp");
		addField("book_fair_prob", bookAnchor.fairProb, "book_fair_prob");
		addField("book_ev", bookAnchor.ev, "book_ev");
		addField("book_spread_line", bookAnchor.spreadLine, "book_spread_line");
		addField("book_total_line", bookAnchor.totalLine, "book_total_line");
		addField(
			"book_total_over_odds",
			bookAnchor.overOdds,
			"book_total_over_odds",
		);
		addField(
			"book_total_under_odds",
			bookAnchor.underOdds,
			"book_total_under_odds",
		);
	}

	if (updates.length === 0) {
		return result;
	}

	params.push(pickId);
	await run(
		db,
		`UPDATE manual_picks SET ${updates.join(", ")} WHERE id = ?`,
		...params,
	);

	// 8. Check for point-in-time trend snapshot availability
	// If we have a team and a time reference, verify that a trend snapshot existed
	// when the pick was made. This is a read-only check — no data is persisted on
	// the pick. The result flag lets the caller know whether trend context exists.
	if (teamId && sportTag) {
		// As-of must be pick time, not event time: an event-time cutoff would
		// admit a snapshot stamped at the game's own start.
		const asOfTime = nowUnixSeconds();
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

	result.failureReasons = Array.from(new Set(result.failureReasons));

	return result;
}

/**
 * Narrow ManualPickEntry.decisionSnapshot from `unknown` to a serializable
 * type so TanStack Start's return-type validation accepts it. The underlying
 * data is always JSON-parsed at the repository layer.
 */
type SerializablePickEntry = Omit<ManualPickEntry, "decisionSnapshot"> & {
	decisionSnapshot?: Record<string, unknown>;
};

function toSerializablePick(pick: ManualPickEntry): SerializablePickEntry {
	return {
		...pick,
		decisionSnapshot: pick.decisionSnapshot as
			| Record<string, unknown>
			| undefined,
	};
}

export const createManualPickFn = createServerFn({
	method: "POST",
})
	.inputValidator((d: CreateManualPickInput) => d)
	.handler(async ({ context, data }) => {
		if (!data.conditionId || !data.marketTitle) {
			return { error: "invalid_payload" as const, pick: null };
		}
		const db = getDb(context);
		const pick = await createManualPick(db, {
			...data,
			strategyVersion: data.strategyVersion ?? buildStrategyVersion() ?? undefined,
		});

		// Attempt inline enrichment — best-effort, never blocks pick creation
		let enrichment: PickEnrichmentResult | null = null;
		try {
			enrichment = await enrichPickInline(db, pick.id, data);
		} catch {
			// Enrichment failure must not prevent pick creation
		}

		// If enrichment set fields, re-read the pick to return updated data
		if (enrichment && enrichment.fieldsSet.length > 0) {
			const updated = await listManualPicks(db, { limit: 50 });
			const freshPick = updated.find((p) => p.id === pick.id);
			return {
				pick: toSerializablePick(freshPick ?? pick),
				enrichment,
			};
		}

		return { pick: toSerializablePick(pick), enrichment };
	});

export const listManualPicksFn = createServerFn({
	method: "POST",
})
	.inputValidator((d: { status?: ManualPickStatus; limit?: number }) => d)
	.handler(async ({ context, data }) => {
		const db = getDb(context);
		const picks = await listManualPicks(db, {
			status: data.status,
			limit: data.limit,
		});
		return { picks: picks.map(toSerializablePick) };
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
})
	.inputValidator((d: { id: string; status: ManualPickStatus }) => d)
	.handler(async ({ context, data }) => {
		if (!data.id || !data.status) {
			return { error: "invalid_payload" as const, pick: null };
		}
		const db = getDb(context);
		const pick = await updateManualPickOutcome(db, data);
		return { pick: pick ? toSerializablePick(pick) : null };
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
