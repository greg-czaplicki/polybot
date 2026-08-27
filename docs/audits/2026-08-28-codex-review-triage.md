# Codex whole-app review — triage (2026-08-28)

External review (Codex) of the full app. This doc adjudicates each finding:
CONFIRMED-NEW / CONFIRMED-KNOWN (already on record) / PARTIAL (real but
overstated) / LATENT (real pattern, not currently reachable). Verifications
below were done by reading the cited code, not by trusting the report.

## Verdict summary

The review's center of gravity is right: the money-moving boundaries
(execution idempotency, server-side auth, realized-P&L accounting) are the
weakest part of the system, and two model-validity catches are genuinely
new. Several P0 severities assume conditions that don't currently hold
(missing secrets, unbounded notional); noted per item.

## Security / control plane

1. **Server functions unauthenticated — CONFIRMED-NEW, the real P0.**
   Verified: `verifyAuthToken` is consumed ONLY by `bot-control.ts`;
   every TanStack server fn (manual-picks mutations incl. delete-history,
   canonical-debug seeding, sharp-money refresh) relies on the client-side
   `AuthGate`. The workers.dev URL is public. Fix: deny-by-default server
   middleware checking the signed token on every mutating fn.
2. **`POST /_pipeline/trigger` anonymous with `force` passthrough —
   CONFIRMED-NEW.** Verified in `server.ts` (~line 58). Same middleware
   fix; require the token.
3. **Auth fail-open branches — LATENT.** Verified the branches exist
   (`auth.ts`: no APP_PASSWORD → token minted or open;
   `bot-control.ts`: no secret → open). But `wrangler secret list`
   confirms APP_PASSWORD and APP_AUTH_SECRET are both set in prod, so
   neither branch is live. Fix is cheap (fail closed on missing config);
   severity is misconfiguration-hazard, not active hole.
   `CONTROL_TOKEN=changeme` in the service file: verify on the VPS what
   the control agent actually loads.

## Bot execution

4. **Order-before-persist crash window — CONFIRMED-NEW (narrow).**
   Verified: `client_pick_id` is generated pre-order but exists only in
   memory until `append_trade_log` after the exchange call; server-side
   already-picked exclusion can't see a pick that was never reported, so
   a crash in that window re-bets on restart. Two-instance race is
   theoretical (systemd singleton). Fix: durable local intent written
   before submission + startup reconciliation of intents vs positions.
5. **Price protection fail-open — PARTIAL.** Verified: live-ask fetch
   failure skips the drift/ROI gates, BUT the order still carries a
   price bound derived from decision price (capped at low-ROI threshold),
   and FOK dollar `amount` bounds loss at the stake ($8). The truly
   unpriced order needs fetch-failure AND an old client without the
   `price` field (TypeError fallback). "Unbounded orders" is overstated;
   fail-closed on missing ask + pinning the client version is still
   correct.
6. **Unknown-state orders — PARTIAL.** The bot already fails safe against
   re-betting (treats unknown as placed, records `fillUnknown` pick);
   what's missing is automatic reconciliation via the exchange API, and
   population separation in summaries. Generic failures downgrade to
   paper and skip pick creation (verified) — "failed orders graded like
   real bets" applies to unknown-fill rows, not error rows.
7. **No portfolio risk engine — CONFIRMED-KNOWN gap.** True: no daily
   loss cap, exposure cap, drawdown stop, or kill switch. Blast radius
   today is fixed $8 stakes; the pre-registered ladder governs raises,
   so a persisted daily-cap + kill-switch is the missing piece, not
   sizing logic.
8. **Kelly critiques — MOOT TODAY.** FIXED_STAKE=8 governs; Kelly path
   dormant. Valid preconditions for any future re-enable (calibrated
   probabilities first) — consistent with our own era-v9 finding that
   fairPrice is a ratio, not a probability.

## Model / data validity

