# Charter — NCAAB wallet backtest on the 2025-26 season (`ncaab_wallet_backtest`)

Written 2026-10-30 before any NCAAB wallet result was computed (the tape
was still downloading). Owner the same day: "Do it". Rule is code:
`research/sharp/ncaab_wallets.py`, run on the desktop against
`~/Documents/Projects/polywhaler-data/ncaab/ncaab_2025.db` (`fills_all`,
full maker + taker tape, fills ≥ $50, fetched by `fast_tape.py`; markets
discovered by `backfill.py` with `SPORTS=cbb MIN_VOL=5000`,
2025-11-01 … 2026-04-10).

Design = the NBA wallet backtest (`nba-wallet-backtest.md`) verbatim except
the three changes below, each taken from what the NBA/Dota pilots taught us
BEFORE this data was seen:
1. **Entry is the bot window** (primary): first fill of the signal token by
   another wallet in [max(trigger + 60 s, start − 180 min), start − 60 min);
   the signal must fire before start − 60 min. Immediate entry (trigger +
   60 s) is reported as information. (Dota: immediate +16.8 % vs bot window
   +10.7 %; the bot can only bet in its window.)
2. **December onward is scored.** November games build records but are not
   in discovery or holdout (NBA fade: Oct–Nov lost in both seasons; records
   are stale early). November is reported as information.
3. **Split**: DISCOVERY 2025-12-01 ≤ start < 2026-02-01, HOLDOUT ≥ 2026-02-01
   (includes conference tournaments and March Madness).

## population
College basketball (`cbb-` slugs, Polymarket series 10470) moneyline, total
and spread markets with volume ≥ $5k, resolved 0/1. Games keyed by start
(10-min bucket) × the two team names parsed from "A vs. B" titles; spreads
("Spread: A (−x)") joined to the game naming A within 3 h, else dropped.

## wallet records, signals, grain — identical to NBA
Positions = pregame fills; stake ≥ $50; a position counts once start + 4 h
has passed. Signals on a wallet's first pregame BUY ≥ $100, 0–24 h out:
`S0_any`; `S1_sharp` ≥ 30 settled NCAAB positions at ROI ≥ +10 %; `S2_hot`
last 12 ≥ 9 wins; `S3_team_specialist` ≥ 10 positions involving one of the
game's teams at ROI ≥ +15 %; `S4_type_specialist` ≥ 20 positions of this
market type at ROI ≥ +10 %; `S5_consensus` 2nd S1 wallet on a side, none
opposite. One row per (signal, market, side); both sides → dropped; entry
price 0.05–0.95. ROI = win / entry − 1; z clustered by game.

## cells and acceptance
6 signals × {all, moneyline, total, spread} = 24 cells. CANDIDATE =
discovery n ≥ 50, |z| ≥ 2 AND holdout same sign, |z| ≥ 1, n ≥ 30 (negative
→ FADE candidate). ~1.1 chance passes expected. A candidate is then read
ONE BET PER GAME (earliest trigger; alt lines averaged) before any lane is
proposed. Nothing passing → recorded as no edge; then the owner's standing
rule applies: a constructive combo pass (unions, stacks), labelled post-hoc.

Candidate → $4 pilot proposal starting 2026-12-01 at the earliest, records
rebuilt daily on the desktop (`wallet-daily.sh`), owner's go required.

## known_leakage_risks
- Records only from positions settled before the trigger.
- MIN_VOL $5k drops small markets from records (low-major totals/spreads);
  the bot also only sees ≥ $10k markets via the app cache.
- `fills_all` $50 floor; the bot buys $4–6 at the ask, slippage not modelled.
- Team-name parsing errors drop rows (not mislabel them): spreads that
  match zero or two games are excluded.
