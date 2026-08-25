import {
	createStartHandler,
	defaultStreamHandler,
} from "@tanstack/react-start/server";
import { handleBotRequest } from "./server/api/bot";
import { handleBotControlRequest } from "./server/api/bot-control";
import { handleShadowDigestRequest } from "./server/api/shadow-digest";
import { warmSeriesRegistry } from "./server/api/series-registry";
import { settlePendingManualPicks } from "./server/api/manual-picks";
import type { Env, RequestContext } from "./server/env";
import { captureBookClosesForPicks } from "./server/pipeline/book-odds";
import { captureCloseSignalForPicks } from "./server/pipeline/close-signal";
import { capturePinnacleOddsForPicks } from "./server/pipeline/pinnacle-odds";
import { getCanonicalFreshness } from "./server/pipeline/canonical-sync";
import { backfillManualPicks } from "./server/pipeline/pick-backfill";
import {
	recordEarlyWindowShadows,
	settleShadowCandidates,
} from "./server/pipeline/shadow-book";
import {
	handleSharpQueue,
	SharpPipeline,
	type SharpPipelineJob,
} from "./server/pipeline/sharp-pipeline";
import {
	getCanonicalSyncStub,
	getPipelineStub,
} from "./server/pipeline/sharp-pipeline-utils";
import {
	backfillMissingSnapshots,
	rebuildSnapshotHistoryForTeam,
} from "./server/pipeline/snapshot-computation";
import { settleWalletEntries } from "./server/pipeline/wallet-clv";
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

		const shadowDigestResponse = await handleShadowDigestRequest(request, env);
		if (shadowDigestResponse) {
			return shadowDigestResponse;
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

		// Mutating canonical ops require the bot bearer key. Fails closed if the
		// key is unset. /_pipeline/trigger stays open: the UI calls it from the
		// browser and it only pokes the same DO tick the cron fires every 2 min.
		const requireOpsAuth = (): Response | null => {
			const apiKey = env.BOT_API_KEY;
			const authorization = request.headers.get("Authorization") ?? "";
			const token = authorization.toLowerCase().startsWith("bearer ")
				? authorization.slice(7).trim()
				: null;
			if (!apiKey || !token || token !== apiKey) {
				return new Response(JSON.stringify({ error: "unauthorized" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}
			return null;
		};

		// Trigger manual canonical sync
		if (url.pathname === "/_canonical/trigger" && request.method === "POST") {
			const denied = requireOpsAuth();
			if (denied) return denied;
			try {
				const body = (await request.json().catch(() => ({}))) as {
					skipSeeding?: boolean;
				};
				// Routed through the D1-primary-pinned DO (same path as the cron
				// sync). force bypasses the 5-min cooldown but NOT the advisory
				// lock — the old inline call here took no lock at all and could
				// run concurrently with a scheduled sync.
				const response = await getCanonicalSyncStub(env).fetch(
					"https://sharp-pipeline/canonical-sync",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							force: true,
							skipSeeding: body.skipSeeding,
						}),
					},
				);
				const payload = (await response.json()) as {
					ran: boolean;
					reason?: string;
					runId?: string;
					result?: unknown;
				};
				if (!payload.ran) {
					return new Response(
						JSON.stringify({ success: false, error: payload.reason }),
						{
							status: 409,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				return new Response(
					JSON.stringify({
						success: true,
						runId: payload.runId,
						result: payload.result,
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
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
			const denied = requireOpsAuth();
			if (denied) return denied;
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

		// Rebuild one team's snapshot history from clean facts, each as-of row
		// bounded at its own game time. Repair tool for snapshot corruption
		// (e.g. the 2026-07-22 BAL@BOS duplicate-game incident).
		if (
			url.pathname === "/_canonical/rebuild-team-snapshots" &&
			request.method === "POST"
		) {
			const denied = requireOpsAuth();
			if (denied) return denied;
			try {
				const teamId = url.searchParams.get("teamId");
				const sportTag = url.searchParams.get("sportTag");
				if (!teamId || !sportTag) {
					return new Response(
						JSON.stringify({ error: "teamId and sportTag are required" }),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					);
				}
				const sinceParam = Number(url.searchParams.get("sinceGameTime"));
				const result = await rebuildSnapshotHistoryForTeam(
					env.POLYWHALER_DB,
					teamId,
					sportTag,
					{
						sinceGameTime: Number.isFinite(sinceParam)
							? sinceParam
							: undefined,
					},
				);
				return new Response(JSON.stringify({ success: true, result }), {
					headers: { "Content-Type": "application/json" },
				});
			} catch (error) {
				console.error("[canonical-sync] Rebuild team snapshots error:", error);
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
			const denied = requireOpsAuth();
			if (denied) return denied;
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
				.then(() =>
					// Pinnacle benchmark (no-op without ODDS_API_KEY; ≤1 Odds API
					// fetch per sport per sweep, only when eligible picks exist).
					capturePinnacleOddsForPicks(env.POLYWHALER_DB, env.ODDS_API_KEY),
				)
				.then((result) => {
					if (
						result.anchors > 0 ||
						result.closes > 0 ||
						result.shadowCloses > 0 ||
						result.shadowAnchors > 0
					) {
						console.log(
							`[pinnacle-odds] Captured ${result.anchors} anchors, ${result.closes} closes, ${result.shadowCloses} shadow closes, ${result.shadowAnchors} shadow anchors (${result.checked} eligible; credits ${result.creditsRemaining ?? "n/a"})`,
						);
					}
				})
				.then(() =>
					// Close-signal capture: freeze live signal state ~10 min
					// pre-start for pending picks (record-only; up to 2 picks
					// per tick — the analysis fans out per-wallet fetches, so
					// keep it small inside the shared subrequest budget).
					captureCloseSignalForPicks(env, { limit: 2 }),
				)
				.then((result) => {
					if (result.captured > 0) {
						console.log(
							`[close-signal] Captured close signal for ${result.captured}/${result.checked} picks`,
						);
					}
				})
				.then(() =>
					// Shadow rows stamp sport_tag via the series registry; warm it
					// so a cold cron isolate labels new-season series correctly.
					warmSeriesRegistry(),
				)
				.then(() =>
					// Shadow book: record beyond-window entries (D1-only), then
					// settle gate-rejected candidates through the same resolution
					// path (1-2 Gamma fetches each; sequenced after the pick
					// settle for the same shared-budget reason).
					recordEarlyWindowShadows(env.POLYWHALER_DB),
				)
				.then(() => settleShadowCandidates(env.POLYWHALER_DB, { limit: 10 }))
				.then((result) => {
					if (result.updated > 0) {
						console.log(
							`[shadow-book] Settled ${result.updated}/${result.checked} shadow candidates`,
						);
					}
				})
				.then(() =>
					// Wallet-CLV entries settle from sharp_money_history — D1-only,
					// no external fetches, so it doesn't eat the subrequest budget.
					settleWalletEntries(env.POLYWHALER_DB, { limit: 50 }),
				)
				.then((result) => {
					if (result.updated > 0 || result.voided > 0) {
						console.log(
							`[wallet-clv] Settled ${result.updated}, voided ${result.voided} of ${result.checked} open entries`,
						);
					}
				})
				.then(() =>
					// bot_candidate_snapshots is insert-only; prune >30d rows
					// (indexed on created_at, so this is cheap even per-tick).
					env.POLYWHALER_DB.prepare(
						"DELETE FROM bot_candidate_snapshots WHERE created_at < ?",
					)
						.bind(Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60)
						.run()
						.then(() => {}),
				)
				.catch((error) => {
					console.error("[book-odds] Book close sweep failed", error);
				}),
		);
		executionCtx.waitUntil(
			// The sync executes inside a DO pinned near the D1 primary
			// (getCanonicalSyncStub): cron invocations land in arbitrary colos,
			// and the 2026-08-18→20 regression showed a distant colo turns ~12 s
			// of sync into ~4 min of per-query roundtrips. Cooldown + advisory
			// lock (migration 0033) both live in the DO route; running there
			// also gives the sync its own subrequest budget instead of sharing
			// this invocation's with the settle chain above.
			getCanonicalSyncStub(env)
				.fetch("https://sharp-pipeline/canonical-sync", { method: "POST" })
				.then(async (response) => {
					const payload = (await response.json().catch(() => null)) as {
						ran?: boolean;
						runId?: string;
						durationMs?: number;
					} | null;
					if (payload?.ran) {
						console.log(
							`[canonical-sync] Scheduled sync complete: ${payload.runId} (${payload.durationMs}ms)`,
						);
					}
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
	async queue(
		batch: MessageBatch<SharpPipelineJob>,
		env: Env,
		executionCtx: ExecutionContext,
	) {
		await handleSharpQueue(batch, env, executionCtx);
	},
};

export type ServerEntry = typeof serverEntry;

export default serverEntry;

export { SharpPipeline };
