import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { AuthGate } from "@/components/auth-gate";
import { MatchupCard } from "@/components/canonical/matchup-card";
import { PickContextPanel } from "@/components/canonical/pick-context-panel";
import { TeamTrendCard } from "@/components/canonical/team-trend-card";
import {
	clearManualPicksFn,
	listManualPicksFn,
} from "../server/api/manual-picks";
import type { ManualPickEntry } from "../server/repositories/manual-picks";

export const Route = createFileRoute("/stats")({
	component: StatsPage,
});

function formatRelativeTime(timestamp: number): string {
	const now = Math.floor(Date.now() / 1000);
	const diff = now - timestamp;

	if (diff < 60) return "just now";
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	return `${Math.floor(diff / 86400)}d ago`;
}

type WindowKey = "day" | "week" | "month" | "all";

const WINDOW_OPTIONS: { key: WindowKey; label: string }[] = [
	{ key: "day", label: "Daily" },
	{ key: "week", label: "Weekly" },
	{ key: "month", label: "Monthly" },
	{ key: "all", label: "All-time" },
];

function statusLabelTone(status: ManualPickEntry["status"]): string {
	switch (status) {
		case "win":
			return "bg-signal-pos/10 text-signal-pos ring-signal-pos/35";
		case "loss":
			return "bg-signal-bad/10 text-signal-bad ring-signal-bad/35";
		case "push":
			return "bg-ink-10 text-ink-70 ring-ink-25";
		default:
			return "bg-ink-10 text-ink-55 ring-ink-25";
	}
}

