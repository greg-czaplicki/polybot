import { all } from "../db/client";
import type { Env } from "../env";
import { PROP_CLEAN_SQL, PROP_SUBTYPE_SQL } from "./shadow-sql";

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
	const [perGate, cleanPerGate, propCohort, propCohortClean] =
		await Promise.all([
			all<GateSummaryRow>(
				db,
				`${GATE_SUMMARY_SQL} GROUP BY reject_reason ORDER BY n DESC`,
				weekAgo,
			),
			// gates_json marks rows with the full gate vector (migration 0027,
			// 2026-08-06) — the only rows valid for per-gate causal reads.
			all<GateSummaryRow>(
				db,
				`${GATE_SUMMARY_SQL} WHERE gates_json IS NOT NULL
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
		]);

	return Response.json(
		{
			generatedAt: new Date().toISOString(),
			perGate,
			cleanPerGate,
			propCohort,
			propCohortClean,
			notes: [
				"roi/clv are fractions (0.05 = +5%), settled rows only",
				"perGate rows before 2026-08-06 are contaminated by the gate chain's early-return; use cleanPerGate for per-gate reads",
				"propCohort accumulates BTTS/NRFI/team-total/period markets from 2026-08-07 (era v7)",
				"propCohortClean is the promotion-read cohort: prop gate sole blocker, all other gates passing — use it, not propCohort, for would-betting-props-pay reads",
			],
		},
		{ headers: { "Cache-Control": "public, max-age=300" } },
	);
}
