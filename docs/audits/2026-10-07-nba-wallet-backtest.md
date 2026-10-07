# NBA wallet backtest, 2025-26 season — 2026-10-07

Charter: `docs/charters/nba-wallet-backtest.md` (a2e7b37, before any result).
Script `research/sharp/nba_wallets.py`; output
`research/sharp/reads/2026-10-07-nba_wallets.txt`. Diagnostics (after the
read, not re-cuts): `nba_s5_diag.py`, `nba_s5_pergame.py`.

Data: full maker+taker tape, fills ≥ $50, 7,148 markets, 5.45M fills (15
largest markets hit the API's 11k-row cap), 847k wallet-market positions,
105k wallets with records.

## Verdict: 1 candidate of 24 — FADE `S5_consensus / total`
When ≥ 2 wallets with an NBA record of ≥ 30 settled positions at ≥ +10% ROI
buy the same side of a game total (and no such wallet is on the other side),
that side loses.

| cut | follow ROI (charter cell) | FADE at executable price, one bet per game |
|---|---|---|
| discovery (< 2/1) | −10.9% z −2.1 n 459 | 181-145, +11.6% z 2.1 |
| holdout (≥ 2/1) | −13.2% z −2.4 n 445 | 151-133, +7.7% z 1.3 |
| full season | | 332-278, +9.8% z 2.4, $4/game +$239 |
| holdout, entry +10 min | −14.3% z −2.6 | +10.6% z 1.7 |

- Fade entries are at ~0.50 (99% between 0.40 and 0.60): no tail-price
  artifact. Months positive 7 of 9 (Nov −8.5%, May playoffs −20.9%).
- Median trigger 5.5 h before tip-off: plenty of time for the bot.
- Charter rows count alt lines separately (904 rows / 613 games). The money
  figures above are one bet per game (earliest trigger, tied lines averaged).
- Over/Under split is unstable across halves (post-hoc, not used).

## Everything else: no edge
- NBA "sharps" (S1) followed alone: −3.9% / −4.1%. Hot streaks (S2):
  −2.8% / −5.3%. Their records do not carry forward: an NBA record of
  30+ positions at +10% is mostly luck.
- Team specialists (S3) +6.3% z 1.6 / +0.8%; type specialists (S4) +7.7%
  z 2.1 / +2.2% z 0.6 (holdout fails). Neither passes.
- The `S0_any` baseline is empty by construction (random $100 buyers are on
  both sides of nearly every market, so the both-sides rule drops it), and
  moneyline rows are thin for the same reason. Charter design flaw, recorded;
  not changed after the fact.

## Consistency with the live book
This is the same shape as the 2026-05-11 forensic: in NBA, a crowd of
high-PnL wallets on one side is public money, and the holder signal inverts.
Here it shows up independently on last season's full tape.

## Next (per charter)
Forward paper lane from opening night 2026-10-20 needs live NBA wallet
records: polysharp crawl with takerOnly=false for NBA, records seeded from
the 2025-26 tape. Real money only on the user's go.
