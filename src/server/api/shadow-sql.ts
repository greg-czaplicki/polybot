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
export const SOLE_BLOCKER_SQL = `(
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
)`;

/**
 * Prop subtype from the market title. The promotion decision is per-subtype
 * (BTTS vs NRFI vs team totals vs period markets are different bets), and
 * prop rows scatter across reject reasons (timing pre-filters fire before
 * the prop gate), so the cohort is defined by market_type + title, not by
 * reject_reason.
 */
export const PROP_SUBTYPE_SQL = `CASE
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
