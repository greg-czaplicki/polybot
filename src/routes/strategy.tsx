import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { AuthGate } from "@/components/auth-gate";
import {
	ContextPerformanceTable,
	type PerformanceBucket,
} from "../components/strategy/context-performance-table";
import { FeatureLegend } from "../components/strategy/feature-legend";
import { StreakPerformanceTable } from "../components/strategy/streak-performance-table";
import {
	getStrategyContextPerformanceFn,
	getStrategyMatchupEdgePerformanceFn,
	getStrategyStreakPerformanceFn,
	getStrategyTrendPerformanceFn,
	getStrategyVenueRolePerformanceFn,
} from "../server/api/strategy-analysis";
import type { StrategyBucketRow } from "../server/repositories/strategy-analysis";

export const Route = createFileRoute("/strategy")({
	component: StrategyPage,
});

// ---------------------------------------------------------------------------
// Section tabs
// ---------------------------------------------------------------------------

type SectionKey =
	| "venue"
	| "trend"
	| "streak"
	| "matchup"
	| "combined"
	| "features";

const SECTION_TABS: { key: SectionKey; label: string }[] = [
	{ key: "venue", label: "Venue / Role" },
	{ key: "trend", label: "ATS Trend" },
	{ key: "streak", label: "Streaks" },
	{ key: "matchup", label: "Matchup Edge" },
	{ key: "combined", label: "Combined" },
	{ key: "features", label: "Feature Spec" },
];

// ---------------------------------------------------------------------------
// Adapter: API bucket → UI bucket
// ---------------------------------------------------------------------------

function toBuckets(rows: StrategyBucketRow[]): PerformanceBucket[] {
	return rows.map((r) => ({
		bucket: r.bucket,
		picks: r.picks,
		wins: r.wins,
		losses: r.losses,
		pushes: r.pushes,
		winRate: r.winRate,
		avgRoi: r.avgRoi,
	}));
}

// ---------------------------------------------------------------------------
// Section state
// ---------------------------------------------------------------------------

type SectionData = {
	buckets: PerformanceBucket[];
	settledPicks: number;
	enrichedPicks: number;
};

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

function StrategyPage() {
	const [activeSection, setActiveSection] = useState<SectionKey>("venue");
	const [sectionData, setSectionData] = useState<SectionData | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const loadSection = useCallback(async (section: SectionKey) => {
		if (section === "features") return; // No data loading needed
		setLoading(true);
		setError(null);
		try {
			let result: { analysis: { buckets: StrategyBucketRow[]; settledPicks: number; enrichedPicks: number } };

			switch (section) {
				case "venue":
					result = await getStrategyVenueRolePerformanceFn();
					break;
				case "trend":
					result = await getStrategyTrendPerformanceFn();
					break;
				case "streak":
					result = await getStrategyStreakPerformanceFn();
					break;
				case "matchup":
					result = await getStrategyMatchupEdgePerformanceFn();
					break;
				case "combined":
					result = await getStrategyContextPerformanceFn();
					break;
			}

			setSectionData({
				buckets: toBuckets(result.analysis.buckets),
				settledPicks: result.analysis.settledPicks,
				enrichedPicks: result.analysis.enrichedPicks,
			});
		} catch (err) {
			console.error(`[strategy] Failed to load ${section}:`, err);
			setError(
				err instanceof Error ? err.message : "Failed to load analysis",
			);
		} finally {
			setLoading(false);
		}
	}, []);

	// Load data when section changes
	useEffect(() => {
		void loadSection(activeSection);
	}, [activeSection, loadSection]);

	const handleTabClick = (key: SectionKey) => {
		setSectionData(null);
		setActiveSection(key);
	};

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
								onClick={() => loadSection(activeSection)}
								disabled={loading}
								className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-[0.6rem] font-semibold uppercase tracking-[0.2em] text-cyan-200 transition-colors hover:bg-cyan-500/20 disabled:opacity-50"
							>
								{loading ? "Loading..." : "Refresh"}
							</button>
						</div>
					</div>

					{/* Summary banner */}
					{sectionData && (
						<div className="mb-4 flex flex-wrap items-center gap-4 text-xs uppercase tracking-[0.2em] text-slate-400">
							<span>{sectionData.settledPicks} settled picks</span>
							<span>{sectionData.enrichedPicks} with trend data</span>
						</div>
					)}

					{/* Section tabs */}
					<div className="mb-4 flex flex-wrap items-center gap-2">
						{SECTION_TABS.map((tab) => (
							<button
								type="button"
								key={tab.key}
								onClick={() => handleTabClick(tab.key)}
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
							title="Performance by Venue + Fav/Dog Role"
							data={sectionData?.buckets ?? []}
							loading={loading}
						/>
					)}

					{activeSection === "trend" && (
						<ContextPerformanceTable
							title="Performance by ATS Trend Bucket"
							data={sectionData?.buckets ?? []}
							loading={loading}
						/>
					)}

					{activeSection === "streak" && (
						<StreakPerformanceTable
							title="Performance by ATS Streak"
							data={sectionData?.buckets ?? []}
							loading={loading}
						/>
					)}

					{activeSection === "matchup" && (
						<ContextPerformanceTable
							title="Performance by Matchup Edge (ATS Delta)"
							data={sectionData?.buckets ?? []}
							loading={loading}
						/>
					)}

					{activeSection === "combined" && (
						<ContextPerformanceTable
							title="Performance by Combined Context (venue|trend|streak)"
							data={sectionData?.buckets ?? []}
							loading={loading}
						/>
					)}

					{activeSection === "features" && <FeatureLegend />}
				</div>
			</div>
		</AuthGate>
	);
}
