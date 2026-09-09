import { all, type Db, run } from "../db/client";
import {
	object,
	pilotSport,
	publicJson,
	seconds,
	WALLET_PILOT_SPORTS,
	type WalletMarket,
	type WalletTrade,
} from "./wallet-trade-common";

export type WalletMetadata = {
	condition_id: string;
	fetched_at: number;
	status: string;
	snapshot_json: string | null;
};
function stringArray(value: unknown): string[] | null {
	try {
		const parsed: unknown =
			typeof value === "string" ? JSON.parse(value) : value;
		return Array.isArray(parsed) &&
			parsed.every((item) => typeof item === "string" && item.trim())
			? parsed
			: null;
	} catch {
		return null;
	}
}

export function parseWalletMetadata(
	value: unknown,
	condition: string,
	now: number,
): { status: string; market: WalletMarket | null } {
	const invalid = { status: "invalid_metadata", market: null };
	if (!Array.isArray(value) || value.length !== 1) return invalid;
	const row = object(value[0]);
	if (!row || row.conditionId !== condition) return invalid;
	const labels = stringArray(row.outcomes);
	const tokens = stringArray(row.clobTokenIds);
	if (
		!labels ||
		labels.length !== 2 ||
		labels[0] === labels[1] ||
		!tokens ||
		tokens.length !== 2 ||
		tokens[0] === tokens[1] ||
		!tokens.every((token) => /^\d+$/.test(token))
	)
		return invalid;
	if (!Array.isArray(row.events) || row.events.length !== 1)
		return { status: "unclassified", market: null };
	const event = object(row.events[0]);
	const eventId = event?.id;
	if (!event || typeof eventId !== "string" || !/^\d+$/.test(eventId))
		return invalid;
	const series = Array.isArray(event.series)
		? event.series.map((entry) => object(entry)?.id)
		: [];
	if (
		series.length !== 1 ||
		typeof series[0] !== "string" ||
		!/^\d+$/.test(series[0])
	)
		return { status: "unclassified", market: null };
	const seriesId = Number(series[0]);
	const sport = pilotSport(seriesId);
	if (!sport)
		return {
			status:
				typeof row.sportsMarketType === "string"
					? "unsupported_series"
					: "unclassified",
			market: null,
		};
	if (!WALLET_PILOT_SPORTS.has(sport))
		return { status: "unsupported_sport", market: null };
	if (
		typeof row.gameStartTime !== "string" ||
		!/(Z|[+-]\d{2}(?::?\d{2})?)$/.test(row.gameStartTime)
	)
		return { status: "unknown_event_time", market: null };
	const time = Date.parse(
		row.gameStartTime.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"),
	);
	if (!Number.isFinite(time))
		return { status: "unknown_event_time", market: null };
	const market: WalletMarket = {
		condition_id: condition,
		sport_series_id: seriesId,
		event_time: new Date(time).toISOString(),
		side_a_label: labels[0],
		side_b_label: labels[1],
		token_a: tokens[0],
		token_b: tokens[1],
		event_id: eventId,
		identity_source: "gamma_token",
		metadata_at: now,
	};
	if (
		row.closed === true ||
		row.archived === true ||
		row.acceptingOrders === false
	)
		return { status: "market_inactive", market };
	return { status: "identified", market };
}

export function resolveWalletIdentity(
	trade: WalletTrade,
	cached: WalletMarket | undefined,
	metadata: WalletMetadata | undefined,
	now: number,
) {
	const fallback = {
		market: cached ? { ...cached, identity_source: "cache_label" } : undefined,
		trade,
		status: undefined as string | undefined,
	};
	if (
		!metadata ||
		metadata.fetched_at > now ||
		now - metadata.fetched_at > 21600 ||
		metadata.status === "lookup_error"
	)
		return fallback;
	if (metadata.status !== "identified")
		return { ...fallback, status: metadata.status };
	// Snapshot JSON is written only by the validated parser, never by API consumers.
	const market = JSON.parse(
		metadata.snapshot_json ?? "null",
	) as WalletMarket | null;
	if (!market || market.condition_id !== trade.condition)
		return { ...fallback, status: "invalid_metadata" };
	if (
		cached &&
		(pilotSport(cached.sport_series_id) !==
			pilotSport(market.sport_series_id) ||
			(cached.event_time !== null &&
				Date.parse(cached.event_time) !== Date.parse(market.event_time ?? "")))
	)
		return { ...fallback, status: "metadata_conflict" };
	let outcome: string;
	if (trade.token === market.token_a) outcome = market.side_a_label;
	else if (trade.token === market.token_b) outcome = market.side_b_label;
	else return { ...fallback, status: "unknown_token" };
	return { market, trade: { ...trade, outcome }, status: undefined };
}

/** Future-only metadata enrichment: never rewrites existing observations or quotes. */
export async function refreshWalletMetadata(db: Db) {
	const now = seconds();
	const due = await all<{ condition_id: string }>(
		db,
		`SELECT o.condition_id
		FROM wallet_trade_observations o LEFT JOIN wallet_trade_market_metadata m USING(condition_id)
		WHERE m.retry_at IS NULL OR m.retry_at <= ? GROUP BY o.condition_id
		ORDER BY COALESCE(m.fetched_at, 0), MIN(o.detected_at), o.condition_id LIMIT 2`,
		now,
	);
	let errors = 0;
	for (const row of due) {
		let parsed: ReturnType<typeof parseWalletMetadata> = {
			status: "lookup_error",
			market: null,
		};
		let errorMessage: string | null = null;
		try {
			const url = new URL("https://gamma-api.polymarket.com/markets");
			url.searchParams.set("condition_ids", row.condition_id);
			url.searchParams.set("limit", "2");
			parsed = parseWalletMetadata(
				await publicJson(url),
				row.condition_id,
				seconds(),
			);
			if (parsed.status === "invalid_metadata") {
				errors++;
				errorMessage = "Invalid Gamma identity response";
			}
		} catch (error) {
			errors++;
			errorMessage = String(error).slice(0, 300);
		}
		const received = seconds();
		await run(
			db,
			`INSERT INTO wallet_trade_market_metadata
			(condition_id, fetched_at, retry_at, status, snapshot_json, error) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(condition_id) DO UPDATE SET fetched_at=excluded.fetched_at, retry_at=excluded.retry_at,
			status=excluded.status, snapshot_json=excluded.snapshot_json, error=excluded.error`,
			row.condition_id,
			received,
			received + (errorMessage ? 900 : 21600),
			parsed.status,
			parsed.market ? JSON.stringify(parsed.market) : null,
			errorMessage,
		);
	}
	return { attempted: due.length, errors };
}
