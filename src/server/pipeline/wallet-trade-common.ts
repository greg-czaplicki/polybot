import { resolveSportTagFromSeriesId } from "../api/series-registry";

export const WALLET_PILOT_SPORTS = new Set([
	"mlb",
	"nfl",
	"ncaaf",
	"epl",
	"atp",
	"wta",
]);
export function pilotSport(seriesId: number): string | null {
	// Gamma /series/12756 verified 2026-09-09; pilot-only cold-start supplement.
	if (seriesId === 12756) return "ncaaf";
	return resolveSportTagFromSeriesId(seriesId);
}
export function seconds(): number {
	return Math.floor(Date.now() / 1000);
}
export function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
export function positive(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}
export async function publicJson(url: URL): Promise<unknown> {
	const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.json();
}
export type WalletTrade = {
	wallet: string;
	tx: string;
	condition: string;
	token: string;
	action: "BUY" | "SELL";
	outcome: string;
	at: number;
	price: number;
	size: number;
};
export type WalletMarket = {
	condition_id: string;
	sport_series_id: number;
	event_time: string | null;
	side_a_label: string;
	side_b_label: string;
	event_id?: string;
	identity_source?: string;
	metadata_at?: number;
	token_a?: string;
	token_b?: string;
};
