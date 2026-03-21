/**
 * Warehouse types for feature snapshots and historical labels.
 * These correspond to the tables created in migrations/0012_warehouse_tables.sql.
 */

/** Database row for player_feature_snapshots table */
export interface PlayerFeatureSnapshot {
	id: string;
	condition_id: string;
	wallet_address: string;
	event_time: string | null;
	sport_series_id: number | null;
	position_value: number | null;
	pnl_day: number | null;
	pnl_week: number | null;
	pnl_month: number | null;
	pnl_all: number | null;
	unit_size: number | null;
	momentum_weight: number | null;
	pnl_tier_weight: number | null;
	stake_units: number | null;
	computed_at: number;
}

/** Database row for market_feature_snapshots table */
export interface MarketFeatureSnapshot {
	id: string;
	condition_id: string;
	market_title: string;
	event_time: string | null;
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
	confidence: string | null;
	score_differential: number | null;
	edge_rating: number | null;
	market_volume: number | null;
	market_liquidity: number | null;
	holder_count_a: number | null;
	holder_count_b: number | null;
	computed_at: number;
}

/** Database row for historical_matchup_labels table */
export interface HistoricalMatchupLabel {
	id: string;
	condition_id: string;
	market_title: string;
	event_time: string | null;
	sport_series_id: number | null;
	sharp_side: string | null;
	sharp_side_price_at_pick: number | null;
	confidence: string | null;
	edge_rating: number | null;
	resolved_outcome: string | null;
	close_price: number | null;
	roi: number | null;
	clv: number | null;
	labeled_at: number;
}
