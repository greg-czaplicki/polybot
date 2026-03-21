// ---------------------------------------------------------------------------
// Shared formatting utilities for canonical analytics display
// ---------------------------------------------------------------------------

/**
 * Format a decimal ratio as a percentage string (e.g. 0.55 → "55.0%").
 * Returns "—" for null/undefined/non-finite values.
 */
export function formatPercent(value: number | null | undefined): string {
	if (value == null || !Number.isFinite(value)) return "—";
	return `${(value * 100).toFixed(1)}%`;
}

/**
 * Format a margin value with sign (e.g. 3.5 → "+3.5", -2.1 → "-2.1").
 * Returns "—" for null/undefined/non-finite values.
 */
export function formatMargin(value: number | null | undefined): string {
	if (value == null || !Number.isFinite(value)) return "—";
	return value >= 0 ? `+${value.toFixed(1)}` : value.toFixed(1);
}

/**
 * Format a win-loss record (e.g. "7-3" or "7-3-1" with pushes).
 */
export function formatRecord(
	wins: number,
	losses: number,
	pushes?: number,
): string {
	if (pushes && pushes > 0) return `${wins}-${losses}-${pushes}`;
	return `${wins}-${losses}`;
}

/**
 * Format a streak (e.g. "W3", "L2").
 * Returns "—" for null/zero/missing values.
 */
export function formatStreak(
	type: string | null | undefined,
	length: number,
): string {
	if (!type || length <= 0) return "—";
	return `${type.charAt(0).toUpperCase()}${length}`;
}

/**
 * Format a spread line with sign (e.g. -3.5 → "-3.5", 7 → "+7").
 * Returns "—" for null/undefined/non-finite values.
 */
export function formatSpreadLine(value: number | null | undefined): string {
	if (value == null || !Number.isFinite(value)) return "—";
	return value >= 0 ? `+${value}` : `${value}`;
}

/**
 * Format a total line (e.g. 145.5 → "O/U 145.5").
 * Returns "—" for null/undefined/non-finite values.
 */
export function formatTotalLine(value: number | null | undefined): string {
	if (value == null || !Number.isFinite(value)) return "—";
	return `O/U ${value}`;
}

/**
 * Format a unix timestamp as a locale date/time string.
 * Returns "—" for null/undefined/zero values.
 */
export function formatTimestamp(ts: number | null | undefined): string {
	if (!ts) return "—";
	return new Date(ts * 1000).toLocaleString();
}
