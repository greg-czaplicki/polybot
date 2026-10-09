# Charter — CS2 wallet backtest (`cs2_wallet_backtest`)

Written 2026-10-09 before any wallet-level CS2 result was computed (the
backfill was still discovering markets). Rule is code:
`research/sharp/cs2_wallets.py`, run on the VPS against
`/root/polysharp/data/cs2/cs2_2025.db` table `fills_all` (full maker + taker
tape, fills ≥ $50, fetched by `research/sharp/nba_full_tape.py` pointed at
that DB).

Why this exists: owner, 2026-10-09: find a small edge that limits the
CS2 pickem-dog lane's bets so its record improves. Price / format / tier /
stage sub-slices were already tested and failed
(`docs/audits/2026-10-02-cs2-deep-dive.md`, 152 cells) — they are NOT
re-tested here. The untested axis is WHO is on each side, the method that
produced the NBA fade (`nba-wallet-backtest.md`). Methods, thresholds and
the acceptance rule are copied from the NBA charter; only the population,
split and the lane-filter cells are new.

## population
CS2 match-winner markets (`markets.market_type = 'moneyline'`, question
`Counter-Strike: A vs B (BOn) - …`), resolved 0/1, discovered by
`backfill.py` with `SPORTS=cs2 MIN_VOL=5000` over 2025-10-01 … 2026-10-07.
Map winners, map handicaps and games totals are NOT bet cells, but every
CS2 market in the DB contributes positions to wallet records.

## wallet records (point-in-time) — identical to NBA
Position in a market = pregame fills (ts < start): per token net shares and
net cash; PnL = Σ net_shares × won − net cash; stake = pregame BUY cash;
stake < $50 ignored. A position enters a record only once settled:
start + 4 h < the moment the record is consulted.

Qualifiers at time t:
- `S1_sharp` — ≥ 30 settled CS2 positions, record ROI ≥ +10%.
- `S2_hot` — last 12 settled CS2 positions ≥ 9 winners.
- `S3_team_specialist` — ≥ 10 settled positions in matches involving one of
  this match's teams, ROI ≥ +15% on them.
- `S5_consensus` — ≥ 2 distinct S1 wallets on a side, none on the other.

## A. lane-filter cells (the owner's question)
Lane row = the backtest analogue of `cs2_pickem_dog`: walk the market's
fills in [start − 180 min, start − 60 min) in time order; the first fill
priced in [0.40, 0.50) defines T, the dog token and the entry price (one row
per market). Wallet state at T uses only fills with ts < T: a wallet is
*on* a token if its pregame BUY cash on that token is ≥ $100 and exceeds its
BUY cash on the other token. ROI = won / entry − 1.

Cells (10): `L0_lane` (all rows); for Q ∈ {S1, S2, S3}: `Q_on_dog` (≥ 1 Q
wallet on the dog, none on the favourite) and `Q_on_fav` (≥ 1 on the
favourite, none on the dog); `S5_on_dog`, `S5_on_fav`; `L_skip_S1_fav`
(lane rows minus those with any S1 wallet on the favourite).
A positive `*_on_dog` → "only bet / bet bigger when sharps agree"; a
negative `*_on_fav` → "skip when sharps are on the favourite".

## B. follow cells (context, NBA method)
Trigger = a wallet's first pregame BUY fill ≥ $100 on a token 0–24 h
before start; qualifies if the wallet meets S0 (none) / S1 / S2 / S3 at the
trigger, S5 = second S1 wallet on the side with none opposite. Entry = first
fill of that token by another wallet ≥ trigger + 60 s, before start, price
0.05–0.95. One row per (signal, market, side); both sides triggered → no
row. Cells (5): S0, S1, S2, S3, S5 on CS2 match winners.

## split and acceptance — identical to NBA
z clustered by match. DISCOVERY start < 2026-06-01, HOLDOUT ≥ 2026-06-01
(CS2 markets begin ~Nov 2025; the early months are record warm-up).
CANDIDATE = discovery n ≥ 50 and |z| ≥ 2 AND holdout same sign, |z| ≥ 1,
n ≥ 30. 15 cells → ~0.7 chance discovery hits expected.

Candidate → a paper filter on the live lane (lane keeps betting $4
unfiltered; filtered sub-record reported beside it) from the day the live
wallet records exist; changing the live lane's bets needs the owner's go
and an era bump. Nothing passing → recorded as no edge; not re-cut, no new
thresholds.

## known_leakage_risks
- Records use only positions settled before T / trigger (start + 4 h).
- Lane T and wallet state use fills strictly before T; entry is the fill at T
  itself (an executable trade at that moment).
- `fills_all` floors fills at $50 (API offset cap), so lane entries are
  ≥ $50 fills — the bot buys $4–8 at the ask; slippage is not modelled
  (live pilot: −69 bps).
- The live lane also requires the market in the app's sharp-money cache;
  the backtest lane is every market with an in-band fill, so its baseline
  can differ from the live lane's record.
