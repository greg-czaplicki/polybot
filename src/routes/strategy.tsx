import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { AuthGate } from "@/components/auth-gate";
import {
	ContextPerformanceTable,
	type PerformanceBucket,
} from "../components/strategy/context-performance-table";
import { FeatureLegend } from "../components/strategy/feature-legend";
import { StreakPerformanceTable } from "../components/strategy/streak-performance-table";

export const Route = createFileRoute("/strategy")({
	component: StrategyPage,
});

// ---------------------------------------------------------------------------
// Section tabs
// ---------------------------------------------------------------------------

type SectionKey =
	| "venue"
	| "favdog"
	| "trend"
	| "streak"
	| "matchup"
	| "combined"
	| "features";

const SECTION_TABS: { key: SectionKey; label: string }[] = [
	{ key: "venue", label: "Venue" },
	{ key: "favdog", label: "Fav/Dog" },
	{ key: "trend", label: "ATS Trend" },
	{ key: "streak", label: "Streaks" },
	{ key: "matchup", label: "Matchup Edge" },
	{ key: "combined", label: "Combined" },
	{ key: "features", label: "Feature Spec" },
];

// ---------------------------------------------------------------------------
// Types for API responses
// ---------------------------------------------------------------------------

type StrategyAnalysisResult = {
	byVenueRole: PerformanceBucket[];
	byFavDogRole: PerformanceBucket[];
	byAtsTrend: PerformanceBucket[];
	byAtsStreak: PerformanceBucket[];
	byOuStreak: PerformanceBucket[];
	byMatchupEdge: PerformanceBucket[];
	byCombinedContext: PerformanceBucket[];
	totalPicks: number;
	settledPicks: number;
	enrichedPicks: number;
	computedAt: number;
};

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadStrategyAnalysis(): Promise<StrategyAnalysisResult | null> {
	try {
		// Dynamically import to avoid build errors if the API file doesn't exist yet
		const mod = await import("../server/api/strategy-analysis");
		const res = await mod.getStrategyAnalysisFn();
		if (res.error) {
			console.error("[strategy] API error:", res.error);
			return null;
		}
		return res.analysis ?? null;
	} catch (err) {
		console.error("[strategy] Failed to load strategy analysis:", err);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

function StrategyPage() {
	const [activeSection, setActiveSection] = useState<SectionKey>("venue");
	const [analysis, setAnalysis] = useState<StrategyAnalysisResult | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await loadStrategyAnalysis();
			if (result) {
				setAnalysis(result);
			} else {
				setError("No analysis data available. Ensure picks have canonical context enrichment.");
			}
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to load analysis",
			);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	return (
		<AuthGate>
			<div className="min-h-screen bg-slate-950 text-white">
				<div className="mx-auto w-full max-w-6xl px-4 py-10">
					{/* Header */}
					<div className="mb-6 flex flex-wrap items-center justify-between gap-4">
						<div>
							<h1 className="text-2xl font-semibold tracking-tight">
								Strategy Analysis
							</h1>
							<p className="text-sm text-slate-400">
								Pick performance by canonical context — which
								trends and setups actually help?
							</p>
						</div>
						<div className="flex flex-wrap items-center gap-3 text-xs uppercase tracking-[0.2em] text-slate-400">
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
								onClick={refresh}
								disabled={loading}
								className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-[0.6rem] font-semibold uppercase tracking-[0.2em] text-cyan-200 transition-colors hover:bg-cyan-500/20 disabled:opacity-50"
							>
								{loading ? "Loading..." : "Refresh"}
							</button>
						</div>
					</div>

					{/* Summary banner */}
					{analysis && (
						<div className="mb-4 flex flex-wrap items-center gap-4 text-xs uppercase tracking-[0.2em] text-slate-400">
							<span>{analysis.totalPicks} total picks</span>
							<span>{analysis.settledPicks} settled</span>
							<span>{analysis.enrichedPicks} enriched</span>
						</div>
					)}

					{/* Section tabs */}
					<div className="mb-4 flex flex-wrap items-center gap-2">
						{SECTION_TABS.map((tab) => (
							<button
								type="button"
								key={tab.key}
								onClick={() => setActiveSection(tab.key)}
								className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] transition-colors ${
									activeSection === tab.key
										? "bg-cyan-500 text-white"
										: "bg-slate-800/60 text-slate-300 hover:bg-slate-800"
								}`}
							>
								{tab.label}
							</button>
						))}
					</div>

					{/* Error state */}
					{error && !loading && (
						<div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
							{error}
						</div>
					)}

					{/* Content sections */}
					{activeSection === "venue" && (
						<ContextPerformanceTable
							title="Performance by Venue Role"
							data={analysis?.byVenueRole ?? []}
							loading={loading}
						/>
					)}

					{activeSection === "favdog" && (
						<ContextPerformanceTable
							title="Performance by Fav/Dog Role"
							data={analysis?.byFavDogRole ?? []}
							loading={loading}
						/>
					)}

					{activeSection === "trend" && (
						<ContextPerformanceTable
							title="Performance by ATS Trend Bucket"
							data={analysis?.byAtsTrend ?? []}
							loading={loading}
						/>
					)}

					{activeSection === "streak" && (
						<div className="space-y-4">
							<StreakPerformanceTable
								title="Performance by ATS Streak"
								data={analysis?.byAtsStreak ?? []}
								loading={loading}
							/>
							<StreakPerformanceTable
								title="Performance by O/U Streak"
								data={analysis?.byOuStreak ?? []}
								loading={loading}
							/>
						</div>
					)}

					{activeSection === "matchup" && (
						<ContextPerformanceTable
							title="Performance by Matchup Edge (ATS Delta)"
							data={analysis?.byMatchupEdge ?? []}
							loading={loading}
						/>
					)}

					{activeSection === "combined" && (
						<ContextPerformanceTable
							title="Performance by Combined Context"
							data={analysis?.byCombinedContext ?? []}
							loading={loading}
						/>
					)}

					{activeSection === "features" && <FeatureLegend />}
				</div>
			</div>
		</AuthGate>
	);
}