function StatsPage() {
	const [settledPicks, setSettledPicks] = useState<ManualPickEntry[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [isClearing, setIsClearing] = useState(false);
	const [windowFilter, setWindowFilter] = useState<WindowKey>("week");

	useEffect(() => {
		let cancelled = false;
		const load = async () => {
			setIsLoading(true);
			try {
				const result = await listManualPicksFn({ data: { limit: 500 } });
				if (cancelled) return;
				setSettledPicks(result.picks ?? []);
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

	const handleClear = async () => {
		if (isClearing) return;
		if (!confirm("Clear all picks? This cannot be undone.")) return;
		setIsClearing(true);
		try {
			await clearManualPicksFn();
			setSettledPicks([]);
		} catch (error) {
			console.error("Failed to clear picks:", error);
		} finally {
			setIsClearing(false);
		}
	};

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
		const counts = { win: 0, loss: 0, push: 0, pending: 0 };
		for (const pick of filteredPicks) {
			counts[pick.status] = (counts[pick.status] ?? 0) + 1;
		}
		const total = filteredPicks.length;
		const denom = counts.win + counts.loss;
		const winRate = denom > 0 ? Math.round((counts.win / denom) * 100) : 0;
		return { total, ...counts, winRate };
	}, [filteredPicks]);

	const statsByGrade = useMemo(() => {
		const rows: Record<
			string,
			{
				grade: "A+" | "A" | "B";
				total: number;
				win: number;
				loss: number;
				push: number;
				pending: number;
			}
		> = {
			"A+": {
				grade: "A+",
				total: 0,
				win: 0,
				loss: 0,
				push: 0,
				pending: 0,
			},
			A: { grade: "A", total: 0, win: 0, loss: 0, push: 0, pending: 0 },
			B: { grade: "B", total: 0, win: 0, loss: 0, push: 0, pending: 0 },
		};
		for (const pick of filteredPicks) {
			const row = pick.grade ? rows[pick.grade] : undefined;
			if (!row) continue;
			row.total += 1;
			row[pick.status] += 1;
		}
		return (["A+", "A", "B"] as const).map((g) => {
			const r = rows[g];
			const denom = r.win + r.loss;
			const winRate = denom > 0 ? Math.round((r.win / denom) * 100) : 0;
			return { ...r, winRate };
		});
	}, [filteredPicks]);

	return (
		<AuthGate>
			<div className="min-h-screen bg-ink-00 text-ink-85">
				<div className="mx-auto w-full max-w-6xl px-4 py-10">
					{/* Page header — title + summary metrics, actions demoted */}
					<div className="mb-6 flex flex-col gap-4">
						<div className="flex flex-wrap items-start justify-between gap-4">
							<div>
								<h1 className="font-sans text-2xl font-semibold tracking-tight text-ink-95">
									Pick Stats
								</h1>
								<p className="mt-0.5 font-sans text-sm text-ink-70">
									Manual and bot picks (pending + settled).
								</p>
							</div>
							<div className="flex items-center gap-2">
								<a
									href="/sharp"
									className="inline-flex h-8 items-center rounded-md px-3 font-mono text-xxs font-semibold uppercase tracking-wider text-ink-85 ring-1 ring-inset ring-ink-25 transition-colors hover:bg-ink-15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
								>
									Back to Sharp
								</a>
								<button
									type="button"
									onClick={handleClear}
									disabled={isClearing}
									aria-label="Clear all picks"
									className="inline-flex h-8 items-center rounded-md px-3 font-mono text-xxs font-semibold uppercase tracking-wider text-ink-55 transition-colors hover:bg-signal-bad/10 hover:text-signal-bad focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue disabled:opacity-40"
								>
									{isClearing ? "clearing…" : "clear picks"}
								</button>
							</div>
						</div>

						{/* Stats strip — tab-num, separate from actions */}
						<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-xs tabular-nums">
							<StatPair label="total" value={stats.total} />
							<StatPair label="W" value={stats.win} tone="pos" />
							<StatPair label="L" value={stats.loss} tone="bad" />
							<StatPair label="P" value={stats.push} />
							<StatPair label="pending" value={stats.pending} muted />
							<StatPair
								label="win%"
								value={stats.winRate}
								tone={stats.winRate >= 55 ? "pos" : undefined}
							/>
						</div>
					</div>

					{/* Window filter pills */}
					<div
						className="mb-4 flex flex-wrap items-center gap-2"
						role="tablist"
						aria-label="Time window"
					>
						{WINDOW_OPTIONS.map((option) => (
							<button
								type="button"
								key={option.key}
								onClick={() => setWindowFilter(option.key)}
								aria-selected={windowFilter === option.key}
								role="tab"
								className={`inline-flex h-9 items-center rounded-full px-4 font-mono text-xxs font-semibold uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue ${
									windowFilter === option.key
										? "bg-brand-blue text-ink-00"
										: "bg-ink-10 text-ink-70 hover:bg-ink-15 hover:text-ink-95"
								}`}
							>
								{option.label}
							</button>
						))}
					</div>

					{/* Pick list */}
					<section
						aria-labelledby="pick-list-heading"
						className="rounded-md bg-ink-05 p-4 ring-1 ring-inset ring-ink-15"
					>
						<h2 id="pick-list-heading" className="sr-only">
							Picks
						</h2>
						{isLoading && (
							<div className="font-mono text-sm text-ink-55">loading…</div>
						)}
						{!isLoading && filteredPicks.length === 0 && (
							<div className="font-mono text-sm text-ink-55">no picks yet.</div>
						)}
						<ul className="space-y-2">
							{filteredPicks.map((pick) => (
								<PickRow key={pick.id} pick={pick} />
							))}
						</ul>
					</section>

					{/* Win rate by grade */}
					<section
						aria-labelledby="grade-stats-heading"
						className="mt-6 rounded-md bg-ink-05 p-4 ring-1 ring-inset ring-ink-15"
					>
						<h2
							id="grade-stats-heading"
							className="mb-3 font-mono text-xxs font-semibold uppercase tracking-[0.2em] text-ink-55"
						>
							Win Rate by Grade
						</h2>
						<div className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
							{statsByGrade.map((row) => (
								<div key={row.grade} className="min-w-0">
									<div className="flex items-baseline justify-between gap-2">
										<span className="font-sans text-base font-semibold text-ink-95">
											{row.grade}
										</span>
										<span className="font-mono text-xxs tabular-nums text-ink-55">
											{row.total} picks
										</span>
									</div>
									<div className="mt-1 flex items-baseline gap-3 font-mono text-xs tabular-nums">
										<span className="text-signal-pos">{row.win}W</span>
										<span className="text-signal-bad">{row.loss}L</span>
										<span className="text-ink-55">{row.push}P</span>
									</div>
									<div className="mt-1.5 flex items-baseline gap-2 font-mono tabular-nums">
										<span className="text-xxs uppercase tracking-wider text-ink-55">
											win%
										</span>
										<span
											className={`text-base font-semibold ${
												row.win + row.loss === 0
													? "text-ink-40"
													: row.winRate >= 55
														? "text-signal-pos"
														: "text-ink-85"
											}`}
										>
											{row.win + row.loss === 0 ? "—" : row.winRate}
										</span>
									</div>
								</div>
							))}
						</div>
					</section>

					{/* Canonical analytics */}
					<div className="mt-6 grid gap-6 lg:grid-cols-2">
						<TeamTrendCard />
						<MatchupCard />
					</div>
				</div>
			</div>
		</AuthGate>
	);
}

function StatPair({
	label,
	value,
	tone,
	muted,
}: {
	label: string;
	value: number;
	tone?: "pos" | "bad";
	muted?: boolean;
}) {
	const valueClass = muted
		? "text-ink-55"
		: tone === "pos"
			? "text-signal-pos"
			: tone === "bad"
				? "text-signal-bad"
				: "text-ink-95";
	return (
		<span className="flex items-baseline gap-1.5">
			<span className={`font-semibold ${valueClass}`}>{value}</span>
			<span className="text-xxs uppercase tracking-wider text-ink-55">
				{label}
			</span>
		</span>
	);
}

function PickRow({ pick }: { pick: ManualPickEntry }) {
	return (
		<li className="rounded-md bg-ink-00/40 p-3 ring-1 ring-inset ring-ink-15">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 flex-1">
					<div className="truncate font-sans text-sm font-semibold text-ink-95">
						{pick.marketTitle}
					</div>
					<div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0 font-mono text-xxs tabular-nums text-ink-55">
						<span className="text-ink-70">{pick.grade ?? "—"}</span>
						<span aria-hidden>·</span>
						<span>{pick.signalScore?.toFixed(1) ?? "—"}</span>
						<span aria-hidden>·</span>
						<span>{formatRelativeTime(pick.pickedAt)}</span>
						{pick.settledAt && (
							<>
								<span aria-hidden>·</span>
								<span className="text-ink-40">
									settled {formatRelativeTime(pick.settledAt)}
								</span>
							</>
						)}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<span
						className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-xxs font-semibold uppercase tracking-wider ring-1 ring-inset ${statusLabelTone(pick.status)}`}
					>
						{pick.status}
					</span>
					<PickContextPanel pickId={pick.id} />
				</div>
			</div>
		</li>
	);
}
