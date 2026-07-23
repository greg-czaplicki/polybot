# 2026-07-20 — Performance Audit + Incident Sweep

## Performance since the 2026-06-25 gates (era v4)

All MLB. 20 graded picks; excluding the one pre-gate straggler (A+ ss=94.3,
picked between the two Jun 25 deploys, never filled): **19 picks, 10W–9L,
avg ROI +12.9%**, ~+$4.90 realized at flat $2 stakes. t≈0.5 — **not
statistically significant**; direction agrees with the May retrospective
(+17.7% predicted for MLB under these gates). Do not scale stakes on this
sample. Volume dropped ~18/wk → ~6/wk from the gates (also see the pagination
caveat below). Split: totals 5–7 (−6.8%), moneyline 5–3 (+28.5%) — opposite of
the June "totals >> ML" finding; both n too small to act on.

Gate compliance post Jun 25 22:05Z: clean. Zero ss≥90, zero edgeRating in
[72,80), zero scoreDiff<20, min price_edge exactly 0.25.

Re-audit when era-v4 sample reaches n≈100 (~late Sep 2026 at current volume),
by which time real CLV should exist on ~50+ picks. Planned analyses:

1. **Does canonicalScore (team trends) predict outcomes?** Trend snapshots
   (last-10 window, 9 contextual splits) are healthy and scored on every pick,
   but the score sits 4th in the candidate sort below three continuous floats,
   so it is essentially never decisive. Test persisted per-pick scores against
   ROI/CLV and only then decide whether trends deserve real weight. Frame it
   as **incremental lift over priceEdge/book_ev**, not standalone predictive
   power — canonicalScore is already correlated with edge/scoreDiff (May MLB
   forensic), so standalone correlation would double-count. Caveat: ATS/OU
   trend records grade against `game_lines` "closes" that are actually
   first-observed lines (see KNOWN-ISSUES 2026-07-23) — fix or bound that
   error before promoting trends on the strength of this test.
2. Totals-vs-moneyline split (signs flipped at tiny n in this audit).
3. Real-CLV validation of the calibration — the first non-circular CLV test
   this system has had. Book-anchor CLV (`book_clv`, logged from 2026-07-23)
   is the primary skill metric: per-observation variance is a fraction of
   ROI's, so a real edge resolves in ~50-100 picks instead of ~400+.
4. **Pre-registered gate hypotheses (stated 2026-07-23, before the data).**
   Predicted to hold: `price_edge >= 0.25` floor and the `signal_score >= 90`
   saturation gate. On probation (no causal story, flip-flopped between the
   Mar 29 and May 11 audits): the edgeRating dead-zone band-pass [72,80).
   The re-audit GRADES these predictions on era-v4 picks; it does not re-tune
   thresholds on the same data — that discipline is the point.
5. **Grade the gate-rejected candidates.** The definitive gate test is
   counterfactual: settle gate-rejected candidates on paper and compare with
   accepted picks. Rejects performing as well as picks ⇒ the gate is noise.
   Prerequisite to verify beforehand: `bot_candidate_snapshots` must be
   capturing rejected candidates with reject reasons, not only accepted ones.
6. Also note: the ROI band evidence cited in `src/lib/sharp-grade.ts` comments
   stands, but the CLV corroboration quoted there comes from the
   pre-`b40fec0` contaminated CLV (Incident 1 below) and should be ignored.

## Incident 1 — CLV was outcome-contaminated for every pick ever (fixed `b40fec0`)

`resolvePickResult` took `closePrice` from the resolved Gamma market's
`outcomePrices` (~0/1 after resolution): stored CLV ≡ rescaled win/loss. All
298 picks affected; invalidates every prior CLV-based claim. Fix: settlement
computes close as the last `sharp_money_history` price at or before
`event_time` (NULL if no coverage — never the resolution price). DB scrubbed;
4 picks within the ~6-day history retention backfilled with true closes.
`strategy_version` stamping added the same day.

Why it wasn't caught: CLV was only validated against itself — perfect
agreement with outcomes read as confirmation when it was the red flag.

## Incident 2 — Gamma events pagination blind spot (fixed `64ee07a`)

Gamma `/events` silently caps at 100 rows; code requested `limit=200` and
paged `offset += 200`, permanently skipping events 100+. With
startTime-descending ordering the skipped tail was exactly the **soonest**
games. Whenever a series had >100 active events the pipeline was blind to the
near slate — the daily evening data gaps, and a systematically narrowed bot
candidate pool. Post-fix a tick queued 19 jobs vs `no_markets` before.

Why it wasn't caught: graceful degradation (fewer markets, no error) plus the
volume drop being attributed to the gates deployed the same week.

## Hardening sweep (fixed `4e9a3f5`, `1974217`)

Three review passes (API truncation, metric contamination, job reliability)
found and fixed:

- `/api/bot/picks/outcome` accepted client `closePrice`/`clv` (unused
  endpoint, would have re-contaminated CLV) — now server-authoritative.
- Grade-recalibration narratives coerced NULL CLV to −Infinity, emitting false
  "A+ not outperforming A" conclusions from scrubbed data — now sample-gated.
- Daily snapshots froze at UTC midnight with late picks stuck pending — now
  re-freeze previous day until +12h.
- `getTeamTrendSnapshotAsOf` inclusive `<=` boundary lookahead — now strict
  `<`; enrichment passes pick time.
- ESPN scoreboard fetches had no `limit` (silent truncation on NCAAB/NCAAF
  slates) — now `limit=1000`.
- Two picks stuck pending 30+ days (Gamma delists closed markets from default
  listing) — settlement retries with `closed=true`.
- Added cron staleness alarm (>30 min); DO cooldown burned only after
  successful fetch; queue ack decoupled from progress reporting (was re-running
  analyses and duplicating history rows); explicit `max_retries: 3`; settle
  batch 100→20 to fit the shared subrequest budget.
- Stale "first run" refresh banner shown only on a genuinely cold cache.

Deferred items: docs/KNOWN-ISSUES.md.
