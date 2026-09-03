/**
 * Number and time formatting shared by every terminal panel. One place, so
 * a signed unit reads the same on the home strip and the verdict board.
 */

export function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

export function ago(seconds: number | null | undefined): string {
	if (!seconds) return "never";
	const diff = nowSec() - seconds;
	if (diff < 60) return "now";
	if (diff < 3600) return `${Math.floor(diff / 60)}m`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
	return `${Math.floor(diff / 86400)}d`;
}

export function signed(
	value: number | null | undefined,
	digits = 2,
	suffix = "",
): string {
	if (value === null || value === undefined || !Number.isFinite(value))
		return "—";
	return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}${suffix}`;
}

export function units(value: number | null | undefined): string {
	return signed(value, 2, "u");
}

export function pct(value: number | null | undefined, digits = 1): string {
	return signed(value, digits, "%");
}

export function num(value: number | null | undefined, digits = 2): string {
	if (value === null || value === undefined || !Number.isFinite(value))
		return "—";
	return value.toFixed(digits);
}

export function dollars(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value))
		return "—";
	return `$${value.toFixed(2)}`;
}

/** Short clock for event and settle stamps: "Wed 7:10p". */
export function clock(input: string | number | null | undefined): string {
	if (!input) return "—";
	const date =
		typeof input === "number" ? new Date(input * 1000) : new Date(input);
	if (Number.isNaN(date.getTime())) return "—";
	const wd = date.toLocaleString(undefined, { weekday: "short" });
	const h = date.getHours();
	const m = `${date.getMinutes()}`.padStart(2, "0");
	const hr = h % 12 === 0 ? 12 : h % 12;
	return `${wd} ${hr}:${m}${h < 12 ? "a" : "p"}`;
}

export function dateStamp(seconds: number | null | undefined): string {
	if (!seconds) return "—";
	return new Date(seconds * 1000).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}
