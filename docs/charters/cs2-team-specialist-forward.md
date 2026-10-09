# Charter — CS2 team-specialist skip, forward paper test (`cs2_team_specialist_forward`)

Written 2026-10-09 ~18:30Z, before any forward row exists (forward window
starts 2026-10-10T00:00Z). Rule is code: `research/sharp/cs2_forward.py`
(lane rows + wallet records copied verbatim from `cs2_wallets.py`), run daily
by `cs2-daily.timer` on the VPS after `cs2-daily.sh` refreshes
`/root/polysharp/data/cs2/cs2_2025.db` (settled CS2 markets + full tapes).

## origin (exploratory — why this is a hypothesis)
The pre-registered wallet backtest (`cs2-wallet-backtest.md`, audit
`docs/audits/2026-10-09-cs2-wallet-backtest.md`) passed 0/15 cells. Looking
afterwards at months (owner asked "what if our strategy switched after
May?"), cell `S3_on_fav` — a team specialist (≥ 10 settled positions in
matches involving one of the two teams, ROI ≥ +15% on them) on the
favourite, none on the lane's underdog — was negative every month Jul–Oct
(−21% n20, −17% n35, −28% n43, −22% n6). Found by looking at those months,
so they cannot confirm it. Only forward rows count.

## hypothesis
On CS2 pickem-dog lane rows, rows where a team specialist is on the
favourite (and none on the dog) lose money. If true, the lane should skip
them.

## population and rule (frozen, identical to the backtest)
Lane row: CS2 match winner (`(BOn)` in question), start ≥ 2026-10-10T00:00Z;
walk fills in [start − 180 min, start − 60 min); the first fill priced in
[0.40, 0.50) gives T, the dog token and the entry price. Wallet "on" a token
= pregame BUY cash on it before T ≥ $100 and above its BUY cash on the other
token. Records: pregame positions in every settled CS2 market, stake ≥ $50,
counted once start + 4 h < T. ROI = won / entry − 1. z clustered by match.

## primary metric and decision
`S3_on_fav` forward ROI. READ once n ≥ 100 (expected ~late December at
~40/month). PASS = ROI < 0 and clustered z ≤ −2 → propose to the owner a
skip filter on the live lane (era bump, owner's go). Otherwise FAIL,
recorded, not re-cut, no new thresholds. The daily report shows n before
the read; nothing is decided before n ≥ 100.

Context lines (no decision): lane baseline `L0_lane`, `lane minus S3_on_fav`
(the filtered lane, in dollars at $4), `S3_on_dog`, `S1_on_fav`.

## known_leakage_risks
- Same as the backtest: state uses fills < T, records settled before T.
- Rows are computed after settlement from the trade tape, which is
  immutable; a match appears once crawled (≥ start + settle lag), never
  before, so no row is chosen by its outcome.
- Backtest-universe rows, not the live lane's own bets (the live lane also
  needs the app's sharp-money cache and caps open bets).
