# Season transition plan — MLB wind-down → football / basketball / hockey (2026-08-27)

Written with ~4.5 weeks of MLB regular season left (ends Sun 2026-09-27;
postseason 09-29 → ~10-31). Purpose: (1) get whatever the MLB edge is worth
without over-betting it; (2) make sure each incoming sport starts on its own
evidence instead of inheriting MLB's. Verification checkpoints are dated so
they can be ticked off in the morning check.

## Principle: the MLB record does not transfer

The live record (90d +20%, out-of-sample +31%, z≈3) is MLB. The same holder
signal is **inverted** in NBA (favorites >90 min), in WTA, and probably ATP;
EPL/MLS have 2 live picks between them. Every sport enters at the base stake
and earns its own ladder (docs/STRATEGY.md, "Live-book stake ladder"). No
sport is scaled on another sport's record.

## Capitalising on MLB (now → 09-27, postseason after)

- Stake stays at the $8 base (≈6.8% of bankroll ≈ 2× Kelly on the shrunk
  +2–4% edge). "Capitalising" = adding bankroll at ≤5%/bet, not raising the
  fraction. Rough expectation for the remaining ~60 totals + ~30 ML live
  bets at a true +3%: ≈ +$20–30 on $8 stakes with a ±$75 one-sigma band —
  the season's remaining value is evidence, not income.
- Totals lean-in trigger (n ≥ 100 OOS totals, z ≥ 2.5, pin_move ≥ 0 on
  n ≥ 30) lands around season end; if it fires, apply it to postseason
  totals only if postseason rows are stamped separately (see below).
- **Postseason is a different regime** (fewer games, sharper markets, deeper
  PM liquidity, every game high-leverage). Read it as its own cohort:
  `games.season_type` = 3 from ESPN; tag postseason picks in any read and do
  not pool them into regular-season reads. VERIFY 09-29: first postseason
  game links (season_type 3), pin capture works (pinnapi MLB label
  unchanged), bot still finds candidates (PM lists postseason under the
  same MLB series 3).

## Sport-by-sport readiness

| sport | first date | policy today | history | verify | ready-when |
|---|---|---|---|---|---|
| **NCAAF** | Sat 08-29 (week 1; week 0 was 08-22) | LIVE (default policy, MLB-calibrated gates, 148-team FBS seeding) | **none** — zero shadows ever, zero picks; week 0 produced nothing (PM listed few/no week-0 games or none cleared volume) | **08-29 evening:** ncaaf shadows/candidates exist; series resolves to 10210 (`cfb-2025` is still the live series — no `cfb-2026` slug, same as EPL); ESPN links + team seeding on real games; pinnapi `NCAA` label captures anchors/closes; `season`/`week` stamped | n ≥ 50 live picks or shadows with pin_move → first read (~mid-Oct). Until then base stake only. Watch: PM CFB volume is thin outside top-25 games. |
| **NFL** | Thu 09-10 (week 1) | LIVE; preseason hard-rejected by date (`isNflPreseasonTime`, lifts Labor Day + 3) | **none** in `manual_picks` (table starts 04-13); preseason shadows only | **09-10/09-13:** `nfl-2026` series 12185 discovered (it is); `nfl_preseason_excluded` stops firing; week-1 candidates graded; pinnapi `NFL` label (verified 08-26) captures; ESPN linkage + week stamping; bot places at base stake | n ≥ 50 (≈ week 4–5, early Oct) → first per-sport read; totals vs ML split from day one. |
| **NBA** | ~10-20 | LIVE ≤ 90 min only (`nba_timing_excluded` above 90); May forensic: signal inverts on favorites >90m | 33 old picks pre-calibration; fade charter registered | **opening week:** series `nba-2026` (10345) still resolves (no `nba-2027` slug yet — registry probes the year window); pinnapi label `NBA` **unverified** (assumed; wrong label = silent 0% coverage); >90m shadow cohort accrues two-way rows for the fade test | fade read at n ≥ 100 conditioned rows (~mid-Nov); ≤90m live cohort gets its own ladder. |
| **NHL** | 10-07 | probation (shadow only) since 08-25 | none recorded | **opening night:** series `nhl-2026` (10346) resolves; `nhl_league_probation` rows appear with gates_json + pin rows; pinnapi label `NHL` unverified | sole-blocker checkpoint (n ≥ 50, z ≥ 2, CLV > 0) → per-sport forensic ~late Nov. |
| **EPL / MLS** | ongoing | LIVE | EPL 0 live picks since restart (era v9 floor), MLS a handful | weekly: EPL candidates clearing the floor; corners/bookings never graded as totals (v8) | ladder per sport; nothing to scale. |
| **La Liga / Bundesliga / Serie A / Ligue 1 / UCL / Championship** | ongoing; UCL league phase mid-Sept | probation | La Liga totals 11-5 +37% (n=16, noise) | monthly via /shadow verdicts | checkpoint rule. |
| **ATP / WTA** | US Open now → indoor season | probation; signal inverted | ATP 83 settled −9%, WTA 41 settled −5% (price ≥ .25) | US Open main draw: pinnapi covers all tournaments (ATP finally has CLV) | WTA fade read n ≥ 100 (~mid-Oct); tennis verdict n ≈ 200 (~mid-Sept). |

## Shared infrastructure checkpoints

- **pinnapi**: labels verified for MLB, soccer (8 leagues), ATP/WTA, NFL,
  NCAA football. **NBA/NHL/NCAAB labels assumed** — verify on the first
  sweep of each opening night (`pinnacle_fetch_log` shows `pinnapi:3` /
  `pinnapi:4` and priced anchors). Budget: football adds one sport-level
  fetch per sweep-window; caps (80/day, 40/sport) leave room.
- **Series registry**: seasonal slugs are probed per year; `cfb-2026`,
  `nba-2027`, `nhl-2027` do not exist yet — the year-window probe falls
  back to the -2025/-2026 series that PM keeps using. Discovery failures
  surface in `discoveryFailures`; check when a sport shows zero markets.
- **ESPN**: NFL/CFB scoreboards need the `week`/`groups` params already
  wired (CFB groups fix 08-05); finals → facts → trends for football have
  never run on real regular-season data — VERIFY first Sunday night that
  NFL finals ingest and `team_game_facts` rows appear.
- **Bot**: no per-sport filter; it trades whatever the server policy
  returns. Stake changes = `FIXED_STAKE` in the systemd unit; Kelly mode
  (`FIXED_STAKE=0`) stays off until a ladder trigger fires.

## What "ready" means on 09-10

NFL week 1 goes live at the $8 base under the existing gates with pin
capture on and a clean out-of-sample cohort from bet one. The first NFL
read is at n ≥ 50 (totals vs ML, pin_move, ladder) — early October — and
nothing about NFL stakes changes before it.
