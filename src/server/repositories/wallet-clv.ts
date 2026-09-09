/** Descriptive wallet records, never point-in-time scoring inputs.
 * Aggregate observed cash/share increments within each market first. A wallet
 * holding both sides still contributes only one market observation.
 * Partially settled markets wait until all their entries are terminal.
 * Voids carry no CLV. Raw entries and dollar totals remain ledger counts. */
export const WALLET_MARKET_CLV_CTE = `WITH wallet_markets AS (
	SELECT wallet_address, condition_id, MAX(sport_series_id) AS sport_series_id,
		COUNT(*) AS entries, SUM(delta_usd) AS total_delta,
		MAX(observed_at) AS last_seen,
		CASE WHEN SUM(status = 'open') = 0
			AND SUM(status = 'closed' AND clv IS NOT NULL AND entry_price > 0 AND delta_usd > 0) > 0
			THEN 1 ELSE 0 END AS closed,
		SUM(CASE WHEN status = 'closed' AND clv IS NOT NULL AND entry_price > 0 AND delta_usd > 0
			THEN delta_usd / entry_price * clv END) AS close_gain,
		SUM(CASE WHEN status = 'closed' AND clv IS NOT NULL AND entry_price > 0 AND delta_usd > 0
			THEN delta_usd / entry_price END) AS closed_shares,
		SUM(CASE WHEN status = 'closed' AND clv IS NOT NULL AND entry_price > 0 AND delta_usd > 0
			THEN delta_usd END) AS closed_cost
	FROM wallet_entries GROUP BY wallet_address, condition_id
), market_clv AS (
	SELECT *, CASE WHEN closed = 1 THEN close_gain / closed_shares END AS clv,
		CASE WHEN closed = 1 THEN close_gain / closed_cost END AS rel_clv
	FROM wallet_markets
)`;

export const WALLET_LEADERBOARD_SQL = `${WALLET_MARKET_CLV_CTE}
	SELECT wallet_address, SUM(entries) AS entries, COUNT(*) AS markets,
		SUM(closed) AS closed, AVG(clv) AS avg_clv, AVG(rel_clv) AS avg_rel_clv,
		SUM(CASE WHEN clv > 0 THEN 1 ELSE 0 END) AS beat_close,
		SUM(total_delta) AS total_delta, MAX(last_seen) AS last_seen
	FROM market_clv GROUP BY wallet_address HAVING SUM(closed) >= 3
	ORDER BY avg_rel_clv DESC, wallet_address LIMIT 25`;

export const WALLET_SPORT_CLV_SQL = `${WALLET_MARKET_CLV_CTE}
	SELECT wallet_address, sport_series_id, SUM(entries) AS n, COUNT(*) AS markets,
		SUM(closed) AS closed, SUM(clv) AS clv_sum, SUM(rel_clv) AS rel_clv_sum,
		COUNT(rel_clv) AS rel_clv_n,
		SUM(CASE WHEN clv > 0 THEN 1 ELSE 0 END) AS beat_close,
		SUM(total_delta) AS total_delta, MAX(last_seen) AS last_seen
	FROM market_clv WHERE sport_series_id IS NOT NULL
	GROUP BY wallet_address, sport_series_id`;
