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

## Open code issues (deferred, ranked)

1. **CLV summaries read the persisted `clv` column** (`getManualPicksClvTimingSummary`,
   calibration/bucket/grade summaries). Mostly NULL until post-2026-07-20
   picks accumulate; they self-heal with time. The shadow-window summary
   recomputes CLV live from `sharp_money_history` and is the trustworthy view
   meanwhile.
2. **`spread_line`/`total_line` on picks are closing lines, not pick-time
   lines** (`getLineValues` prefers `close`; backfill overwrites). Mild
   lookahead if used as pick-time features; `fav_dog_role` derives from them.
   Proper fix: separate pick-time-line column captured at creation.
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
