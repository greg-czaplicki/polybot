import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { Panel, Workspace } from "@/components/terminal/panel";
import { Shell, ShellButton } from "@/components/terminal/shell";
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
			let result: {
				analysis: {
					buckets: StrategyBucketRow[];
					settledPicks: number;
					enrichedPicks: number;
				};
			};

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
			setError(err instanceof Error ? err.message : "Failed to load analysis");
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
		<Shell
			wide
			actions={
				<ShellButton
					onClick={() => loadSection(activeSection)}
					disabled={loading}
				>
					{loading ? "…" : "Refresh"}
				</ShellButton>
			}
		>
			{/* Tabs + summary on one bar */}
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-ink-05 px-3 py-1.5">
				<span className="mr-1 font-mono text-xxs font-semibold uppercase tracking-[0.18em] text-ink-55">
					Strategy context
				</span>
				<div className="flex flex-wrap items-center gap-0.5">
					{SECTION_TABS.map((tab) => (
						<button
							type="button"
							key={tab.key}
							onClick={() => handleTabClick(tab.key)}
							className={`h-7 border-b-2 px-2.5 font-mono text-xxs font-semibold uppercase tracking-[0.15em] transition-colors ${
								activeSection === tab.key
									? "border-brand-blue text-ink-95"
									: "border-transparent text-ink-55 hover:text-ink-85"
							}`}
						>
							{tab.label}
						</button>
					))}
				</div>
				{sectionData && (
					<span className="ml-auto font-mono text-xxs tabular-nums text-ink-40">
						{sectionData.settledPicks} settled · {sectionData.enrichedPicks}{" "}
						with trend data
					</span>
				)}
			</div>

			{error && !loading && (
				<div className="border-t border-ink-15 bg-signal-bad/10 px-3 py-2 text-sm text-signal-bad">
					{error}
				</div>
			)}

			<Workspace>
				<Panel
					title={
						SECTION_TABS.find((t) => t.key === activeSection)?.label ??
						"Context"
					}
					span={12}
					meta="pick performance by canonical context"
					bodyClassName="p-3"
				>
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
				</Panel>
			</Workspace>
		</Shell>
	);
}
