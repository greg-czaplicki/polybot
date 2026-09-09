import { all, type Db, first } from "../db/client";

// Rank BEFORE filtering quotes or measurements: a later successful fill cannot
// replace an earlier missing first signal. Tokens uniquely identify outcomes.
export const WALLET_FIRST_SIGNALS_CTE = `WITH buys AS (
	SELECT o.*, ROW_NUMBER() OVER(PARTITION BY wallet_address, token_id
	 ORDER BY detected_at, trade_at, trade_key) rn FROM wallet_trade_observations o WHERE action='BUY'
), signals AS (
	SELECT o.*, m.status measurement_status, m.source, m.follow_clv, m.relative_clv,
	 m.wallet_clv, m.best_ask_clv, json_extract(o.market_snapshot_json,'$.event_id') event_id,
	 EXISTS(SELECT 1 FROM wallet_trade_skips s WHERE s.wallet_address=o.wallet_address
	  AND json_extract(s.trade_key,'$[2]')=o.token_id AND json_extract(s.trade_key,'$[3]')='BUY'
	  AND s.detected_at<=o.detected_at) skipped_before
	FROM buys o LEFT JOIN wallet_trade_measurements m USING(trade_key) WHERE rn=1
)`;

export const WALLET_FIRST_SIGNAL_SUMMARY_SQL = `${WALLET_FIRST_SIGNALS_CTE}
SELECT collection_version, sport, COUNT(*) first_buys,
 COUNT(DISTINCT wallet_address) wallets, COUNT(DISTINCT condition_id) conditions,
 COUNT(DISTINCT event_id) known_events,
 SUM(event_id IS NULL) missing_event_id,
 SUM(skipped_before) prior_truncation,
 SUM(quote_status='quoted' AND NOT skipped_before) first_quotes,
 SUM(COALESCE(measurement_status='measured',0) AND NOT skipped_before) measured,
 SUM(COALESCE(measurement_status='missing_close',0) AND NOT skipped_before) missing_close,
 SUM(COALESCE(measurement_status='invalid_snapshot',0) AND NOT skipped_before) invalid_snapshot,
 SUM(quote_status='quoted' AND measurement_status IS NULL AND NOT skipped_before) awaiting_close,
 AVG(detected_at-trade_at) mean_detection_delay_seconds
FROM signals GROUP BY collection_version, sport`;

const WALLET_EVENT_METRICS_CTE = `${WALLET_FIRST_SIGNALS_CTE}, events AS (
 SELECT collection_version, sport, source, event_id, MIN(event_time) event_time,
 COUNT(*) first_signals, AVG(follow_clv) follow_clv, AVG(relative_clv) relative_clv,
 AVG(wallet_clv) wallet_clv, AVG(best_ask_clv) best_ask_clv
 FROM signals WHERE measurement_status='measured' AND NOT skipped_before AND event_id IS NOT NULL
 GROUP BY collection_version, sport, source, event_id
)`;

export const WALLET_EVENT_METRICS_SQL = `${WALLET_EVENT_METRICS_CTE}
SELECT collection_version, sport, source, COUNT(*) measured_events, SUM(first_signals) first_signals,
 AVG(follow_clv) event_mean_follow_clv, AVG(relative_clv) event_mean_relative_clv,
 AVG(wallet_clv) event_mean_wallet_clv, AVG(best_ask_clv) event_mean_best_ask_clv
FROM events GROUP BY collection_version, sport, source`;

export const WALLET_DAILY_METRICS_SQL = `${WALLET_EVENT_METRICS_CTE}
SELECT collection_version, sport, source, date(event_time,'unixepoch') event_day_utc,
 COUNT(*) measured_events, AVG(follow_clv) event_mean_follow_clv,
 AVG(wallet_clv) event_mean_wallet_clv, AVG(best_ask_clv) event_mean_best_ask_clv
FROM events GROUP BY collection_version, sport, source, event_day_utc`;

export async function getWalletTradeReport(db: Db) {
	const [
		pilot,
		polls,
		observations,
		firstSignals,
		eventMetrics,
		dailyMetrics,
		metadata,
	] = await Promise.all([
		first<{
			enabled: number;
			enrolled_at: number | null;
			expires_at: number | null;
			wallets: number | null;
			last_run_at: number;
			maintenance_at: number | null;
			maintenance_json: string | null;
		}>(
			db,
			`SELECT enabled, enrolled_at, expires_at, json_array_length(cohort_json) wallets,
			 last_run_at, maintenance_at, maintenance_json FROM wallet_trade_pilot WHERE id=1`,
		),
		all(
			db,
			`SELECT collection_version,
			COUNT(*) runs, SUM(finished_at IS NULL) unfinished,
			SUM(error IS NOT NULL OR COALESCE(json_extract(report_json,'$.errors'),0)>0) runs_with_errors,
			SUM(json_extract(report_json,'$.eligible')) eligible_buys,
			SUM(json_extract(report_json,'$.quoted')) quoted,
			SUM(json_extract(report_json,'$.gaps')) gaps,
			SUM(json_extract(report_json,'$.cappedPages')) capped_pages,
			SUM(json_extract(report_json,'$.truncated')) truncated,
			MAX(started_at) latest_poll FROM wallet_trade_polls GROUP BY collection_version`,
		),
		all(
			db,
			`SELECT collection_version, sport, quote_status, action, COUNT(*) n
			FROM wallet_trade_observations GROUP BY collection_version, sport, quote_status, action`,
		),
		all(db, WALLET_FIRST_SIGNAL_SUMMARY_SQL),
		all(db, WALLET_EVENT_METRICS_SQL),
		all(db, WALLET_DAILY_METRICS_SQL),
		all(
			db,
			`SELECT status, COUNT(*) conditions FROM wallet_trade_market_metadata GROUP BY status`,
		),
	]);
	const now = Math.floor(Date.now() / 1000);
	let stage = "not_enrolled";
	if (pilot?.enrolled_at) stage = "collecting";
	if (pilot?.expires_at && now >= pilot.expires_at)
		stage = "collection_expired_review_required";
	if (pilot?.enabled === 0) stage = "paused";
	return {
		generatedAt: new Date().toISOString(),
		stage,
		timingBasis: "polymarket_scheduled_start",
		liveEligible: false,
		pilot: pilot
			? {
					enrolledAt: pilot.enrolled_at,
					expiresAt: pilot.expires_at,
					wallets: pilot.wallets,
					lastRunAt: pilot.last_run_at,
					maintenanceAt: pilot.maintenance_at,
					maintenance: pilot.maintenance_json
						? JSON.parse(pilot.maintenance_json)
						: null,
				}
			: null,
		polls,
		observations,
		firstSignals,
		eventMetrics,
		dailyMetrics,
		metadata,
		notes: [
			"Tennis scheduled times can be session times rather than actual match starts; tennis marks are session-time proxies pending timing validation.",
			"Shadow instrumentation only; no automatic live promotion. Collection versions and close sources are separate.",
			"CLV is gross probability-point movement, not profit or a guaranteed exit. Fees and net execution remain unvalidated.",
			"clob_midpoint is primary; history_ask_proxy is a separate ask-based fallback. Never pool these sources.",
			"First buys are selected before quote filtering. Earlier missing/truncated signals cannot be replaced by later fills.",
			"Event metrics weight known frozen event IDs equally. Unknown event IDs are excluded, not called independent games.",
			"Metadata counts describe current enrichment; historical observation classifications and prices are not rewritten.",
			">=50 eligible buys, >=50% quotes and >=95% clean polls are instrumentation checks only, not trading thresholds.",
		],
	};
}
