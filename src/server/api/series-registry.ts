/**
 * Dynamic Polymarket series discovery.
 *
 * Polymarket creates a NEW Gamma series per season for most sports
 * (e.g. `nfl-2025`, `nba-2026`, `premier-league-2025`, `mls-2025`), so any
 * hardcoded series ID silently goes stale at the next season boundary — the
 * events endpoint keeps answering for the old series, it just never has
 * upcoming games again. This module resolves the currently-active series IDs
 * for each tracked sport by probing `/series?slug=<base>-<year>` for the
 * surrounding season years, with hardcoded IDs as a fallback when Gamma is
 * unreachable.
 *
 * Season-year conventions differ per sport (NFL uses the start year, NBA the
 * end year, EPL the start year), so instead of guessing which convention a
 * sport uses we probe [year-1, year, year+1] and keep EVERY match that is
 * still active and not closed. A stale-but-active series (Polymarket rarely
 * flips `active` off after a season ends) costs one empty events request
 * downstream, which is cheap; missing the new season's series costs the
 * entire sport.
 */

import { detectSportTagFromSeriesId } from "../../lib/sports";

const POLYMARKET_GAMMA_API = "https://gamma-api.polymarket.com";

const REGISTRY_TTL_MS = 6 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 10_000;

export type SeriesSportConfig =
	| {
			tag: string;
			kind: "static";
			seriesId: number;
			/** Whether this sport's events should be fetched by the runtime sync. */
			target: boolean;
	  }
	| {
			tag: string;
			kind: "seasonal";
			slugBase: string;
			/** Last-known-good series IDs, used when discovery fails. */
			fallbackIds: number[];
			target: boolean;
	  };

/**
 * One entry per sport we label or fetch. `target: true` sports are fetched by
 * the runtime sync; the rest only get id -> tag labeling.
 *
 * Fallback IDs are the resolved series as of 2026-07-30.
 */
export const SPORT_SERIES_CONFIG: SeriesSportConfig[] = [
	// 12185 = nfl-2026 (minted by 2026-08-05); 10187 = nfl-2025, still active.
	{ tag: "nfl", kind: "seasonal", slugBase: "nfl", fallbackIds: [10187, 12185], target: true },
	{ tag: "nba", kind: "seasonal", slugBase: "nba", fallbackIds: [10345], target: true },
	// Tag is "ncaaf" (canonical DB convention: teams/games sport_tag), but the
	// Gamma series slug base is "cfb" (cfb-2025, cfb-2026, ...).
	{ tag: "ncaaf", kind: "seasonal", slugBase: "cfb", fallbackIds: [10210], target: true },
	{ tag: "ncaab", kind: "static", seriesId: 10470, target: true },
	{ tag: "mlb", kind: "static", seriesId: 3, target: true },
	// NHL shadow-settles behind nhl_league_probation (2026-08-25; was a hard
	// nhl_sport_excluded reject from 2026-03-19) so the 2026-27 season builds
	// a would-have-bet cohort under current gates.
	{ tag: "nhl", kind: "seasonal", slugBase: "nhl", fallbackIds: [10346], target: true },
	{ tag: "epl", kind: "seasonal", slugBase: "premier-league", fallbackIds: [10188], target: true },
	{ tag: "mls", kind: "seasonal", slugBase: "mls", fallbackIds: [10189], target: true },
	// EFL Championship uses an evergreen slug (`efl-championship`, no season
	// suffix — verified 2026-08-18), so it's static, not seasonal. Ingested
	// for the shadow book only: the {championship,atp,wta} league-probation
	// gate in api/bot.ts rejects every live pick until the shadow cohort
	// clears the promotion checkpoint.
	{ tag: "championship", kind: "static", seriesId: 10355, target: true },
	// European soccer majors (2026-08-18): shadow-only via the same gate.
	// Seasonal slugs like EPL (la-liga-2025, ...); like EPL, Polymarket has
	// not minted -2026 slugs — the 2026-27 seasons run on the -2025 series,
	// which discovery finds via the year-window probe. UCL has no ESPN
	// linkage or team seeding yet (league-phase field not drawn until late
	// Aug); its games only link when both clubs are seeded domestically.
	{ tag: "laliga", kind: "seasonal", slugBase: "la-liga", fallbackIds: [10193], target: true },
	{ tag: "bundesliga", kind: "seasonal", slugBase: "bundesliga", fallbackIds: [10194], target: true },
	{ tag: "seriea", kind: "seasonal", slugBase: "serie-a", fallbackIds: [10203], target: true },
	{ tag: "ligue1", kind: "seasonal", slugBase: "ligue-1", fallbackIds: [10195], target: true },
	{ tag: "ucl", kind: "seasonal", slugBase: "ucl", fallbackIds: [10204], target: true },
	// Tennis: per-match markets live under the evergreen atp/wta series (no
	// per-tournament series; US Open matches flow through these). Shadow-only
	// via the same league-probation gate.
	{ tag: "atp", kind: "static", seriesId: 10365, target: true },
	{ tag: "wta", kind: "static", seriesId: 10366, target: true },
	// Label-only sports (not fetched by runtime sync).
	// Gamma's UFC games series. (The old SPORTS_SERIES_IDS map pointed `mma`
	// at 10500, which is actually a Netflix stock-price series.)
	{ tag: "mma", kind: "static", seriesId: 38, target: false },
];

