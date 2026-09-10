# Football plan (NFL + NCAAF) — 2026-09-10

## Where we start
- Both sports are shadow-only (probation eras v10–v12). Rows accrue on every
  game the holder signal fires on: NCAAF ≈ 115 rows/week over ≈ 60 games,
  NFL ≈ 30 rows per game (main lines + alternates) over 16 games/week.
- Rows inside one game are correlated (Patriots–Seahawks: Under 7-0, Over
  0-10). Every read is ONE ROW PER GAME (`research/sharp/sport_edge.py`).
- Pinnacle coverage is 2 fetches/day: the old promotion rule's Pinnacle-CLV
  criterion is unreachable. Reads use ROI + Polymarket-close CLV, both.
- Tape: every football market is crawled after settlement; the book
  recorder captures pregame books; polysharp scores sharp-wallet signals per
  event. Past-profit "sharps" were an anti-signal in MLB; football is a
  fresh read.
- NCAAF after 2 weeks (80 games): ALL +12% test / CLV +0.1c, n far too small.
  Our signal on away dogs −80% (11 games) and big dogs −51%: the same
  "public dog" inversion seen in NBA; a candidate fade, not a bet.

## Pre-registered cells (both readouts, one row per game, train/test by week)
1. ML home dog · 2. Total Under · 3. Under at high line (top third of the
season's totals) · 4. All-five-gates cohort · 5. Fade our signal on away dogs
(NCAAF) · 6. Spread on key numbers (3/7) · 7. polysharp event signal per sport.
Negative controls: Total Over, away favorite, big dogs.

## Reads and decision points
- Weekly, Monday: `sport_edge.py nfl` and `ncaaf` with split = midpoint of
  the season so far; polysharp daily report per sport. Record in this file.
- **NCAAF read 1: Oct 5** (≈ 300 games). **NFL read 1: Oct 12** (week 5,
  ≈ 80 games; cells will still be thin). **NFL read 2: Nov 9** (week 9,
  ≈ 150 games) — the first NFL read that can decide a cell.
- A cell HOLDS when ROI > 0 and CLV > 0 in both halves with ≥ 40 games per
  half (NFL cells will reach this only by read 2). ≈ 1 in 16 cuts holds by
  chance; with 7 registered cells, one accidental hold is expected — a cell
  is acted on only if it also has a mechanism (home dog, Under at high
  totals) or repeats the MLB finding.
- If a cell holds at a read: propose a probation tier for that cell only
  (small fixed stake, cap per day, era bump + charter). The user decides at
  that point; nothing goes live automatically.
- If nothing holds by Nov 9: football stays shadow-only for the season; the
  data keeps accruing for 2027 at zero cost.

## What is deliberately not in the plan
No new gates or scoring changes before a read. No Pinnacle purchase. No
taker-side sharp following (tape says −19% NFL preseason, −18% NCAAF).
