// ---------------------------------------------------------------------------
// Context Performance Table — generic bucketed performance display
// ---------------------------------------------------------------------------

import { formatPercent } from "../canonical/formatters";

export type PerformanceBucket = {
	bucket: string;
	picks: number;
	wins: number;
	losses: number;
	pushes: number;
	winRate: number | null;
	avgRoi: number | null;
};

function winRateColor(rate: number | null): string {
	if (rate == null) return "text-slate-400";
	if (rate > 0.55) return "text-emerald-300";
	if (rate < 0.45) return "text-red-300";
	return "text-slate-200";
}

function roiColor(roi: number | null): string {
	if (roi == null) return "text-slate-400";
	if (roi > 0) return "text-emerald-300";
	if (roi < 0) return "text-red-300";
	return "text-slate-200";
}

function formatRoi(roi: number | null): string {
	if (roi == null || !Number.isFinite(roi)) return "—";
	return `${roi >= 0 ? "+" : ""}${(roi * 100).toFixed(1)}%`;
}

function sampleBadge(count: number): string | null {
	if (count < 10) return "tiny";
	if (count < 30) return "small";
	return null;
}

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
		<div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
			<div className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
				{title}
			</div>

			{loading && (
				<div className="py-6 text-center text-sm text-slate-500">
					Loading...
				</div>
			)}

			{!loading && data.length === 0 && (
				<div className="py-6 text-center text-sm text-slate-500">
					No data available.
				</div>
			)}

			{!loading && data.length > 0 && (
				<div className="overflow-x-auto">
					<table className="w-full text-left text-[0.7rem]">
						<thead>
							<tr className="border-b border-slate-700/60">
								<th className="px-2 py-1.5 text-[0.6rem] font-semibold uppercase tracking-[0.15em] text-slate-500">
									Context
								</th>
								<th className="px-2 py-1.5 text-right text-[0.6rem] font-semibold uppercase tracking-[0.15em] text-slate-500">
									Picks
								</th>
								<th className="px-2 py-1.5 text-right text-[0.6rem] font-semibold uppercase tracking-[0.15em] text-slate-500">
									W-L-P
								</th>
								<th className="px-2 py-1.5 text-right text-[0.6rem] font-semibold uppercase tracking-[0.15em] text-slate-500">
									Win Rate
								</th>
								<th className="px-2 py-1.5 text-right text-[0.6rem] font-semibold uppercase tracking-[0.15em] text-slate-500">
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
										className="border-b border-slate-800/50 transition-colors hover:bg-slate-800/20"
									>
										<td className="px-2 py-1.5 font-semibold text-slate-200">
											{row.bucket}
											{badge && (
												<span className="ml-1.5 text-[0.55rem] text-amber-400/70">
													({badge})
												</span>
											)}
										</td>
										<td className="px-2 py-1.5 text-right text-slate-300">
											{row.picks}
										</td>
										<td className="px-2 py-1.5 text-right text-slate-300">
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
