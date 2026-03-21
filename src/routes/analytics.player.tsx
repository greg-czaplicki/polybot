import { createFileRoute } from "@tanstack/react-router";
import { Loader2, Search } from "lucide-react";
import { useEffect, useState } from "react";

import {
	fetchPlayerAnalyticsFn,
	type PlayerFeatureSnapshot,
	type PlayerSummary,
} from "../server/api/analytics";

export const Route = createFileRoute("/analytics/player")({
	component: PlayerAnalyticsPage,
});

/**
 * Player analytics dashboard.
 *
 * Displays player feature snapshots from the warehouse with optional
 * filtering by condition ID. Shows per-wallet aggregated summaries and
 * a detail table of individual snapshots.
 */
function PlayerAnalyticsPage() {
	const [summaries, setSummaries] = useState<PlayerSummary[]>([]);
	const [snapshots, setSnapshots] = useState<PlayerFeatureSnapshot[]>([]);
	const [loading, setLoading] = useState(true);
	const [filterConditionId, setFilterConditionId] = useState("");
	const [appliedFilter, setAppliedFilter] = useState("");

	const loadData = async (conditionId?: string) => {
		setLoading(true);
		try {
			const result = await fetchPlayerAnalyticsFn({
				data: {
					conditionId: conditionId || undefined,
					limit: 200,
				},
			});
			setSummaries(result.summaries ?? []);
			setSnapshots(result.snapshots ?? []);
		} catch (err) {
			console.error("Failed to load player analytics:", err);
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		void loadData();
	}, []);

	const handleFilter = () => {
		setAppliedFilter(filterConditionId);
		void loadData(filterConditionId);
	};

	const handleClearFilter = () => {
		setFilterConditionId("");
		setAppliedFilter("");
		void loadData();
	};

	return (
		<div className="space-y-6">
			{/* Filter */}
			<div className="flex gap-2">
				<div className="relative flex-1">
					<Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
					<input
						type="text"
						placeholder="Filter by condition ID…"
						value={filterConditionId}
						onChange={(e) => setFilterConditionId(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && handleFilter()}
						className="w-full rounded-lg border border-slate-700 bg-slate-800/60 py-2 pl-10 pr-4 text-sm text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
					/>
				</div>
				<button
					type="button"
					onClick={handleFilter}
					className="rounded-lg border border-slate-700 bg-slate-800/60 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-700/60"
				>
					Filter
				</button>
				{appliedFilter && (
					<button
						type="button"
						onClick={handleClearFilter}
						className="rounded-lg border border-slate-700 bg-slate-800/60 px-4 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-slate-700/60"
					>
						Clear
					</button>
				)}
			</div>

			{loading ? (
				<div className="flex items-center justify-center py-16">
					<Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
				</div>
			) : summaries.length === 0 ? (
				<div className="rounded-xl border border-slate-800 bg-slate-900/60 p-8 text-center text-slate-400">
					No player snapshots found.{" "}
					{appliedFilter
						? "Try a different condition ID."
						: "Run feature generation to populate data."}
				</div>
			) : (
				<>
					{/* Wallet summaries */}
					<section className="rounded-xl border border-slate-800 bg-slate-900/60">
						<div className="border-b border-slate-800 px-4 py-3">
							<h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
								Player Summaries ({summaries.length})
							</h2>
						</div>
						<div className="overflow-x-auto">
							<table className="w-full text-sm">
								<thead>
									<tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wider text-slate-500">
										<th className="px-4 py-3">Wallet</th>
										<th className="px-4 py-3 text-right">Position Value</th>
										<th className="px-4 py-3 text-right">PnL (Day)</th>
										<th className="px-4 py-3 text-right">PnL (Week)</th>
										<th className="px-4 py-3 text-right">PnL (Month)</th>
										<th className="px-4 py-3 text-right">PnL (All)</th>
										<th className="px-4 py-3 text-right">Momentum</th>
										<th className="px-4 py-3 text-right">Markets</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-slate-800/60">
									{summaries.map((s) => (
										<tr key={s.wallet_address} className="hover:bg-slate-800/30">
											<td className="px-4 py-3 font-mono text-xs text-slate-300">
												{truncateAddress(s.wallet_address)}
											</td>
											<td className="px-4 py-3 text-right text-white">
												{formatUsd(s.total_position_value)}
											</td>
											<td className={`px-4 py-3 text-right ${pnlColor(s.avg_pnl_day)}`}>
												{formatPct(s.avg_pnl_day)}
											</td>
											<td className={`px-4 py-3 text-right ${pnlColor(s.avg_pnl_week)}`}>
												{formatPct(s.avg_pnl_week)}
											</td>
											<td className={`px-4 py-3 text-right ${pnlColor(s.avg_pnl_month)}`}>
												{formatPct(s.avg_pnl_month)}
											</td>
											<td className={`px-4 py-3 text-right ${pnlColor(s.avg_pnl_all)}`}>
												{formatPct(s.avg_pnl_all)}
											</td>
											<td className="px-4 py-3 text-right text-slate-300">
												{s.avg_momentum_weight != null
													? s.avg_momentum_weight.toFixed(2)
													: "—"}
											</td>
											<td className="px-4 py-3 text-right text-slate-300">
												{s.market_count}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</section>

					{/* Raw snapshots */}
					<section className="rounded-xl border border-slate-800 bg-slate-900/60">
						<div className="border-b border-slate-800 px-4 py-3">
							<h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
								Recent Snapshots ({snapshots.length})
							</h2>
						</div>
						<div className="overflow-x-auto">
							<table className="w-full text-sm">
								<thead>
									<tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wider text-slate-500">
										<th className="px-4 py-3">Wallet</th>
										<th className="px-4 py-3">Condition</th>
										<th className="px-4 py-3 text-right">Position</th>
										<th className="px-4 py-3 text-right">PnL All</th>
										<th className="px-4 py-3 text-right">Stake Units</th>
										<th className="px-4 py-3 text-right">Computed</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-slate-800/60">
									{snapshots.slice(0, 50).map((s) => (
										<tr key={s.id} className="hover:bg-slate-800/30">
											<td className="px-4 py-3 font-mono text-xs text-slate-300">
												{truncateAddress(s.wallet_address)}
											</td>
											<td className="px-4 py-3 font-mono text-xs text-slate-400">
												{s.condition_id.slice(0, 12)}…
											</td>
											<td className="px-4 py-3 text-right text-white">
												{formatUsd(s.position_value)}
											</td>
											<td className={`px-4 py-3 text-right ${pnlColor(s.pnl_all)}`}>
												{formatPct(s.pnl_all)}
											</td>
											<td className="px-4 py-3 text-right text-slate-300">
												{s.stake_units?.toFixed(1) ?? "—"}
											</td>
											<td className="px-4 py-3 text-right text-slate-500 text-xs">
												{formatTimestamp(s.computed_at)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</section>
				</>
			)}
		</div>
	);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function truncateAddress(addr: string): string {
	if (addr.length <= 12) return addr;
	return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatUsd(value: number): string {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 0,
	}).format(value);
}

function formatPct(value: number): string {
	return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

function pnlColor(value: number): string {
	if (value > 0) return "text-emerald-400";
	if (value < 0) return "text-red-400";
	return "text-slate-400";
}

function formatTimestamp(ts: number): string {
	return new Date(ts * 1000).toLocaleString();
}
