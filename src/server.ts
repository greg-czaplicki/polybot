import {
	createStartHandler,
	defaultStreamHandler,
} from "@tanstack/react-start/server";
import { handleBotRequest } from "./server/api/bot";
import { handleBotControlRequest } from "./server/api/bot-control";
import { settlePendingManualPicks } from "./server/api/manual-picks";
import type { Env, RequestContext } from "./server/env";
import {
	getCanonicalFreshness,
	persistSyncRun,
	runCanonicalSync,
} from "./server/pipeline/canonical-sync";
import { captureBookClosesForPicks } from "./server/pipeline/book-odds";
import { backfillManualPicks } from "./server/pipeline/pick-backfill";
import { backfillMissingSnapshots } from "./server/pipeline/snapshot-computation";
import {
	handleSharpQueue,
	SharpPipeline,
} from "./server/pipeline/sharp-pipeline";
import { getPipelineStub } from "./server/pipeline/sharp-pipeline-utils";
import { maybeRefreshDailyStatsSnapshot } from "./server/repositories/daily-stats-snapshots";
import { getSharpMoneyCacheFreshnessStats } from "./server/repositories/sharp-money";

const startFetch = createStartHandler(defaultStreamHandler);

const serverEntry = {
	async fetch(request: Request, env: Env, executionCtx: ExecutionContext) {
		const url = new URL(request.url);

		const botResponse = await handleBotRequest(request, env);
		if (botResponse) {
			return botResponse;
		}

		const botControlResponse = await handleBotControlRequest(request, env);
		if (botControlResponse) {
			return botControlResponse;
		}

		// Trigger background sharp pipeline refresh
		if (url.pathname === "/_pipeline/trigger" && request.method === "POST") {
			try {
				const stub = getPipelineStub(env);
				const response = await stub.fetch("https://sharp-pipeline/tick", {
					method: "POST",
					body: await request.text(),
				});
				const payload = await response.text();
				return new Response(payload, {
					headers: { "Content-Type": "application/json" },
				});
			} catch (error) {
				console.error("[sharp-pipeline] Trigger error:", error);
				return new Response(
					JSON.stringify({ success: false, error: String(error) }),
					{
						status: 500,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
		}

		// Pipeline status for UI polling
		if (url.pathname === "/_pipeline/status" && request.method === "GET") {
			try {
				const stub = getPipelineStub(env);
				const response = await stub.fetch("https://sharp-pipeline/status");
				const payload = await response.text();
				return new Response(payload, {
					headers: { "Content-Type": "application/json" },
				});
			} catch (error) {
				console.error("[sharp-pipeline] Status error:", error);
				return new Response(
					JSON.stringify({ success: false, error: String(error) }),
					{
						status: 500,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
		}

		// Trigger manual canonical sync
		if (url.pathname === "/_canonical/trigger" && request.method === "POST") {
			try {
				const body = (await request.json().catch(() => ({}))) as {
					skipSeeding?: boolean;
				};
				const result = await runCanonicalSync(env.POLYWHALER_DB, {
					skipSeeding: body.skipSeeding,
				});
				const runId = await persistSyncRun(env.POLYWHALER_DB, result);
				return new Response(JSON.stringify({ success: true, runId, result }), {
					headers: { "Content-Type": "application/json" },
				});
			} catch (error) {
				console.error("[canonical-sync] Trigger error:", error);
				return new Response(
					JSON.stringify({ success: false, error: String(error) }),
					{
						status: 500,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
		}

		// Canonical pipeline freshness status
		if (url.pathname === "/_canonical/status" && request.method === "GET") {
			try {
				const freshness = await getCanonicalFreshness(env.POLYWHALER_DB);
				return new Response(JSON.stringify(freshness), {
					headers: { "Content-Type": "application/json" },
				});
			} catch (error) {
				console.error("[canonical-sync] Status error:", error);
				return new Response(
					JSON.stringify({ success: false, error: String(error) }),
					{
						status: 500,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
		}

		// Backfill missing team_trend_snapshots for teams that have facts
		// but no snapshots. One-shot utility to close the gap where facts were
		// computed via a path that didn't trigger snapshot compute.
		if (
			url.pathname === "/_canonical/backfill-snapshots" &&
			request.method === "POST"
		) {
			try {
				const sportTagParam = url.searchParams.get("sportTag") ?? undefined;
				const limitParam = Number(url.searchParams.get("limit"));
				const result = await backfillMissingSnapshots(env.POLYWHALER_DB, {
					sportTag: sportTagParam,
					limit: Number.isFinite(limitParam) ? limitParam : undefined,
				});
				return new Response(JSON.stringify({ success: true, result }), {
					headers: { "Content-Type": "application/json" },
				});
			} catch (error) {
				console.error("[canonical-sync] Backfill snapshots error:", error);
				return new Response(
					JSON.stringify({ success: false, error: String(error) }),
					{
						status: 500,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
		}

		// Run manual pick backfill against remote D1
		if (
			url.pathname === "/_canonical/backfill-picks" &&
			request.method === "POST"
		) {
			try {
				const modeParam = url.searchParams.get("mode");
				const repairWindowParam = Number(
					url.searchParams.get("repairWindowHours"),
				);
				const result = await backfillManualPicks(env.POLYWHALER_DB, {
					mode: modeParam === "incremental" ? "incremental" : "full",
					repairWindowHours: Number.isFinite(repairWindowParam)
						? repairWindowParam
						: undefined,
				});
				return new Response(JSON.stringify({ success: true, result }), {
					headers: { "Content-Type": "application/json" },
				});
			} catch (error) {
				console.error("[canonical-sync] Backfill picks error:", error);
				return new Response(
					JSON.stringify({ success: false, error: String(error) }),
					{
						status: 500,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
		}

		const context: RequestContext = {
			env,
			executionCtx,
		};

		return startFetch(request, { context });
	},
	scheduled(_event: ScheduledEvent, env: Env, executionCtx: ExecutionContext) {
		const stub = getPipelineStub(env);
		executionCtx.waitUntil(
			stub
				.fetch("https://sharp-pipeline/tick", {
					method: "POST",
				})
				.then(() => {})
				.catch((error) => {
					console.error("[sharp-pipeline] Scheduled tick failed", error);
				}),
		);
		executionCtx.waitUntil(
			// The whole scheduled invocation shares one subrequest budget across
			// waitUntil branches; each settle costs 1-2 Gamma fetches, so a large
			// batch here starves canonical sync in the same tick.
			settlePendingManualPicks(env.POLYWHALER_DB, { limit: 20 })
				.then((result) => {
					if (result.updated > 0) {
						console.log(
							`[manual-picks] Scheduled settle updated ${result.updated}/${result.checked} pending picks`,
						);
					}
				})
				.catch((error) => {
					console.error("[manual-picks] Scheduled settle failed", error);
				})
				.then(() =>
					// Sequenced after settle (1 ESPN fetch per pick) to stay inside
					// the shared subrequest budget noted above.
					captureBookClosesForPicks(env.POLYWHALER_DB, { limit: 8 }),
				)
				.then((result) => {
					if (result.updated > 0) {
						console.log(
							`[book-odds] Captured book closes for ${result.updated}/${result.checked} picks`,
						);
					}
				})
				.catch((error) => {
					console.error("[book-odds] Book close sweep failed", error);
				}),
		);
		executionCtx.waitUntil(
			getCanonicalFreshness(env.POLYWHALER_DB)
				.then(async (freshness) => {
					// Cooldown: skip if last run was within 5 minutes
					const COOLDOWN_MS = 5 * 60 * 1000;
					if (
						freshness.lastRunAt &&
						Date.now() - freshness.lastRunAt < COOLDOWN_MS
					) {
						return;
					}
					// Seed teams if none exist yet (one-time bootstrap)
					const teamCount = await env.POLYWHALER_DB.prepare(
						"SELECT COUNT(*) as c FROM teams",
					).first<{ c: number }>();
					const skipSeeding = (teamCount?.c ?? 0) > 0;
					return runCanonicalSync(env.POLYWHALER_DB, { skipSeeding })
						.then((result) => persistSyncRun(env.POLYWHALER_DB, result))
						.then((id) => {
							console.log(`[canonical-sync] Scheduled sync complete: ${id}`);
						});
				})
				.catch((error) => {
					console.error("[canonical-sync] Scheduled sync failed", error);
				}),
		);
		executionCtx.waitUntil(
			// Staleness alarm: the pipeline can degrade silently (upstream returning
			// empty, queue messages dying) while every tick still reports success.
			getSharpMoneyCacheFreshnessStats(env.POLYWHALER_DB, 15 * 60)
				.then((stats) => {
					const newest = stats.newestHistory;
					if (!newest) return;
					const ageMinutes = Math.round((Date.now() / 1000 - newest) / 60);
					if (ageMinutes > 30) {
						console.error(
							`[sharp-pipeline] STALE: newest sharp_money_history row is ${ageMinutes}m old ` +
								`(${stats.total} cached markets, ${stats.staleHistory} stale)`,
						);
					}
				})
				.catch((error) => {
					console.error("[sharp-pipeline] Staleness check failed", error);
				}),
		);
		executionCtx.waitUntil(
			maybeRefreshDailyStatsSnapshot(env.POLYWHALER_DB)
				.then((snapshot) => {
					if (snapshot) {
						console.log(
							`[daily-stats] Refreshed snapshot for ${snapshot.dayKey}`,
						);
					}
				})
				.catch((error) => {
					console.error("[daily-stats] Scheduled snapshot failed", error);
				}),
		);
	},
	async queue(batch: MessageBatch, env: Env, executionCtx: ExecutionContext) {
		await handleSharpQueue(batch, env, executionCtx);
	},
};

export type ServerEntry = typeof serverEntry;

export default serverEntry;

export { SharpPipeline };
