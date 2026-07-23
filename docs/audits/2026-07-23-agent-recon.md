# 2026-07-23 — Multi-Agent Recon Audit

Method: 8 parallel finder agents, one per dimension (settlement, data
integrity, ingestion, scoring/gates, summary SQL, bot execution, ops/infra,
and a fresh-eyes review of the 2026-07-23 book-anchor deploy), each primed
with KNOWN-ISSUES so only NEW findings count. Every finding was then passed
to an independent adversarial verifier instructed to refute it against the
actual code. 67 agents total; 59 raw findings -> 52 confirmed, 7 refuted.

Severities: P0 corrupts money/picks/settlement now; P1 wrong
metrics/analytics that could drive bad decisions; P2 correctness bug with
limited blast radius; P3 hygiene/gap.

Status column: `open` unless noted. Fixes land as separate dated commits;
update this file (and KNOWN-ISSUES where applicable) as they close.

**Confirmed: 52** — P0: 1, P1: 11, P2: 20, P3: 20


## P0

**Remediation (same day):** fixed in the commit landing this report — the
unresolved-market guard now uses loose `== null` (catches Gamma omitting the
field entirely) and the outcomePrices fallback requires the market to be
closed. `settleManualPick` additionally gained a `status = 'pending'` WHERE
guard, closing the P2 outcome-endpoint overwrite below at the repository
layer. Historical damage audit: 9 settled picks had `settled_at` within 90
minutes of game start (clear mid-game settlements; 7 of 9 are O/U picks where
an already-crossed total cannot reverse). All 9 re-verified against Gamma
final outcome prices on 2026-07-23: stored win/loss matches the true
resolution in every case — no historical corruption, the exposure was
forward-looking only.

### [P0] Live in-game markets settle on price extremes: unresolved-market guard is dead code because Gamma never returns `resolved`/`resolution`

`src/server/api/manual-picks.ts:241` — dimension: settlement — **status: open**

resolvePickResult's guard `if (!resolved && resolution === null) return null;` never fires: live-verified Gamma /markets responses contain NO `resolved` and NO `resolution` keys (both undefined, and `undefined === null` is false), and `umaResolutionStatus` is absent on open markets. So every settlement pass on a live market (closed=false) falls through to the outcomePrices fallback (lines 278-290, winThreshold 0.98 / loseThreshold 0.02), which has no closed/resolved precondition. The eligibility filter (lines 133-137) admits any pick whose event started >=15 minutes ago, so a pick on a game IN PROGRESS whose live price hits >=0.98/<=0.02 (routine in blowouts) is settled win/loss mid-game. A comeback leaves a permanently wrong win/loss, wrong roi, and wrong resolved_outcome — settled picks are never re-checked. This also means the numeric and string `resolution` branches (lines 256-274) are dead code and ALL historical settlements have flowed through the price fallback.

**Suggested fix:** Require the market to actually be closed before applying the price fallback: `if (!resolvedSide && market.closed === true && outcomePrices.length >= 2) {...}`, and change the guard to `resolution == null` (loose) so unresolved markets bail early. Optionally also require `endDate` in the past.

