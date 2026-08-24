import { all } from "../db/client";
import type { Env } from "../env";
import {
	PROP_CLEAN_SQL,
	PROP_SUBTYPE_SQL,
	SOLE_BLOCKER_SQL,
} from "./shadow-sql";

/**
 * Public read-only aggregate view of the shadow book, consumed by the
 * weekly digest routine (a cloud agent with no D1 credentials). Aggregates
 * only — no market titles, wallets, or per-row data beyond gate counts.
 */

type GateSummaryRow = {
	reject_reason: string;
	n: number;
	pending: number;
	wins: number;
	losses: number;
	avg_roi: number | null;
	avg_clv: number | null;
	avg_pin_clv: number | null;
	pin_clv_n: number;
	new_7d: number;
	settled_7d: number;
};

type PropCleanRow = {
	subtype: string;
	n: number;
	pending: number;
	wins: number;
	losses: number;
	avg_roi: number | null;
	avg_clv: number | null;
};

const GATE_SUMMARY_SQL = `
	SELECT
		reject_reason,
		COUNT(*) AS n,
		SUM(status = 'pending') AS pending,
		SUM(status = 'win') AS wins,
		SUM(status = 'loss') AS losses,
		ROUND(AVG(CASE WHEN status IN ('win','loss') THEN roi END), 4) AS avg_roi,
		ROUND(AVG(CASE WHEN status IN ('win','loss') THEN clv END), 4) AS avg_clv,
		ROUND(AVG(CASE WHEN status IN ('win','loss') THEN pin_clv END), 4) AS avg_pin_clv,
		SUM(CASE WHEN status IN ('win','loss') AND pin_clv IS NOT NULL THEN 1 ELSE 0 END) AS pin_clv_n,
		SUM(CASE WHEN created_at > ?1 THEN 1 ELSE 0 END) AS new_7d,
		SUM(CASE WHEN settled_at > ?1 THEN 1 ELSE 0 END) AS settled_7d
	FROM shadow_candidates`;

