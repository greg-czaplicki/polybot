/** Short display names for execution lanes (manual_picks.lane). */
const LANE_LABELS: Record<string, string> = {
	cs2_pickem_dog: "CS2 dogs",
	ncaaf_totals_pilot: "NCAAF totals",
	nfl_totals_pilot: "NFL totals",
	nba_totals_fade: "NBA fade",
	cfb_hot_follow: "CFB hot",
	nfl_wallet_follow: "NFL wallets",
	nhl_hot_fade: "NHL fade",
	soccer_hot_fade: "Soccer fade",
};

/** NULL / missing lane = the holder book. */
export function laneLabel(lane: string | null | undefined): string {
	if (!lane) return "Book";
	return LANE_LABELS[lane] ?? lane.replaceAll("_", " ");
}
