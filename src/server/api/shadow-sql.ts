/**
 * Shared SQL fragments for shadow-book aggregation, used by both the
 * /shadow server functions (shadow-book-api.ts) and the public digest
 * endpoint (shadow-digest.ts). Fragments only — no imports, safe on the
 * raw worker path.
 */

/**
 * A row is a sole-blocker reject when every vector gate passes except the
 * gate its reject_reason maps to. Gates without a vector entry (timing,
 * microstructure, sport policies) get no exemption — for them "clean" means
 * all five vector gates pass. json_extract returns NULL for pass=null
 * (input unavailable at record time), which fails the =1 test: unknown is
 * never counted as a pass.
 */
/**
 * Pin-divergence paper lanes (docs/charters/tennis-ground-up.md,
 * pin-divergence-benchmark.md). Rows here are NOT holder-signal gate
 * rejects: reject_reason names the RULE that fired, sharp_side is the side
 * the rule bets, gates_json/top_holders_json are NULL. Every lane row is
 * its own clean cohort — the rule was the only decision — so the standard
 * promotion verdict (n>=50, clustered z>=2, pin_clv>0) applies to all of
 * them, per lane per sport. Keep them OUT of per-gate reads.
 */
export const PAPER_LANE_REASONS = ["tennis_v2_paper", "pin_div_paper"] as const;
export const PAPER_LANE_SQL = `reject_reason IN (${PAPER_LANE_REASONS.map(
	(r) => `'${r}'`,
).join(",")})`;

export const SOLE_BLOCKER_SQL = `(
	${PAPER_LANE_SQL}
	OR (
	gates_json IS NOT NULL
	AND (json_extract(gates_json,'$.price_edge.pass') = 1
	     OR reject_reason = 'price_edge_below_floor')
	AND (json_extract(gates_json,'$.edge_rating.pass') = 1
	     OR reject_reason IN ('edge_rating_saturation','edge_rating_dead_zone','edge_rating_below_floor'))
	AND (json_extract(gates_json,'$.signal_score.pass') = 1
	     OR reject_reason = 'signal_score_saturation')
	AND (json_extract(gates_json,'$.score_differential.pass') = 1
	     OR reject_reason = 'low_score_differential')
	AND (json_extract(gates_json,'$.grade_vs_base.pass') = 1
	     OR reject_reason = 'below_policy_grade')
	)
)`;

/**
 * Prop subtype from the market title. The promotion decision is per-subtype
 * (BTTS vs NRFI vs team totals vs period markets are different bets), and
 * prop rows scatter across reject reasons (timing pre-filters fire before
 * the prop gate), so the cohort is defined by market_type + title, not by
 * reject_reason.
 */
export const PROP_SUBTYPE_SQL = `CASE
	WHEN lower(market_title) LIKE '%: touchdown%'
	  OR lower(market_title) LIKE '%: first touchdown%'
	  OR lower(market_title) LIKE '%: last touchdown%'
	  OR lower(market_title) LIKE '%: passing%'
	  OR lower(market_title) LIKE '%: rushing%'
	  OR lower(market_title) LIKE '%: receiving%'
	  OR lower(market_title) LIKE '%: receptions%'
	  OR lower(market_title) LIKE '%: anytime%'
	  OR lower(market_title) LIKE '%: completions%'
	  OR lower(market_title) LIKE '%: interceptions%'
	  OR lower(market_title) LIKE '%: sacks%'
	  OR lower(market_title) LIKE '%: tackles%'
	  OR lower(market_title) LIKE '%: kicking%'
	  OR lower(market_title) LIKE '%: field goals%'
	  OR lower(market_title) LIKE '%: strikeouts%'
	  OR lower(market_title) LIKE '%: hits%'
	  OR lower(market_title) LIKE '%: home runs%'
	  OR lower(market_title) LIKE '%: total bases%'
	  OR lower(market_title) LIKE '%: rbis%'
	  OR lower(market_title) LIKE '%: points%'
	  OR lower(market_title) LIKE '%: rebounds%'
	  OR lower(market_title) LIKE '%: assists%'
	  OR lower(market_title) LIKE '%: threes%'
	  OR lower(market_title) LIKE '%: three pointers%'
	  OR lower(market_title) LIKE '%: steals%'
	  OR lower(market_title) LIKE '%: blocks%'
	  OR lower(market_title) LIKE '%: shots%'
	  OR lower(market_title) LIKE '%: saves%'
	  OR lower(market_title) LIKE '%: goals%'
	  OR lower(market_title) LIKE '%: yards%' THEN 'player_prop'
	WHEN lower(market_title) LIKE '%first inning%'
	  OR lower(market_title) LIKE '%1st inning%'
	  OR lower(market_title) LIKE '%nrfi%'
	  OR lower(market_title) LIKE '%yrfi%' THEN 'first_inning'
	WHEN lower(market_title) LIKE '%both teams to score%'
	  OR lower(market_title) LIKE '%btts%' THEN 'btts'
	WHEN lower(market_title) LIKE '%team total%' THEN 'team_total'
	WHEN lower(market_title) LIKE '%corner%' THEN 'corners'
	WHEN lower(market_title) LIKE '%total cards%'
	  OR lower(market_title) LIKE '%yellow card%'
	  OR lower(market_title) LIKE '%red card%'
	  OR lower(market_title) LIKE '%booking%' THEN 'cards'
	WHEN lower(market_title) LIKE '%1h%'
	  OR lower(market_title) LIKE '%2h%'
	  OR lower(market_title) LIKE '%half%'
	  OR lower(market_title) LIKE '%quarter%' THEN 'period'
	ELSE 'other_prop'
END`;

/**
 * A prop row is clean for the promotion read only when the prop gate was
 * the sole blocker: reject_reason = 'prop_market_excluded' means every
 * chain gate ahead of it (timing pre-filters, sport policies) passed, and
 * the five vector gates — evaluated independently of the chain — must all
 * pass too. A prop first sighted at too_close_to_start would not have been
 * bet even without the prop gate; counting it answers "how do props do",
 * not "what would betting props recover". grade_vs_base carries the same
 * documented approximation as SOLE_BLOCKER_SQL (base min grade, not the
 * unknowable no-prop-gate policy grade).
 */
export const PROP_CLEAN_SQL = `(
	reject_reason = 'prop_market_excluded'
	AND gates_json IS NOT NULL
	AND json_extract(gates_json,'$.price_edge.pass') = 1
	AND json_extract(gates_json,'$.edge_rating.pass') = 1
	AND json_extract(gates_json,'$.signal_score.pass') = 1
	AND json_extract(gates_json,'$.score_differential.pass') = 1
	AND json_extract(gates_json,'$.grade_vs_base.pass') = 1
)`;