9. **pin anchor timing — CONFIRMED-NEW and important.** Verified in
   `pinnacle-odds.ts`: the anchor sweep can fetch (or use) a feed at
   sweep time and stamp `pin_feed_at > created_at` — the charter's
   "not possible by construction" claim (v1.1) conflated "feed ≤ sweep"
   with "feed ≤ decision". Mitigations: NO pin_edge read has been taken
   yet, so nothing is invalidated; both timestamps are stored per row,
   so the repair is a read-time population filter
   (`pin_feed_at ≤ created_at`) + charter amendment v1.4, salvaging the
   compliant subset. `pin_clv`/`pin_move` are evaluation metrics
   (post-T by definition), unaffected as criteria.
10. **Shadow evaluation grain — CONFIRMED-NEW refinement.** True that
    rows are unique on (condition_id, reject_reason), promotion cuts
    aggregate rows, and z assumes independence. The sole-blocker cut
    reduces but does not eliminate multi-row-per-market-side; same-game
    O/U + ML pairs are correlated. Repair (dedup to market-side grain +
    clustered/block uncertainty) belongs in the checkpoint machinery
    BEFORE the next promotion read. The live book is less exposed
    (one-pick-per-market-group already enforces one row per group).
11. **Canonical features lookahead — CONFIRMED-KNOWN.** This is the
    deferred "closing-line-as-pick-line" item from the 2026-07-20
    hardening sweep. Codex's independent confirmation raises its
    priority; the decision_*/close_*/result_* split is the right shape.
12. **Realized P&L from decision price — CONFIRMED-NEW (accounting).**
    True: settlement ROI uses pick.price; the dollar panel multiplies
    notional × that ROI. `fill_price`/`fill_slippage_bps` exist since
    8/5, so realized-vs-decision P&L is computable and should be
    reported side by side. FOK price bounds keep the gap small; measure
    rather than assume.
13. **Descriptive-not-proven profitability — AGREED, already our
    stance.** The ladder pre-registration, shrinkage language, and
    "MLB record does not transfer" are on record; no scaling before
    thresholds. No change needed beyond items 10/12.
14. **New sports inherit gates — PARTIAL, policy question.** Tennis,
    NHL, and the extra soccer leagues ARE probation/shadow-only.
    NCAAF/NFL/NBA default live-eligible under MLB-derived gates; our
    own inversion findings (tennis, WTA, NBA favorites) argue for
    shadow-first per sport. Era-gated decision for the user at season
    starts — not a code bug.
15. **Calibration "invalid-eval" — CONFIRMED-KNOWN** (era-v9 ratio
    finding). Matters only when a probability consumer (Kelly) returns.

## Ops / misc

16. Queue success:false acked — check intent: the 7/20 hardening added
    deliberate ack+cooldown semantics and 8/24 added a DLQ; verify the
    cited path routes through them before "fixing".
17. Games table unique-constraint — CONFIRMED-KNOWN (848-dup incident;
    app-level defense today).
18. Provider identity per anchor — PARTIAL: chartered as a date-boundary
    slice (v1.2); a per-row provider column is the durable version.
19. tsc errors — pre-existing createServerFn typing noise (95 with and
    without recent changes); enforcement + cleanup worthwhile, not a
    regression.
20. Systemd unit / file-mode hygiene — accept; verify on VPS.

## Remediation order (adjusted)

1. Server-side auth middleware on all mutating server fns + token on
   `/_pipeline/trigger` (infra, no era bump) — the single highest-value
   fix in the report.
2. Bot: durable pre-submit intent + startup reconciliation; fail-closed
   price protection; pinned client version.
3. Charter amendment v1.4 + `pin_feed_at ≤ created_at` read filter
   (before any pin_edge read).
4. Shadow promotion grain dedup + clustered z (before next checkpoint
   read).
5. Realized P&L column beside decision-price ROI; population split
   (matched / unknown / paper) in every summary.
6. Daily loss cap + kill switch in the bot; fail-closed auth branches;
   games unique constraint; sport-probation default (era discussion).
