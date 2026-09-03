// ---------------------------------------------------------------------------
// Context Performance Table — generic bucketed performance display
// ---------------------------------------------------------------------------

import { formatPercent } from "../canonical/formatters";
import { formatRoi, roiColor, sampleBadge, winRateColor } from "./helpers";

export type PerformanceBucket = {
	bucket: string;
	picks: number;
	wins: number;
	losses: number;
	pushes: number;
	winRate: number | null;
	avgRoi: number | null;
};

export function ContextPerformanceTable({
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
					No data available.
				</div>
			)}

			{!loading && data.length > 0 && (
				<div className="overflow-x-auto">
					<table className="w-full text-left text-[0.7rem]">
						<thead>
							<tr className="border-b border-ink-15">
								<th className="px-2 py-1.5 text-[0.6rem] font-semibold uppercase tracking-[0.15em] text-ink-40">
									Context
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
								const badge = sampleBadge(row.picks);
								return (
									<tr
										key={row.bucket}
										className="border-b border-ink-15/50 transition-colors hover:bg-ink-10/20"
									>
										<td className="px-2 py-1.5 font-semibold text-ink-85">
											{row.bucket}
											{badge && (
												<span className="ml-1.5 text-[0.55rem] text-amber-400/70">
													({badge})
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
