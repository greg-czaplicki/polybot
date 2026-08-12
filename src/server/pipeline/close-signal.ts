/**
 * Close-signal capture: freeze each pick's live signal state just before
 * game time, so pick-time state vs game-time state becomes a measurable
 * split at the n≈100 audit (does late deterioration — concentration,
 * conviction, side flip, edge collapse — predict losses?).
 *
 * Record-only by design. Picking and holding behavior are unchanged
 * (hold-never-churn); this is the evidence an exit/last-look rule would
 * need before ever being pre-registered. Exits would pay spread and
 * slippage into a thin pre-game book on a signal with no outcome data —
 * measure first.
 *
 * Reuses analyzeMarketSharpness (the exact pick-time code path) with
 * includeDebug so warnings + concentration come back. What this captures
 * is the market/holder layer (sharp side, score differential, edge
 * rating, warnings, concentration, per-side prices/values/holder books);
 * the full gate vector (signal_score with novelty, price_edge vs fair
 * price) lives in the pipeline scoring layer and is NOT recomputed here.
 *
 * Window: capture on the first cron tick once the event is ≤12 min out
 * (cron runs every 2 min → lands ~T-10..T-12), with grace until 10 min
 * AFTER start for missed ticks — the holder book just after first pitch
 * still approximates the close. Past the grace window a failure sentinel
 * is stamped so rows stop occupying the sweep.
 */

import type { Env } from "../env";
import { nowUnixSeconds } from "../env";
import { all, run } from "../db/client";
import { analyzeMarketSharpness } from "../api/sharp-money";

/** Capture window opens this long before event_time. */
const WINDOW_BEFORE_SECONDS = 720;
/** Capture gives up this long after event_time. */
const WINDOW_AFTER_SECONDS = 600;

interface CloseSignalPickRow {
	id: string;
	condition_id: string;
	market_title: string;
	event_time: number;
}

interface AnalysisSide {
	label?: string | null;
	price?: number | null;
	totalValue?: number | null;
	holderCount?: number | null;
	topHolders?: Array<{ proxyWallet?: string; amount?: number }>;
}

function slimSide(side: AnalysisSide | undefined) {
	if (!side) return null;
	return {
		label: side.label ?? null,
		price: side.price ?? null,
		totalValue: side.totalValue ?? null,
		holderCount: side.holderCount ?? null,
		topHolders: (side.topHolders ?? []).map((h) => ({
			w: h.proxyWallet ?? null,
			usd: h.amount ?? null,
		})),
	};
}

export async function captureCloseSignalForPicks(
	env: Env,
	options?: { limit?: number },
): Promise<{ checked: number; captured: number }> {
	const db = env.POLYWHALER_DB;
	const limit =
		typeof options?.limit === "number" && options.limit > 0
			? Math.min(options.limit, 10)
			: 2;
	const now = nowUnixSeconds();

	// manual_picks.event_time is ISO-8601 TEXT — select/compare via
	// unixepoch() (same trap as pinnacle-odds.ts, fixed 2026-08-12).
	const rows = await all<CloseSignalPickRow>(
		db,
		`SELECT id, condition_id, market_title,
		        unixepoch(event_time) AS event_time
		 FROM manual_picks
		 WHERE status = 'pending'
		   AND close_signal_captured_at IS NULL
		   AND unixepoch(event_time) BETWEEN ? AND ?
		 ORDER BY event_time ASC
		 LIMIT ?`,
		now - WINDOW_AFTER_SECONDS,
		now + WINDOW_BEFORE_SECONDS,
		limit,
	);
	if (rows.length === 0) return { checked: 0, captured: 0 };

	let captured = 0;
	for (const row of rows) {
		let json: string;
		try {
			const result = await analyzeMarketSharpness(env, {
				conditionId: row.condition_id,
				marketTitle: row.market_title,
				includeDebug: true,
			});
			if (!result.analysis) {
				// Analysis-level failure (holders fetch etc.). Retry on later
				// ticks while inside the window; stamp a sentinel once the
				// grace period is over so the row stops re-fetching forever.
				if (now <= row.event_time + WINDOW_AFTER_SECONDS - 120) continue;
				json = JSON.stringify({ error: result.error ?? "analysis null" });
			} else {
				const analysis = result.analysis;
				const debug = "debug" in result ? result.debug : undefined;
				json = JSON.stringify({
					capturedAt: now,
					secondsToStart: row.event_time - now,
					sharpSide: analysis.sharpSide ?? null,
					confidence: analysis.confidence ?? null,
					scoreDifferential: analysis.scoreDifferential ?? null,
					sharpSideValueRatio: analysis.sharpSideValueRatio ?? null,
					edgeRating: analysis.edgeRating ?? null,
					warnings: debug?.warnings ?? null,
					concentration: debug?.concentration ?? null,
					pnlCoverage: analysis.pnlCoverage ?? null,
					sideA: slimSide(analysis.sideA),
					sideB: slimSide(analysis.sideB),
				});
			}
		} catch (err) {
			console.warn(
				`[close-signal] Capture failed for ${row.id}:`,
				err instanceof Error ? err.message : err,
			);
			if (now <= row.event_time + WINDOW_AFTER_SECONDS - 120) continue;
			json = JSON.stringify({
				error: err instanceof Error ? err.message : "capture threw",
			});
		}
		await run(
			db,
			`UPDATE manual_picks
			 SET close_signal_captured_at = ?, close_signal_json = ?
			 WHERE id = ?`,
			now,
			json,
			row.id,
		);
		captured += 1;
	}
	return { checked: rows.length, captured };
}
