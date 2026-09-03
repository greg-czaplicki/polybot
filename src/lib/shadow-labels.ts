/** Human labels for shadow reject reasons (gates and paper lanes). */
export const REASON_LABELS: Record<string, string> = {
	outside_window: "Earlier than window (>180m)",
	too_close_to_start: "Later than window (<60m)",
	spread_market_excluded: "Spread gate",
	ncaab_spread_excluded: "NCAAB spread gate",
	nhl_league_probation: "NHL probation",
	nba_timing_excluded: "NBA >90m gate",
	nfl_preseason_excluded: "NFL preseason gate",
	prop_market_excluded: "Prop market gate",
	tennis_v2_paper: "Paper · tennis-v2 R1",
	pin_div_paper: "Paper · pin-divergence",
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
	entry_price_below_floor: "Entry-price floor",
};

export function reasonLabel(reason: string): string {
	if (REASON_LABELS[reason]) return REASON_LABELS[reason];
	const m = reason.match(/^([a-z0-9]+)_league_probation$/);
	if (m) return `${m[1].toUpperCase()} probation`;
	return reason.replace(/_/g, " ");
}

export const PROP_SUBTYPE_LABELS: Record<string, string> = {
	player_prop: "Player prop",
	first_inning: "First inning (NRFI/YRFI)",
	btts: "Both teams to score",
	team_total: "Team total",
	period: "Period (1H/2H/quarter)",
	corners: "Corners",
	cards: "Cards / bookings",
	other_prop: "Other prop",
};
