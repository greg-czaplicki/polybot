import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { AuthGate } from "@/components/auth-gate";
import {
	getShadowBookSummaryFn,
	type ShadowReasonSummary,
	type ShadowRowSummary,
	type ShadowSportSummary,
} from "../server/api/shadow-book-api";

export const Route = createFileRoute("/shadow")({
	component: ShadowBookPage,
});

const REASON_LABELS: Record<string, string> = {
	outside_window: "Earlier than window (>180m)",
	too_close_to_start: "Later than window (<60m)",
	spread_market_excluded: "Spread gate",
	ncaab_spread_excluded: "NCAAB spread gate",
	nhl_sport_excluded: "NHL gate",
	nba_timing_excluded: "NBA >90m gate",
	nfl_preseason_excluded: "NFL preseason gate",
	"0-15m_timing_excluded": "0-15m gate",
	not_ready: "Not ready",
	below_policy_grade: "Grade below policy",
	low_score_differential: "Low score differential",
	signal_score_saturation: "Signal saturation gate",
	edge_rating_saturation: "Edge saturation gate",
	edge_rating_dead_zone: "Edge dead-zone gate",
	edge_rating_below_floor: "Edge below floor",
	below_policy_microstructure: "Microstructure gate",
	price_edge_below_floor: "Price-edge floor",
};

function reasonLabel(reason: string): string {
	return REASON_LABELS[reason] ?? reason;
}

function formatUnits(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "—";
	return `${value >= 0 ? "+" : ""}${value.toFixed(2)}u`;
}

