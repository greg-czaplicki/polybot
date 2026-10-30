# NCAAB wallet backtest — 0/24 (2026-10-30)

Charter `docs/charters/ncaab-wallet-backtest.md` (committed before the run).
Script `research/sharp/ncaab_wallets.py`; data desktop
`polywhaler-data/ncaab/ncaab_2025.db` (7,326 markets ≥ $5k, 4,157 games,
774k fills ≥ $50 — about 1/7 of the NBA tape; volume is mostly moneylines,
totals/spreads rarely reach $5k). Full output
`polywhaler-data/ncaab/ncaab_wallets_2026-10-30.txt`.

## pre-registered result
0 of 24 cells pass (≈ 1.1 expected by chance). Only discovery hit:
`S3_team_specialist / all` −16.8 % z −2.4, holdout flips to +7.0 % — fails.
Following any $100+ buyer (S0) ≈ +1–2 %, i.e. NCAAB prices are about fair
to wallet identity at the bot's entry window.

## constructive pass (POST-HOC, owner's standing rule)
- By month, sharp / hot / team-specialist follows swing sign month to month
  (S1 bot window: Dec +18 %, Jan −10 %, Feb +8 %, Mar −6 %) — no stable
  season-phase effect.
- Sharp ∪ team-specialist follow, one bet per game, bot window: Dec–Jan
  240-181 −5.1 % z −1.1; Feb+ 328-249 +6.6 % z +1.3; immediate entry Feb+
  +2.2 %. Nothing a lane should be built on.
- No consistent fade cell either (S5 spread / S4 total negatives are small
  and unreplicated).

## decision
No NCAAB lane. The app keeps recording NCAAB shadows (sport probation).
Optional cheap re-check: fetch the 2026-27 tape in early March and score
the one post-hoc idea (S1 ∪ S3 follow, Feb+, bot window) forward; pass =
ROI > 0 and game-clustered z ≥ 2.
