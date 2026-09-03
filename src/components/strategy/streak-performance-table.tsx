// ---------------------------------------------------------------------------
// Streak Performance Table — streak-specific bucketed performance display
// ---------------------------------------------------------------------------

import { formatPercent } from "../canonical/formatters";
import type { PerformanceBucket } from "./context-performance-table";
import { formatRoi, roiColor, sampleBadge, winRateColor } from "./helpers";

function streakBadge(bucket: string): {
	color: string;
	bgColor: string;
	label: string;
} | null {
	const match = bucket.match(/^([WL])(\d+)/i);
	if (!match) return null;
	const type = match[1].toUpperCase();
	const length = Number.parseInt(match[2], 10);
	if (type === "W") {
		return {
			color:
				length >= 5
					? "text-signal-pos"
					: length >= 3
						? "text-signal-pos"
						: "text-emerald-500",
			bgColor:
				length >= 5
					? "bg-emerald-500/15 border-emerald-500/30"
					: "bg-emerald-500/5 border-emerald-500/15",
			label: `W${length}+`,
		};
	}
	return {
		color:
			length >= 5
				? "text-red-300"
				: length >= 3
					? "text-signal-bad"
					: "text-red-500",
		bgColor:
			length >= 5
				? "bg-red-500/15 border-red-500/30"
				: "bg-red-500/5 border-red-500/15",
		label: `L${length}+`,
	};
}

export function StreakPerformanceTable({
	data,
	title,
	loading,
}: {
	data: PerformanceBucket[];
	title: string;
	loading?: boolean;
}) {
	return (
		<div className="rounded-xl border border-ink-15 bg-ink-05/50 p-4">
			<div className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-ink-55">
				{title}
			</div>

			{loading && (
				<div className="py-6 text-center text-sm text-ink-40">Loading...</div>
			)}

			{!loading && data.length === 0 && (
				<div className="py-6 text-center text-sm text-ink-40">
					No streak data available.
				</div>
			)}

			{!loading && data.length > 0 && (
				<div className="overflow-x-auto">
					<table className="w-full text-left text-[0.7rem]">
						<thead>
							<tr className="border-b border-ink-15">
								<th className="px-2 py-1.5 text-[0.6rem] font-semibold uppercase tracking-[0.15em] text-ink-40">
									Streak
								</th>
								<th className="px-2 py-1.5 text-right text-[0.6rem] font-semibold uppercase tracking-[0.15em] text-ink-40">
									Picks
								</th>
								<th className="px-2 py-1.5 text-right text-[0.6rem] font-semibold uppercase tracking-[0.15em] text-ink-40">
									W-L-P
								</th>
								<th className="px-2 py-1.5 text-right text-[0.6rem] font-semibold uppercase tracking-[0.15em] text-ink-40">
									Win Rate
								</th>
								<th className="px-2 py-1.5 text-right text-[0.6rem] font-semibold uppercase tracking-[0.15em] text-ink-40">
									Avg ROI
								</th>
							</tr>
						</thead>
						<tbody>
							{data.map((row) => {
								const badge = streakBadge(row.bucket);
								const sample = sampleBadge(row.picks);
								return (
									<tr
										key={row.bucket}
										className={`border-b border-ink-15/50 transition-colors hover:bg-ink-10/20 ${badge ? badge.bgColor : ""}`}
									>
										<td className="px-2 py-1.5">
											{badge ? (
												<span className={`font-semibold ${badge.color}`}>
													{badge.label}
												</span>
											) : (
												<span className="font-semibold text-ink-85">
													{row.bucket}
												</span>
											)}
											{sample && (
												<span className="ml-1.5 text-[0.55rem] text-amber-400/70">
													({sample})
												</span>
											)}
										</td>
										<td className="px-2 py-1.5 text-right text-ink-70">
											{row.picks}
										</td>
										<td className="px-2 py-1.5 text-right text-ink-70">
											{row.wins}-{row.losses}
											{row.pushes > 0 ? `-${row.pushes}` : ""}
										</td>
										<td
											className={`px-2 py-1.5 text-right font-semibold ${winRateColor(row.winRate)}`}
										>
											{formatPercent(row.winRate)}
										</td>
										<td
											className={`px-2 py-1.5 text-right font-semibold ${roiColor(row.avgRoi)}`}
										>
											{formatRoi(row.avgRoi)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
