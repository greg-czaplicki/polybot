// ---------------------------------------------------------------------------
// Shared display helpers for strategy analysis tables
// ---------------------------------------------------------------------------

/** Tailwind color class for win rate values. */
export function winRateColor(rate: number | null): string {
	if (rate == null) return "text-slate-400";
	if (rate > 0.55) return "text-emerald-300";
	if (rate < 0.45) return "text-red-300";
	return "text-slate-200";
}

/** Tailwind color class for ROI values. */
export function roiColor(roi: number | null): string {
	if (roi == null) return "text-slate-400";
	if (roi > 0) return "text-emerald-300";
	if (roi < 0) return "text-red-300";
	return "text-slate-200";
}

/** Format ROI as a signed percentage (e.g., +5.2%, -3.1%). */
export function formatRoi(roi: number | null): string {
	if (roi == null || !Number.isFinite(roi)) return "—";
	return `${roi >= 0 ? "+" : ""}${(roi * 100).toFixed(1)}%`;
}

/** Sample size badge for low-count buckets. */
export function sampleBadge(count: number): string | null {
	if (count < 10) return "tiny";
	if (count < 30) return "small";
	return null;
}
