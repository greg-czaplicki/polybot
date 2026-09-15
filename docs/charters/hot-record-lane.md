# Charter — Hot-record wallets lane (`hot_record`)

Written 2026-09-15 under the `sports-modeling-doctrine` schema, BEFORE any
forward data exists. The rule is code (`research/sharp/hot_record.py`,
mirrored at `/root/polysharp/hot_record.py` on the VPS); the start date and
every constant are frozen in that file. Changing the window, the hot
threshold, the side rule, the trigger time, the entry definition or the
metric after 2026-09-16 means a NEW charter version; the prior result is
then labelled exploratory.

## question
Owner's hypothesis (2026-09-15): on a given night, on a given market, the
side held by wallets that are currently hot in that sport — "10-2 in their
last 12" — wins more than its price implies. Hot is a per-event, per-day
property (tonight's hot wallets need not be hot tomorrow) and a RECORD, not
a PnL sign. This is deliberately different from the app's live signal, whose
momentum weight is the sign of Polymarket's rolling day/week PnL across
every market a wallet trades, and from polysharp's "follow the sharps"
(lifetime PnL rank, which loses in every major sport).

## sport_and_competition
Every sport label in the polysharp crawl, each read ON ITS OWN. A pooled
all-sports line is printed for information and is never a decision input.

## population_and_exclusions
Markets in the polysharp crawl (`markets.status = 'done'`, `winner0 ∈
{0,1}`, both tokens known) with `start ≥ 2026-09-16T00:00Z`. Wallet
positions come from `polysharp.load_fills` (pregame fills, ts < start − 15
min, side price 0.05–0.95) collapsed to ONE net position per wallet per
market (usd-weighted; a wallet that flipped sides is judged on its net).
Markets with no qualifying entry fill are dropped, not imputed. The record
is computed only from markets in the crawl universe — a wallet's bets
outside it are invisible, and the record is "in our universe" by definition.

## grain_and_natural_key
One row = one market (the signal side only). z clustered by `event_key`.

## analysis_type
Predictive, prospective. No causal claim about who the wallets are.

## decision_time_and_horizon
T = start − 60 min.
- **Record at T**: a wallet's last 12 settled positions in the SAME sport
  whose `start + SETTLE_LAG (6 h) ≤ T` — settled before T, point-in-time.
  Needs ≥ 8 such positions, else the wallet is not scoreable.
- **Hot, variant `record` (primary, the owner's rule)**: wins ≥ ⌈0.75 ×
  window⌉ (9 of 12 when the window is full).
- **Hot, variant `units` (secondary, price-aware)**: ROI sum over the
  window > 0. Pre-registered beside the primary because a 9-3 record on
  80-cent favourites is not the same evidence as 9-3 on coin flips.
- **Side at T**: net pregame position of every wallet with fills before T.
  The lane fires on the side with ≥ 3 hot wallets AND hot USD ≥ 2× the
  other side's hot USD. Both sides qualifying is impossible under 2×.
- **Entry**: the first taker-BUY fill of that side's token in [T, start]
  with $5 ≤ notional ≤ $100 — an executable price, identical to the
  cell-lanes definition. Horizon = settlement, ROI = win / entry − 1.
Legal at T: every record input settled ≥ 6 h before T, every position fill
before T. The entry fill is after T and is the price, not a feature.

## baselines
- Zero: ROI = 0 (the side is priced).
- The in-sample reference (markets starting before 2026-09-16), printed
  beside the forward numbers. It is a backtest of an unfitted rule, useful
  for sign and volume only; it is NOT the test, because the constants were
  chosen with the tape in view.

## primary_metric_and_others
Primary: mean ROI per row, event-clustered z, per sport, variant `record`.
Secondary: wins/n, rows per week, variant `units`, hot-wallet counts and
USD on each side (stored on every row for later re-cuts, never for the
decision). No CLV term (owner decision 2026-09-15; the close is not a
decision input on this exchange).

## validation_and_acceptance
- Per sport, variant `record`: read at n ≥ 100 rows. Pass = ROI > 0 and
  clustered z ≥ 2. Pass → a record-only shadow lane in the app (same rule,
  live tape) for one more n ≥ 100 before any live proposal. Fail → drop.
- Variant `units` passing while `record` fails is recorded as "hot is
  price-aware, not a record" and becomes its own charter; it does not
  rescue the primary.
- n ≥ 100 with ROI ≤ 0 → recorded as "cannot make money", dropped; no
  re-cut of the same rows with other constants.
- Every read is quoted from the polysharp daily report section
  `HOT-RECORD LANE`, never from an ad-hoc cut.

## data_requirements
Polysharp daily crawl (`polysharp-daily.timer`, 11:45Z). The lane is a
pure function of the crawl — no recorder, no table — so it can be recomputed
from scratch at any time and cannot drift from its own history.

## known_leakage_risks
- Settlement proxy is `start + 6 h`. A game that resolved later than that
  would put an unsettled result into a record; the proxy is conservative in
  the other direction (a game settled 5 h after start is not yet counted).
- `start` is the scheduled start (see cell-lanes charter); tennis session
  times are the weak point.
- The crawl backfills pregame tapes after settlement, so the same fills
  feed both the record and the position. That is fine for point-in-time
  as long as the ts filters above hold; it is a leak only if `trades.ts`
  were wrong, which the crawl takes verbatim from the data API.
- Multiple testing: two variants × ~15 sports. The n ≥ 100 and z ≥ 2 bar
  per sport is the control; one sport passing at z 2.0 among fifteen is
  expected by chance about once, which is why a pass buys a second n ≥ 100
  in the app, not a live lane.
