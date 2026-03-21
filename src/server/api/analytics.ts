import { createServerFn } from "@tanstack/react-start";
import { all, first } from "../db/client";
import { getDb } from "../env";

// ── Types ──────────────────────────────────────────────────────────────────

/** A single player feature snapshot row from the warehouse. */
export type PlayerFeatureSnapshot = {
	id: number;
	condition_id: string;
	wallet_address: string;
	event_time: number;
	sport_series_id: number | null;
	position_value: number;
	pnl_day: number;
	pnl_week: number;
	pnl_month: number;
	pnl_all: number;
	unit_size: number | null;
	momentum_weight: number | null;
	pnl_tier_weight: number | null;
	stake_units: number | null;
	computed_at: number;
};

/** Aggregated player summary across markets. */
export type PlayerSummary = {
	wallet_address: string;
	total_position_value: number;
	avg_pnl_day: number;
	avg_pnl_week: number;
	avg_pnl_month: number;
	avg_pnl_all: number;
	avg_momentum_weight: number | null;
	market_count: number;
};

/** A single market feature snapshot row from the warehouse. */
export type MarketFeatureSnapshot = {
	id: number;
	condition_id: string;
	market_title: string;
	event_time: number;
	sport_series_id: number | null;
	side_a_label: string | null;
	side_b_label: string | null;
	side_a_sharp_score: number | null;
	side_b_sharp_score: number | null;
	side_a_price: number | null;
	side_b_price: number | null;
	side_a_total_value: number | null;
	side_b_total_value: number | null;
	sharp_side: string | null;
	confidence: number | null;
	score_differential: number | null;
	edge_rating: number | null;
	market_volume: number | null;
	market_liquidity: number | null;
	holder_count_a: number | null;
	holder_count_b: number | null;
	computed_at: number;
};

/** A historical matchup label row from the warehouse. */
export type HistoricalMatchupLabel = {
	id: number;
	condition_id: string;
	market_title: string;
	event_time: number;
	sport_series_id: number | null;
	sharp_side: string | null;
	sharp_side_price_at_pick: number | null;
	confidence: number | null;
	edge_rating: number | null;
	resolved_outcome: string | null;
	close_price: number | null;
	roi: number | null;
	clv: number | null;
	labeled_at: number;
};

/** Event-level analytics summary. */
export type EventAnalyticsSummary = {
	sport_series_id: number | null;
	market_count: number;
	avg_edge_rating: number | null;
	avg_confidence: number | null;
	label_count: number;
	sharp_side_wins: number;
	sharp_side_win_rate: number | null;
};

/** Market analytics including time series and CLV data. */
export type MarketAnalyticsResult = {
	snapshots: MarketFeatureSnapshot[];
	labels: HistoricalMatchupLabel[];
};

/** Warehouse health summary with table counts. */
export type WarehouseSummary = {
	player_feature_snapshots_count: number;
	market_feature_snapshots_count: number;
	historical_matchup_labels_count: number;
};

// ── Server Functions ───────────────────────────────────────────────────────

/**
 * Fetch player analytics from the warehouse.
 *
 * Queries `player_feature_snapshots` with optional filters and returns both
 * raw snapshots and per-wallet aggregated summaries.
 *
 * @param data.conditionId - Optional: filter by market condition ID
 * @param data.walletAddress - Optional: filter by wallet address
 * @param data.limit - Max rows to return (default 200)
 */
export const fetchPlayerAnalyticsFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = data as {
		conditionId?: string;
		walletAddress?: string;
		limit?: number;
	};
	const db = getDb(context);
	const limit = payload.limit ?? 200;

	const conditions: string[] = [];
	const params: unknown[] = [];

	if (payload.conditionId) {
		conditions.push("condition_id = ?");
		params.push(payload.conditionId);
	}
	if (payload.walletAddress) {
		conditions.push("wallet_address = ?");
		params.push(payload.walletAddress);
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

	const snapshots = await all<PlayerFeatureSnapshot>(
		db,
		`SELECT * FROM player_feature_snapshots ${where} ORDER BY computed_at DESC LIMIT ?`,
		...params,
		limit,
	);

	// Aggregate by wallet
	const summaries = await all<PlayerSummary>(
		db,
		`SELECT
			wallet_address,
			SUM(position_value) AS total_position_value,
			AVG(pnl_day) AS avg_pnl_day,
			AVG(pnl_week) AS avg_pnl_week,
			AVG(pnl_month) AS avg_pnl_month,
			AVG(pnl_all) AS avg_pnl_all,
			AVG(momentum_weight) AS avg_momentum_weight,
			COUNT(DISTINCT condition_id) AS market_count
		FROM player_feature_snapshots ${where}
		GROUP BY wallet_address
		ORDER BY SUM(position_value) DESC
		LIMIT ?`,
		...params,
		limit,
	);

	return { snapshots, summaries };
});

/**
 * Fetch event-level analytics from the warehouse.
 *
 * Aggregates `market_feature_snapshots` and `historical_matchup_labels` to
 * produce per-sport-series summaries including sharp-side win rates.
 *
 * @param data.sportSeriesId - Optional: filter by sport series ID
 * @param data.conditionId - Optional: filter by specific market condition ID
 */
