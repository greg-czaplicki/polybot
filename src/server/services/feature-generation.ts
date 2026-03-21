import type { Db } from "../db/client";
import { all, first } from "../db/client";
import { nowUnixSeconds } from "../env";
import type { SharpMoneyCacheRow, TopHolderPnlData } from "../repositories/sharp-money";
import {
	upsertPlayerFeatureSnapshot,
	upsertMarketFeatureSnapshot,
} from "../repositories/warehouse";

/**
 * Result summary returned after feature generation.
 */
export interface FeatureGenerationResult {
	conditionId: string;
	playerFeaturesWritten: number;
	marketFeaturesWritten: boolean;
}

/**
 * Generate player feature snapshots for a single market.
 *
 * Reads top holders from the sharp_money_cache entry's JSON columns
 * and writes one player_feature_snapshot per holder.
 *
 * @param db - D1 database handle
 * @param conditionId - Market condition ID to generate features for
 * @returns Summary of features generated, or null if market not found
 */
export async function generatePlayerFeatures(
	db: Db,
	conditionId: string,
): Promise<{ count: number } | null> {
	const row = await first<SharpMoneyCacheRow>(
		db,
		`SELECT * FROM sharp_money_cache WHERE condition_id = ?`,
		conditionId,
	);
	if (!row) return null;

	const now = nowUnixSeconds();
	const holders: Array<TopHolderPnlData & { side: string; amount: number }> =
		[];

	// Parse side A top holders
	if (row.side_a_top_holders) {
		const parsed = JSON.parse(row.side_a_top_holders) as TopHolderPnlData[];
		for (const h of parsed) {
			holders.push({ ...h, side: "A", amount: h.amount });
		}
	}

	// Parse side B top holders
	if (row.side_b_top_holders) {
		const parsed = JSON.parse(row.side_b_top_holders) as TopHolderPnlData[];
		for (const h of parsed) {
			holders.push({ ...h, side: "B", amount: h.amount });
		}
	}

	let count = 0;
	for (const holder of holders) {
		await upsertPlayerFeatureSnapshot(db, {
			condition_id: conditionId,
			wallet_address: holder.proxyWallet,
			event_time: row.event_time ?? null,
			sport_series_id: row.sport_series_id ?? null,
			position_value: holder.amount,
			pnl_day: holder.pnlDay ?? null,
			pnl_week: holder.pnlWeek ?? null,
			pnl_month: holder.pnlMonth ?? null,
			pnl_all: holder.pnlAll ?? null,
			unit_size: holder.unitSize ?? null,
			momentum_weight: holder.momentumWeight,
			pnl_tier_weight: holder.pnlTierWeight,
			stake_units: holder.stakeUnits ?? null,
			computed_at: now,
		});
		count++;
	}

	return { count };
}

/**
 * Generate a market feature snapshot for a single market.
 *
 * Reads the current sharp_money_cache entry and snapshots its state
 * into market_feature_snapshots.
 *
 * @param db - D1 database handle
 * @param conditionId - Market condition ID to snapshot
 * @returns true if snapshot was written, null if market not found
 */
export async function generateMarketFeatures(
	db: Db,
	conditionId: string,
): Promise<boolean | null> {
	const row = await first<SharpMoneyCacheRow>(
		db,
		`SELECT * FROM sharp_money_cache WHERE condition_id = ?`,
		conditionId,
	);
	if (!row) return null;

	const now = nowUnixSeconds();

	await upsertMarketFeatureSnapshot(db, {
		condition_id: conditionId,
		market_title: row.market_title,
		event_time: row.event_time ?? null,
		sport_series_id: row.sport_series_id ?? null,
		side_a_label: row.side_a_label,
		side_b_label: row.side_b_label,
		side_a_sharp_score: row.side_a_sharp_score,
		side_b_sharp_score: row.side_b_sharp_score,
		side_a_price: row.side_a_price ?? null,
		side_b_price: row.side_b_price ?? null,
		side_a_total_value: row.side_a_total_value,
		side_b_total_value: row.side_b_total_value,
		sharp_side: row.sharp_side ?? null,
		confidence: row.confidence ?? null,
		score_differential: row.score_differential,
		edge_rating: row.edge_rating ?? null,
		market_volume: row.market_volume ?? null,
		market_liquidity: row.market_liquidity ?? null,
		holder_count_a: row.side_a_holder_count,
		holder_count_b: row.side_b_holder_count,
		computed_at: now,
	});

	return true;
}

/**
 * Generate all features (player + market) for one or more markets.
 *
 * If no condition IDs are provided, processes all active markets in the cache.
 *
 * @param db - D1 database handle
 * @param conditionIds - Optional list of specific condition IDs. If omitted, processes all cached markets.
 * @returns Array of generation results per market
 */
export async function generateAllFeatures(
	db: Db,
	conditionIds?: string[],
): Promise<FeatureGenerationResult[]> {
	let ids = conditionIds;

	if (!ids || ids.length === 0) {
		const rows = await all<{ condition_id: string }>(
			db,
			`SELECT condition_id FROM sharp_money_cache`,
		);
		ids = rows.map((r) => r.condition_id);
	}

	const results: FeatureGenerationResult[] = [];

	for (const conditionId of ids) {
		const playerResult = await generatePlayerFeatures(db, conditionId);
		const marketResult = await generateMarketFeatures(db, conditionId);

		results.push({
			conditionId,
			playerFeaturesWritten: playerResult?.count ?? 0,
			marketFeaturesWritten: marketResult === true,
		});
	}

	return results;
}