export type ResolvedSeries = {
	tag: string;
	seriesId: number;
	slug?: string;
	source: "static" | "discovered" | "fallback";
	target: boolean;
};

export type SeriesRegistry = {
	resolvedAt: number;
	series: ResolvedSeries[];
	/** Series IDs the runtime sync should fetch events for. */
	targetSeriesIds: number[];
	idToTag: Map<number, string>;
	/** Sports whose seasonal discovery failed and fell back to static IDs. */
	discoveryFailures: string[];
};

type GammaSeries = {
	id?: string | number;
	slug?: string;
	active?: boolean;
	closed?: boolean;
	archived?: boolean;
};

let cachedRegistry: SeriesRegistry | null = null;

function buildFallbackRegistry(): SeriesRegistry {
	const series: ResolvedSeries[] = [];
	for (const config of SPORT_SERIES_CONFIG) {
		if (config.kind === "static") {
			series.push({
				tag: config.tag,
				seriesId: config.seriesId,
				source: "static",
				target: config.target,
			});
		} else {
			for (const seriesId of config.fallbackIds) {
				series.push({
					tag: config.tag,
					seriesId,
					source: "fallback",
					target: config.target,
				});
			}
		}
	}
	return finalizeRegistry(
		series,
		SPORT_SERIES_CONFIG.filter((c) => c.kind === "seasonal").map((c) => c.tag),
	);
}

function finalizeRegistry(
	series: ResolvedSeries[],
	discoveryFailures: string[],
): SeriesRegistry {
	return {
		resolvedAt: Date.now(),
		series,
		targetSeriesIds: [...new Set(series.filter((s) => s.target).map((s) => s.seriesId))],
		idToTag: new Map(series.map((s) => [s.seriesId, s.tag])),
		discoveryFailures,
	};
}

async function probeSeriesSlug(slug: string): Promise<GammaSeries | null> {
	const url = new URL("/series", POLYMARKET_GAMMA_API);
	url.searchParams.set("slug", slug);
	const response = await fetch(url.toString(), {
		signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`series probe ${slug} -> HTTP ${response.status}`);
	}
	const body = (await response.json()) as GammaSeries[] | null;
	if (!Array.isArray(body) || body.length === 0) return null;
	const match = body.find((s) => s.slug === slug);
	if (!match) return null;
	if (match.active === false || match.closed === true || match.archived === true) {
		return null;
	}
	const id = Number(match.id);
	if (!Number.isFinite(id) || id <= 0) return null;
	return { ...match, id };
}

async function discoverSeasonalSeries(
	config: Extract<SeriesSportConfig, { kind: "seasonal" }>,
	seasonYears: number[],
): Promise<{ resolved: ResolvedSeries[]; failed: boolean }> {
	const resolved: ResolvedSeries[] = [];
	let anyProbeFailed = false;

	for (const year of seasonYears) {
		const slug = `${config.slugBase}-${year}`;
		try {
			const match = await probeSeriesSlug(slug);
			if (match) {
				resolved.push({
					tag: config.tag,
					seriesId: Number(match.id),
					slug,
					source: "discovered",
					target: config.target,
				});
			}
		} catch (error) {
			anyProbeFailed = true;
			console.warn(`[series-registry] Probe failed for ${slug}:`, error);
		}
	}

	if (resolved.length > 0) {
		return { resolved, failed: false };
	}

	// Nothing discovered: either every probe errored, or the sport genuinely
	// has no active seasonal series right now. Fall back to last-known-good
	// IDs either way — fetching a dead series is one cheap empty request.
	return {
		resolved: config.fallbackIds.map((seriesId) => ({
			tag: config.tag,
			seriesId,
			source: "fallback" as const,
			target: config.target,
		})),
		failed: anyProbeFailed,
	};
}

