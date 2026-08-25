# Known Issues & Data Caveats

Living document. When one is fixed, move it to the relevant audit doc with the
fixing commit.

## Data-validity caveats (permanent)

- **Shadow-only league coverage starts 2026-08-18** (EFL Championship
  10355; La Liga 10193, Bundesliga 10194, Serie A 10203, Ligue 1 10195,
  UCL 10204 — same evening; ATP 10365, WTA 10366; **NHL from 2026-08-25**
  — moved off a hard `nhl_sport_excluded` reject dated 2026-03-19 whose
  evidence predates `manual_picks` (table starts 2026-04-13), so NHL has
  NO recorded history under any calibrated era; its probation cohort
  starts at the 2026-27 opening night, ~Oct 7). All are ingested but
  every candidate rejects pre-live via the `<tag>_league_probation` gate
  and settles in the shadow book; promotion goes through the
  pre-registered sole-blocker checkpoint. Expectations when reading their
  cohorts: (a) Championship market volume is ~1000x below EPL (max market
  $25 vs $30k at the same days-out on 2026-08-18) — virtually nothing
  clears the $10k `MIN_VOLUME_USD` floor, so zero Championship rows is
  expected, not a pipeline failure (League One/Two exist on Polymarket
  but were skipped for the same reason); (b) tennis has NO ESPN linkage
  by design (no canonical games/teams/trends/facts — shadows settle via
  Gamma resolution only), and the ATP series carries low-liquidity
  Challenger matches that the volume floor trims; (c) UCL has no ESPN
  linkage or team seeding either (league-phase field not drawn at ship
  time) — UCL games link only when both clubs are seeded via their
  domestic league; (d) before 2026-08-24 none of these leagues was in
  `ODDS_API_SPORT_KEYS`, so like EPL/MLS they got no Pinnacle `pin_clv`
  and their promotion CLV criterion rested on PM close — soccer + tennis
  capture starts 2026-08-24 (see the pin-CLV coverage caveat below).
- **Pinnacle `pin_clv` coverage is NOT end-to-end; know these bounds
  before using it as a promotion criterion.** (a) `pin_close_captured_at
  IS NOT NULL` means "swept", not "captured": the sweep also stamps it as
  a give-up marker for untracked sports, expired windows, and events with
  no Pinnacle listing — always test `pin_clv`/`pin_close_fair_prob`, never
  the timestamp. (b) Soccer (EPL, MLS, La Liga, Bundesliga, Serie A,
  Ligue 1, UCL, Championship) and tennis (ATP/WTA, tournament keys
  resolved dynamically) accrue only from 2026-08-24; every earlier
  soccer/tennis row is a give-up stamp with NULL data. Soccer ML fair
  probs use three-way de-vig (draw in the overround) from day one.
  (c) Totals `pin_clv` computes only when Pinnacle's closing total line
  exactly matches the Polymarket line — ~32% of MLB totals — and that
  subsample is biased toward book/PM line agreement; treat totals pin CLV
  as supporting evidence, not a hard gate. MLB moneylines are the only
  cohort with ~99% coverage. (d) NFL preseason rows are 0% by design:
  The Odds API keys preseason separately (`americanfootball_nfl_preseason`,
  unmapped since preseason is permanently gated from betting); verify
  regular-season NFL capture at week 1. (e) Probation-league fetches are
  skipped when remaining Odds API credits drop below 100 (live leagues
  keep fetching), so shadow coverage can have credit-driven gaps that
  live-pick coverage does not. (f) Tennis day one (2026-08-24) was
  0-for-113: PM tennis titles use bare " vs " (no period), which the
  title parser didn't split — fixed same day. Post-fix diagnosis (worker
  logs, 22:5x UTC): parsing/matching now work, but The Odds API's active
  index lists ZERO tennis tournament keys this week (keys=[] — no
  Winston-Salem, Monterrey, or even tennis_atp_us_open yet); the
  provider carries majors and activates keys when main-draw odds post.
  Tennis pin coverage therefore starts when the US Open main-draw key
  activates (~2026-08-31); smaller tournaments may never be covered. Tennis `pin_close_*` is ALSO a weaker proxy than
  other sports: PM stamps the session start (all quals "15:00"), not the
  match slot, so the sweep captures Pinnacle at PM's stamped time (up to
  ~6h before the actual match) — treat tennis pin_clv as
  "vs Pinnacle-at-session-time", not a true close. (g) Draw-question
  markets ("Will X vs. Y end in a draw?") are NULL-stamped, never
  benchmarked: their junk side labels ("Will Fulham FC") substring-match
  team names and mis-benchmarked 4 rows on 2026-08-24 (scrubbed).
  Era-review candidate: classify draw-question markets as props.
