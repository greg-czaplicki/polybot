import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { AuthGate } from "@/components/auth-gate";
import { listManualPicksFn } from "../server/api/manual-picks";
import type { ManualPickEntry } from "../server/repositories/manual-picks";

export const Route = createFileRoute("/stats")({
	component: StatsPage,
});

function formatRelativeTime(timestamp: number): string {
	const now = Math.floor(Date.now() / 1000);
	const diff = now - timestamp;

	if (diff < 60) return "Just now";
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	return `${Math.floor(diff / 86400)}d ago`;
}

function StatsPage() {
	const [settledPicks, setSettledPicks] = useState<ManualPickEntry[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [windowFilter, setWindowFilter] = useState<
		"day" | "week" | "month" | "all"
	>("week");

	useEffect(() => {
		let cancelled = false;
		const load = async () => {
			setIsLoading(true);
			try {
			const result = await listManualPicksFn({ data: { limit: 500 } });
				if (cancelled) return;
				const settled = (result.picks ?? []).filter(
					(pick) => pick.status !== "pending",
				);
				setSettledPicks(settled);
			} catch (error) {
				console.error("Failed to load settled picks:", error);
			} finally {
				if (!cancelled) {
					setIsLoading(false);
				}
			}
		};
		void load();
		return () => {
			cancelled = true;
		};
	}, []);

	const filteredPicks = useMemo(() => {
		if (windowFilter === "all") return settledPicks;
		const now = Date.now();
		let cutoff = now;
		if (windowFilter === "day") {
			cutoff = now - 24 * 60 * 60 * 1000;
		} else if (windowFilter === "week") {
			cutoff = now - 7 * 24 * 60 * 60 * 1000;
		} else if (windowFilter === "month") {
			const date = new Date(now);
			date.setMonth(date.getMonth() - 1);
			cutoff = date.getTime();
		}
		const cutoffSeconds = Math.floor(cutoff / 1000);
		return settledPicks.filter((pick) => pick.pickedAt >= cutoffSeconds);
	}, [settledPicks, windowFilter]);

	const stats = useMemo(() => {
		if (filteredPicks.length === 0) {
			return { total: 0, wins: 0, losses: 0, pushes: 0, winRate: 0 };
		}
		const wins = filteredPicks.filter((pick) => pick.status === "win").length;
		const losses = filteredPicks.filter((pick) => pick.status === "loss").length;
		const pushes = filteredPicks.filter((pick) => pick.status === "push").length;
		const total = filteredPicks.length;
		const denom = wins + losses;
		const winRate = denom > 0 ? Math.round((wins / denom) * 100) : 0;
		return { total, wins, losses, pushes, winRate };
	}, [filteredPicks]);

	return (
		<AuthGate>
			<div className="min-h-screen bg-slate-950 text-white">
				<div className="mx-auto w-full max-w-6xl px-4 py-10">
					<div className="mb-6 flex flex-wrap items-center justify-between gap-4">
						<div>
							<h1 className="text-2xl font-semibold tracking-tight">
								Pick Stats
							</h1>
							<p className="text-sm text-slate-400">
								Manual settled picks (win/loss/push).
							</p>
						</div>
						<div className="flex flex-wrap items-center gap-3 text-xs uppercase tracking-[0.2em] text-slate-400">
							<span>{stats.total} total</span>
							<span className="text-emerald-300">{stats.wins} W</span>
							<span className="text-red-300">{stats.losses} L</span>
							<span className="text-slate-300">{stats.pushes} P</span>
							<span>Win% {stats.winRate}</span>
						</div>
					</div>

					<div className="mb-4 flex flex-wrap items-center gap-2">
						{[
							{ key: "day", label: "Daily" },
							{ key: "week", label: "Weekly" },
							{ key: "month", label: "Monthly" },
							{ key: "all", label: "All-time" },
						].map((option) => (
							<button
								type="button"
								key={option.key}
								onClick={() =>
									setWindowFilter(option.key as typeof windowFilter)
								}
								className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] transition-colors ${
									windowFilter === option.key
										? "bg-cyan-500 text-white"
										: "bg-slate-800/60 text-slate-300 hover:bg-slate-800"
								}`}
							>
								{option.label}
							</button>
						))}
					</div>

					<div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
						{isLoading && (
							<div className="text-sm text-slate-400">Loading...</div>
						)}
						{!isLoading && filteredPicks.length === 0 && (
							<div className="text-sm text-slate-400">
								No settled picks yet.
							</div>
						)}
						<div className="space-y-2">
							{filteredPicks.map((pick) => (
								<div
									key={pick.id}
									className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800/70 bg-slate-950/40 px-3 py-2"
								>
									<div className="min-w-0">
										<div className="truncate text-sm font-semibold text-slate-100">
											{pick.marketTitle}
										</div>
										<div className="text-[0.65rem] text-slate-400">
											{pick.grade ?? "—"} · {pick.signalScore?.toFixed(1) ?? "—"} · {formatRelativeTime(pick.pickedAt)}
										</div>
									</div>
									<div className="flex items-center gap-2">
										{pick.settledAt && (
											<span className="text-[0.65rem] text-slate-500">
												Settled {formatRelativeTime(pick.settledAt)}
											</span>
										)}
										<span
											className={`rounded border px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide ${
												pick.status === "win"
													? "border-emerald-500/40 bg-emerald-500/15 text-emerald-200"
													: pick.status === "loss"
														? "border-red-500/40 bg-red-500/15 text-red-200"
														: "border-slate-500/40 bg-slate-700/30 text-slate-200"
											}`}
										>
											{pick.status}
										</span>
									</div>
								</div>
							))}
						</div>
					</div>
				</div>
			</div>
		</AuthGate>
	);
}
