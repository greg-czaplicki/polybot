import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { AuthGate } from "@/components/auth-gate";
import { RankedOpportunityTable } from "../components/opportunities/ranked-opportunity-table";
import { getRankedOpportunitiesFn } from "../server/api/opportunity-ranking";
import type { RankedOpportunity } from "../server/repositories/opportunity-ranking";

export const Route = createFileRoute("/opportunities")({
	component: OpportunitiesPage,
});

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

function OpportunitiesPage() {
	const [opportunities, setOpportunities] = useState<RankedOpportunity[]>([]);
	const [summary, setSummary] = useState<{
		computedAt: number;
		totalCandidates: number;
		scoredCount: number;
		excludedCount: number;
	} | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const loadRankings = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const { ranking } = await getRankedOpportunitiesFn();
			setOpportunities(ranking.opportunities);
			setSummary({
				computedAt: ranking.computedAt,
				totalCandidates: ranking.totalCandidates,
				scoredCount: ranking.scoredCount,
				excludedCount: ranking.excludedCount,
			});
		} catch (err) {
			console.error("[opportunities] Failed to load rankings:", err);
			setError(err instanceof Error ? err.message : "Failed to load rankings");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadRankings();
	}, [loadRankings]);

	return (
		<AuthGate>
			<div className="min-h-screen bg-slate-950 text-white">
				<div className="mx-auto w-full max-w-6xl px-4 py-10">
					{/* Header */}
					<div className="mb-6 flex flex-wrap items-center justify-between gap-4">
						<div>
							<h1 className="text-2xl font-semibold tracking-tight">
								Opportunity Rankings
							</h1>
							<p className="text-sm text-slate-400">
								Upcoming picks scored by pre-pick canonical context — strongest
								opportunities ranked first.
							</p>
						</div>
						<div className="flex flex-wrap items-center gap-3 text-xs uppercase tracking-[0.2em] text-slate-400">
							<a
								href="/strategy"
								className="rounded-lg border border-slate-700/60 bg-slate-900/60 px-3 py-2 text-[0.6rem] font-semibold uppercase tracking-[0.2em] text-slate-200 transition-colors hover:bg-slate-800/60"
							>
								Strategy
							</a>
							<a
								href="/stats"
								className="rounded-lg border border-slate-700/60 bg-slate-900/60 px-3 py-2 text-[0.6rem] font-semibold uppercase tracking-[0.2em] text-slate-200 transition-colors hover:bg-slate-800/60"
							>
								Stats
							</a>
							<a
								href="/runtime"
								className="rounded-lg border border-slate-700/60 bg-slate-900/60 px-3 py-2 text-[0.6rem] font-semibold uppercase tracking-[0.2em] text-slate-200 transition-colors hover:bg-slate-800/60"
							>
								Runtime
							</a>
							<button
								type="button"
								onClick={() => void loadRankings()}
								disabled={loading}
								className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-[0.6rem] font-semibold uppercase tracking-[0.2em] text-cyan-200 transition-colors hover:bg-cyan-500/20 disabled:opacity-50"
							>
								{loading ? "Scoring..." : "Refresh"}
							</button>
						</div>
					</div>

					{/* Summary banner */}
					{summary && (
						<div className="mb-4 flex flex-wrap items-center gap-4 text-xs uppercase tracking-[0.2em] text-slate-400">
							<span>{summary.totalCandidates} candidates</span>
							<span>{summary.scoredCount} scored</span>
							{summary.excludedCount > 0 && (
								<span className="text-amber-400/70">
									{summary.excludedCount} excluded (missing context)
								</span>
							)}
						</div>
					)}

					{/* Error state */}
					{error && !loading && (
						<div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
							{error}
						</div>
					)}

					{/* Ranked table */}
					<RankedOpportunityTable data={opportunities} loading={loading} />
				</div>
			</div>
		</AuthGate>
	);
}