- **Pinnacle capture runs on The Odds API FREE tier from 2026-08-25
  (decision: no paid plan)** — 500 credits/month, 2 per sport fetch, so
  the whole system gets `DAILY_FETCH_CAP = 8` fetches/day across all
  sports (+4 reserve only live-pick closes may spend), counted in
  `pinnacle_fetch_log`. Consequences for every pin_* / pin_close_* read:
  (a) ONE per-sport feed cache (`pinnacle_feed_cache`) serves pick anchors,
  pick closes, shadow anchors and shadow closes; a "close" is Pinnacle
  within ≤15 min (live picks) / ≤30 min (shadows) of the close window, an
  "anchor" within ≤30 min of sighting — or, when the day's budget is
  spent, any pre-T feed up to 3 h old. Staleness is a column on every row
  (`pin_feed_at`, `pin_close_feed_at` on both tables; `captured_at −
  feed_at`); filter on it when precision matters. (b) When the cap is hit,
  closes are simply NOT captured (no stale close is ever written) — so
  coverage drops on heavy slates, biased toward events early in the UTC
  day. (c) Tennis fetches at most one tournament per tour per sweep, Grand
  Slam preferred, so a second concurrent tournament is uncovered. (d)
  Benchmark leagues stop below 20 credits, live sports below 2; the
  balance on 2026-08-25 evening was 40, so coverage is thin until the
  monthly reset. (e) Timing-reject shadow rows are never anchored; draw-
  question markets never benchmarked. (f) Same match/line caveats as
  `pin_clv` above (MLB ML near-complete, totals exact-line-only, soccer
  quarter-lines, tennis only while a key is active). Shadow anchors exist
  from 2026-08-25 13:17Z (migration 0035); the budget design from the
  same evening (migration 0037). Purpose: the pre-registered `pin_edge`
  and fade tests in docs/STRATEGY.md / docs/charters/.
