import { createFileRoute, Link, Outlet, useMatchRoute } from "@tanstack/react-router";
import { BarChart3, Loader2, TrendingUp, Users } from "lucide-react";
import { useEffect, useState } from "react";

import { AuthGate } from "@/components/auth-gate";
import {
	fetchWarehouseSummaryFn,
	type WarehouseSummary,
} from "../server/api/analytics";

export const Route = createFileRoute("/analytics")({
	component: AnalyticsLayout,
});

const TABS = [
	{ to: "/analytics/player", label: "Player", icon: Users },
	{ to: "/analytics/event", label: "Event", icon: BarChart3 },
	{ to: "/analytics/market", label: "Market", icon: TrendingUp },
] as const;

/**
 * Layout route for /analytics.
 *
 * Renders navigation tabs (Player | Event | Market), a warehouse health
 * summary bar, and the active child route via <Outlet />.
 */
function AnalyticsLayout() {
	const [summary, setSummary] = useState<WarehouseSummary | null>(null);
	const [loading, setLoading] = useState(true);
	const matchRoute = useMatchRoute();

	useEffect(() => {
		let cancelled = false;
		const load = async () => {
			try {
				const result = await fetchWarehouseSummaryFn();
				if (!cancelled) setSummary(result);
			} catch (err) {
				console.error("Failed to load warehouse summary:", err);
			} finally {
				if (!cancelled) setLoading(false);
			}
		};
		void load();
		return () => { cancelled = true; };
	}, []);

	return (
		<AuthGate>
			<div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-white">
				<div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
					{/* Header */}
					<header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
						<div>
							<h1 className="text-2xl font-bold tracking-tight text-white">
								Warehouse Analytics
							</h1>
							<p className="mt-1 text-sm text-slate-400">
								Player, event, and market insights from warehouse data.
							</p>
						</div>
						<a
							href="/sharp"
							className="inline-flex items-center justify-center rounded-lg border border-slate-700/60 bg-slate-900/60 px-3 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-200 transition-colors hover:bg-slate-800/60"
						>
							Back to Sharp
						</a>
					</header>

					{/* Warehouse summary bar */}
					<div className="mb-6 grid grid-cols-3 gap-3">
						<SummaryCard
							label="Player Snapshots"
							count={summary?.player_feature_snapshots_count}
							loading={loading}
						/>
						<SummaryCard
							label="Market Snapshots"
							count={summary?.market_feature_snapshots_count}
							loading={loading}
						/>
						<SummaryCard
							label="Matchup Labels"
							count={summary?.historical_matchup_labels_count}
							loading={loading}
						/>
					</div>

					{/* Tab navigation */}
					<nav className="mb-6 flex gap-1 rounded-xl border border-slate-800 bg-slate-900/60 p-1">
						{TABS.map(({ to, label, icon: Icon }) => {
							const isActive = matchRoute({ to });
							return (
								<Link
									key={to}
									to={to}
									className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${
										isActive
											? "bg-cyan-500/10 text-cyan-400 shadow-sm"
											: "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
									}`}
								>
									<Icon className="h-4 w-4" />
									{label}
								</Link>
							);
						})}
					</nav>

					{/* Child route */}
					<Outlet />
				</div>
			</div>
		</AuthGate>
	);
}

/** Small card displaying a single warehouse table count. */
function SummaryCard({
	label,
	count,
	loading,
}: {
	label: string;
	count: number | undefined;
	loading: boolean;
}) {
	return (
		<div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-center">
			<p className="text-xs font-medium uppercase tracking-wider text-slate-500">
				{label}
			</p>
			{loading ? (
				<Loader2 className="mx-auto mt-2 h-5 w-5 animate-spin text-slate-500" />
			) : (
				<p className="mt-1 text-2xl font-bold text-white">
					{(count ?? 0).toLocaleString()}
				</p>
			)}
		</div>
	);
}