**Verifier:** Fully reproduced. (1) Live-verified via curl: Gamma /markets omits resolved/resolution/umaResolutionStatus entirely on both open AND closed markets, so the line-241 guard `resolution === null` never matches `undefined` and the numeric/string resolution branches (256-274) are dead — all settlements flow through the price fallback (278-290), which has no closed/resolved precondition. (2) Eligibility filter (133-137) admits picks 15 min after event START; server.ts:213 runs the settle sweep every scheduled tick against live markets (fetchGammaMarket's first attempt uses no closed filter). (3) set


## P1

### [P1] Moneyline picks classified as 'other' — entire book de-vig/EV/CLV path never executes

`src/lib/markets.ts:61` — dimension: book-anchor — **status: fixed 2026-07-23 batch 1 — word-boundary matching incl. "vs."; 140 historical picks relabeled**

detectBetType only returns 'moneyline' when the haystack contains ' vs ' or ' at ' (space-delimited), but every Polymarket moneyline title uses 'vs.' with a period (e.g. 'Chicago White Sox vs. Texas Rangers'), so ML picks get bet_type='other'. Both book-anchor capture points gate the de-vig on betType === 'moneyline' (src/server/pipeline/book-odds.ts:148 pick-time, :227 close sweep), so book_ml_side/book_ml_opp/book_fair_prob/book_ev/book_close_ml_*/book_close_fair_prob/book_clv will NEVER be populated for any pick — the headline metrics of yesterday's deploy are structurally dead.

**Suggested fix:** Match 'vs.' in detectBetType (e.g. /\bvs\.?\b|\bat\b|@/ on the title) or, less invasively, make the book-odds gate accept picks that have a home/away venue_role and are not total/spread (mapMoneylinesToPick already null-guards). Then backfill bet_type for the 139 'other' picks.

**Verifier:** Confirmed end-to-end. markets.ts:61 matches only space-delimited ' vs '/' at '; real titles use 'vs.' so detectBetType returns 'other' (verified by tracing: no PARLAY/FUTURE/TOTAL/SPREAD/PROP keyword hits for 'chicago white sox vs. texas rangers'). manual-picks.ts:411 is the sole bet_type source, passed to captureBookAnchorForGame (:558) and persisted (:583); pick-backfill.ts:211 uses the same function. Both gates (book-odds.ts:148, :227) require exact 'moneyline', nulling all ML/fair-prob/EV/CLV fields. Remote D1 confirms: 304 picks = 139 'other' + 165 'total', zero 'moneyline'; sampled 'othe

### [P1] Doubleheader collision stamps espn_event_id from the wrong game — book anchors fetch the other game's odds

`src/server/pipeline/espn-schedule-ingestion.ts:294` — dimension: book-anchor — **status: open**

findExistingGame dedups on teams+sport within an inclusive ±6h window with LIMIT 1 and no ORDER BY, so both halves of an MLB doubleheader match one game row. The second ESPN event is swallowed (never creates a row), espn_event_id is stamped from whichever event happens to process first, and the finalization writes one game's score onto the shared row. Every book-anchor fetch keyed on that espn_event_id (pick-time captureBookAnchorForGame and the close sweep) then returns odds for the wrong game, and team_game_facts/trends inherit wrong scores and missing games.

**Suggested fix:** Shrink the dedup window (games >4h apart are distinct) or ORDER BY ABS(game_time - ?) and require the nearest match; when an existing row already has a different espn_event_id, create a new row instead of swallowing the event; re-verify espn_event_id against startDate proximity before stamping.

**Verifier:** Fully reproduced. Code: findExistingGame (espn-schedule-ingestion.ts:294-320) matches teams+sport within an inclusive ±6h window, LIMIT 1 no ORDER BY; the ingestion loop (lines 489-532) then skips row creation for the second doubleheader event, stamps espn_event_id only if NULL (first event wins), and skips finalization once alreadyFinal. No unique constraint on games, no doubleheader handling anywhere, not in docs/KNOWN-ISSUES.md. Live verification: ESPN scoreboard 2026-07-22 shows PIT@NYY at 17:05Z/23:05Z (exactly 6h apart — inclusive BETWEEN still matches) and BAL@BOS at 17:35Z/23:10Z; remo

### [P1] Timeout/exception after post_order treated as not-placed: live order can fill while bot forgets it and re-bets

`bot/bot.py:684` — dimension: bot — **status: open**

execute_live_trade submits a FOK market order (`response = client.post_order(signed, OrderType.FOK)`, line 684). If the HTTP call raises after the exchange accepted the order (timeout, dropped response, Cloudflare 403 on the response path), place_bet's except handler (lines 1029-1045) rewrites the trade as `trade["mode"] = "paper"`, sets placed_successfully=False, creates no pick, and does NOT add the conditionId to the placed set. The order may have actually filled on-chain: the position is untracked in D1 and the next poll re-places the same bet (double spend). There is no orderId reconciliation or open-order check anywhere in the file.

**Suggested fix:** On exception, query open orders / trade history by token_id before concluding the order failed; at minimum mark the conditionId placed pessimistically and reconcile on the next loop.

**Verifier:** Confirmed in /home/greg-czaplicki/Documents/Projects/polywhaler/bot/bot.py. post_order (line ~684) can raise after the exchange accepted/filled the FOK order (read timeout, dropped response); place_bet's except handler (~1029-1045) rewrites the trade as mode=paper and returns False (~1048-1049), so the caller (~1301-1314) never adds condition_id to placed/placed_meta or the group set. Dedup consults only those success-populated sets; the trade log recording the failed attempt is never read back, and grep confirms zero orderId reconciliation or open-order/get_trades checks anywhere in the file.

### [P1] Live fill permanently lost from D1 when the pick-creation POST fails; bot never sends the clientPickId idempotency key the server supports

`bot/bot.py:1098` — dimension: bot — **status: open**

Pick creation happens after the live order. If `post_json(.../api/bot/picks, ...)` (lines 1067-1092) throws, the handler at 1098-1099 only prints `"[bot] failed to log pick:"` — no retry, no queue — yet place_bet still returns True and the conditionId is marked placed, so the fill is never re-reported. A real-money position then exists with no manual_picks row: it is never graded, settled, or counted in ROI/CLV. The server explicitly supports idempotent creation via clientPickId (src/server/api/bot.ts line 2717 passes `payload.clientPickId`; manual-picks.ts lines 554-558 do `SELECT * FROM manual_picks WHERE client_pick_id = ?` before INSERT), but the bot's payload (bot.py 1070-1091) contains no clientPickId, so even a manual retry would duplicate.

**Suggested fix:** Generate a UUID clientPickId per trade, include it in the picks POST, and retry failed pick/execution reports from a local outbox on subsequent polls.

**Verifier:** Confirmed against code. bot/bot.py: live order executes first (execute_live_trade, line 1015); the pick POST (1067-1092) has no retry — post_json (407-426) is a single urlopen with 20s timeout — and the except at 1098-1099 only prints, then place_bet returns True (1103). run_loop (1301-1307, persisted 1327-1328) marks the conditionId placed so the POST is never reattempted. The bot payload contains no clientPickId (grep confirms zero occurrences in bot.py) even though the server supports idempotent create (src/server/api/bot.ts:2717; src/server/repositories/manual-picks.ts:554-562), and create

### [P1] Duplicate-bet guard is only the local state file, saved once per poll after all bets; server candidates never exclude already-picked conditions

`bot/bot.py:1331` — dimension: bot — **status: open**

run_loop places up to max_bets live orders inside the for-loop (line 1301) but persists placed/placedMeta only once at the end of the whole iteration (`save_state(config.state_path, state)`, line 1331). A crash/OOM/systemd restart between a live fill and that save loses every placed marker from the poll. The server offers no backstop: listBotCandidates (src/server/api/bot.ts line 1504) builds candidates purely from the sharp-money cache — grep shows zero references to manual_picks anywhere in bot.ts — so on restart the same conditions come back as candidates and the bot re-places real orders (each also creating a duplicate manual_picks row, since inserts are only deduped by the clientPickId the bot doesn't send).

**Suggested fix:** Call save_state immediately after each successful placement, and/or have listBotCandidates exclude conditions with a manual_pick in the last N hours.

**Verifier:** Confirmed against code. bot/bot.py: the only save_state in the poll path is line 1331, after the whole candidate loop; place_bet (956) fills live orders (execute_live_trade, 1015) without persisting placed markers, and load_state (184) never reconstructs state from the per-bet trade log. Server offers no backstop: listBotCandidates (src/server/api/bot.ts:1504) builds from listSharpMoneyCache only — zero manual_picks references in bot.ts — and createManualPick (src/server/repositories/manual-picks.ts:554) dedupes solely on client_pick_id, which bot.py never sends (zero occurrences). So a restar

### [P1] Market FOK order carries no price bound: fills at whatever the book shows, while the low-ROI gate is checked against a stale cached price

`bot/bot.py:677` — dimension: bot — **status: open**

place_bet gates on `entry.get("sharpSidePrice")` (line 964) — a price computed when the worker cached the candidate (grade.computedAt, potentially many minutes before execution) — including the `float(price) >= config.low_roi_threshold` skip at line 968. execute_live_trade then submits `MarketOrderArgs(token_id=token_id, amount=float(stake), side="BUY", order_type=OrderType.FOK)` (lines 677-682) with no price/limit argument and no fresh midpoint check (the bot fetches no live price at all before ordering). If the market moved between candidate computation and execution — exactly when sharp action is present — the FOK market order fills at the current book price, possibly far above the 0.72 ROI ceiling the strategy just enforced, and the resulting slippage_bps measures decision-price drift rather than execution quality.

**Suggested fix:** Fetch the live midpoint/best-ask before ordering, re-apply the low_roi_threshold and a max-drift-vs-decision-price bound, and pass an explicit worst-acceptable price to the order.

**Verifier:** Reproduced end-to-end. bot/bot.py:964-975 gates on entry["sharpSidePrice"], which the /api/bot/candidates handler (src/server/api/bot.ts:1546, toSlimCandidate:1338) sources from listSharpMoneyCache — a D1 cache refreshed on ~5-min pipeline cadence (staleness alarm only at >30 min), plus bot poll pacing that can stretch effective_poll_seconds. execute_live_trade (bot.py:677-685) then submits MarketOrderArgs(amount, side=BUY, order_type=FOK) with no price argument and no live book/midpoint fetch anywhere in the trade path (get_midpoint exists only in run_preflight, line 902); py-clob-client deri

### [P1] Sharp side A/B is hard-mapped to away/home team for ALL market types; inverts team linkage on spread picks and fabricates it on totals picks

`src/server/pipeline/pick-enrichment-helpers.ts:240` — dimension: data-integrity — **status: fixed 2026-07-23 batch 2 — resolvePickedSide: totals/props get no team side, name-match precedes positional mapping, A→away fallback restricted to moneyline; 155 poisoned totals/prop rows nulled (actual_total retained)**

resolvePickedSide strategy 1 maps pickedLabel 'a' -> awayTeamId/venue_role='away' and 'b' -> homeTeamId/'home' unconditionally, and strategy 2 maps a match on side_a_label to the away team. manual_picks.sharp_side stores literal 'A'/'B' for every bot pick (validated in resolvePickResult, manual-picks.ts:246-250), so this fires for every pick. But side A is only the away team for moneyline markets: in sharp-money.ts, O/U markets set sideALabel='Over' (line 2682) and spread markets set sideALabel=outcomes[0], the NAMED spread team (line 2686), which has no venue guarantee. Result: every totals pick gets a fabricated team_id/venue_role (Over -> away team, Under -> home team), and spread picks are inverted whenever outcomes[0] is the home team (e.g. 'PHI vs CHA: Spread: Hornets (-6.5)': candidate label 'hornets' equals side_a_label -> returned teamId = awayTeamId = 76ers, the wrong team). The correct spread fallback (extractSpreadPickedLabel -> mapPickedTeamToSide, pick-backfill.ts:271-284 and manual-picks.ts:463-476) is unreachable because strategies 1/2 always return first for 'a'/'b'. Poisoned team_id/opponent_id/venue_role then drive fav_dog_role derivation (deriveFavDogRole(homeSpread, isHomeTeam)), canonical feature extraction (canonical-features.ts snapshotType from venue+favdog), and every venue/favdog bucket in strategy-analysis — exactly the analytics slated to decide whether team trends get weight at the n~100 re-audit. The pick-backfill.ts header (lines 18-21) even records the OPPOSITE observed convention ('side_a has mapped to the home team and side_b to the away team'), so at minimum one whole class of picks is stored inverted. Not documented in KNOWN-ISSUES.md.

**Suggested fix:** Gate team-side resolution by bet_type: for totals, set no team_id/venue_role (or an explicit over/under marker); for spreads, resolve via extractSpreadPickedLabel + mapPickedTeamToSide FIRST; keep the a->away mapping only for moneyline markets after empirically verifying outcome[0] ordering against settled picks (resolved_outcome vs actual winner). Then re-backfill affected picks and re-derive venue_role/fav_dog_role.

**Verifier:** CONFIRMED with two refinements. Code verified: resolvePickedSide (pick-enrichment-helpers.ts:240-275) hard-maps 'a'/side_a_label→away and 'b'→home for all market types; sharp-money.ts sets side A=outcomeIndex 0 with sideALabel='Over' for O/U and outcomes[0] (named team, no venue guarantee) for spreads; neither enrichment caller (api/manual-picks.ts:427-480, pick-backfill.ts:235-291) gates by bet_type; strategy 1 never returns null for 'a'/'b' so the mapPickedTeamToSide spread fallback is unreachable for bot picks. Not in KNOWN-ISSUES.md. Empirically confirmed against remote D1: venue_role is a

### [P1] Unauthenticated pipeline/canonical ops endpoints, including force-trigger and full pick backfill

`src/server.ts:42` — dimension: ops — **status: mostly fixed 2026-07-23 batch 1 — canonical trigger/backfills gated by BOT_API_KEY bearer (fail closed); /_pipeline/trigger deliberately left open (UI calls it; equivalent to the 2-min cron tick)**

The worker handles POST /_pipeline/trigger, POST /_canonical/trigger, POST /_canonical/backfill-snapshots, and POST /_canonical/backfill-picks before the auth-carrying app handler, with no credential check of any kind. /_pipeline/trigger forwards the raw request body to the DO tick, so anyone can POST {"force":true} to bypass the 2-minute cooldown and re-queue the full market batch repeatedly (each re-run INSERTs new sharp_money_history rows and burns the shared Data-API/Gamma subrequest budget — the exact duplicate-history failure the 2026-07-20 hardening fixed for queue acks). /_canonical/backfill-picks?mode=full runs backfillManualPicks in full mode, which rewrites linkage fields (and per KNOWN-ISSUES overwrites spread_line/total_line) on every pick in manual_picks.

**Suggested fix:** Gate all /_pipeline/* and /_canonical/* routes behind APP_AUTH_SECRET/BOT_API_KEY bearer check (same pattern as requireBotAuth) before dispatching.

**Verifier:** Confirmed against code. src/server.ts:42-188 serves POST /_pipeline/trigger, /_canonical/trigger, /_canonical/backfill-snapshots, /_canonical/backfill-picks with no credential check; the only prior handlers are path-scoped (bot.ts:2340 /api/bot/*, bot-control.ts:66 /api/bot-control/*) and APP_PASSWORD auth lives only inside startFetch, reached after these branches. wrangler.jsonc has no routes/Access policy, so the worker is publicly reachable; sharp.tsx calls /_pipeline/trigger bare from the browser, confirming no cookie check exists. Force bypass verified: server.ts:47 forwards raw body to t

### [P1] detectBetType substring matching misclassifies bet_type (e.g. 'Thunder' contains 'under' -> total), corrupting persisted bet-type analytics

`src/lib/markets.ts:26` — dimension: scoring — **status: fixed 2026-07-23 batch 1 — word-boundary regexes; 140 historical picks relabeled (134 other→moneyline, 6 →prop)**

detectBetType uses naive substring .includes() over title+outcome+slug with keyword lists containing common substrings, and total/future/spread checks run before the moneyline check. Any market whose text contains 'under' as a substring — e.g. every Oklahoma City Thunder game ('Thunder vs. Pacers') — is classified 'total' even when it is a moneyline. TOTAL_KEYWORDS also contains regex-syntax literals ('goals?', 'points?', 'runs?') that can never match via .includes(), showing the list was written as regex but used as literals. SPREAD_KEYWORDS contains 'line', so any text containing 'moneyline' returns 'spread' (the moneyline branch at line 61 is unreachable for it); FUTURE_KEYWORDS ('winner', 'finals', 'title') fire before the total/moneyline checks on playoff-named events. This detected value is persisted as manual_picks.bet_type at pick creation (src/server/api/manual-picks.ts:411 'const betType = detectBetType({ title }) ?? null;') and in backfill (src/server/pipeline/pick-backfill.ts:211), then consumed by canonical analytics (src/server/api/canonical-analytics.ts:408 'betType: pick.bet_type') and canonical feature vectors (src/server/domain/canonical-features.ts:280), where scoreOpportunity routes betType==='total' through OU-only scorers (src/server/domain/opportunity-scoring.ts:97-115) — so misclassified picks are scored by the wrong scorer family in retrospectives. Meanwhile the bot's own classifier getMarketTypeLabel (src/server/api/bot.ts:689) classifies the same Thunder title correctly as moneyline (it requires 'o/u'/'over/under'/'total'), so decisionSnapshot.marketType and the bet_type column disagree for the same pick; grade summaries prefer the snapshot (src/server/repositories/manual-picks.ts:1146-1167) while canonical analytics use the column. The totals-vs-moneyline split is planned analysis #2 of the n≈100 re-audit, so this directly contaminates a decision-driving metric.

**Suggested fix:** Use word-boundary regexes (the '?' literals show that was the intent), check moneyline patterns ('X vs Y' with no total/spread markers) before keyword lists, and backfill bet_type for affected picks (at minimum re-run detection with the fixed classifier and reconcile against decisionSnapshot.marketType); align on one classifier for both the bet_type column and decisionSnapshot.

**Verifier:** CONFIRMED, with live production evidence. Code claims all reproduce: TOTAL_KEYWORDS=['total','over','under','o/u','goals?','points?','runs?'] matched via .includes() before the moneyline branch (src/lib/markets.ts:26,49-51,61); regex literals 'goals?/points?/runs?' can never match; SPREAD 'line' shadows 'moneyline'. D1 remote query found an actual corrupted row: "Sunderland AFC vs. Nottingham Forest FC: Both Teams to Score" persisted as bet_type='total' (decisionSnapshot.marketType='prop') because 'Sunderland' contains 'under' — the exact mechanism claimed. Also worse than claimed: ALL 134 mon

### [P1] Drift baseline coerces NULL day-averages to 0 and equal-weights days (avg-of-avgs)

`src/server/repositories/daily-stats-snapshots.ts:391` — dimension: summaries — **status: open**

buildDrift computes 7-day baselines as an unweighted mean of per-day averages, and days with no data are coerced to 0 instead of being excluded: `(row.manualPicks.avgRoi ?? 0)`, `(row.manualPicks.avgClv ?? 0)`, `(row.candidateFunnel.avgReturnedPerRun ?? 0)`, `(row.candidateFunnel.avgReturnRate ?? 0)`, each divided by `baseline.length`. A quiet week (avgRoi NULL) yields a baseline ROI of 0, so avgRoiDelta collapses to today's raw avgRoi; with CLV scrubbed to NULL for most history, avgClvDelta is measured against a fabricated 0 baseline. Separately, a day with 1 settled pick weighs the same as a day with 15, so the baseline is an avg-of-avgs, not a pooled average.

**Suggested fix:** Exclude NULL days from both numerator and denominator (average only over days where the metric is non-null), or pool: recompute baseline as sum(roiSum)/sum(roiCount) across days by storing sums/counts in the snapshot JSON.

**Verifier:** Confirmed against code. daily-stats-snapshots.ts:387-408 coerces NULL day-averages to 0 via `?? 0` while dividing by baseline.length, and equal-weights days (avg-of-avgs). NULL provably means "no data": manual-picks.ts ~696-717 maps SQL AVG(roi)/AVG(clv) with `?? null`, so zero-settled days store avgRoi=NULL and days whose picks all have scrubbed clv store avgClv=NULL. The CLV case is live today (2026-07-23): the 7-day baseline spans mostly pre-2026-07-20 days where clv was scrubbed to NULL, so pickClvBaseline is dragged toward a fabricated 0 and avgClvDelta approximately equals today's raw av

### [P1] Shadow-window summary silently restricted to picks with surviving sharp_money_history (~7-day retention), including the 'Actual entry' row

`src/server/repositories/manual-picks.ts:1713` — dimension: summaries — **status: open**

getManualPicksShadowWindowSummary skips any pick whose condition has no sharp_money_history rows — before even reaching the 'actual' window branch, which needs no history when pick.price exists. sharp_money_history is pruned at 7 days (sharp-money.ts:181 `HISTORY_RETENTION_HOURS = 24 * 7`), so every row of every window — including 'Actual entry' hitRate/avgRoi — reflects only roughly the last week of settled picks, while `settledPicks` and `matchedPicks` report the full population. KNOWN-ISSUES item 1 designates this summary as the trustworthy CLV view while persisted clv heals, making the hidden recency filter decision-relevant: its hit rates and ROIs look like all-time segment stats but are a small recent subsample.

**Suggested fix:** For the 'actual' window, only require history for the CLV component (apply the pick to the bucket with clv undefined when history is missing); alternatively expose a `withHistory` count per segment so the effective denominator is visible.

**Verifier:** Confirmed by direct code reading; could not refute. Chain of evidence: (1) src/server/repositories/manual-picks.ts:1712-1714 — inside getManualPicksShadowWindowSummary, `const history = historyByConditionId[candidate.pick.conditionId]; if (!history || history.length === 0) continue;` executes before the `if (window.key === "actual")` branch at line 1720, so picks with no surviving history are dropped from every window row including "Actual entry". (2) The actual branch does not need history when `pick.price` is a finite positive number (lines 1721-1730): history is only the fallback entry pric


## P2

### [P2] book_source hardcoded 'espn_draftkings' even when the pickcenter entry is a fallback non-DK provider

`src/server/pipeline/book-odds.ts:111` — dimension: book-anchor — **status: fixed 2026-07-23 batch 1 — source derived from actual provider; book_close_source added (migration 0019)**

captureBookAnchorForGame sets source = 'espn_draftkings' unconditionally whenever the live ESPN fetch yields any pickcenter entry, but selectPickcenterEntry falls back to summary.pickcenter[0] (any provider) when DraftKings is absent. The provider is never recorded, so book_* rows can silently mix books; worse, pick-time and close-time captures can come from DIFFERENT providers, making book_clv a cross-book comparison with no trace in the data.

**Suggested fix:** Record entry.provider.name (or id) into book_source and add a book_close_source column; optionally only compute book_clv when open and close providers match, or at least when both are DK.

**Verifier:** Confirmed against code. book-odds.ts:111 sets source='espn_draftkings' and the live-fetch path (114-118) never reassigns it; only the game_lines DB fallback (143) changes it. selectPickcenterEntry (espn-schedule-ingestion.ts:86-95) explicitly falls back to summary.pickcenter[0] of any provider when no name matches 'draftkings', and entry.provider (available in the type, line 65-66) is discarded — never read in book-odds.ts. The close sweep (207-258) writes book_close_*/book_clv with no source/provider column at all, so pick-time and close-time captures from different providers are indistinguis

### [P2] Close sweep livelock: permanently-failing ESPN fetches are retried forever and starve older picks

`src/server/pipeline/book-odds.ts:208` — dimension: book-anchor — **status: fixed 2026-07-23 batch 1 — RANDOM() candidate order + 14-day give-up stamp**

captureBookClosesForPicks selects `ORDER BY p.picked_at DESC LIMIT 8` and, when fetchEspnSummary returns null (any non-OK HTTP status, including permanent 404s from stale/reissued event ids — ESPN reissues event ids for rescheduled/makeup games, e.g. the 4018987xx makeup ids observed on 2026-07-22), the pick is left unstamped with no retry counter or backoff. Such picks are re-selected every scheduled tick forever, burning up to 8 subrequests/tick; once the number of permanently-failing settled picks reaches the limit (8), every older unstamped pick is starved of book-close capture indefinitely.

**Suggested fix:** Add a retry cap: after N failed attempts (or when the pick settled more than ~7 days ago) stamp book_close_captured_at with null fields; distinguish 4xx (stamp immediately) from 5xx/network (retry) in fetchEspnSummary.

**Verifier:** Confirmed against actual code. (1) src/server/pipeline/book-odds.ts:193-203 selects unstamped settled picks ORDER BY picked_at DESC LIMIT 8 with no age cutoff or retry counter; src/server.ts:227 runs it every scheduled tick. (2) fetchEspnSummary (espn-schedule-ingestion.ts:184-189) returns null identically for transient and permanent HTTP errors; empirically verified ESPN summary returns HTTP 404 (not 200/empty) for a nonexistent event id, so the terminating pickcenter-absent stamp path (book-odds.ts:213-224) is never reached. (3) The 404 is permanent: ingestion only stamps espn_event_id when 

### [P2] stop_on_403 Cloudflare kill switch is dead code: ray-ID regexes contain literal backslashes and can never match

`bot/bot.py:819` — dimension: bot — **status: open**

extract_cloudflare_ray_id uses raw strings with a doubled backslash: `r"Cloudflare Ray ID:\\s*<strong..."` and `r"Cloudflare Ray ID:\\s*([A-Za-z0-9]+)"`. In a raw string `\\s` is regex 'literal backslash then s', not whitespace, so the pattern requires a literal `\` after the colon — real Cloudflare block pages have a space. Verified empirically: both patterns return None against genuine Cloudflare 403 HTML while the single-backslash version matches. Consequence: `trade["cloudflareRayId"]` is never set and the `config.stop_on_403` shutdown path (lines 1041-1044) never fires — the bot keeps hammering an edge that is actively blocking it (the exact failure mode this switch was added for), with every attempt logged as a mode='paper' trade.

**Suggested fix:** Replace `\\s` with `\s` in both patterns (or match on 'error code: 1020' / HTTP 403 + cloudflare markers instead of parsing HTML).

**Verifier:** Confirmed. bot/bot.py:819,822 use r"Cloudflare Ray ID:\\s*..." — in a raw string \\ is a regex-escaped literal backslash followed by s*, so the pattern demands a literal '\' after the colon; real Cloudflare pages have a space. Empirically reproduced: both patterns return None on genuine block-page text while the single-backslash version extracts the ray ID. No alternate guard: extract_cloudflare_ray_id (line 1033) is the sole trigger for stop_on_403 (line 1041 is nested inside `if ray_id:`), and there is no status-code-based 403 check anywhere in the file. stop_on_403 defaults to True (BOT_STO

### [P2] Gamma token-map fallback queries an arbitrary market and permanently negative-caches, disabling live trading for a condition after one transient CLOB failure

`bot/bot.py:537` — dimension: bot — **status: open**

fetch_token_map calls `gamma-api.polymarket.com/markets?condition_id=...` (lines 537-546). Verified live: Gamma ignores the `condition_id` parameter (a request with condition_id=0x000...0 returned an unrelated market, 'New Rihanna Album before GTA VI'), and Gamma market objects contain no `tokens` field at all (they expose `clobTokenIds`/`outcomes`), so `market.get("tokens") or []` is always empty and the function always returns [] — but first it executes `_token_cache[condition_id] = mapped` (line 577), permanently caching the empty list. Since fetch_clob_token_map checks `if condition_id in _token_cache: return` (line 512) before hitting the CLOB, one transient CLOB /markets error (its `except Exception: data = {}` at 517-518 doesn't cache, but then resolve_token_id falls through to fetch_token_map which does) makes every subsequent live trade for that condition fail with 'token_id not found' until process restart.

**Suggested fix:** Drop or rewrite the Gamma fallback to parse clobTokenIds+outcomes with the correct query param, and never cache empty results.

**Verifier:** Confirmed by code inspection and live API reproduction. Gamma /markets ignores the singular condition_id param (bogus 0x0..0 returned the unrelated 'New Rihanna Album before GTA VI' market; the correct param is condition_ids, plural), and Gamma market objects expose clobTokenIds/outcomes but no tokens field, so fetch_token_map (bot/bot.py:532-578) always produces mapped=[] and unconditionally executes _token_cache[condition_id]=[] at line 577 (line 557 does the same on the empty branch). _token_cache is a process-lifetime module global (line 468) shared with fetch_clob_token_map, whose line-51

### [P2] Bankroll is only ever debited — never credited on settlement — so Kelly stakes decay monotonically until the bot silently stops betting

`bot/bot.py:1100` — dimension: bot — **status: open**

After every placement (paper and live), `state["bankroll"]` is reduced by the stake (lines 1100-1102). Nothing in bot.py ever adds winnings back or reconciles against outcomes — the bot has no settlement path at all. With default sizing (`stake = bankroll * kelly * kelly_fraction`, line 978), the bankroll declines strictly monotonically across the persisted state file, stakes shrink proportionally, and once `stake < config.min_stake` every candidate is skipped with 'skip tiny stake' (lines 982-984) — the bot dies quietly with no error. With BOT_FIXED_STAKE set, stakes are unaffected but bankroll still drains linearly and goes negative in state.json, making any future switch back to Kelly sizing produce negative stakes fed into `min(stake, max_stake)`.

**Suggested fix:** Credit settled wins (or periodically re-sync bankroll from actual/paper P&L via the outcomes endpoint), and floor bankroll at 0 with a loud warning.

**Verifier:** Confirmed. bot/bot.py has exactly one bankroll debit (lines 1100-1102, unconditional for paper and live) and one init (1128-1129); no credit/settlement path exists anywhere in bot/ (greps for settle/payout/winnings hit only token-outcome label mapping). State persists across restarts (save_state at 1331 dumps full dict each poll; load_state reads it; init only when key absent), so decay is permanent. Kelly path (line 978) makes stakes proportional to bankroll; once stake < min_stake (default $1), lines 982-984 skip every candidate with only a 'skip tiny stake' print — silent death. Empirical: 

### [P2] Trend snapshots computed for late-processed games include results of games played after the snapshot's as_of_time (lookahead)

`src/server/pipeline/snapshot-computation.ts:117` — dimension: data-integrity — **status: open**

computeSnapshotsForGame calls computeSnapshotsForTeam(db, homeTeamId, sportTag, gameId, gameTime) with NO options, so buildFilterForSnapshotType gets beforeGameTime=undefined and listTeamGameFacts (team-game-facts.ts:162-176) just takes the 10 most recent facts by game_time DESC at processing time. Whenever a game is fact-processed out of chronological order — e.g. a game created 1-3 days late by espn-schedule ingestion (team alias seeded late, ESPN fetch failure that day) and finalized immediately at creation (espn-schedule-ingestion.ts:520-531), then picked up by processUnprocessedGames (which selects 'is_final AND no facts' regardless of when neighbors were processed) — the snapshot stamped as_of_time = that old game's start time contains facts of games PLAYED AFTER it. getTeamTrendSnapshotAsOf's strict `as_of_time < ?` (fixed in the 2026-07-20 hardening) assumes as_of_time bounds the window content; this violates that invariant from the write side. Every retrospective as-of consumer — extractPickFeatures (canonical-features.ts:219-249, asOfTime=picked_at), getPickContextFn (canonical-analytics.ts:370-397), and all strategy-analysis trend buckets built on them — can silently receive future results for picks whose picked_at falls between the late game and the newer games it absorbed. Same species as the fixed <= boundary bug, but content contamination instead of boundary contamination; not documented anywhere.

**Suggested fix:** In processGame, pass { beforeGameTime: gameTime + 1 } (or an explicit inclusive bound of the as-of game) so the window can never contain facts with game_time > as_of_time; additionally, after processing a late game, invalidate/recompute snapshots for that team whose as_of_time > the late game's time (their windows are missing it).

**Verifier:** Confirmed mechanically. computeSnapshotsForGame (snapshot-computation.ts:117-119) and its only production caller processGame (canonical-pipeline.ts:69-76) pass no beforeGameTime, so listTeamGameFacts (team-game-facts.ts:161-165) takes the 10 most recent facts at processing time with no upper time bound. Snapshots are keyed ON CONFLICT(team_id, snapshot_type, as_of_game_id), so a late-processed old game writes a retained historical row stamped with the old game's time but containing newer games' results. Trigger path is real: ingestEspnSchedule has lookback=3 days and skips unresolved teams, so

### [P2] Polymarket 'close' line ingestion writes home_spread from title orientation even when the game matched with reversed team order — sign-inverted spreads corrupt fav/dog and ATS grading

`src/server/pipeline/canonical-sync.ts:211` — dimension: data-integrity — **status: open**

getLineInputsFromCache matches a cache market to a canonical game accepting EITHER team ordering — the comment says 'Match either (home, away) or (away, home) ordering since market title parsing may not always get home/away correct' — but then passes only marketTitle to batchIngestLines. ingestLineFromMarket (line-ingestion.ts:180-194) derives home_spread purely from title position ('first'-listed team = away, else home, 'or indeterminate — assume home'). When the reversed branch matched (i.e. the canonical game's home team is the title's first-listed team), the assigned home_spread has the WRONG SIGN. That inverted close spread then drives deriveFavDogRoles (fact-computation.ts:307-328) and deriveAtsResult for BOTH teams' team_game_facts, flipping favorite<->dog and cover<->no_cover, which flows into team_trend_snapshots favorite/dog splits and picks' fav_dog_role. This is distinct from the documented 2026-07-23 caveat (close rows are first-observed/stale): staleness bounds magnitude error, this is orientation corruption. The 'indeterminate — assume home' guess at line-ingestion.ts:188-190 is a second, independent coin-flip on the same field.

**Suggested fix:** Return which ordering matched from the game query and flip the spread sign when the reversed branch matched; drop the 'assume home' fallback (skip instead). Audit existing polymarket-sourced close rows against book_close_spread_line where available.

**Verifier:** Confirmed against actual code. canonical-sync.ts:211-230 matches either team ordering but discards which branch matched, passing only marketTitle (lines 235-240). ingestLineFromMarket (line-ingestion.ts:180-194) re-derives home_spread from title position assuming first-listed=away — unrecoverable after a reversed-order match. Reachable: espn-schedule-ingestion.ts creates games with authoritative ESPN home/away, so any Polymarket title listing the true home team first matches via the reversed branch and stores a sign-inverted home_spread. Downstream deriveFavDogRoles (fact-computation.ts:307-32

### [P2] Straggler finalization queries the ESPN scoreboard by UTC date of game_time; evening US games live on the previous ET slate and are never found

`src/server/pipeline/result-ingestion.ts:274` — dimension: data-integrity — **status: fixed 2026-07-23 batch 1 — same Eastern-date fix**

finalizeCompletedGames groups unfinalized games by formatDateUTC(game.gameTime) and fetches scoreboard?dates=YYYYMMDD for that UTC date. ESPN's scoreboard dates parameter groups events by the US/Eastern slate date. Any game starting 00:00-04:00 UTC (8pm ET through West-coast late games — a large share of MLB/NBA slates) has a UTC date one day after its ESPN slate date, so the fetched scoreboard doesn't contain it and findMatchingScore returns null every cycle ('not_found'). These games are exactly the ones most likely to need this straggler path (espn-schedule ingestion covers most games via its own -3..+1 date loop with per-event startDate matching, which is why the bug is masked). Games that depend on this path (e.g. polymarket-created games espn-schedule never matched) stay unfinalized permanently -> no team_game_facts -> systematic underrepresentation of late/West-coast games in trend windows (survivorship species).

**Suggested fix:** Fetch both the UTC date and the previous day (or compute the ET date: game_time - 4/5h before formatting), or match by team+time window across a 2-day scoreboard union as espn-schedule ingestion effectively does.

**Verifier:** CONFIRMED, with live-API reproduction. (1) Code check: result-ingestion.ts:274 groups by formatDateUTC(game.gameTime) (UTC calendar date, lines 130-136) and fetches exactly one scoreboard date per game (line 287) with no adjacent-date fallback. (2) Empirical check against ESPN today: `dates=20260721` (MLB) returns 7 events with startDate 2026-07-22T00:00Z-01:40Z (the 8pm-10:40pm ET games), and `dates=20260722` does NOT contain any of them — its earliest event is 17:05Z. So ESPN's dates param groups by the US/Eastern slate, and any game starting 00:00-04:00 UTC has a UTC date one day past its s

### [P2] result-ingestion queries ESPN scoreboard by UTC date, but ESPN groups games by US-Eastern date — night games can never be finalized by the straggler path

`src/server/pipeline/result-ingestion.ts:130` — dimension: ingestion — **status: fixed 2026-07-23 batch 1 — straggler path now keys scoreboard fetches by US-Eastern date**

finalizeCompletedGames computes the scoreboard date with formatDateUTC(game.gameTime) and fetches exactly that one date, but ESPN's scoreboard `dates=YYYYMMDD` parameter is keyed to the US-Eastern game day. Any game starting 00:00-04:59 UTC (i.e., every US prime-time game, ~8pm ET and later) has a UTC date one day ahead of its ESPN date, so the fetch hits the wrong day's scoreboard and findMatchingScore returns not_found forever. espn-schedule-ingestion masks this for games finalized within its 3-day lookback, but any straggler older than that which is a night game is permanently unfinalizable — no score, no team_game_facts, no trend contribution.

**Suggested fix:** Compute the ESPN date in America/New_York (as sharp-money.ts already does via getEasternDateString), and/or fetch dateStr and dateStr-1 for games whose UTC hour is < 05.

**Verifier:** Mechanism CONFIRMED, evidence REFUTED, severity downgraded. The code defect is real: result-ingestion.ts:130/274 keys the ESPN fetch to the game's UTC date, but ESPN's scoreboard dates= param is US-Eastern-keyed — verified live: SAS@MIN starting 2026-05-16T01:30Z is listed under dates=20260515 while dates=20260516 returns zero events. Any real game starting 00:00-03:59 UTC that reaches the straggler path (i.e., escapes espn-schedule-ingestion's 3-day lookback, e.g., during a >3-day pipeline outage) fetches the wrong day's scoreboard and returns not_found forever. However, the finding's product

### [P2] Permanently-unfinalizable games accumulate with no age cutoff against result-ingestion's LIMIT 50 ASC scan — progressive starvation of game finalization

`src/server/pipeline/result-ingestion.ts:255` — dimension: ingestion — **status: open**

finalizeCompletedGames takes the 50 OLDEST unfinalized games per sport (listUnfinalizedGames orders game_time ASC, LIMIT 50) and only then filters for eligibility. Games that can never finalize — postponed/cancelled games, ET/UTC-date victims (previous finding), phantom rows from bad market event times — are permanent residents at the head of that ASC scan. Production already has 29 such residents (20 MLB, 9 NBA; oldest 2026-04-25). Once a sport accumulates 50, result-ingestion is 100% starved and no new straggler ever gets a score again; MLB is at 20/50 and climbing. Missing finals cascade into missing team_game_facts and biased team_trend_snapshots, which the planned n≈100 re-audit (analysis 1) will read.

**Suggested fix:** Add a max-age cutoff or a not_found retry counter that marks games abandoned (e.g., a status column), and order the scan game_time DESC so fresh stragglers are always processed first.

**Verifier:** CONFIRMED mechanically: listUnfinalizedGames (game-ingestion.ts:283-291) is ORDER BY game_time ASC LIMIT 50 with eligibility filtered only after the limit (result-ingestion.ts:255, 265-269); there is no age cutoff, retry cap, or persisted terminal status, so unmatchable games occupy head-of-scan slots forever. Live D1 query reproduces the claimed state exactly: mlb=20 stuck (oldest 2026-04-25), nba=9. Not in docs/KNOWN-ISSUES.md. At 50 residents per sport the result-ingestion scan is permanently starved with no recovery path. HOWEVER, severity is overstated: the finding ignores a second finali

### [P2] 6-hour game dedup window collapses MLB doubleheaders into one canonical game row

`src/server/pipeline/game-ingestion.ts:68` — dimension: ingestion — **status: open**

findExistingGame (and its twin in espn-schedule-ingestion.ts:294) matches any game with the same home/away teams within +/-6 hours. A traditional MLB doubleheader's two games start ~4-6h apart, so game 2's ESPN event matches game 1's row: the second createGame never happens, game 1's final score is kept (updateGameResult skipped once alreadyFinal), and game 2's result, lines, and facts silently vanish from the canonical layer. Team trend windows (last-10) then run over an incomplete game set for those teams, and any pick made on game 2 of a doubleheader backfills onto game 1's row (pick-backfill uses the same +/-6h team match) — enriching it with the wrong game's margin/total facts.

**Suggested fix:** Shrink the window for MLB (e.g., 3h) or additionally discriminate on espn_event_id when the incoming event carries one that differs from the matched row's.

**Verifier:** Confirmed by reading all three cited sites. espn-schedule-ingestion.ts:294-320 matches games only on team pair + inclusive ±6h game_time window (LIMIT 1), never on espn_event_id; line 493 only sets espn_event_id when null, so DH game 2's event id is never recorded. Lines 489-491/520: matched row already finalized with game 1's scores sets alreadyFinal=true, skipping updateGameResult — game 2's result is dropped, and ingestOddsForGames (353-356) skips its lines because game 1's row already has a close snapshot. game-ingestion.ts:68-103/158-165 has the identical window on the Polymarket path and

### [P2] fetchTrendingSportsMarkets swallows all errors into { markets: [] }, defeating the cooldown-only-after-success hardening and faking 'no_markets' during outages

`src/server/api/sharp-money.ts:1250` — dimension: ingestion — **status: open**

The whole market-discovery function is wrapped in a catch that returns { markets: [] }, and per-series pagination failures just `break` with partial pages kept (only a metrics counter records it). The SharpPipeline tick was hardened on 2026-07-20 to 'burn the cooldown only once the market fetch has succeeded', but since the fetch cannot fail visibly, a Gamma outage or mid-pagination failure still burns the 2-minute cooldown, overwrites pipeline status with totalQueued:0, and logs 'no_markets' — exactly the graceful-degradation failure mode the Incident 2 postmortem called out. Data goes stale for the whole interval chain with no retry-now behavior and no error status.

**Suggested fix:** Have fetchTrendingSportsMarkets return an explicit error/partial flag (it already tracks failureCount); in the DO tick, skip the lastRun write and return reason:'fetch_failed' when the flag is set.

**Verifier:** Confirmed against code. fetchTrendingSportsMarkets cannot fail visibly: fetchWithRetry (sharp-money.ts:500-522) returns null rather than throwing; the per-page null check (1008-1013) breaks with partial pages kept; the per-series catch (1097-1101) and outer catch (1250-1253, returns {markets:[]}) swallow the rest. So sharp-pipeline.ts:103-118's comment 'burn the cooldown only once the market fetch has succeeded' rests on a false premise — during a Gamma outage the tick still burns the 2-min cooldown (DEFAULT_INTERVAL_MS, line 31), overwrites status with totalQueued:0, and returns 'no_markets',

### [P2] Book-anchor lines are stamped 'espn_draftkings' even when the DraftKings provider is absent and a different sportsbook's odds are used

`src/server/pipeline/book-odds.ts:111` — dimension: ingestion — **status: fixed 2026-07-23 batch 1 — same provider-derivation fix**

selectPickcenterEntry falls back to summary.pickcenter[0] (any provider ESPN lists) when DraftKings is missing, but every consumer hardcodes the source label: captureBookAnchorForGame sets source='espn_draftkings' regardless of which provider was selected, and ingestOddsForGames writes game_lines rows with source 'espn_draftkings' the same way. captureBookClosesForPicks records no provider at all. book_clv — designated in the 2026-07-20 audit as the primary skill metric for the n≈100 re-audit — can therefore compare a pick-time DraftKings line against a close from a different book (or vice versa), injecting cross-book vig/line differences into the metric with no way to filter them out afterward.

**Suggested fix:** Return the chosen provider name from selectPickcenterEntry and stamp it into source / a book_close_source column; or refuse the fallback for book_* anchor captures so the metric stays single-book.

**Verifier:** Verified in code. selectPickcenterEntry (src/server/pipeline/espn-schedule-ingestion.ts:86-95) silently falls back to pickcenter[0] (any provider); captureBookAnchorForGame (src/server/pipeline/book-odds.ts:111) hardcodes source='espn_draftkings' without ever reading entry.provider, and that flows into manual_picks.book_source (src/server/api/manual-picks.ts:595); ingestOddsForGames (espn-schedule-ingestion.ts:375) hardcodes the same label on game_lines; captureBookClosesForPicks (book-odds.ts:239-258) records no provider at all, so non-DK closes feeding book_clv are undetectable post-hoc. Not

### [P2] Canonical sync cooldown races with in-flight runs; games dedup is SELECT-then-INSERT with no unique constraint, so overlapping syncs can create duplicate games

`src/server.ts:240` — dimension: ops — **status: open**

The scheduled cooldown reads lastRunAt from canonical_sync_runs, which is only written by persistSyncRun at run COMPLETION. An in-flight sync is invisible, so any sync taking longer than the 2-minute cron interval guarantees a second concurrent sync (every subsequent tick sees an even-older lastRunAt and passes the 5-minute check). Game dedup in both ingestion paths is a bare SELECT followed by INSERT, and migrations define no unique index on games (only non-unique idx_games_* in 0012), so interleaved concurrent syncs can insert duplicate game rows; duplicate game ids then produce duplicate team_game_facts rows (unique only per game_id+team_id) and double-counted team_trend_snapshots records feeding canonicalScore. The unauthenticated /_canonical/trigger (finding 1) makes concurrent runs trivially inducible from outside.

**Suggested fix:** Persist a run-started marker (or DO-held lock) before the sync begins and check it in the cooldown; add a unique index on games(sport_tag, home_team_id, away_team_id, game_time) or use INSERT ... ON CONFLICT.

**Verifier:** Reproduced end-to-end. (1) Cron is */2 min (wrangler.jsonc:87); scheduled cooldown (src/server.ts:243-250) reads lastRunAt from canonical_sync_runs, which is written ONLY by persistSyncRun after run completion (canonical-sync.ts:488-511, called at server.ts:256-257) — no running-state row or lock exists, so any sync longer than 2 min guarantees a concurrent second run. (2) /_canonical/trigger (server.ts:87-98) has no auth and no cooldown — two parallel POSTs induce concurrency directly, no long run needed. (3) Game dedup is bare SELECT-then-INSERT in both paths (game-ingestion.ts:86-99+169, es

### [P2] Migration and setup scripts target D1 database name 'polywhaler', which does not exist — config name is 'polywhaler-db'

`package.json:17` — dimension: ops — **status: open**

The documented migration path `pnpm run migrate:d1:remote` runs `wrangler d1 migrations apply polywhaler --remote`, but wrangler.jsonc declares database_name 'polywhaler-db' (binding POLYWHALER_DB). Verified against the live account with `wrangler d1 list`: databases are triadic-db, sward-db, polywhaler-db, parlaywhaler — there is no 'polywhaler', so the script fails on every run, meaning migrations (including 0018 applied 2026-07-23) are being applied ad hoc outside the tracked migrations flow. scripts/verify-setup.sh (lines 83, 103, 116, 125) and scripts/backfill-event-timestamps.mjs (line 12: `['d1', 'execute', 'polywhaler', '--json', ...]`) repeat the wrong name. Extra hazard: the shared account's OTHER project's DB is named 'parlaywhaler' — one typo-distance from the wrong name these scripts use — and CLAUDE.md forbids touching it or creating new DBs to 'fix' the lookup failure.

**Suggested fix:** Replace 'polywhaler' with 'polywhaler-db' in package.json:17, scripts/verify-setup.sh, and scripts/backfill-event-timestamps.mjs; run migrations list to reconcile drift between applied schema and the migrations table.

**Verifier:** CONFIRMED by direct reproduction, not just code reading. (1) /home/greg-czaplicki/Documents/Projects/polywhaler/package.json:17 runs `wrangler d1 migrations apply polywhaler --remote`; wrangler.jsonc (lines 12 and 52, top-level and env.preview) declares only database_name 'polywhaler-db' / binding 'POLYWHALER_DB' — no alias 'polywhaler' anywhere. (2) I ran `wrangler d1 list` on the live account: databases are triadic-db, sward-db, polywhaler-db (5c45f749-...), parlaywhaler — no 'polywhaler'. (3) I executed the exact command verify-setup.sh:103 uses (`wrangler d1 execute polywhaler --remote --c

### [P2] Observability not enabled: the staleness alarm and all failure logs are ephemeral console output with no sink

`wrangler.jsonc:85` — dimension: ops — **status: open**

wrangler.jsonc has no `observability` block (and no logpush/tail_consumers), so Workers Logs persistence is disabled. Every failure path in the scheduled tick — including the `[sharp-pipeline] STALE` alarm added in the 2026-07-20 hardening sweep specifically to catch silent degradation — is a console.error visible only in a live `wrangler tail` session that nobody runs continuously. The alarm designed to prevent 'pipeline degrades silently while every tick reports success' is itself silent: a repeat of the graceful-degradation failure mode behind Incident 2 (pagination blind spot unnoticed for weeks).

**Suggested fix:** Add `"observability": { "enabled": true }` to wrangler.jsonc so alarms are queryable in Workers Logs, and/or persist STALE events to a table or push to an external webhook.

**Verifier:** Reproduced fully. wrangler.jsonc (91 lines, read in full) has no observability/logpush/tail_consumers key in top-level or env.preview; src/server.ts:274-279 confirms the STALE alarm's sole action is console.error, and all six cited .catch(console.error) paths exist. No alternate sink (sentry/webhook/etc.) anywhere in src/. Refutation attempts failed: (1) docs/KNOWN-ISSUES.md mentions the STALE log as an operational note but relies on it being read — it does not document the no-sink limitation, so this is not a documented/accepted issue in the refuting sense; (2) freshness IS exposed pull-based

### [P2] resolvePickedSide Strategy 2 assumes sideA label = away team; for spread markets sideALabel comes from outcomes[0], so team_id/venue_role/fav_dog_role invert when the named team is home

`src/server/pipeline/pick-enrichment-helpers.ts:258` — dimension: scoring — **status: fixed 2026-07-23 batch 2 — resolvePickedSide: totals/props get no team side, name-match precedes positional mapping, A→away fallback restricted to moneyline; 155 poisoned totals/prop rows nulled (actual_total retained)**

resolvePickedSide maps a picked label that equals the cached sideALabel to the AWAY team and sideBLabel to the HOME team (Strategy 2, lines 258-275; Strategy 1 does the same for literal 'a'/'b'). That mapping is only valid when sideALabel is the first team in an 'Away vs Home' title. For moneyline markets sharp-money.ts derives sideALabel from title order, but for spread markets it uses `sideALabel = outcomes?.[0]` (sharp-money.ts:2686), whose order is not tied to title order. For a market like 'PHI vs CHA: Spread: Hornets (-6.5)' with outcomes ['Hornets','76ers'], the picked label 'Hornets' (home team CHA) matches normA and Strategy 2 returns the AWAY team's id — assigning teamId/opponentId/venueRole/isHomeTeam to the wrong franchise before the more reliable name-based Strategy 3 (lines 279+) can run. isHomeTeam then feeds deriveFavDogRole (lines 165-174), inverting fav_dog_role, and venue_role/team_id drive trend-snapshot joins and canonical analytics. The function's own docstring contradicts the code ('side_a ... maps to the home team' at lines 202-203, while the code maps A to away), evidence this mapping has already been confused once.

**Suggested fix:** Run the team-name substring match (Strategy 3) before the positional Strategy 2, or make Strategy 2 verify the side label against homeTeamName/awayTeamName instead of assuming A=away; audit persisted venue_role/fav_dog_role on spread picks.

**Verifier:** CONFIRMED with live data. Remote sharp_money_cache currently holds two spread rows and BOTH exhibit the hazard: side_a_label is the named team, which is the HOME team ('ARI vs STL: Spread: St. Louis Cardinals (-1.5)' -> A='St. Louis Cardinals'; 'SD vs ATL: Spread: Atlanta Braves (-1.5)' -> A='Atlanta Braves'), while title convention is away-first (team-seeder.ts parseTeamsFromTitle:1904-1906). Concrete failure: for the ARI/STL market, extractSpreadPickedLabel yields 'St. Louis Cardinals', which exactly equals normA, so Strategy 2 (pick-enrichment-helpers.ts:259-266) returns teamId=awayTeamId (

### [P2] calculateSharpScore: an empty side scores 50 while a neutral populated side scores ~27 — the normalization contradicts its own comment and inflates no-holder sides

`src/server/api/sharp-money.ts:1919` — dimension: scoring — **status: open**

calculateSharpScore returns 50 ('Neutral score') when a side has zero holders (lines 1896-1898), but the normalization for populated sides is `((weightedSum - 0.25) / (3.0 - 0.25)) * 100` (line 1919), which maps the average-quality case weightedSum=1.0 (all momentum/pnl weights 1.0) to 27.3, not 50 as the adjacent comment claims ('Scale so that 1.0 = 50'). Consequently a side with NO money on it scores nearly double a side full of exactly-average holders: sharpSide determination (diff > 5, line 2697) and scoreDifferential can favor the empty side, fade boosts multiply the inflated 50 (line 2667: `Math.min(100, sideARawScore * fadeBoostFromSideB)`), and fairPrice = scoreA/(scoreA+scoreB) (computePriceEdgeFromEntry line 832) treats the empty side as ~65% likely against a weak-holder side. Bot picks are shielded only because isReady requires minHolderCount >= 10 (repositories/sharp-money.ts:330-333) and requireReady defaults true — but the inflated scores are persisted to sharp_money_cache/history and feed UI, edge-stats summaries, and the shadow-window CLV recomputation that KNOWN-ISSUES designates as the trustworthy view.

**Suggested fix:** Make the two neutral points agree: either return the populated-neutral value (~27.3) for empty sides, or use a piecewise scale that actually maps 1.0 to 50; alternatively return null for empty sides and force sharpSide='EVEN' when either side lacks holders.

**Verifier:** CONFIRMED. Math reproduces exactly: sharp-money.ts:1896-1898 returns 50 for an empty side, while lines 1907-1919 map an all-neutral populated side (momentumWeight 1.0 at line 1735, pnlTierWeight 1.0 at lines 1760-1783 → weightedSum 1.0) to (1.0−0.25)/2.75×100 = 27.3, contradicting the "1.0 = 50" comment (whose three anchors 0.25→0/1.0→50/3.0→100 are not even mutually consistent under a linear map). A populated side needs weightedSum ≈ 1.625 (genuinely sharp holders) just to tie an empty side. Concrete failure: thin market with 0 holders on side B and 5 neutral holders on side A → sideB scores 

### [P2] /api/bot/picks/outcome wipes valid close_price/clv on any call and can un-settle picks (settleManualPick has no status guard)

`src/server/api/bot.ts:2808` — dimension: settlement — **status: open**

The outcome endpoint always calls settleManualPick with `closePrice: null, clv: null`, and settleManualPick (src/server/repositories/manual-picks.ts lines 759-771) unconditionally overwrites status, settled_at, resolved_outcome, close_price, roi and clv with no `WHERE status='pending'` guard. One call against a pick already settled by the cron destroys its genuine post-2026-07-20 close_price/clv (the exact data the b40fec0 scrub was done to protect). The endpoint also trusts client-supplied `roi` without validation, and `status: "pending"` re-opens a settled pick while nulling all settlement fields. The 2026-07-20 audit fixed this endpoint accepting client closePrice/clv, but the null-overwrite/un-settle hazard is new and undocumented. Currently unused by bot.py (only picks/execution is called), so blast radius is a future/manual caller — but it is live and authenticated callers can trigger it.

**Suggested fix:** In settleManualPick add `AND status = 'pending'` (or have the endpoint preserve existing close_price/clv via COALESCE and reject status='pending'); validate roi range server-side.

**Verifier:** Confirmed. bot.ts:2808-2816 hardcodes closePrice:null/clv:null into settleManualPick, and manual-picks.ts:759-771 runs an unconditional UPDATE overwriting status, settled_at, resolved_outcome, close_price, roi, clv with no status='pending' guard and no COALESCE (unlike updateManualPickExecution in the same file, which COALESCEs every field). Payload status has only a truthiness check (bot.ts:2802), so "pending" (or any string) is accepted and un-settles the pick (settled_at=null, manual-picks.ts:756). The endpoint is live behind requireBotAuth; grep confirms zero callers (bot.py uses only /can

### [P2] Trend snapshot as_of_time is game START time, so as-of lookups leak results of games in progress at pick time

`src/server/pipeline/canonical-pipeline.ts:66` — dimension: summaries — **status: open**

Snapshots are computed after a game finalizes but stamped `as_of_time = game.gameTime` (the scheduled start). getTeamTrendSnapshotAsOf (team-trend-snapshots.ts:252, `WHERE ... as_of_time < ?`) therefore returns, for any pick placed between a prior game's start and its finalization, a snapshot that already contains that unfinished game's ATS/OU result. The 2026-07-20 fix addressed only the inclusive-boundary case (`<=` → `<`); the start-time-vs-finalization-time gap remains. Blast radius: strategy-analysis feature vectors (extractPickFeatures passes picked_at as asOfTime, canonical-features.ts:212) for MLB doubleheaders and picks made while the team's previous game is live — the code's 'point-in-time safe' guarantee (strategy-analysis.ts header) is violated for exactly those picks.

**Suggested fix:** Stamp snapshots with the game's finalization/processing time (or store both), or have getTeamTrendSnapshotAsOf compare against an end-of-game estimate rather than start time.

**Verifier:** Confirmed against the code. processGame (canonical-pipeline.ts:66-76) runs only after a game finalizes yet stamps snapshots with as_of_time = game.gameTime (scheduled start, in epoch seconds — unit-consistent with picked_at); computeSnapshotsForTeam passes no beforeGameTime, so the snapshot includes the stamped game's own ATS/OU result (acknowledged by the doc comment at team-trend-snapshots.ts:239-241). getTeamTrendSnapshotAsOf's strict `as_of_time < ?` (line 252) fixes only the equal-timestamp case; for a pick at T with a prior game started S<T but finalized F>T, the snapshot stamped S match


## P3

### [P3] resolvePickedSide maps side_a to the away team, but spread markets' side_a is the title-named (often home) team

`src/server/pipeline/pick-enrichment-helpers.ts:240` — dimension: book-anchor — **status: fixed 2026-07-23 batch 2 — resolvePickedSide: totals/props get no team side, name-match precedes positional mapping, A→away fallback restricted to moneyline; 155 poisoned totals/prop rows nulled (actual_total retained)**

Strategies 1 and 2 of resolvePickedSide assume side_a = away (first-listed team in 'Away vs Home' titles). Remote D1 shows this holds for moneyline markets but NOT spread markets, where side_a_label is the team named in the title — the home team in observed rows. A spread pick whose sharp_side is 'a' or whose label equals side_a_label gets team_id/opponent_id/venue_role/fav_dog_role inverted, and getFactValues then 'confirms' the wrong team. Currently latent (0 spread picks in manual_picks) but armed for the first spread pick; the code also contradicts its own comments.

**Suggested fix:** For spread markets, resolve the picked label against team names first (Strategy 3) or map side labels by comparing them to the resolved home/away team names instead of assuming positional order; reconcile the comments with whichever convention is verified per bet type.

**Verifier:** CONFIRMED. Reproduced against code and remote D1. (1) Code: pick-enrichment-helpers.ts:240-246 maps normalized 'a' -> awayTeamId and :259-265 maps label==side_a_label -> awayTeamId; candidateLabels orders parsedSpreadLabel before pickedLabel, so for spread markets Strategy 2 fires on the title-named team before the correct substring Strategy 3. (2) Data: remote polywhaler-db sharp_money_cache shows moneyline rows ('Arizona Diamondbacks vs. St. Louis Cardinals') with side_a = first-listed = AWAY team (a->away correct), but spread rows ('ARI vs STL: Spread: St. Louis Cardinals (-1.5)' side_a='St

### [P3] Unparseable fill response silently records fillPrice = pick price and fillSlippageBps = 0.0, indistinguishable from a genuine zero-slippage fill

`bot/bot.py:736` — dimension: bot — **status: open**

parse_fill_from_response falls back to the intended stake/entry price whenever makingAmount/takingAmount are missing or imply a price outside (0, 1.0001] (lines 736-739). report_pick_execution then computes `slippage_bps = round((fill_price - price) / price * 10000, 1)` (lines 802-804) — which is exactly 0.0 in the fallback case — and posts it as a real number. So every fill whose v2 response shape isn't recognized lands in D1 as fillStatus likely 'filled' (line 749-750 defaults to 'filled' when no status field), fillPrice = decision price, fillSlippageBps = 0. This contaminates the planned roi-vs-fill and book_clv fill-price analyses with fake-perfect fills; the KNOWN-ISSUES note that slippage is 'currently ~0' may partly be this artifact rather than measured execution quality. (Sign convention itself is already documented — this is the distinct fake-zero fallback.)

**Suggested fix:** When the fallback engages, send fillSlippageBps=None and a distinct fillStatus (e.g. 'filled_unparsed') so analytics can filter, instead of synthesizing a perfect fill.

**Verifier:** Code mechanics confirmed (bot/bot.py:736-739 fallback, :802-804 slippage=0.0, :750 'filled' default), and the failure scenario is constructible if a future CLOB v2 response shape omits makingAmount/takingAmount. However the finding's harm claims are refuted by production data: all 25 live fills in polywhaler-db have fill_status='matched' with makingAmount/takingAmount present in execution_notes (0 rows missing them), so the fallback has NEVER fired; the 16 exact-price/zero-slippage rows are genuine parses (e.g. 1.999999/4.444443 rounds to the 0.45 pick price), meaning the KNOWN-ISSUES '~0 slip

### [P3] Exponential backoff never escalates: backoff is reset to 0 before the next failure, so every error waits the base delay

`bot/bot.py:1198` — dimension: bot — **status: open**

The backoff sleep sets `backoff = 0.0` after sleeping (line 1198). The except handler computes `backoff * 2 if backoff else config.poll_backoff_base` (lines 1335-1338), but by the time any exception occurs backoff has always been zeroed by the previous iteration's sleep, so it re-arms at the 2s base every time. `poll_backoff_max` (default 120s) is unreachable; a persistently failing upstream (e.g. the Cloudflare-blocked worker this bot has actually experienced) is retried at full poll cadence + 2s forever instead of backing off — compounding the dead stop_on_403 switch.

**Suggested fix:** Track consecutive_failures and derive the delay from it; reset the counter only on a successful poll, not after sleeping.

**Verifier:** Confirmed against bot/bot.py. Line 1134 initializes backoff=0; lines 1194-1198 sleep any pending backoff then unconditionally reset it to 0 BEFORE the poll at line 1215. All realistic exception sources (fetch_candidates 1215, place_bet 1301, save_state 1331) execute after that reset, so the except handler's ternary at 1335-1338 (`backoff * 2 if backoff else base`) always sees backoff==0 and re-arms at the 2s base. poll_backoff_max (120s, line 123) is unreachable except via exceptions in lines 1156-1192 (deterministic window/prune code that effectively never throws). Concrete scenario: persiste

### [P3] Hourly call budget counts only the candidates poll; pick/execution POSTs and public CLOB/Gamma fetches are unmetered

`bot/bot.py:1214` — dimension: bot — **status: open**

`call_timestamps.append(time.time())` (line 1214) is the only place a call is recorded against `max_calls_per_hour`, immediately before fetch_candidates. Each placed bet additionally makes a picks POST plus an execution POST to the same worker (post_json at lines 1067 and 765), and resolve_token_id makes CLOB/Gamma requests — none counted. A poll that places max_bets=5 bets issues ~11 worker requests but consumes 1 budget slot, so the budget (added specifically to pace calls after Cloudflare rate blocks — commit 595c49b) undercounts by up to ~10x during the busiest windows, exactly when triggering edge rate-limiting is most costly.

**Suggested fix:** Append to call_timestamps in post_json/request_json themselves (or count expected per-bet calls against the budget before entering the placement loop).

**Verifier:** Verified: line 1214 is the sole call_timestamps.append; worker POSTs at bot/bot.py:1067 (/api/bot/picks) and :765 (/api/bot/picks/execution, fired for paper and live via report_pick_execution) plus resolve_token_id's CLOB/Gamma fetches (lines 514/538, live-only, cached) are all unmetered. With max_bets=5 a bet-placing poll really does issue 11 worker requests on 1 budget slot. However, the finding overstates impact: (a) the "~10x in busiest windows" is per-poll only — placed/placed_groups dedup caps each condition at one POST pair, and historical pick volume (~2/day) makes sustained overage a 

### [P3] Exact-orientation game dedup creates duplicate reversed games; picks link to an orphan copy that can never be finalized

`src/server/pipeline/game-ingestion.ts:88` — dimension: data-integrity — **status: open**

findExistingGame in game-ingestion (and its twin in espn-schedule-ingestion.ts:296-319) dedups only on the EXACT (home_team_id, away_team_id) ordering. canonical-sync's own line-matching code acknowledges title-derived orientation is sometimes wrong, yet batchIngestGames creates games from that same title orientation (resolveTeamFromMarketTitle assumes 'Away vs Home', team-seeder.ts:1898-1907). If Polymarket's ordering for a game disagrees with the ESPN-created canonical row, a second, reversed game row is created for the same physical game. The reversed copy is unfinalizable: espn-schedule matching and result-ingestion's findMatchingScore (result-ingestion.ts:200-203) both require homeMatch && awayMatch in exact orientation. Pick enrichment's findGameForPick (pick-enrichment-helpers.ts:41-52) also matches exact orientation using the pick's title-derived orientation, so picks bind to the orphan copy — their actual_margin/actual_total stay NULL forever, venue_role is inverted, and getFactValues/getLineValues return nothing or title-parsed junk, while the correctly-oriented twin accumulates the real facts.

**Suggested fix:** Dedup on the unordered team pair (both orderings) in game-ingestion and espn-schedule findExistingGame, preferring the ESPN-oriented row as canonical; add a one-off query for existing (A,B)/(B,A) duplicate pairs within a 6h window and merge/repoint picks.

**Verifier:** Code reading confirmed: findExistingGame in game-ingestion.ts:88-93 and its twin in espn-schedule-ingestion.ts:302-320 dedup only on exact (home_team_id, away_team_id), while canonical-sync.ts:216-220 explicitly matches both orientations because "market title parsing may not always get home/away correct". result-ingestion.ts:200-203 and pick-enrichment-helpers.ts:41-52 also require exact orientation, so a reversed duplicate would indeed be unfinalizable and would capture title-oriented picks. Not documented in docs/KNOWN-ISSUES.md. HOWEVER, production evidence shows the scenario has never fire

### [P3] Head-of-line blocking in result ingestion: permanently-unfinalizable games occupy the ASC-ordered LIMIT 50 window and starve new games

`src/server/pipeline/game-ingestion.ts:287` — dimension: data-integrity — **status: open**

listUnfinalizedGames returns `ORDER BY game_time ASC LIMIT 50` (PER_SPORT_LIMIT), and finalizeCompletedGames filters for eligibility (game_time + 4h < now) only AFTER that truncation. Games that can never finalize — reversed-orientation duplicates (finding above), games whose UTC date is wrong for the scoreboard fetch (finding above), or teams ESPN can't match — are never evicted and, being oldest, permanently occupy the head of the list. Once 50+ such rows accumulate for a sport, every subsequent cycle processes only the same 50 dead games and newly-completed games never enter the window, so they are never finalized by this path and never produce facts. Graceful-degradation failure of the same species as the Gamma pagination incident: no error, just quietly shrinking coverage over time.

**Suggested fix:** Add a not_found retry counter or max-age cutoff (e.g. skip games older than 14 days, or mark them abandoned after N failed attempts) so the LIMIT window advances; alert when the per-sport unfinalized backlog exceeds the limit.

**Verifier:** Mechanism verified: game-ingestion.ts:283-291 selects `is_final = 0 ORDER BY game_time ASC LIMIT 50` and result-ingestion.ts:265-269 filters eligibility only after truncation; there is no eviction, retry cap, or dead-letter marking, so permanently-unmatchable rows (oldest first) occupy the window head forever. Live D1 confirms accumulation: MLB has 20 past-due unfinalized games (oldest ~2026-04-26) and NBA 9, re-selected and re-fetched from ESPN every cycle. Not documented in docs/KNOWN-ISSUES.md. HOWEVER the claimed consequence ("newly-completed games are never finalized and never produce fac

### [P3] recomputeAllSnapshotsForTeam deletes the team's entire as-of snapshot history and rebuilds only the latest snapshot per type

`src/server/pipeline/snapshot-computation.ts:154` — dimension: data-integrity — **status: open**

recomputeAllSnapshotsForTeam calls deleteTeamTrendSnapshots (removes EVERY row for the team/sport, team-trend-snapshots.ts:316-331) and then computeSnapshotsForTeam once, as-of only the most recent fact — producing at most 9 rows where there was one row per (game, type). The per-game snapshot history is what getTeamTrendSnapshotAsOf time-travels over for retrospective feature extraction (extractPickFeatures asOfTime=picked_at); after a recompute, every as-of lookup for a pick older than the team's newest game returns NULL, silently reclassifying those picks as 'unknown/no trend data' in strategy-analysis buckets, and there is no code path that rebuilds per-game historical snapshots. The exposed caller backfillMissingSnapshots (src/server.ts:140) only targets teams with zero snapshots, but for those teams it likewise creates ONLY the newest-stamped snapshot even when the team has a long facts history — so all older picks on backfilled teams permanently lack as-of trend context despite the facts existing to compute it. The function is exported and its docstring invites broader use ('Useful for backfill scenarios'), making the destructive variant one call away.

**Suggested fix:** Make recompute rebuild one snapshot per historical fact (iterate facts oldest->newest, computing as-of each game with a proper beforeGameTime bound) instead of only the newest; until then, remove the delete-all or rename/guard the function so it cannot be run against teams with existing history.

**Verifier:** All code facts verified: recomputeAllSnapshotsForTeam (snapshot-computation.ts:153-166) deletes ALL team/sport snapshot rows (team-trend-snapshots.ts:324) then rebuilds only at one as-of point (newest fact), collapsing the per-game history that getTeamTrendSnapshotAsOf (strict as_of_time < asOfTime) and extractPickFeatures (asOfTime=picked_at) depend on for retrospective features; no replay path exists. HOWEVER, the destructive scenario is latent, not active: the sole caller, backfillMissingSnapshots (exposed at POST /_canonical/backfill-snapshots, server.ts:134), selects only (team,sport) pai

### [P3] Line ingestion accepts a reversed home/away game match but assigns the spread sign from title order — home_spread sign flips when the reversed ordering matched

`src/server/pipeline/canonical-sync.ts:211` — dimension: ingestion — **status: open**

getLineInputsFromCache deliberately matches a game in either (home,away) OR (away,home) orientation 'since market title parsing may not always get home/away correct', but it discards which orientation matched. ingestLineFromMarket then derives home_spread purely from the title's team positions, assuming the title's second team is the game row's home team. When the reversed ordering was the one that matched, the stored home_spread/away_spread are sign-inverted, which inverts ATS grading and fav_dog_role for that game. Blast radius is currently tiny — only 2 game_lines rows have source='polymarket' (ESPN fills most closes first) — but the bug fires precisely on the games ESPN missed, and it is latent growth if ESPN odds coverage degrades.

**Suggested fix:** Return the matched orientation from the SQL (select home_team_id and compare to resolved homeTeam.id) and negate the parsed spread when the row is reversed — or skip reversed matches for spread-bearing titles.

**Verifier:** Confirmed by reading all three code sites. canonical-sync.ts:211-230 matches games in either orientation and discards which one matched (only gameId is pushed at :235-240); parseTeamsFromTitle (team-seeder.ts:1887) derives home/away purely from title order; ingestLineFromMarket (line-ingestion.ts:180-194) assigns home_spread from title position without any orientation input — MarketLineInput has no field to carry it. Failure scenario reproduced: ESPN-created game (true orientation) missing a close line + Polymarket title listing teams in reversed order with a parseable spread → stored home_spr

### [P3] Every ESPN-finalized game hardcodes wentToOt: false — went_to_ot is unconditionally 0 in the games table

`src/server/pipeline/espn-schedule-ingestion.ts:528` — dimension: ingestion — **status: open**

Both finalization paths write wentToOt: false for every game regardless of whether it went to overtime/extra innings (result-ingestion even has a comment acknowledging it). Since ESPN ingestion finalizes essentially all games, the went_to_ot column is constant-false garbage. Nothing in analytics consumes it today (only the games repository maps it), so this is a dormant trap: any future trend split or grading rule keyed on OT would silently operate on all-zeros and 'validate' cleanly.

**Suggested fix:** Derive OT from the scoreboard response (competitions[].status.period vs the sport's regulation period count), or drop the column so future analyses can't trust it accidentally.

**Verifier:** Confirmed. All production finalization paths hardcode wentToOt:false: espn-schedule-ingestion.ts:525-529 and result-ingestion.ts:211 (with a comment admitting OT isn't extracted). The only path accepting a real value (game-ingestion.ts) is reachable only via the debug endpoint canonical-debug.ts:430. Empirically verified against remote D1: all 1,526 games (1,477 final) have went_to_ot=0, statistically impossible if populated (MLB extra innings ~8-9%, NBA OT ~6%). NOT documented in docs/KNOWN-ISSUES.md (grep hits were false positives inside "not"); meanwhile docs/stats-spec/phase2-schema.md:86 

### [P3] DO tick cooldown equals the cron interval exactly, so delivery jitter silently skips ticks and doubles the sampling gap

`src/server/pipeline/sharp-pipeline.ts:85` — dimension: ops — **status: open**

The cron fires every 2 minutes (wrangler.jsonc: "*/2 * * * *") and the DO cooldown is DEFAULT_INTERVAL_MS = exactly 2 minutes with a strict `<` check against the previous tick's arrival timestamp. Whenever tick N+1 reaches the DO with less latency than tick N (elapsed 119.x s < 120000 ms), the tick is rejected as 'cooldown' and the refresh silently waits for the next cron — a 4-minute gap. Since lastRun is only advanced on successful runs the skips can't cascade, but jitter makes the effective sharp_money_history sampling cadence irregular (2 or 4 minutes nondeterministically), which coarsens the pre-event close price used for CLV and any history-density analysis.

**Suggested fix:** Set the cooldown below the cron period with margin, e.g. DEFAULT_INTERVAL_MS = 90 * 1000.

**Verifier:** Confirmed against code. Cron */2 (wrangler.jsonc:86-88) hits the DO /tick without force (src/server.ts:197-208); the DO gate (sharp-pipeline.ts:85) rejects when now - lastRun < 120000 with DEFAULT_INTERVAL_MS exactly equal to the cron period, and lastRun (:83, stored :109) is the previous tick's arrival timestamp. Any tick arriving with lower delivery latency than its predecessor yields elapsed < 120000 ms -> 'cooldown' skip with no retry/alarm, producing a 4-minute sampling gap; skips cannot cascade (post-skip elapsed ~240s always passes) but under jitter roughly half of eligible ticks can sk

### [P3] bot_candidate_snapshots grows unbounded — insert-only, no prune anywhere

`src/server/repositories/bot-candidate-snapshots.ts:118` — dimension: ops — **status: open**

insertBotCandidateSnapshot writes one row (with five JSON blob columns) per bot /api/bot/candidates request and per pick-flow snapshot (bot.ts:1673, 2136), and no code path ever deletes from bot_candidate_snapshots — grep across src/ finds only INSERT and SELECT. KNOWN-ISSUES documents unbounded growth for canonical_sync_runs only; this table is a second unbounded grower, and it is also the audit-critical table for the planned n≈100 gate-rejection counterfactual analysis, so silent bloat/eventual manual truncation would destroy that forensic trail. The prod DB is already 113 MB.

**Suggested fix:** Add a retention prune (e.g. keep 90 days) in the scheduled tick, mirroring the sharp_money_history retention pattern, sized to survive until the n≈100 re-audit.

**Verifier:** Confirmed. insertBotCandidateSnapshot (bot-candidate-snapshots.ts:121) runs on every listBotCandidates call (bot.ts:1673 empty-path, bot.ts:2136 normal path; only skipped in inspectConditionId debug mode), writing one row with 5 JSON blob columns per bot candidates poll. Repo-wide DELETE inventory (sharp_money_cache/history, manual_picks, wallet caches, team_trend_snapshots) contains no bot_candidate_snapshots statement; migration 0016 defines no TTL and D1 has none. docs/KNOWN-ISSUES.md documents unbounded growth for canonical_sync_runs only (line 82) — this table is undocumented. Table is ac

### [P3] Cron cooldown check runs four COUNT(*) full-table scans every 2 minutes

`src/server.ts:241` — dimension: ops — **status: open**

The scheduled canonical-sync branch calls getCanonicalFreshness solely to read lastRunAt for the 5-minute cooldown, but that function also executes COUNT(*) over games, team_game_facts, team_trend_snapshots, and manual_picks, plus a 5-row recent-runs query — 7 queries per tick, ~5040 unnecessary row-scan queries/day against a 113 MB D1 database, in the same invocation whose subrequest budget the code elsewhere carefully rations (see the comment at src/server.ts:210-213).

**Suggested fix:** Add a lightweight getLastSyncRunStartedAt(db) (single indexed SELECT on canonical_sync_runs) and use it in the scheduled handler; keep getCanonicalFreshness for the status endpoint.

**Verifier:** Confirmed. wrangler.jsonc:85-88 sets the cron to */2 * * * * (720 ticks/day). src/server.ts:241-250 calls getCanonicalFreshness but reads only freshness.lastRunAt for the 5-minute cooldown; the sync path re-queries anything else it needs (teamCount at line 252). getCanonicalFreshness (canonical-sync.ts:559-615) awaits 7 serial queries: 2 canonical_sync_runs lookups, 4 COUNT(*) scans (games, team_game_facts, team_trend_snapshots, manual_picks WHERE team_id IS NOT NULL), and a 5-row recent-runs query — the counts run BEFORE the cooldown decision, so they execute on every tick even when the sync 

### [P3] edgeRating 'volume bonus' is computed from marketLiquidity, not volume — a 0-5 point shift across the load-bearing edgeRating band boundaries

`src/server/api/sharp-money.ts:2647` — dimension: scoring — **status: open**

calculateEdgeRatingBreakdown's second input is named totalVolume and documented as a volume bonus ('$200K+ volume = max bonus', line 1990-1991: `5 * (1 - Math.exp(-totalVolume / 100_000))`), but the caller passes `marketVolumeForBonus = Math.max(0, marketLiquidity ?? marketVolume ?? holderMarketValue)` (lines 2647-2650) — liquidity takes precedence over volume whenever it is present, and liquidity is typically an order of magnitude smaller than volume, so the bonus is systematically understated (and driven by the wrong quantity). Because edgeRating is gated by hard band boundaries — accepted [66,72) and [80,90), dead zone [72,80), saturation >=90 (sharp-grade.ts:92-101), all fitted on historical edgeRating values — a 0-5 point bonus computed from liquidity instead of volume can move a candidate across an accept/reject boundary. The debug output further mislabels it (`totals.marketVolume: marketVolumeForBonus`, line 2825). Whether the bands were fitted on liquidity-fed or volume-fed ratings, the code/documentation disagreement means the feature is not what analyses believe it is.

**Suggested fix:** Pass marketVolume (falling back to liquidity only when volume is absent) or rename/redocument the term as a liquidity bonus; note in KNOWN-ISSUES that historical edgeRating values embed the liquidity-fed bonus so the band gates must not be re-fitted assuming volume.

**Verifier:** Code facts all reproduce: sharp-money.ts:2647-2650 passes marketLiquidity-first (Gamma liquidityNum, distinct from and typically much smaller than volumeNum) into a function documented as a volume bonus (lines 1988-1992), and debug output mislabels it at 2825. Extra defect found: pipeline maps liquidity with `?? 0` (sharp-money.ts:1242), so marketLiquidity is always defined on the main path and the `?? marketVolume` fallback is dead code — missing liquidity yields bonus 0 regardless of volume. Not in KNOWN-ISSUES.md. However, the claimed failure scenario (candidate crossing an accept/reject ba

### [P3] Manual outcome override (updateManualPickOutcome) leaves stale roi/clv/close_price when flipping a settled status

`src/server/repositories/manual-picks.ts:728` — dimension: settlement — **status: open**

updateManualPickOutcome (used by updateManualPickOutcomeFn, the UI manual-override path in src/server/api/manual-picks.ts lines 851-862) updates only status and settled_at. Correcting a mis-graded pick from win to loss keeps the winning roi (e.g. +0.6) and clv on the row, so getManualPicksSummary's `AVG(roi)`, `SUM(roi)` and `AVG(clv)` (repo lines 696-704) aggregate a loss with positive roi — silently corrupting the exact ROI numbers used for gate decisions. Setting status back to 'pending' nulls settled_at but likewise leaves roi/clv/close_price populated on a nominally pending pick.

**Suggested fix:** Recompute roi from the new status and the stored price (win: 1/price-1, loss: -1, push: 0, pending: NULL) and null clv/close_price/resolved_outcome when they no longer match the status.

**Verifier:** Defect confirmed in code: updateManualPickOutcome (src/server/repositories/manual-picks.ts:726-732) updates only status/settled_at, leaving roi/clv/close_price/resolved_outcome stale, and getManualPicksSummary (lines 696-708) aggregates AVG(roi)/SUM(roi)/AVG(clv) with no consistency guard — a win→loss flip via this function would permanently keep the winning roi in gate-decision ROI numbers (settlement cron only reprocesses status='pending', so it never self-heals; the flip-to-pending case WOULD self-heal on the next settle tick via settleManualPick, which correctly overwrites all six columns)

### [P3] Settlement starvation: pending batch LIMIT applied before the eligibility filter, ordered newest-first

`src/server/api/manual-picks.ts:126` — dimension: settlement — **status: open**

settlePendingManualPicks fetches `listManualPicks(db, { status: 'pending', limit })` (cron limit 20, src/server.ts line 213) and only then applies the eventTime>=15-min eligibility filter (lines 133-137). listManualPicks orders `ORDER BY picked_at DESC LIMIT ?` (repo line 654), so the window fills with the NEWEST pending picks — exactly the ones on future games that fail eligibility — while the oldest, actually-settleable picks fall outside the LIMIT and are never fetched whenever pending count exceeds the batch size. During a high-volume slate (>20 pending), finished games' picks wait until newer picks settle first; combined with permanently-unsettleable picks (sharpSide not A/B returns null forever at lines 246-250), settlement can lag by days. Self-healing at current ~6 picks/wk volume, hence P3.

**Suggested fix:** Push eligibility into SQL (e.g. WHERE status='pending' AND (event_time IS NULL OR event_time <= now-15min) ORDER BY event_time ASC LIMIT 20) so the batch contains only settleable picks, oldest events first.

**Verifier:** Confirmed against code. listManualPicks (repositories/manual-picks.ts:654) applies `ORDER BY picked_at DESC LIMIT ?` with only a status filter; settlePendingManualPicks (manual-picks.ts:126) applies the eventTime>=15-min eligibility filter in JS AFTER the SQL LIMIT, so with >20 pending the batch fills with newest (ineligible, future-game) picks and oldest settleable picks are never fetched. Cron (server.ts:213, `*/2 * * * *`) is the only automatic settler — the bot never calls /api/bot/picks/outcome (verified in bot/bot.py). No guard elsewhere; not in KNOWN-ISSUES.md. Concrete scenario: 25 pen

### [P3] No staleness bound on the history-derived close price; cross-pick fetch cutoff lets later-event picks take multi-day-old 'closes'

`src/server/api/manual-picks.ts:158` — dimension: settlement — **status: open**

The settlement close price is findPriceAtOrBefore's last history row at or before event_time, with no cap on how far before. The batch history fetch uses a single cutoff of `min(all eligible picks' event times) - 4h` (line 158), so for the earliest-event pick staleness is bounded at 4h, but for a pick whose event is N days after the batch minimum the scan can walk back N days+4h (findPriceAtOrBefore, repositories/manual-picks.ts lines 1228-1234, skips forward rows then accepts ANY earlier non-null price). A market that fell below the $10k volume floor (documented overnight staleness) before its game gets a 'close' from many hours or days earlier, recorded indistinguishably from a genuine close — biasing stored clv toward the pick-time price (clv~0) with no annotation of close quality. The 2026-07-20 audit documents 'last price at or before event_time (NULL if no coverage)' but not the unbounded-staleness behavior.

**Suggested fix:** Bound close staleness per pick (e.g. require recordedAt >= eventTime - 4h, else store NULL), or persist the close row's recorded_at alongside close_price so analyses can filter stale closes.

**Verifier:** Confirmed against code. (1) src/server/api/manual-picks.ts:155-159 fetches sharp_money_history for the whole settle batch with one cutoff, min(all eligible event times) - 4h; listSharpMoneyHistoryByConditionIds (sharp-money.ts:858-883) applies it uniformly via recorded_at >= ?. (2) findPriceAtOrBefore (repositories/manual-picks.ts:1223-1235) has no max-age check — it returns any non-null price at or before event_time, so a later-event pick's close can be up to (its event − batch-min + 4h) old. (3) Preconditions are realizable: picks stay pending for days (fetchGammaMarket null or unresolved ma

### [P3] Previous-day drift baseline includes the current day's partial snapshot (no upper day_key bound)

`src/server/repositories/daily-stats-snapshots.ts:364` — dimension: summaries — **status: open**

buildDrift's baseline query excludes only the day being built (`WHERE day_key != ?`) with no `day_key < ?` bound. maybeRefreshDailyStatsSnapshot re-freezes yesterday (lines 541-547) on every hourly refresh until +12h grace — and on every refresh after the day's first, today's snapshot already exists in daily_stats_snapshots. Sorted `day_key DESC LIMIT 7`, today's partial-day row (a few hours of picks/candidate runs) is the first baseline row for yesterday's archived drift, deflating the baseline and inflating yesterday's stored settledDelta/runCountDelta. The final persisted version of each day's drift_json is contaminated this way, since the last re-freeze happens up to 12h into the following day.

**Suggested fix:** Change the baseline predicate to `WHERE day_key < ?` so a day's trailing baseline only contains strictly earlier days.

**Verifier:** Confirmed. buildDrift (daily-stats-snapshots.ts:361-368) uses `WHERE day_key != ? ORDER BY day_key DESC LIMIT 7` with no upper bound, so it takes the 7 newest other rows, not the 7 preceding days. maybeRefreshDailyStatsSnapshot runs hourly from the scheduled handler (src/server.ts:286); within each call it re-freezes yesterday (line 546) before upserting today (line 549). Only the day's FIRST refresh re-freezes yesterday cleanly; every subsequent hourly re-freeze until the +12h grace expires includes today's partial-day row as the top baseline row (and displaces D-8), and the last such write (

### [P3] strategy-analysis 'settledPicks' silently excludes all picks without team_id; venue/role enrichedPicks counter always equals total

`src/server/repositories/strategy-analysis.ts:137` — dimension: summaries — **status: open**

SETTLED_ENRICHED_QUERY filters `AND team_id IS NOT NULL`, then `settledCount = picks.length` is surfaced as `settledPicks` in every StrategyAnalysisSummary. Totals picks and any pick where enrichment failed are dropped before bucketing, yet the field name claims the full settled population — win rates and ROIs read as portfolio-wide but describe only the team-enriched subset (totals have historically been the majority market type). Secondary defect: getPerformanceByVenueAndRole increments `enriched` unconditionally (line 311, `enriched += 1;`) with no snapshot-found check, unlike its sibling functions (e.g. line 191 `if (fv.teamSnapshotFound) enriched += 1;`), so enrichedPicks === settledPicks always for that endpoint, masking enrichment coverage gaps.

**Suggested fix:** Report the true settled count alongside (e.g., settledPicks vs enrichedEligible), or rename the field; gate the venue/role `enriched` counter on fv.teamSnapshotFound like the other functions.

**Verifier:** Code claims verified: SETTLED_ENRICHED_QUERY filters team_id IS NOT NULL (line 137) and picks.length is published as settledPicks with no excluded-count field; getPerformanceByVenueAndRole increments enriched unconditionally (line 311) so enrichedPicks===settledPicks always for that endpoint, and strategy.tsx:178 mislabels it as "with trend data". Not documented in KNOWN-ISSUES.md. HOWEVER the central impact claim is empirically false: totals picks are NOT excluded — resolvePickedSide matches Over/Under against sharp_money_cache side labels, so 155/165 settled totals picks have team_id. Remote

### [P3] L2 imbalance bucket label '<=-0.10' contradicts the exclusive boundary predicate

`src/server/repositories/manual-picks.ts:386` — dimension: summaries — **status: open**

PERFORMANCE_L2_IMBALANCE_BUCKETS labels the first bucket '<=-0.10' with `max: -0.1`, but bucketIndexFromRange uses `value >= range.min && value < range.max` (line 917), so a pick with imbalance exactly -0.10 falls into the middle '-0.10 to 0.10' bucket, contradicting the label. The positive-side '>= 0.10' label is correct (min is inclusive). Asymmetric misclassification at the boundary plus a mislabeled bucket in the published summary.

**Suggested fix:** Rename the first label to '<-0.10', or shift the boundary so the label matches (max: -0.1 exclusive means strictly-less-than).

**Verifier:** Confirmed against code. bucketIndexFromRange (manual-picks.ts:917) uses exclusive max; first L2 bucket (line 386) is labeled '<=-0.10' with max -0.1, so imbalance exactly -0.1 lands in the '-0.10 to 0.10' bucket, contradicting the label; the '>=0.10' side is inclusive-min and correct, so the tails are asymmetric. The boundary is reachable: l2ImbalanceNearMid is a raw unrounded ratio (bid-ask)/(bid+ask) computed in sharp-money.ts:3324-3328; e.g. notionals 90 vs 110 yield (9-11)/(9+11) which is bit-exact === -0.1 in IEEE doubles (verified with node). No rounding or guard exists elsewhere in the 

### [P3] DailyStatsPickSummary mixes CLV units: top-level avgClv is a price fraction, nested rows are bps

`src/server/repositories/daily-stats-snapshots.ts:36` — dimension: summaries — **status: open**

The persisted daily snapshot JSON carries `avgClv` at top level in raw price units (from getManualPicksSummary's `AVG(clv)`, manual-picks.ts:704) while every nested bucket row in the same object (`byTimeToStart`, `byMarketType`, `bySport`, etc.) reports `avgClvBps` (clv * 10000). Drift's `avgClvDelta` is likewise in fractions. Same species as the documented seconds-vs-milliseconds timestamp footgun: any ad-hoc query or UI comparing top-level CLV against bucket CLV is off by 10^4.

**Suggested fix:** Standardize on bps in the snapshot JSON (rename to avgClvBps and multiply by 10000 at build time), or document the unit split in the interface.

**Verifier:** Verified: persisted manual_picks_json mixes units — top-level avgClv is a 0-1 price fraction (AVG(clv), manual-picks.ts:704/717; clv = closePrice - entryPrice, api/manual-picks.ts:187-190) while all six nested bucket arrays carry avgClvBps = clv*10000 (manual-picks.ts:948), and drift.picks.avgClvDelta is in fractions (daily-stats-snapshots.ts:419-422). Not documented in KNOWN-ISSUES.md or CLAUDE.md. Mitigating: NO live bug — every current consumer converts correctly (runtime.tsx:2023-2025, 2031-2033, 2109-2110 all do avgClv*10000 before formatBps), and drift math is internally consistent. The 


## Refuted (for the record)

Findings raised by recon but killed in adversarial verification:

- **Bot candidate gates fail open when the gated metric is null: priceEdge, signalScore, edgeRating, scoreDifferential gates are all skipped if the value is not a number** (`src/server/api/bot.ts`) — The fail-open pattern exists textually but no gate can actually be skipped in a way that produces a bet. (1) edgeRating: parseRow coerces NULL edge_rating to 0 (repositories/sharp-money.ts:227), which the gate then REJECTS as below-floor — fails closed. (2) scoreDifferential: non-nullable column, al
- **O/U side labels hard-coded as sideA='Over'/sideB='Under' by outcomeIndex while prices attach by outcome text — holder scores and prices can bind to opposite outcomes** (`src/server/api/sharp-money.ts`) — Mechanism is accurately described (index-bound scores vs text-bound prices, no cross-check; bot.ts:1121 depends on sideA=Over), but the failure scenario cannot occur with real Polymarket data. Empirical check replicating the pipeline's exact Gamma query (all 7 TARGET_SPORT_SERIES_IDS, tag_id=100639)
- **Indeterminate spread-team position silently treated as home-team spread, flipping favDogRole in canonical bot scoring** (`src/server/api/bot.ts`) — Code reading is accurate (bot.ts:1180 collapses null spreadPosition into the home branch), but the claimed failure scenario is unreachable. To reach line 1180 the title must (a) contain "spread" (getMarketTypeLabel, bot.ts:702), (b) have its pre-colon segment parse via parseTeamsFromTitle AND both f
- **computeMarketQualityScoreFromCacheEntry treats non-'A' sharpSide (including 'EVEN'/undefined) as side B, diverging from the gate-time microstructure function** (`src/server/api/bot.ts`) — Refuted. The cited line bot.ts:363 is preceded by a guard at bot.ts:348-353 that returns null whenever input.sharpSide is falsy or not exactly "A"/"B" — so "EVEN", undefined, and label-valued strings never reach the ternary, and it can never misattribute side B's price. Within the function, sharpSid
- **Grade-imputed signal scores fabricated into signal-score calibration buckets and the 90+ anti-signal observation** (`src/server/repositories/manual-picks.ts`) — The code path exists exactly as cited (resolveSignalScore falls back to GRADE_TO_SIGNAL_SCORE at manual-picks.ts:1044, and the result flows unflagged into the bySignalScore buckets at 1316-1323, PERFORMANCE_SIGNAL_BUCKETS at 1448-1457, and the 90+ vs 75-90 observation at 2092-2099; it is not documen
- **Backfill can rewrite venue_role after pick-time capture, desyncing book_ml_side from the close sweep's side mapping** (`src/server/pipeline/pick-backfill.ts`) — The claimed home/away flip is structurally impossible for any pick with book snapshots. Book fields require game_id (manual-picks.ts:553), and game_id is only ever set by findGameForPick, which demands the pick's own derived home/away orientation exactly match games.home_team_id/away_team_id (pick-e
- **Sweep stamps pickcenter-absent picks identically to captured picks and counts them as 'updated'; pushes arbitrarily excluded from book_clv** (`src/server/pipeline/book-odds.ts`) — Refuted on both halves. (1) The "indistinguishable from a captured non-moneyline pick" claim is contradicted by the code and the finding's own evidence: successful captures always write book_close_spread_line/book_close_total_line (book-odds.ts:239-258), so captured non-ML picks carry real line valu