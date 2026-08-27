# Wallet functionality deep dive — position aggregation (2026-08-28)

Prompted by the /wallets specialist work: "are we aggregating positions
everywhere we should?" Full trace of both wallet paths: the scoring path
(`sharp-money.ts` holders → sharpScore) and the ledger path
(`wallet-clv.ts` → `wallet_entries` → /wallets).

## How positions flow

- **Scoring path:** per market, top-20 holders per token from
  `data-api /holders?token=` (per-token re-fetch, line ~2235, avoids the
  market-level 20-cap skewing sides; market-level list is only the fallback
  when per-token fetch fails — the known era-gated skew). Holder `amount` is
  the wallet's CURRENT total position in that token (shares × price), so
  increments self-aggregate. sharpScore = Σ positionWeight × momentum ×
  pnlTier, where positionWeight uses amount × stakeUnitWeight
  (sqrt(stake/unit), clamped [0.25, 2]), momentum from day/week/month PnL
  signs, pnlTier from all-time PnL (unit-normalized when unit size known).
  Unit size = median-top-half of last ≤50 closed-position stakes
  (`MIN_UNIT_SIZE_SAMPLES=3`, 6h cache, subrequest-budget-limited).
- **Ledger path:** `wallet_entries` records pre-event top-20 INCREASES
  (shares-diffed, ≥$100) at their own entry price; settles to
  `clv = PM close − entry`. Settle cron in `server.ts` (limit 50/tick).

## Aggregation verdicts

| where | aggregated? | verdict |
|---|---|---|
| increments within a position (scoring) | yes — API amount is current total | OK |
| increments within a position (ledger rows) | no — one row per increase, each graded separately | correct for CLV-per-decision; WRONG basis for leaderboard ranking (finding 1) |
| same wallet on BOTH sides (hedge) | no netting anywhere | finding 2 |
| same wallet across markets of one game (ML+spread+total) | no | finding 3 (needs game linkage; low priority) |
| per-season series → sport | yes (registry tag merge, 8/27) | OK |
| specialist floor/share | distinct markets (8/28 fix) | OK |

## Findings (ranked)

1. **Leaderboard still ranks on raw increments.** `avg_rel_clv` averages
   over entries, and the ≥3-settled qualification counts increments — a
   4-increment single-game pyramid qualifies and ranks with what is really
   ONE observation (the 0x8c59… Seahawks wallet sits high on exactly this).
   Same class of bug as the specialist floor just fixed. Fix: aggregate to
   per-(market, side) — dollar-weighted entry price vs close — then average;
   qualify on ≥3 distinct markets.
2. **Hedged wallets are diagnostic-only everywhere.** A wallet top-20 on
   both sides contributes FULL weight to both sharpScores (the
   `computeHedgingMetrics` docstring itself says this can fabricate two-way
   conviction). Metrics are computed in `bot.ts` and stored in decision
   snapshots, but: not in scoring, not a gate, not in the shadow
   `gates_json` vector, not shown on /wallets. Both hedge legs also enter
   `wallet_entries` as independent rows (their CLVs sum to ≈ −spread, a
   mild self-penalty — acceptable). Cheapest upgrade with teeth: surface
   `totalHedgedFraction` per market and flag hedged wallets in the /wallets
   feed; any scoring use is era-gated + charter.
3. **No game-level aggregation.** ML + spread + total of one game are
   independent markets everywhere (scoring signals, ledger, specialist
   counts). Picks are deduped by the one-pick-per-market-group rule, so
   exposure is safe; signal-side double counting remains. Needs a
   game_id/condition-group linkage on `wallet_entries` to fix; defer.
4. **Known era-gated items still present** (recon 7/23): empty-side
   sharpScore = 50 fabricates differential vs a holderless side
   (`calculateSharpScore`, ~line 1912); market-level holder fallback skew
   (only on per-token fetch failure). Both awaiting an era review, not
   regressions.
5. **Coverage-dependent weighting.** Unit-size fetches are cut off by the
   subrequest budget, so some holders are tiered on raw USD and others on
   units within the same market — a wallet's weight can differ tick to tick
   with cache state. Inherent to the budget; recorded, not fixed.
6. **Recorded-but-stale inputs.** `wallet_pnl_cache` refresh is
   budget-bound (observed 4-day-old rows); exits/reductions are never
   observed (top-20 in-flow only), so `total_usd` on old rows can overstate
   a live position. Display caveats, not bugs.

## Decisions

- Finding 1 accepted for immediate fix (display/ranking only, no scoring
  change, no era bump).
- Finding 2: flag/surface only for now; scoring use would need a charter.
- Findings 3–6 recorded; no action this pass.
