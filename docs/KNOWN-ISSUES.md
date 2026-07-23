# Known Issues & Data Caveats

Living document. When one is fixed, move it to the relevant audit doc with the
fixing commit.

## Data-validity caveats (permanent)

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
- **Book anchor columns (`book_*`) are valid only from 2026-07-23 onward**
  (migration 0018). Pick-time fields come from a live ESPN fetch at creation
  (`book_source = 'espn_draftkings'`); a `game_lines` fallback is tagged
  `'game_lines_stale'` with the row's own `recorded_at` — filter on source
  when staleness matters. `book_fair_prob`/`book_ev`/`book_clv` are
  moneyline-picks-only (two-way multiplicative de-vig of the DraftKings ML);
  totals/spread picks carry only the book's line numbers. `book_clv` =
  de-vigged book close − pick price (positive = beat the close); the
  fill-price variant is derivable as `book_close_fair_prob − fill_price`.
- **`game_lines` `snapshot_type='close'` rows are first-observed lines, not
  true closes** (discovered 2026-07-23): odds ingestion writes once and skips
  games that already have a close row, so the value freezes at whatever ESPN
  showed when the game first entered the fetch window — possibly days before
  tip. Downstream contamination: `team_game_facts` ATS/OU results,
  `team_trend_snapshots` ATS/OU records, and `fav_dog_role` all grade or
  derive against these lines. Any analysis that would *increase* the weight
  of team trends must first fix or bound this error. True book closes exist
  only in `book_close_*` on picks (captured post-game, when ESPN's
  pickcenter is frozen at the closing line).
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

1. `detectBetType` misses "vs." (dot) so moneyline picks classify as
   `other` — kills bet_type analytics AND the book-anchor fair-prob path.
2. `resolvePickedSide`/enrichment hard-maps side A→away, side B→home for all
   market types — inverts team linkage on spread markets, fabricates it on
   totals.
3. Bot (fix on `main` branch): order timeout treated as not-placed (can
   double-bet), fills lost when pick POST fails (no clientPickId sent),
   duplicate-bet guard is local-state only, market FOK orders have no price
   bound.
4. Unauthenticated pipeline ops endpoints in server.ts (force-trigger,
   backfill).
5. ESPN scoreboard queried by UTC date but ESPN slates are US-Eastern —
   night games never finalize via the straggler path; doubleheaders collapse
   into one game (6h dedup window) and can stamp the wrong espn_event_id.
6. Shadow-window summary silently limited to picks with surviving
   sharp_money_history (~7-day retention) — misleading beyond that horizon.

## Open code issues (deferred, ranked)

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
4. **No dead-letter queue on `sharp-pipeline`** — a message that exhausts
   `max_retries: 3` is deleted, so a persistently-failing market loses its
   forensic trail. Needs `wrangler queues create sharp-pipeline-dlq` + config.
5. **Subrequest budget miscount in `analyzeSharpMoney`** — ~2 per-token holder
   re-fetches aren't counted against `MAX_SUBREQUESTS`; only matters on the
   50-subrequest free plan.
6. **Dead code**: holders `slice(0, 50)` is a no-op (Data API caps at 20) with
   a misleading comment; market-level holder fallback can skew per-side counts.
7. **`canonical_sync_runs` grows unbounded** (no prune; ~12 rows/hour). Note
   its timestamps are **milliseconds** while `manual_picks` uses **seconds** —
   a recurring audit-query footgun.
8. **Duplicate migration ordinal `0008`** (two files). Cosmetic.

## Operational notes

- Sharp data is expected to go stale overnight once all tracked games start
  and next-day markets are under the $10k volume floor. The cron logs
  `[sharp-pipeline] STALE: ...` when the newest history row is >30 min old —
  expected overnight, actionable during game hours.
- Always query remote D1 with `--remote`; the local miniflare DB is empty.