export const fetchEventAnalyticsFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = data as {
		sportSeriesId?: number;
		conditionId?: string;
	};
	const db = getDb(context);

	const mfConditions: string[] = [];
	const mfParams: unknown[] = [];
	const labelConditions: string[] = [];
	const labelParams: unknown[] = [];

	if (payload.sportSeriesId) {
		mfConditions.push("sport_series_id = ?");
		mfParams.push(payload.sportSeriesId);
		labelConditions.push("sport_series_id = ?");
		labelParams.push(payload.sportSeriesId);
	}
	if (payload.conditionId) {
		mfConditions.push("condition_id = ?");
		mfParams.push(payload.conditionId);
		labelConditions.push("condition_id = ?");
		labelParams.push(payload.conditionId);
	}

	const mfWhere = mfConditions.length > 0 ? `WHERE ${mfConditions.join(" AND ")}` : "";
	const labelWhere = labelConditions.length > 0 ? `WHERE ${labelConditions.join(" AND ")}` : "";

	// Market-level aggregation by sport
	const marketStats = await all<{
		sport_series_id: number | null;
		market_count: number;
		avg_edge_rating: number | null;
		avg_confidence: number | null;
	}>(
		db,
		`SELECT
			sport_series_id,
			COUNT(DISTINCT condition_id) AS market_count,
			AVG(edge_rating) AS avg_edge_rating,
			AVG(confidence) AS avg_confidence
		FROM market_feature_snapshots ${mfWhere}
		GROUP BY sport_series_id
		ORDER BY market_count DESC`,
		...mfParams,
	);

	// Label-level aggregation for sharp side accuracy
	const labelStats = await all<{
		sport_series_id: number | null;
		label_count: number;
		sharp_side_wins: number;
	}>(
		db,
		`SELECT
			sport_series_id,
			COUNT(*) AS label_count,
			SUM(CASE WHEN resolved_outcome = sharp_side THEN 1 ELSE 0 END) AS sharp_side_wins
		FROM historical_matchup_labels ${labelWhere}
		GROUP BY sport_series_id`,
		...labelParams,
	);

	// Merge market + label stats
	const labelMap = new Map(
		labelStats.map((l) => [l.sport_series_id, l]),
	);

	const summaries: EventAnalyticsSummary[] = marketStats.map((m) => {
		const labels = labelMap.get(m.sport_series_id);
		return {
			sport_series_id: m.sport_series_id,
			market_count: m.market_count,
			avg_edge_rating: m.avg_edge_rating,
			avg_confidence: m.avg_confidence,
			label_count: labels?.label_count ?? 0,
			sharp_side_wins: labels?.sharp_side_wins ?? 0,
			sharp_side_win_rate:
				labels && labels.label_count > 0
					? labels.sharp_side_wins / labels.label_count
					: null,
		};
	});

	return { summaries };
});

/**
 * Fetch market-level analytics for a specific condition ID.
 *
 * Returns a time series of `market_feature_snapshots` (price movement, sharp
 * score changes) and any `historical_matchup_labels` for CLV data.
 *
 * @param data.conditionId - Required: the market condition ID to query
 */
export const fetchMarketAnalyticsFn = createServerFn({
	method: "POST",
}).handler(async ({ context, data }) => {
	const payload = data as { conditionId: string };
	const db = getDb(context);

	if (!payload.conditionId) {
		return {
			snapshots: [] as MarketFeatureSnapshot[],
			labels: [] as HistoricalMatchupLabel[],
			error: "conditionId is required",
		};
	}

	const snapshots = await all<MarketFeatureSnapshot>(
		db,
		`SELECT * FROM market_feature_snapshots
		 WHERE condition_id = ?
		 ORDER BY computed_at ASC`,
		payload.conditionId,
	);

	const labels = await all<HistoricalMatchupLabel>(
		db,
		`SELECT * FROM historical_matchup_labels
		 WHERE condition_id = ?
		 ORDER BY labeled_at ASC`,
		payload.conditionId,
	);

	return { snapshots, labels } satisfies MarketAnalyticsResult;
});

/**
 * Fetch a summary of warehouse table counts.
 *
 * Quick health check showing how many rows exist in each derived table.
 * Useful for verifying that generation jobs have populated data.
 */
export const fetchWarehouseSummaryFn = createServerFn({
	method: "POST",
}).handler(async ({ context }) => {
	const db = getDb(context);

	const [players, markets, labels] = await Promise.all([
		first<{ cnt: number }>(
			db,
			"SELECT COUNT(*) AS cnt FROM player_feature_snapshots",
		),
		first<{ cnt: number }>(
			db,
			"SELECT COUNT(*) AS cnt FROM market_feature_snapshots",
		),
		first<{ cnt: number }>(
			db,
			"SELECT COUNT(*) AS cnt FROM historical_matchup_labels",
		),
	]);

	return {
		player_feature_snapshots_count: players?.cnt ?? 0,
		market_feature_snapshots_count: markets?.cnt ?? 0,
		historical_matchup_labels_count: labels?.cnt ?? 0,
	} satisfies WarehouseSummary;
});
