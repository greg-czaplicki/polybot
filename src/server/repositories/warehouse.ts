import type { Db } from "../db/client";
import { all, first, run } from "../db/client";
import type {
	HistoricalMatchupLabel,
	MarketFeatureSnapshot,
	PlayerFeatureSnapshot,
} from "../../types/warehouse";

/**
 * Generate a unique ID for warehouse records.
 */
function generateId(prefix: string): string {
	return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// ---------------------------------------------------------------------------
// Player Feature Snapshots
// ---------------------------------------------------------------------------

/**
 * Insert or update a player feature snapshot.
 * Uses INSERT OR REPLACE with the UNIQUE(condition_id, wallet_address) constraint.
 */
export async function upsertPlayerFeatureSnapshot(
	db: Db,
	input: Omit<PlayerFeatureSnapshot, "id">,
): Promise<void> {
	const id = generateId("pfs");
	await run(
		db,
		`INSERT OR REPLACE INTO player_feature_snapshots (
      id, condition_id, wallet_address, event_time, sport_series_id,
      position_value, pnl_day, pnl_week, pnl_month, pnl_all,
      unit_size, momentum_weight, pnl_tier_weight, stake_units, computed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id,
		input.condition_id,
		input.wallet_address,
		input.event_time ?? null,
		input.sport_series_id ?? null,
		input.position_value ?? null,
		input.pnl_day ?? null,
		input.pnl_week ?? null,
		input.pnl_month ?? null,
		input.pnl_all ?? null,
		input.unit_size ?? null,
		input.momentum_weight ?? null,
		input.pnl_tier_weight ?? null,
		input.stake_units ?? null,
		input.computed_at,
	);
}

/**
 * Get all player feature snapshots for a given market condition.
 */
export async function getPlayerFeaturesByConditionId(
	db: Db,
	conditionId: string,
): Promise<PlayerFeatureSnapshot[]> {
	return all<PlayerFeatureSnapshot>(
		db,
		`SELECT * FROM player_feature_snapshots WHERE condition_id = ? ORDER BY computed_at DESC`,
		conditionId,
	);
}

// ---------------------------------------------------------------------------
// Market Feature Snapshots
// ---------------------------------------------------------------------------

/**
 * Insert or update a market feature snapshot.
 * Uses INSERT OR REPLACE with the UNIQUE(condition_id, computed_at) constraint.
 */
export async function upsertMarketFeatureSnapshot(
	db: Db,
	input: Omit<MarketFeatureSnapshot, "id">,
): Promise<void> {
	const id = generateId("mfs");
	await run(
		db,
		`INSERT OR REPLACE INTO market_feature_snapshots (
      id, condition_id, market_title, event_time, sport_series_id,
      side_a_label, side_b_label, side_a_sharp_score, side_b_sharp_score,
      side_a_price, side_b_price, side_a_total_value, side_b_total_value,
      sharp_side, confidence, score_differential, edge_rating,
      market_volume, market_liquidity, holder_count_a, holder_count_b, computed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id,
		input.condition_id,
		input.market_title,
		input.event_time ?? null,
		input.sport_series_id ?? null,
		input.side_a_label ?? null,
		input.side_b_label ?? null,
		input.side_a_sharp_score ?? null,
		input.side_b_sharp_score ?? null,
		input.side_a_price ?? null,
		input.side_b_price ?? null,
		input.side_a_total_value ?? null,
		input.side_b_total_value ?? null,
		input.sharp_side ?? null,
		input.confidence ?? null,
		input.score_differential ?? null,
		input.edge_rating ?? null,
		input.market_volume ?? null,
		input.market_liquidity ?? null,
		input.holder_count_a ?? null,
		input.holder_count_b ?? null,
		input.computed_at,
	);
}

/**
 * Get market feature snapshots for a given market condition.
 */
export async function getMarketFeaturesByConditionId(
	db: Db,
	conditionId: string,
): Promise<MarketFeatureSnapshot[]> {
	return all<MarketFeatureSnapshot>(
		db,
		`SELECT * FROM market_feature_snapshots WHERE condition_id = ? ORDER BY computed_at DESC`,
		conditionId,
	);
}

/**
 * Get the latest market feature snapshot for each condition.
 */
export async function getLatestMarketFeatures(
	db: Db,
	options?: { sportSeriesId?: number; limit?: number },
): Promise<MarketFeatureSnapshot[]> {
	const { sportSeriesId, limit = 100 } = options ?? {};
	if (sportSeriesId != null) {
		return all<MarketFeatureSnapshot>(
			db,
			`SELECT m.* FROM market_feature_snapshots m
       INNER JOIN (
         SELECT condition_id, MAX(computed_at) AS max_computed
         FROM market_feature_snapshots
         WHERE sport_series_id = ?
         GROUP BY condition_id
       ) latest ON m.condition_id = latest.condition_id AND m.computed_at = latest.max_computed
       ORDER BY m.computed_at DESC LIMIT ?`,
			sportSeriesId,
			limit,
		);
	}
	return all<MarketFeatureSnapshot>(
		db,
		`SELECT m.* FROM market_feature_snapshots m
     INNER JOIN (
       SELECT condition_id, MAX(computed_at) AS max_computed
       FROM market_feature_snapshots
       GROUP BY condition_id
     ) latest ON m.condition_id = latest.condition_id AND m.computed_at = latest.max_computed
     ORDER BY m.computed_at DESC LIMIT ?`,
		limit,
	);
}

// ---------------------------------------------------------------------------
// Historical Matchup Labels
// ---------------------------------------------------------------------------

/**
 * Insert or update a historical matchup label.
 * Uses INSERT OR REPLACE with the UNIQUE(condition_id) constraint.
 */
export async function upsertMatchupLabel(
	db: Db,
	input: Omit<HistoricalMatchupLabel, "id">,
): Promise<void> {
	const id = generateId("hml");
	await run(
		db,
		`INSERT OR REPLACE INTO historical_matchup_labels (
      id, condition_id, market_title, event_time, sport_series_id,
      sharp_side, sharp_side_price_at_pick, confidence, edge_rating,
      resolved_outcome, close_price, roi, clv, labeled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id,
		input.condition_id,
		input.market_title,
		input.event_time ?? null,
		input.sport_series_id ?? null,
		input.sharp_side ?? null,
		input.sharp_side_price_at_pick ?? null,
		input.confidence ?? null,
		input.edge_rating ?? null,
		input.resolved_outcome ?? null,
		input.close_price ?? null,
		input.roi ?? null,
		input.clv ?? null,
		input.labeled_at,
	);
}

/**
 * Get all historical matchup labels, optionally filtered.
 */
export async function getMatchupLabels(
	db: Db,
	options?: { sportSeriesId?: number; outcome?: string; limit?: number },
): Promise<HistoricalMatchupLabel[]> {
	const { sportSeriesId, outcome, limit = 200 } = options ?? {};
	const whereClauses: string[] = [];
	const params: unknown[] = [];

	if (sportSeriesId != null) {
		whereClauses.push("sport_series_id = ?");
		params.push(sportSeriesId);
	}
	if (outcome) {
		whereClauses.push("resolved_outcome = ?");
		params.push(outcome);
	}

	const where =
		whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
	params.push(limit);

	return all<HistoricalMatchupLabel>(
		db,
		`SELECT * FROM historical_matchup_labels ${where} ORDER BY labeled_at DESC LIMIT ?`,
		...params,
	);
}

/**
 * Get a single matchup label by condition ID.
 */
export async function getMatchupLabelByConditionId(
	db: Db,
	conditionId: string,
): Promise<HistoricalMatchupLabel | null> {
	return first<HistoricalMatchupLabel>(
		db,
		`SELECT * FROM historical_matchup_labels WHERE condition_id = ?`,
		conditionId,
	);
}

// ---------------------------------------------------------------------------
// Warehouse Stats
// ---------------------------------------------------------------------------

/** Counts for each warehouse table */
export interface WarehouseStats {
	playerFeatureCount: number;
	marketFeatureCount: number;
	matchupLabelCount: number;
}

/**
 * Get row counts for each warehouse table.
 */
export async function getWarehouseStats(db: Db): Promise<WarehouseStats> {
	const [pf, mf, ml] = await Promise.all([
		first<{ cnt: number }>(
			db,
			`SELECT COUNT(*) AS cnt FROM player_feature_snapshots`,
		),
		first<{ cnt: number }>(
			db,
			`SELECT COUNT(*) AS cnt FROM market_feature_snapshots`,
		),
		first<{ cnt: number }>(
			db,
			`SELECT COUNT(*) AS cnt FROM historical_matchup_labels`,
		),
	]);

	return {
		playerFeatureCount: pf?.cnt ?? 0,
		marketFeatureCount: mf?.cnt ?? 0,
		matchupLabelCount: ml?.cnt ?? 0,
	};
}
