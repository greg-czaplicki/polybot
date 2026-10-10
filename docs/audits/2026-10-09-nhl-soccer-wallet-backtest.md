# NHL + soccer wallet backtests — 2026-10-09

Charter: docs/charters/nhl-soccer-wallet-backtest.md (pre-registered before data).
Desktop data via fast_tape.py: NHL 3,871 markets (244 s), soccer 11,589 markets over 9 leagues
(645 s), 0 failed. Raw: ~/Documents/Projects/polywhaler-data/{nhl,soccer}/reports/.

## NHL (split 2026-02-01; 1,101 games with totals, 899 with an in-window main line)
PRIMARY replications FAIL (HT FOLLOW −14.3 %, S3SQ −4.0 %). Pre-registered CANDIDATE:
`A HT FOLLOW` negative — discovery −16.0 % z −2.1 (n 163), holdout −12.0 % z −1.4 (n 125).
**Fade** (bet against hot / team-specialist wallets), one bet per game: 164-124, +12.6 %, z 2.2,
$4 → +$146; 7/10 months positive. GOOD FADE +9.8 % (z 1.5). Baseline Over +5 %.
→ era v23 lane `nhl_hot_fade` (charter nhl-hot-fade-pilot.md).

## Soccer (split 2026-07-01; 2,569 games with totals, 2,014 in-window)
PRIMARY replications FAIL (HT FOLLOW −7.1 %, S3SQ −5.4 %). Pre-registered candidates:
`B S0 FADE` (+42 %) — ARTIFACT: tail lines (O/U 0.5/4.5…) priced near 0/1, fade entry 1 − p
ignores the spread (same class as the 2026-08-23 EPL tail-line phantom edges); disregarded.
`B S0/S4 FOLLOW` negative (−6.5 % / −6.7 %, trigger entries) — noted, not laned.
A cells (in-window main line, no tail artifact): S2 hot FADE +7.7 % z 1.7 / +20.5 % z 2.6, pooled
+10.8 % z 2.7 (n 679); **HT FADE** (= the NHL rule) +6.1 % / +17.6 %, pooled 323-282 +8.7 % z 2.1,
$4 → +$211 (n 607). Out-of-sport replication of the NHL pre-registered pass → era v23 lane
`soccer_hot_fade` (charter soccer-hot-fade-pilot.md), exploratory.

## Cross-sport picture (A HT FOLLOW, one bet per game)
CFB +19 % (follow) · NFL +16 % (n 59, holdout n 7) · NBA +4 % · NHL −14 % · soccer −7 %.
Hot/specialist wallets carry signal in high-scoring US football totals and anti-signal in the
low-scoring sports (NHL, soccer), where streaks are mostly variance.