function formatRoi(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "—";
	return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function roiClass(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "text-ink-55";
	return value >= 0 ? "text-emerald-500" : "text-red-500";
}

function formatTime(seconds: number | null): string {
	if (!seconds) return "—";
	return new Date(seconds * 1000).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function ShadowBookPage() {
	const [reasons, setReasons] = useState<ShadowReasonSummary[]>([]);
	const [bySport, setBySport] = useState<ShadowSportSummary[]>([]);
	const [recent, setRecent] = useState<ShadowRowSummary[]>([]);
	const [computedAt, setComputedAt] = useState<number | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			const result = await getShadowBookSummaryFn();
			setReasons(result.reasons);
			setBySport(result.bySport);
			setRecent(result.recent);
			setComputedAt(result.computedAt);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load");
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const settledTotal = reasons.reduce((s, r) => s + r.wins + r.losses, 0);
	const pendingTotal = reasons.reduce((s, r) => s + r.pending, 0);
	const unitsTotal = reasons.reduce((s, r) => s + (r.units ?? 0), 0);

	return (
		<AuthGate>
			<div className="mx-auto max-w-6xl px-4 py-8">
				<div className="flex items-baseline justify-between">
					<div>
						<h1 className="text-xl font-semibold text-ink-95">Shadow Book</h1>
						<p className="mt-1 text-sm text-ink-55">
							Gate-rejected candidates settled without betting — what each
							filter saved or cost. Recording started 2026-07-30; ROI assumes
							1u at the first-sighting price (ignores slippage). Small samples
							lie: judge gates on n, not vibes.
						</p>
					</div>
					<button
						type="button"
						onClick={() => void load()}
						disabled={isLoading}
						className="rounded-md border border-ink-15 px-3 py-1.5 text-sm text-ink-85 hover:bg-ink-05 disabled:opacity-50"
					>
						{isLoading ? "Loading…" : "Refresh"}
					</button>
				</div>

				{error ? (
					<p className="mt-4 rounded-md bg-red-500/10 p-3 text-sm text-red-500">
						{error}
					</p>
				) : null}

				<div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
					{[
						{ label: "Shadow candidates", value: String(settledTotal + pendingTotal + reasons.reduce((s, r) => s + r.pushes, 0)) },
						{ label: "Settled", value: String(settledTotal) },
						{ label: "Pending", value: String(pendingTotal) },
						{
							label: "Units (all gates)",
							value: formatUnits(settledTotal > 0 ? unitsTotal : null),
						},
					].map((tile) => (
						<div
							key={tile.label}
							className="rounded-md bg-ink-00 p-4"
						>
							<p className="text-xs uppercase tracking-[0.2em] text-ink-55">
								{tile.label}
							</p>
							<p className="mt-1 text-lg font-semibold text-ink-95">
								{tile.value}
							</p>
						</div>
					))}
				</div>

				<h2 className="mt-8 text-sm font-semibold uppercase tracking-[0.2em] text-ink-55">
					Performance by gate
				</h2>
				<div className="mt-3 overflow-x-auto rounded-md bg-ink-00 p-4">
					<table className="min-w-full text-left text-sm text-ink-85">
						<thead>
							<tr className="text-xs uppercase tracking-[0.15em] text-ink-55">
								<th className="pb-2 pr-4">Gate</th>
								<th className="pb-2 pr-4">Total</th>
								<th className="pb-2 pr-4">Pending</th>
								<th className="pb-2 pr-4">W-L</th>
								<th className="pb-2 pr-4">Units</th>
								<th className="pb-2 pr-4">ROI</th>
								<th className="pb-2">Avg mins-to-start</th>
							</tr>
						</thead>
						<tbody>
							{reasons.map((r) => (
								<tr key={r.rejectReason} className="border-t border-ink-10">
									<td className="py-2 pr-4">
										<span className="text-ink-95">
											{reasonLabel(r.rejectReason)}
										</span>
										<span className="ml-2 text-xs text-ink-55">
											{r.rejectReason}
										</span>
									</td>
									<td className="py-2 pr-4">{r.total}</td>
									<td className="py-2 pr-4">{r.pending}</td>
									<td className="py-2 pr-4">
										{r.wins}-{r.losses}
										{r.pushes > 0 ? ` (${r.pushes}p)` : ""}
									</td>
									<td className={`py-2 pr-4 ${roiClass(r.units)}`}>
										{formatUnits(r.units)}
									</td>
									<td className={`py-2 pr-4 ${roiClass(r.roiPct)}`}>
										{formatRoi(r.roiPct)}
									</td>
									<td className="py-2 text-ink-55">
										{r.avgMinutesToStart !== null
											? Math.round(r.avgMinutesToStart)
											: "—"}
									</td>
								</tr>
							))}
							{reasons.length === 0 && !isLoading ? (
								<tr>
									<td colSpan={7} className="py-4 text-ink-55">
										No shadow candidates yet.
									</td>
								</tr>
							) : null}
						</tbody>
					</table>
				</div>

				<h2 className="mt-8 text-sm font-semibold uppercase tracking-[0.2em] text-ink-55">
					Performance by gate × sport
				</h2>
				<p className="mt-1 text-xs text-ink-55">
					The same gate can be right for one sport and wrong for another
					(e.g. football spreads vs. MLB spreads). Sport comes from the
					series registry; soccer shows per-league (epl/mls).
				</p>
				<div className="mt-3 overflow-x-auto rounded-md bg-ink-00 p-4">
					<table className="min-w-full text-left text-sm text-ink-85">
						<thead>
							<tr className="text-xs uppercase tracking-[0.15em] text-ink-55">
								<th className="pb-2 pr-4">Gate</th>
								<th className="pb-2 pr-4">Sport</th>
								<th className="pb-2 pr-4">Total</th>
								<th className="pb-2 pr-4">Pending</th>
								<th className="pb-2 pr-4">W-L</th>
								<th className="pb-2 pr-4">Units</th>
								<th className="pb-2">ROI</th>
							</tr>
						</thead>
						<tbody>
							{bySport.map((r) => (
								<tr
									key={`${r.rejectReason}-${r.sportTag}`}
									className="border-t border-ink-10"
								>
									<td className="py-2 pr-4 text-xs text-ink-55">
										{r.rejectReason}
									</td>
									<td className="py-2 pr-4 uppercase text-ink-95">
										{r.sportTag}
									</td>
									<td className="py-2 pr-4">{r.total}</td>
									<td className="py-2 pr-4">{r.pending}</td>
									<td className="py-2 pr-4">
										{r.wins}-{r.losses}
										{r.pushes > 0 ? ` (${r.pushes}p)` : ""}
									</td>
									<td className={`py-2 pr-4 ${roiClass(r.units)}`}>
										{formatUnits(r.units)}
									</td>
									<td className={`py-2 ${roiClass(r.roiPct)}`}>
										{formatRoi(r.roiPct)}
									</td>
								</tr>
							))}
							{bySport.length === 0 && !isLoading ? (
								<tr>
									<td colSpan={7} className="py-4 text-ink-55">
										No shadow candidates yet.
									</td>
								</tr>
							) : null}
						</tbody>
					</table>
				</div>

				<h2 className="mt-8 text-sm font-semibold uppercase tracking-[0.2em] text-ink-55">
					Recent shadow candidates (latest 100)
				</h2>
				<div className="mt-3 overflow-x-auto rounded-md bg-ink-00 p-4">
					<table className="min-w-full text-left text-sm text-ink-85">
						<thead>
							<tr className="text-xs uppercase tracking-[0.15em] text-ink-55">
								<th className="pb-2 pr-4">Market</th>
								<th className="pb-2 pr-4">Gate</th>
								<th className="pb-2 pr-4">Side</th>
								<th className="pb-2 pr-4">Price</th>
								<th className="pb-2 pr-4">Grade</th>
								<th className="pb-2 pr-4">Mins</th>
								<th className="pb-2 pr-4">Status</th>
								<th className="pb-2 pr-4">ROI</th>
								<th className="pb-2">Recorded</th>
							</tr>
						</thead>
						<tbody>
							{recent.map((row) => (
								<tr
									key={`${row.marketTitle}-${row.rejectReason}-${row.createdAt}`}
									className="border-t border-ink-10"
								>
									<td className="max-w-xs truncate py-2 pr-4 text-ink-95">
										{row.marketTitle}
									</td>
									<td className="py-2 pr-4 text-xs text-ink-55">
										{row.rejectReason}
									</td>
									<td className="py-2 pr-4">{row.sharpSide ?? "—"}</td>
									<td className="py-2 pr-4">
										{row.price !== null ? row.price.toFixed(2) : "—"}
									</td>
									<td className="py-2 pr-4">{row.grade ?? "—"}</td>
									<td className="py-2 pr-4 text-ink-55">
										{row.minutesToStart !== null
											? Math.round(row.minutesToStart)
											: "—"}
									</td>
									<td className="py-2 pr-4">
										<span
											className={
												row.status === "win"
													? "text-emerald-500"
													: row.status === "loss"
														? "text-red-500"
														: "text-ink-55"
											}
										>
											{row.status}
										</span>
									</td>
									<td
										className={`py-2 pr-4 ${roiClass(
											row.status === "win" || row.status === "loss"
												? row.roi
												: null,
										)}`}
									>
										{row.status === "win" || row.status === "loss"
											? formatUnits(row.roi)
											: "—"}
									</td>
									<td className="py-2 text-xs text-ink-55">
										{formatTime(row.createdAt)}
									</td>
								</tr>
							))}
							{recent.length === 0 && !isLoading ? (
								<tr>
									<td colSpan={9} className="py-4 text-ink-55">
										Nothing recorded yet.
									</td>
								</tr>
							) : null}
						</tbody>
					</table>
				</div>

				{computedAt ? (
					<p className="mt-4 text-xs text-ink-55">
						Computed {formatTime(computedAt)}
					</p>
				) : null}
			</div>
		</AuthGate>
	);
}