- **Line-ingestion silently failed in 1,520 canonical sync runs,
  2026-04-12 → 2026-08-12.** `parseTeamsFromTitle` treated everything
  before "vs." as the away team, so prop-style titles ("Will there be a
  run scored in the first inning?: A vs. B") produced 60+ char "team
  names"; `findTeamByAlias` fed them to `aliases_json LIKE '%...%'`,
  exceeding D1's LIKE pattern length cap, which THROWS — killing the
  whole line-ingestion step for that run (status `partial`). The failure
  came and went with whatever titles sat in `sharp_money_cache`, so
  Polymarket-source `game_lines` close rows have intermittent gaps in
  that window (the ESPN pickcenter line path was unaffected and covered
  most games). Fixed `8b4d749` (colon-aware title parsing + length guard
  before LIKE + per-row try/catch so one bad row can't kill the step).
  The sweep shipped 2026-08-11 (migration 0030) but captured nothing:
  `manual_picks.event_time` is ISO text and the sweep compared it as unix
  seconds — SQLite's TEXT>INTEGER affinity made the anchor filter
  always-true while the string coerced to NaN in the JS window checks, so
  every selected row was skipped. Fixed `d62d2c2` (unixepoch() in
  select + where). The four 2026-08-11 picks are permanently pin-NULL.
- **`close_signal_*` coverage starts 2026-08-12 evening** (migration 0031,
  `9a9a75e`): live signal state (sharp side, score differential, edge
  rating, warnings, concentration, slimmed holder books) frozen ~10 min
  before start for pending picks, via the same `analyzeMarketSharpness`
  path used at pick time. Record-only — no picking/holding behavior
  change. NOT covered: the pipeline-layer gate vector (signal_score with
  novelty, price_edge vs fair price) is not recomputed at close. Rows may
  instead hold `{"error": ...}` when the analysis failed through the whole
  capture window.
- **Sport coverage gaps before 2026-07-30.** Series IDs were hardcoded and
  Polymarket mints a new Gamma series per season (`nfl-2025` → `nfl-2026`,
  `premier-league-2025`, ...), so the pipeline was structurally blind to (a)
  any sport not in the list — MLS, all non-EPL soccer, the entire 2026 World
  Cup (June 11–July 19) — and (b) any tracked sport once its next-season
  series appeared. Fixed 2026-07-30: `src/server/api/series-registry.ts`
  resolves active series dynamically by slug probe (6h in-memory TTL,
  hardcoded fallback); MLS added as a target sport. Volume/coverage
  comparisons that straddle 2026-07-30 are confounded by the wider universe.
- **Sport-performance stats regrouped by tag on 2026-07-30.** Grouping keys
  changed from `series_<id>` (season-bound) to sport tags (`mlb`, `epl`, ...)
  so one sport's history no longer splits at season boundaries. Consumers of
  the stats API that matched on `series_*` keys must use tags.
- **Football (NFL/NCAAF) canonical data starts with the 2026 season.** The
  system went live Feb 2026 as football ended, so `games`/facts/trends have
  zero football history; week-1 scoring correctly degrades to
  "missing snapshot". 2026-07-30 readiness work: full-FBS NCAAF seeding
  (148 teams), NFL preseason gate (`nfl_preseason_excluded`, era v5),
  `games.season/season_type/week` stamped from ESPN going forward (NULL on
  all earlier rows — 2025 MLB/NBA rows are not season-taggable), odds
  fetches prioritized by kickoff proximity, 45-day max-age guard on latest
  trend snapshots. Ambiguous team aliases (e.g. bare "Tigers") now skip
  resolution instead of silently linking the wrong team.
- **Soccer picks have no canonical linkage or book anchor.** ESPN
  schedule/team ingestion does not cover soccer, so soccer picks get
  `game_id = NULL` (no trend features, settlement via market resolution
  only), and `book_*` de-vig columns are moneyline-only while soccer picks
  to date are all totals/BTTS.
- **BAL/BOS trend data was corrupt 2026-07-23 → 2026-08-05** (see
  docs/audits/2026-08-05-duplicate-game-incident.md, including its
  same-day CORRECTION). The 2026-07-22 BAL@BOS doubleheader triggered
  `f91dce2`'s tie-unaware nearest-by-time matching into creating 848
  duplicate game rows (one every ~2 min for 2.5 days — the loop ended when
  the 3-day lookback dropped the slate date; the tie-break bug was FIXED
  later that day, see 2026-08-05-post-recon-deep-dive.md #2), each with facts, so
  every Orioles/Red Sox trend snapshot computed in that window had its
  last-10 filled with copies of that one game. Data cleaned up + rebuilt
  2026-08-05 (snapshot-bound commit `06d798a`). Three picks made during the window
  (`pick_1785197348845_5gck6mk`, `pick_1785531552200_ns3ve7v`,
  `pick_1785622207476_beejpwc` — all totals, all losses) carry poisoned
  pick-time trend context; exclude them from trend-bucket analyses. Totals
  don't consume trends in scoring, so decision impact was nil.

- **wallet_entries is valid only from 2026-08-05 onward.** The original
  share-reconstruction mixed price bases (USD valued at mid ÷ ask-based
  side price), fabricating 'increase' entries from spread oscillation
  (deep-dive finding #5). All 1,467 pre-fix rows were deleted 2026-08-05;
  diffs now use raw shares carried from the holders API.
- **CLV is valid only from 2026-07-20 onward.** Before `b40fec0`,
  `close_price` was captured from the resolved market (~0/1), so every stored
  `clv` was a rescaled win/loss flag. All settled picks were scrubbed to NULL
  on 2026-07-20 (4 backfilled from history). Any CLV claim in analyses dated
  before 2026-07-20 — including the 2026-06-25 "+3.2% CLV out-of-sample"
  validation — is invalid.
- **Pick volume before/after 2026-07-20 is not comparable.** Until `64ee07a`,
  Gamma events pagination silently skipped the soonest games whenever a series
  had >100 active events, shrinking the candidate universe. Post-fix volume
  may rise for behavioral rather than market reasons.
- **Daily stats snapshots before 2026-07-20 have survivorship bias**: days
  froze at UTC midnight, so picks settling after the rollover stayed counted
  as pending in that day's history (biases daily win-rate toward
  early-settling games). Fixed forward in `4e9a3f5`.
- **`strategy_version` on picks made before 2026-07-20 is a backfill**
  (`+backfill` suffix) assigned from `picked_at` vs deploy timestamps — see
  docs/STRATEGY.md.
- **Book anchor columns (`book_*`) have real coverage only from 2026-08-11**
  (schema from 2026-07-23, migration 0018; only 10 of 148 ML picks before
  then ever got values). Two compounding causes, both fixed (see
  docs/audits/2026-08-11-espn-403-outage.md): picks before 8/5 attached to
  Polymarket-created duplicate game rows without `espn_event_id`
  (`findGameForPick` didn't prefer ESPN-linked rows until `b2ea470`), and
  8/6–8/11 every ESPN call 403'd (UA-less requests; fixed `e26c852`).
  Pick-time fields come from a live ESPN fetch at creation
  (`book_source = 'espn_draftkings'`); a `game_lines` fallback is tagged
  `'game_lines_stale'` with the row's own `recorded_at` — filter on source
  when staleness matters. `book_fair_prob`/`book_ev`/`book_clv` are
  moneyline-picks-only (two-way multiplicative de-vig of the DraftKings ML)
  until 2026-08-11; from migration 0030 totals picks also de-vig side-aware
  (pickcenter over/under prices), but ONLY when the book's total line equals
  the pick market's line — line-mismatch rows keep raw odds with NULL fair
  prob, and that selection is non-random (lines diverge more on
  volatile-total games), so filter consciously. Spread picks still carry
  only line numbers. `book_clv` = de-vigged book close − pick price
  (positive = beat the close); the fill-price variant is derivable as
  `book_close_fair_prob − fill_price`.
- **Pinnacle columns (`pin_*`) exist from 2026-08-11** (migration 0030,
  The Odds API, env-gated on `ODDS_API_KEY` — rows stay NULL until the
  secret is set). `pin_close_*` is a close PROXY (last capture in a window
  opening 10 min before start), not a frozen closing line; `pin_captured_at`
  set with NULL prices means the sweep ran but Pinnacle had no matching
  listing (or, for rows stamped at window expiry, the capture was missed).
- **Canonical game data was frozen 2026-08-05 → 2026-08-11** (ESPN 403
  outage, docs/audits/2026-08-11-espn-403-outage.md): no finals, no fact
  computation, no trend refresh for six days, invisible because fetch
  failures counted as success. Finals self-healed post-fix via the 14-day
  result-ingestion window, but (a) trend context stamped on picks/shadow
  rows made 8/5–8/11 reflects finals frozen at 8/4 — treat trend-bucket
  analyses over that window as stale; (b) games of 8/5–8/7 permanently
  lack `espn_event_id` (outside the 3-day schedule lookback at fix time),
  so picks on those games can never get book closes.
- **`game_lines` `snapshot_type='close'` rows are TRUE closes only from
  2026-07-30** (first-observed before that; discovered 2026-07-23): odds
  ingestion used to write once and never revisit, freezing the value at
  whatever ESPN showed when the game first entered the fetch window. Fixed
  2026-07-30: each close row is refreshed once after kickoff, when ESPN's
  pickcenter is frozen at the closing line; refreshed rows have
  `recorded_at > games.game_time` (that inequality is the true-close
  marker). Rows finalized before the fix remain first-observed, so
  `team_game_facts` ATS/OU results, `team_trend_snapshots` ATS/OU records,
  and `fav_dog_role` computed from pre-2026-07-30 games still carry the
  old error — any analysis that would *increase* the weight of team trends
  should restrict to facts graded after the fix (or to `recorded_at >
  game_time` lines). `book_close_*` on picks was always post-game-captured
  and unaffected.
- **Hard gates were unfalsifiable before 2026-07-30 (shadow book).** All 318
  picks settled before then are 1–3h — timing windows, sport excludes, and
  the low_conviction filter produced only silence, so no gate could be
  proven right or wrong from the pick book. From 2026-07-30 the
  `shadow_candidates` table records every policy-gate reject at first sight
  and settles it via the pick resolution path without betting; audit with
  ROI grouped by `reject_reason`. Gate performance claims for periods
  before 2026-07-30 have no counterfactual data. Trend-dimension slicing of
  shadow rows (`trend_context_json`: fav/dog role, venue, streaks, canonical
  score; migration 0023) is populated only from 2026-07-31, first-sighting
  rows only; `market_type` on cron-path `outside_window` rows is likewise
  NULL before 2026-07-31. **Pre-filter shadow rows (`too_close_to_start`,
  `outside_window`, `not_ready`) have `grade`/`signal_score`/`warnings_json`
  = NULL before 2026-08-03 ~22:33 UTC** — those gates fire before the scan's
  grade pass, so earlier rows test the raw sharp signal, not
  would-have-been-picks (see
  docs/audits/2026-08-03-shadow-checkpoint-too-close-to-start.md); graded at
  record time from then on — filter `grade IS NOT NULL` for
  would-have-been-pick analyses. Shadow rows may also be **`status='void'`**
  (from 2026-08-03, migration 0024): still unresolved 14 days after their
  event — canceled/delisted markets; excluded from win/loss/pending
  aggregates by construction. Related in-sample finding
  (2026-07-30 audit, multiple-comparisons-exposed, pre-registered for the
  n≈100 re-audit, NOT acted on): v4 picks with zero warnings were 18–8
  (+41.5%, t=2.17) vs break-even with ≥1 warning; `sharpSideValueRatio`
  quartiles showed no gradient.
- **Shadow rows before 2026-08-06 have no gate vector** (`price_edge`,
  `fair_price`, `edge_rating`, `score_differential`, `gates_json` = NULL;
  migration 0027). The gate chain early-returns on the first failing gate,
  so for those rows "would it have passed the OTHER gates" is unknowable —
  per-gate shadow ROI on pre-2026-08-06 rows overstates what loosening that
  single gate would recover. Concretely: `signal_score_saturation` fires
  before edge-rating/microstructure/price-edge are ever evaluated, so its
  +20% ROI cohort (n=42 at 2026-08-06) is contaminated with candidates that
  would have been rejected downstream anyway; `price_edge_below_floor` is
  the LAST gate, so its cohort (13–3, n=16) is the only clean
  single-gate-away counterfactual among pre-0027 rows. From 2026-08-06,
  filter with `json_extract(gates_json, '$.<gate>.pass')` — `pass` is null
  when the input was unavailable at record time (NOT a pass). `gates_json`
  evaluates global calibration gates only; per-policy-segment min-grade and
  microstructure thresholds are not reproduced (`grade_vs_base` compares
  against the BASE min grade).
- **The v6 prop shadow cohort starts ~2026-08-07 for MLB first-inning
  markets.** Era v6 (2026-08-06) added the `prop_market_excluded` gate, but
  `getMarketTypeLabel` only knew abbreviation/bookmaker keywords ("nrfi",
  "btts", ...) while Polymarket titles NRFI/YRFI as a question ("Will there
  be a run scored in the first inning?: Twins vs. Royals"), so those markets
  classified as `other` and were dropped silently — no shadow row under ANY
  reason. At least 6 first-inning markets seen 2026-08-05→06 in
  `sharp_money_history` have no shadow record. Fixed by adding "first
  inning"/"1st inning" to `GAME_PROP_KEYWORDS`. BTTS titles ("... : Both
  Teams to Score") always matched, so the BTTS cohort has no gap. When
  counting the prop cohort for the v6 revisit, filter by
  `market_type='prop'`, not `reject_reason='prop_market_excluded'` — the
  timing pre-filters (`too_close_to_start`, `outside_window`) run before the
  policy gate and will claim some prop rows. Era v7 (2026-08-07) widened
  `prop` to team totals and 1H/2H/quarter period markets — which until then
  classified as pickable `total`/`moneyline` — and moved 1H spreads from the
  `spread` cohort to `prop`; segment prop-cohort analyses by era.
- **One-pick-per-market-group rule (era v7, 2026-08-07) leans on the sharp
  cache.** The cross-scan guard derives the picked market's group key
  (event × market type) from its `sharp_money_cache` row; if that row is
  evicted while sibling alternate lines remain listed, the guard lapses for
  that game. Shadow reasons: `market_group_already_picked` (bet-eligible
  sibling of a picked line), `alt_line_deduped` (lost same-scan dedup to a
  better-graded sibling; recorded only from 2026-08-07 — earlier dedup
  losers were dropped silently, so the hold-vs-upgrade question has no
  pre-v7 data).
- **Gate-threshold epistemics**: every gate value (90-min window, edgeRating
  band-pass, `MIN_PRICE_EDGE` 0.25, signalScore saturation 90) was fitted
  retrospectively on ~160-298 picks across multiple bucketings — in-sample,
  multiple-comparisons-exposed. The edgeRating dead-zone flip-flopped between
  the 2026-03-29 and 2026-05-11 audits (opposite conclusions on overlapping
  data). The CLV corroboration quoted in `src/lib/sharp-grade.ts` comments
  is pre-`b40fec0` contaminated CLV — ROI bands stand, CLV numbers don't.
  Clean out-of-sample evidence is n=19 (t≈0.5). Disposition: pre-registered
  hypotheses graded at the n≈100 re-audit (see
  docs/audits/2026-07-20-audit-and-hardening.md, planned analyses 4-5) —
  not re-tuned.

## 2026-07-23 multi-agent recon — 52 confirmed findings

Full ranked list with evidence and suggested fixes:
docs/audits/2026-07-23-agent-recon.md (1×P0, 11×P1, 20×P2, 20×P3; 7 refuted
by adversarial verification). Fixed same-day: the P0 (mid-game settlement on
live price extremes — guard + closed-market requirement + settle status
guard; 9 exposed historical picks re-verified clean against Gamma finals).
Highest-priority still open, in rough fix order:

Fixed in batch 1 (2026-07-23 afternoon): detectBetType word-boundary rewrite
(140 historical picks relabeled; bet_type now clean), canonical ops endpoints
gated by BOT_API_KEY (`/_pipeline/trigger` deliberately open — UI calls it,
equivalent to the cron tick), result-ingestion scoreboard lookups keyed by
US-Eastern date, book_source derived from actual provider (+
book_close_source, migration 0019), close-sweep livelock (RANDOM order +
14-day give-up).

Fixed in batch 2 (2026-07-23): resolvePickedSide side-mapping — totals/prop
picks get no team linkage (Over/Under is not a team; 155 historical rows
nulled, actual_total retained), name matching precedes positional mapping,
and the A→away/B→home fallback is restricted to moneyline where the ordering
is verified. fav_dog_role now derives only when a picked team exists.

Fixed in batch 3 (2026-07-23 evening): pipeline outage no longer burns the
tick cooldown as "no_markets"; drift baselines NULL-safe and bounded to
earlier days; result-ingestion 14-day cutoff (no more straggler starvation);
doubleheader-aware ESPN event stamping + nearest-by-time game matching;
settle sweep over-fetches before the eligibility filter; history-close
requires a sample within 1h of start; bot_candidate_snapshots pruned to 30d
(151k rows purged); observability enabled; broken migrate script replaced
with `d1:exec:remote`.

Fixed in the bot batch (2026-07-23 night, bot branch `b8594ae` — restart
the VPS service to activate): unknown-order-state handling (no more
double-bet on timeout), clientPickId + pendingReports outbox (fills can't
be lost from D1), per-bet state persistence, live-price gates + bounded FOK
orders (BOT_MAX_PRICE_DRIFT_BPS, default 300), working stop_on_403 kill
switch, non-poisoning Gamma token fallback, honest 'filled_unparsed'
status, escalating backoff, full call metering. Bankroll floored at 0 with
warning — credit-on-settlement still an open design item.

Still open, in rough fix order:

1. Bot follow-ups — both halves closed 2026-08-24:
   (a) Bankroll credit: SHIPPED as wallet-balance sync (bot `main`
   commit `d64daf1`; mirror in `bot/`) — Polymarket auto-claims settled
   winnings to the wallet, so the bot re-syncs `state["bankroll"]` from
   the live COLLATERAL balance every 15 min (BOT_BANKROLL_SOURCE /
   _REFRESH_SECONDS / _BALANCE_SCALE envs; paper ledger kept for dry
   run). DEPLOYED+VERIFIED on VPS 2026-08-24 15:47 UTC: first
   sync logged "bankroll synced from wallet: 0.0 -> 118.02" — the old
   ledger had decayed to exactly $0 (the failure mode live), scale
   correct. BOT_FIXED_STAKE=8 still set, so sizing unchanged until the
   user opts back into Kelly.
   (b) Server-side already-picked exclusion: verified already
   implemented — /api/bot/candidates excludes condition_ids picked in
   the last 7 days (`already_picked` pre-filter) plus the era-v7
   market-group gate behind it.
2. Shadow-window summary silently limited to picks with surviving
   sharp_money_history (~7-day retention) — misleading beyond that horizon.
3. Scoring-behavior findings needing an era decision (do NOT fix casually):
   empty-side sharpScore=50 inflation; edgeRating "volume bonus" computed
   from liquidity. Both change picking behavior → strategy era bump.
4. Remaining P2/P3s tracked in docs/audits/2026-07-23-agent-recon.md
   (canonical-sync reversed-order spread signs, games dedup race, summary
   label/unit nits, wentToOt hardcoded, DO tick cooldown jitter).

## Open code issues (deferred, ranked)

0. **Canonical sync runs ~3-7 min 2026-08-18 16h UTC → 2026-08-20 (baseline
   ~12 s).** Two stacked causes. (a) Concurrent-run pile-up: the 5-min
   cooldown reads the last COMPLETED run, so one slow run let every 2-min
   tick start another concurrent sync — FIXED with the migration-0033
   advisory lock (`cca8841`). (b) Even solo runs sat at ~3-4 min around the
   clock (fast overnight hours never returned; slowdown uniform ~20-50x per
   step at identical work counts, e.g. line-ingestion with 0 inputs 0.17 s →
   9.3 s): the 2026-08-18 deploy moved cron invocations to a colo far from
   the D1 primary (ENAM/EWR), adding ~200 ms RTT to every D1 query. Load was
   only the minor component (±40% diurnal; sharp_money_history writes 4k →
   10k/day with the new leagues). FIXED 2026-08-20: the sync now executes in
   a Durable Object instance pinned via `locationHint: 'enam'`
   (`getCanonicalSyncStub`, DO name `canonical-sync-enam-v1` — the hint only
   applies at first instantiation, so bump the suffix if the D1 primary ever
   moves region). Every run now records a `d1-ping` step (3× `SELECT 1`
   roundtrip, medianMs) in `steps_json`. Observed values: pinned-DO runs
   ping ~30 ms median / ~24 s total (verified stable 2026-08-20 12:38Z +
   12:44Z; the regressed colo implied ~200 ms; pre-regression baseline
   ~12 s implied single-digit ms). Median >~75 ms means the run is
   executing far from the primary again. `/_canonical/trigger` routes
   through the same DO and now respects the advisory lock (it previously
   took no lock and could run concurrently with a scheduled sync); it
   returns 409 `{error:'locked'|'cooldown'}` when refused (force bypasses
   only the cooldown). Fallback if a regression appears with LOW ping (i.e.
   genuinely workload): batch D1 writes in pick-backfill/espn steps.
1. **CLV summaries read the persisted `clv` column** (`getManualPicksClvTimingSummary`,
   calibration/bucket/grade summaries). Mostly NULL until post-2026-07-20
   picks accumulate; they self-heal with time. The shadow-window summary
   recomputes CLV live from `sharp_money_history` and is the trustworthy view
   meanwhile.
2. **`spread_line`/`total_line` on picks are closing lines, not pick-time
   lines** (`getLineValues` prefers `close`; backfill overwrites). Mild
   lookahead if used as pick-time features; `fav_dog_role` derives from them.
   Partially addressed 2026-07-23: `book_spread_line`/`book_total_line` are
   genuine pick-time captures (bot picks now run inline enrichment at
   creation), so use those as pick-time features going forward; the legacy
   columns and `fav_dog_role` derivation are unchanged.
3. **`roi` uses pick price, not `fill_price`** — overstates realized return by
   average slippage (currently ~0, occasionally ±200–400bps at $2 stakes).
   `fill_slippage_bps` sign convention audited 2026-07-21: positive =
   adverse fill (`(fill - price)/price * 10000`, bot.py ~line 804).
4. **No dead-letter queue on `sharp-pipeline`** — FIXED 2026-08-24:
   `sharp-pipeline-dlq` created (14-day retention, no consumer — inspect
   via dashboard or `wrangler queues`), `dead_letter_queue` wired on both
   consumer blocks in wrangler.jsonc.
5. **Subrequest budget miscount in `analyzeSharpMoney`** — FIXED
   2026-08-24: per-token holder re-fetches now counted
   (`marketDataSubrequests = 2 + tokenIds.length`) in both the PnL and
   unit-size budgets.
6. **Dead code**: holders `slice(0, 50)` no-op — FIXED 2026-08-24 (slice
   matches the API's 20-row cap, comment now honest). Still open:
   market-level holder fallback can skew per-side counts (behavior
   change to fix — leave for an era decision).
7. **`canonical_sync_runs` grows unbounded** — FIXED 2026-08-24:
   `persistSyncRun` prunes rows older than 90 days after each insert.
   Note its timestamps are **milliseconds** while `manual_picks` uses
   **seconds** — a recurring audit-query footgun.
8. **Duplicate migration ordinal `0008`** (two files). Cosmetic.

## Operational notes

- Sharp data is expected to go stale overnight once all tracked games start
  and next-day markets are under the $10k volume floor. The cron logs
  `[sharp-pipeline] STALE: ...` when the newest history row is >30 min old —
  expected overnight, actionable during game hours.
- Always query remote D1 with `--remote`; the local miniflare DB is empty.