/**
 * Resolve the active series registry, using a module-level cache with a 6h
 * TTL. Never throws: on any failure it degrades to fallback IDs (stale cache
 * first, then hardcoded).
 */
export async function resolveSeriesRegistry(options?: {
	forceRefresh?: boolean;
}): Promise<SeriesRegistry> {
	if (
		!options?.forceRefresh &&
		cachedRegistry &&
		Date.now() - cachedRegistry.resolvedAt < REGISTRY_TTL_MS
	) {
		return cachedRegistry;
	}

	const currentYear = new Date().getUTCFullYear();
	const seasonYears = [currentYear - 1, currentYear, currentYear + 1];

	const series: ResolvedSeries[] = [];
	const discoveryFailures: string[] = [];

	for (const config of SPORT_SERIES_CONFIG) {
		if (config.kind === "static") {
			series.push({
				tag: config.tag,
				seriesId: config.seriesId,
				source: "static",
				target: config.target,
			});
			continue;
		}
		const { resolved, failed } = await discoverSeasonalSeries(config, seasonYears);
		series.push(...resolved);
		if (failed) {
			discoveryFailures.push(config.tag);
		}
	}

	const registry = finalizeRegistry(series, discoveryFailures);

	// If every seasonal sport failed discovery, Gamma is likely down; prefer a
	// stale cache over an all-fallback registry so a previously-discovered new
	// season series isn't dropped mid-outage.
	const seasonalCount = SPORT_SERIES_CONFIG.filter(
		(c) => c.kind === "seasonal",
	).length;
	if (discoveryFailures.length >= seasonalCount && cachedRegistry) {
		console.warn(
			"[series-registry] All seasonal discovery failed; keeping stale cache from",
			new Date(cachedRegistry.resolvedAt).toISOString(),
		);
		return cachedRegistry;
	}

	cachedRegistry = registry;
	console.log(
		"[series-registry] Resolved series:",
		registry.series
			.map((s) => `${s.tag}=${s.seriesId}(${s.slug ?? s.source})`)
			.join(", "),
		registry.discoveryFailures.length > 0
			? `discovery failures: ${registry.discoveryFailures.join(", ")}`
			: "",
	);
	return registry;
}

/** Synchronous best-effort registry for callers that cannot await (labeling). */
export function getSeriesRegistrySnapshot(): SeriesRegistry {
	return cachedRegistry ?? buildFallbackRegistry();
}

let inflightWarm: Promise<SeriesRegistry> | null = null;

/**
 * Warm the registry cache from the request path, waiting at most
 * `maxWaitMs`. Without this, isolates that serve /api/bot/candidates or
 * pick creation without ever running the pipeline sync label new-season
 * series IDs as unknown, so sport-keyed policy gates (nfl_preseason_
 * excluded, nhl_league_probation) silently don't fire. The bounded wait
 * keeps a Gamma outage from stalling bot requests: on timeout the caller
 * proceeds with the best-effort snapshot while discovery finishes and
 * benefits the next request on this isolate. Concurrent callers share one
 * discovery via `inflightWarm`.
 */
export async function warmSeriesRegistry(maxWaitMs = 5000): Promise<void> {
	if (
		cachedRegistry &&
		Date.now() - cachedRegistry.resolvedAt < REGISTRY_TTL_MS
	) {
		return;
	}
	inflightWarm ??= resolveSeriesRegistry().finally(() => {
		inflightWarm = null;
	});
	await Promise.race([
		inflightWarm,
		new Promise((resolve) => setTimeout(resolve, maxWaitMs)),
	]);
}

/**
 * Map a series ID to its sport tag using the live registry first (covers
 * newly-discovered season IDs), then the static map in lib/sports as a
 * fallback for historical IDs no longer in the registry.
 */
export function resolveSportTagFromSeriesId(
	seriesId?: number | null,
): string | null {
	if (typeof seriesId !== "number" || !Number.isFinite(seriesId)) return null;
	const id = Math.trunc(seriesId);
	return (
		getSeriesRegistrySnapshot().idToTag.get(id) ??
		detectSportTagFromSeriesId(id)
	);
}

/** Test hook. */
export function __resetSeriesRegistryCache(): void {
	cachedRegistry = null;
}