export async function handleShadowDigestRequest(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const url = new URL(request.url);
	if (url.pathname !== "/api/shadow-digest") return null;
	if (request.method !== "GET") {
		return new Response("method not allowed", { status: 405 });
	}

	const db = env.POLYWHALER_DB;
	const weekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
	// canonical_sync_runs timestamps are MILLISECONDS (unlike shadow rows).
	const dayAgoMs = Date.now() - 24 * 60 * 60 * 1000;
	const [
		perGate,
		soleBlockerPerGate,
		propCohort,
		propCohortClean,
		chronicErrors,
		runStats,
		lastRunRows,
	] = await Promise.all([
			all<GateSummaryRow>(
				db,
				`${GATE_SUMMARY_SQL} GROUP BY reject_reason ORDER BY n DESC`,
				weekAgo,
			),
			// Promotion-read cohort, same semantics as the /shadow page's
			// Sole-blocker columns: this gate alone fired, every other vector
			// gate passing. A bare gates_json filter is NOT sufficient — rows
			// still land under the FIRST gate that fired, so that cut mixes in
			// candidates other gates would have rejected anyway (this digest
			// served exactly that cut as "cleanPerGate" until 2026-08-12).
			all<GateSummaryRow>(
				db,
				`${GATE_SUMMARY_SQL} WHERE ${SOLE_BLOCKER_SQL}
				GROUP BY reject_reason ORDER BY n DESC`,
				weekAgo,
			),
			all<GateSummaryRow>(
				db,
				`${GATE_SUMMARY_SQL} WHERE market_type = 'prop'
				GROUP BY reject_reason ORDER BY n DESC`,
				weekAgo,
			),
			// Promotion-read cohort: prop gate was the sole blocker (all other
			// gates pass). The raw propCohort mixes in props other gates would
			// have rejected anyway.
			all<PropCleanRow>(
				db,
				`SELECT
					${PROP_SUBTYPE_SQL} AS subtype,
					COUNT(*) AS n,
					SUM(status = 'pending') AS pending,
					SUM(status = 'win') AS wins,
					SUM(status = 'loss') AS losses,
					ROUND(AVG(CASE WHEN status IN ('win','loss') THEN roi END), 4) AS avg_roi,
					ROUND(AVG(CASE WHEN status IN ('win','loss') THEN clv END), 4) AS avg_clv
				FROM shadow_candidates
				WHERE market_type = 'prop' AND ${PROP_CLEAN_SQL}
				GROUP BY subtype ORDER BY n DESC`,
			),
			// Chronic same-error detector: the project's two worst incidents
			// (4-month line-ingestion death, 6-day ESPN 403 freeze) both showed
			// as the SAME error_summary repeating across partial runs with
			// nothing alarming on it. Three repeats in 24h of 6-min runs is
			// already far outside normal (a transient hits 1-2 runs).
			all<{ error: string; runs: number; last_seen_ms: number }>(
				db,
				`SELECT error_summary AS error, COUNT(*) AS runs,
				        MAX(started_at) AS last_seen_ms
				 FROM canonical_sync_runs
				 WHERE started_at > ?1 AND status != 'success'
				   AND error_summary IS NOT NULL
				 GROUP BY error_summary
				 HAVING COUNT(*) >= 3
				 ORDER BY runs DESC LIMIT 10`,
				dayAgoMs,
			),
			all<{
				total: number;
				success: number;
				partial: number;
				failed: number;
			}>(
				db,
				`SELECT COUNT(*) AS total, SUM(status = 'success') AS success,
				        SUM(status = 'partial') AS partial,
				        SUM(status = 'failed') AS failed
				 FROM canonical_sync_runs WHERE started_at > ?1`,
				dayAgoMs,
			),
			all<{ started_at: number; status: string; duration_ms: number }>(
				db,
				`SELECT started_at, status, duration_ms FROM canonical_sync_runs
				 ORDER BY started_at DESC LIMIT 1`,
			),
		]);

	const lastRun = lastRunRows[0] ?? null;
	const lastRunAgeMinutes = lastRun
		? Math.round((Date.now() - lastRun.started_at) / 60_000)
		: null;
	const stats = runStats[0] ?? { total: 0, success: 0, partial: 0, failed: 0 };
	const nonSuccess = stats.total - stats.success;
	const health = {
		lastRun: lastRun
			? {
					startedAt: new Date(lastRun.started_at).toISOString(),
					ageMinutes: lastRunAgeMinutes,
					status: lastRun.status,
					durationMs: lastRun.duration_ms,
				}
			: null,
		runs24h: stats,
		chronicErrors24h: chronicErrors.map((row) => ({
			error: row.error,
			runs: row.runs,
			lastSeenAt: new Date(row.last_seen_ms).toISOString(),
		})),
		// Sync cron is every 6 min: 30 min of silence = 5 missed runs.
		alert:
			chronicErrors.length > 0 ||
			(lastRunAgeMinutes !== null && lastRunAgeMinutes > 30) ||
			(stats.total > 0 && nonSuccess / stats.total >= 0.2),
	};

	return Response.json(
		{
			generatedAt: new Date().toISOString(),
			health,
			perGate,
			soleBlockerPerGate,
			propCohort,
			propCohortClean,
			notes: [
				"health.alert=true means the pipeline needs attention NOW — lead the digest with it: chronicErrors24h lists error_summary values repeating >=3x across 24h of sync runs (the failure shape of the two worst past incidents: a 4-month silent line-ingestion death and a 6-day ESPN freeze), and alert also fires when the last sync run is >30 min old (cron is 6-min) or >=20% of 24h runs are non-success",
				"roi/clv are fractions (0.05 = +5%), settled rows only",
				"avg_pin_clv is the de-vigged Pinnacle close-proxy benchmark (coverage from 2026-08-12, pin_clv_n = rows carrying it); once pin_clv_n is meaningful prefer it over avg_clv (PM self-close) for the checkpoint's CLV criterion",
				"perGate attributes each row to the FIRST gate that fired — contaminated for per-gate causal reads; soleBlockerPerGate (this gate alone failed, all others passed) is the ONLY cohort valid for gate-promotion decisions, and the pre-registered n>=50 checkpoint counts ITS rows",
				"the former cleanPerGate field (bare gate-vector filter, still first-fired attribution) was removed 2026-08-12 — it overstated cohort sizes and nearly false-fired the checkpoint",
				"propCohort accumulates BTTS/NRFI/team-total/period markets from 2026-08-07 (era v7)",
				"propCohortClean is the promotion-read cohort: prop gate sole blocker, all other gates passing — use it, not propCohort, for would-betting-props-pay reads",
			],
		},
		{ headers: { "Cache-Control": "public, max-age=300" } },
	);
}
