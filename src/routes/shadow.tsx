import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { AuthGate } from "@/components/auth-gate";
import { formatSideLabel } from "@/lib/side-label";
import {
	getShadowBookSummaryFn,
	type ShadowPropSummary,
	type ShadowReasonSummary,
	type ShadowRowSummary,
	type ShadowSportSummary,
	type ShadowTimingPairSummary,
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
	prop_market_excluded: "Prop market gate",
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

/**
 * Below this many settled rows, ROI/CLV cells render dimmed: the number is
 * still shown, but the color no longer vouches for it (multiple-comparisons
 * guard — with a dozen gates, some small cell is always at ±60%).
 */
const MIN_SETTLED_FOR_EMPHASIS = 20;

function roiCellClass(value: number | null, settled: number): string {
	if (settled < MIN_SETTLED_FOR_EMPHASIS) return "text-ink-40 opacity-70";
	return roiClass(value);
}

function smallSampleTitle(settled: number): string | undefined {
	return settled < MIN_SETTLED_FOR_EMPHASIS
		? `n=${settled} settled — too small to color`
		: undefined;
}

const PROP_SUBTYPE_LABELS: Record<string, string> = {
	first_inning: "First inning (NRFI/YRFI)",
	btts: "Both teams to score",
	team_total: "Team total",
	period: "Period (1H/2H/quarter)",
	other_prop: "Other prop",
};

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
	const [props, setProps] = useState<ShadowPropSummary[]>([]);
	const [timingPairs, setTimingPairs] = useState<ShadowTimingPairSummary[]>(
		[],
	);
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
			setProps(result.props);
			setTimingPairs(result.timingPairs);
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
				<p className="mt-2 text-sm text-amber-500/90">
					Read with care: a row lands under the FIRST gate that fired, and the
					chain stops there — so a gate&apos;s raw ROI mixes in candidates
					other gates would have rejected anyway, and overstates what
					loosening that one gate would recover. The Sole-blocker columns are
					the clean cohort: rejected by this gate alone, every other gate
					passing — but only rows from 2026-08-06 onward carry the per-gate
					vector, so those columns start near-empty. Among older rows only
					price_edge_below_floor (the last gate in the chain) is a clean
					single-gate cohort. Dimmed cells have fewer than{" "}
					{MIN_SETTLED_FOR_EMPHASIS} settled rows — the number is shown but
					the sample is too small to color.
				</p>
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
								<th className="pb-2 pr-4">Avg CLV</th>
								<th className="pb-2 pr-4">Avg mins-to-start</th>
								<th className="pb-2 pr-4">Sole-blocker W-L</th>
								<th className="pb-2">Sole-blocker ROI</th>
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
									<td
										className={`py-2 pr-4 ${roiCellClass(r.units, r.wins + r.losses)}`}
										title={smallSampleTitle(r.wins + r.losses)}
									>
										{formatUnits(r.units)}
									</td>
									<td
										className={`py-2 pr-4 ${roiCellClass(r.roiPct, r.wins + r.losses)}`}
										title={smallSampleTitle(r.wins + r.losses)}
									>
										{formatRoi(r.roiPct)}
									</td>
									<td
										className={`py-2 pr-4 ${roiCellClass(r.avgClvPct, r.wins + r.losses)}`}
										title={smallSampleTitle(r.wins + r.losses)}
									>
										{formatRoi(r.avgClvPct)}
									</td>
									<td className="py-2 pr-4 text-ink-55">
										{r.avgMinutesToStart !== null
											? Math.round(r.avgMinutesToStart)
											: "—"}
									</td>
									<td className="py-2 pr-4">
										{r.cleanTotal > 0
											? `${r.cleanWins}-${r.cleanLosses}${
													r.cleanTotal > r.cleanWins + r.cleanLosses
														? ` (${r.cleanTotal - r.cleanWins - r.cleanLosses}p)`
														: ""
												}`
											: "—"}
									</td>
									<td
										className={`py-2 ${roiCellClass(r.cleanRoiPct, r.cleanWins + r.cleanLosses)}`}
										title={smallSampleTitle(r.cleanWins + r.cleanLosses)}
									>
										{formatRoi(r.cleanRoiPct)}
									</td>
								</tr>
							))}
							{reasons.length === 0 && !isLoading ? (
								<tr>
									<td colSpan={9} className="py-4 text-ink-55">
										No shadow candidates yet.
									</td>
								</tr>
							) : null}
						</tbody>
					</table>
				</div>

				<h2 className="mt-8 text-sm font-semibold uppercase tracking-[0.2em] text-ink-55">
					Paired timing view — window boundary drift
				</h2>
				<p className="mt-1 text-xs text-ink-55">
					Timing-gate shadows paired with a real pick on the SAME market —
					the direct measurement of the 60–180m window. Drift = later price −
					earlier price on the same side (probability points): the early row
					measures what waiting from first sighting (&gt;180m) into the
					window did to our entry; the late row measures where the price went
					after our entry, inside the final hour. Positive = market moved
					toward the sharp side. Side-flipped pairs (sharp side changed
					between sightings) are excluded from drift.
				</p>
				<div className="mt-3 overflow-x-auto rounded-md bg-ink-00 p-4">
					<table className="min-w-full text-left text-sm text-ink-85">
						<thead>
							<tr className="text-xs uppercase tracking-[0.15em] text-ink-55">
								<th className="pb-2 pr-4">Boundary</th>
								<th className="pb-2 pr-4">Pairs</th>
								<th className="pb-2 pr-4">Side matched</th>
								<th className="pb-2 pr-4">Side flipped</th>
								<th className="pb-2 pr-4">Avg drift</th>
								<th className="pb-2 pr-4">Median drift</th>
								<th className="pb-2 pr-4">Toward / away</th>
								<th className="pb-2">Paired pick W-L</th>
							</tr>
						</thead>
						<tbody>
							{timingPairs.map((r) => (
								<tr key={r.rejectReason} className="border-t border-ink-10">
									<td className="py-2 pr-4 text-ink-95">
										{r.rejectReason === "outside_window"
											? "Early sighting → pick entry"
											: "Pick entry → final hour"}
									</td>
									<td className="py-2 pr-4">{r.pairs}</td>
									<td className="py-2 pr-4">{r.sideMatched}</td>
									<td className="py-2 pr-4">{r.sideFlipped}</td>
									<td
										className={`py-2 pr-4 ${roiCellClass(r.avgDriftPct, r.sideMatched)}`}
										title={smallSampleTitle(r.sideMatched)}
									>
										{r.avgDriftPct !== null
											? `${r.avgDriftPct >= 0 ? "+" : ""}${r.avgDriftPct.toFixed(1)}pp`
											: "—"}
									</td>
									<td
										className={`py-2 pr-4 ${roiCellClass(r.medianDriftPct, r.sideMatched)}`}
										title={smallSampleTitle(r.sideMatched)}
									>
										{r.medianDriftPct !== null
											? `${r.medianDriftPct >= 0 ? "+" : ""}${r.medianDriftPct.toFixed(1)}pp`
											: "—"}
									</td>
									<td className="py-2 pr-4">
										{r.movedTowardSide} / {r.movedAway}
									</td>
									<td className="py-2">
										{r.pickWins}-{r.pickLosses}
									</td>
								</tr>
							))}
							{timingPairs.every((r) => r.pairs === 0) && !isLoading ? (
								<tr>
									<td colSpan={8} className="py-4 text-ink-55">
										No timing-shadow/pick pairs yet.
									</td>
								</tr>
							) : null}
						</tbody>
					</table>
				</div>

				<h2 className="mt-8 text-sm font-semibold uppercase tracking-[0.2em] text-ink-55">
					Prop cohort — promotion watch
				</h2>
				<p className="mt-1 text-xs text-ink-55">
					All prop-typed shadows regardless of which gate claimed them (timing
					pre-filters fire before the prop gate, so reject reason under-counts
					the cohort). Accumulating since 2026-08-07 (era v7). The Clean columns
					count only rows where the prop gate was the sole blocker — every other
					gate passing — which is the number the promotion decision reads; the
					raw columns mix in props other gates would have rejected anyway. A
					subtype earns a promotion review on sustained clean n with positive
					ROI and CLV — per-subtype, with its own scoring path, never by
					unmuting the full-game machinery.
				</p>
				<div className="mt-3 overflow-x-auto rounded-md bg-ink-00 p-4">
					<table className="min-w-full text-left text-sm text-ink-85">
						<thead>
							<tr className="text-xs uppercase tracking-[0.15em] text-ink-55">
								<th className="pb-2 pr-4">Subtype</th>
								<th className="pb-2 pr-4">Total</th>
								<th className="pb-2 pr-4">Pending</th>
								<th className="pb-2 pr-4">W-L</th>
								<th className="pb-2 pr-4">Units</th>
								<th className="pb-2 pr-4">ROI</th>
								<th className="pb-2 pr-4">Avg CLV</th>
								<th className="pb-2 pr-4">Clean W-L</th>
								<th className="pb-2 pr-4">Clean ROI</th>
								<th className="pb-2">Clean CLV</th>
							</tr>
						</thead>
						<tbody>
							{props.map((r) => (
								<tr key={r.subtype} className="border-t border-ink-10">
									<td className="py-2 pr-4">
										<span className="text-ink-95">
											{PROP_SUBTYPE_LABELS[r.subtype] ?? r.subtype}
										</span>
										<span className="ml-2 text-xs text-ink-55">
											{r.subtype}
										</span>
									</td>
									<td className="py-2 pr-4">{r.total}</td>
									<td className="py-2 pr-4">{r.pending}</td>
									<td className="py-2 pr-4">
										{r.wins}-{r.losses}
										{r.pushes > 0 ? ` (${r.pushes}p)` : ""}
									</td>
									<td
										className={`py-2 pr-4 ${roiCellClass(r.units, r.wins + r.losses)}`}
										title={smallSampleTitle(r.wins + r.losses)}
									>
										{formatUnits(r.units)}
									</td>
									<td
										className={`py-2 pr-4 ${roiCellClass(r.roiPct, r.wins + r.losses)}`}
										title={smallSampleTitle(r.wins + r.losses)}
									>
										{formatRoi(r.roiPct)}
									</td>
									<td
										className={`py-2 pr-4 ${roiCellClass(r.avgClvPct, r.wins + r.losses)}`}
										title={smallSampleTitle(r.wins + r.losses)}
									>
										{formatRoi(r.avgClvPct)}
									</td>
									<td className="py-2 pr-4">
										{r.cleanTotal > 0
											? `${r.cleanWins}-${r.cleanLosses}${
													r.cleanTotal > r.cleanWins + r.cleanLosses
														? ` (${r.cleanTotal - r.cleanWins - r.cleanLosses}p)`
														: ""
												}`
											: "—"}
									</td>
									<td
										className={`py-2 pr-4 ${roiCellClass(r.cleanRoiPct, r.cleanWins + r.cleanLosses)}`}
										title={smallSampleTitle(r.cleanWins + r.cleanLosses)}
									>
										{formatRoi(r.cleanRoiPct)}
									</td>
									<td
										className={`py-2 ${roiCellClass(r.cleanAvgClvPct, r.cleanWins + r.cleanLosses)}`}
										title={smallSampleTitle(r.cleanWins + r.cleanLosses)}
									>
										{formatRoi(r.cleanAvgClvPct)}
									</td>
								</tr>
							))}
							{props.length === 0 && !isLoading ? (
								<tr>
									<td colSpan={10} className="py-4 text-ink-55">
										No prop shadows yet — they accumulate as BTTS, NRFI/YRFI,
										team-total, and period markets hit the gates.
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
								<th className="pb-2 pr-4">ROI</th>
								<th className="pb-2">Avg CLV</th>
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
									<td
										className={`py-2 pr-4 ${roiCellClass(r.units, r.wins + r.losses)}`}
										title={smallSampleTitle(r.wins + r.losses)}
									>
										{formatUnits(r.units)}
									</td>
									<td
										className={`py-2 pr-4 ${roiCellClass(r.roiPct, r.wins + r.losses)}`}
										title={smallSampleTitle(r.wins + r.losses)}
									>
										{formatRoi(r.roiPct)}
									</td>
									<td
										className={`py-2 ${roiCellClass(r.avgClvPct, r.wins + r.losses)}`}
										title={smallSampleTitle(r.wins + r.losses)}
									>
										{formatRoi(r.avgClvPct)}
									</td>
								</tr>
							))}
							{bySport.length === 0 && !isLoading ? (
								<tr>
									<td colSpan={8} className="py-4 text-ink-55">
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
									<td className="py-2 pr-4">
										{(() => {
											const sideText = formatSideLabel(
												row.sharpSideLabel,
												row.sharpSide,
												row.marketTitle,
											);
											return sideText ? (
												<>
													<span className="text-ink-95">{sideText}</span>
													<span className="ml-1 text-xs text-ink-55">
														({row.sharpSide})
													</span>
												</>
											) : (
												(row.sharpSide ?? "—")
											);
										})()}
									</td>
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
