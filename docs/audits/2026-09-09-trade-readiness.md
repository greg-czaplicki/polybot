# Trade readiness — 2026-09-09

Scope: core quote collection and shadow diagnostics. Owner authorized implementation
after the production readiness review. No UI, live entry gate, stake, strategy
threshold, or promotion-rule changes.

## Production baseline

Read-only D1 queries on September 9 found:

- Since August 28, 41 settled CFB probation rows; only one carried Pinnacle CLV.
  None passed all five vector gates together.
- All-history sole-blocker tennis probation samples: ATP four settled, WTA seven.
- No `pin_div_paper` or `tennis_v2_paper` rows had been recorded.
- Latest paper heartbeat evaluated one market and fired zero rules. It previously
  updated only when a fresh feed existed, hiding missing-coverage ticks.
- Eight provider fetches in the preceding 24 hours: MLB two, soccer three, tennis
  three; no football fetch. Account reported 153 remaining credits.
- EPL is live-eligible, with two matched soccer picks since August 28. The premise
  that every non-MLB sport is shadow-only is not the deployed behavior.

These are coverage diagnostics, not early formal reads of the registered tests.
The contracts remain `pin-divergence-benchmark.md` and the tennis R1 addendum:
moneylines, price 0.25–0.75, fresh reference at decision time, 5-point minimum
discount, at least 30 minutes pre-event; future settlement/CLV are labels only.
Per-sport promotion still requires its registered sample and clustered evidence.

## Implementation

Football demand comes from pending observed moneyline/total shadows, including
outside-window rejects, rather than passing holder gates. With football due in
the next 24 hours, reserve up to two unused slots within OddsPapi's existing
eight-fetch ceiling. Live closes retain priority. NFL and CFB share one provider
group. Request a pregame quote 45–90 minutes before a slate starts and a close
quote in the last ten minutes. One pregame request and one closing request per
rolling day: this is a minimal coverage allocation, not every-kickoff coverage.
Credit floors and provider backoff still apply. Already-spent budget cannot be
recovered; on the first deployment day a window can still be missed.

Shadow anchor/close batches interleave sports so one busy sport cannot occupy
every row in the batch. Football scheduling also runs without eligible pick rows.
The existing tennis boost remains in place; no paid subscription is purchased.

`bot_runtime_status.paper_lanes` now reports per-sport eligibility, evaluations,
fires, rejection counts, and errors on every evaluator call, including empty
scans. Reasons distinguish missing/stale/empty/invalid feeds, market type,
timing, event and side matching, missing prices, and insufficient discount within
the price band. `football_coverage` records demand, quote availability, provider,
spend, balance and backoff on active quote sweeps. Both are latest snapshots,
not cumulative evaluation samples. They cannot establish historical coverage
rates by themselves.

## Operational follow-up

After deployment, read the two runtime keys and verify the new per-sport fields.
During tonight's football windows, verify football fetch-log entries, feed times,
and captured closes. Zero rule fires with fresh quotes is a valid result; missing
quotes or matching failures are operational issues. Tennis still uses the
documented session-time proxy and requires a separate timing review before live
activation. Multiple football kickoff blocks cannot all receive paired quotes
under the two-slot allocation; use observed coverage to size any future budget
change, rather than relaxing freshness or thresholds.

The wallet-settlement queue issue and wallet-ranking sample-count issue from the
earlier review remain separate follow-up work; neither is fixed by this change.

## Validation and release

- 314 tests passed across 17 files, including six new scheduling/diagnostic tests.
- Biome passed on all changed TypeScript files; production build passed.
- The interleaved close query executed successfully against production D1 as a
  read-only check. Repository-wide `tsc --noEmit` remains unsuccessful with
  errors outside these changes (server-function typing and Cloudflare bindings,
  among others); this release does not claim a clean repository typecheck.
- Deployed worker version `db71bea5-7684-4606-859a-d71d74e6012b` on September 9.
  Source committed in `caaec6d`; no strategy era bump.
- Post-deploy health endpoint returned HTTP 200, no alert or chronic errors.
  Production wrote `football_coverage` at 12:10:36 UTC (NFL demand detected,
  outside scheduled windows, eight requests spent, 153 credits, no backoff).
  At 12:11:07 UTC `paper_lanes` wrote the new per-sport diagnostics: one WTA
  entry blocked by `stale_feed`. Runtime verification passed; tonight's actual
  football quote-window captures remain to be observed.
