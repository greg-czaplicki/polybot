# Metric Definitions — Canonical Stats Spec v1

> Source-of-truth for every stat displayed in the polywhaler analytics UI.
> Each metric traces to an explicit formula; no stat may be shown without a definition here.

---

## v1 Sport Scope

v1 covers the sport tags with the highest betting volume on Polymarket:

| Tier | Sport Tag | Label | Rationale |
|------|-----------|-------|-----------|
| 1 | `nfl` | NFL | Highest volume, full spread/total/ML coverage |
| 1 | `nba` | NBA | High volume, daily action |
| 1 | `mlb` | MLB | High volume, deep season |
| 2 | `nhl` | NHL | Moderate volume, puck-line markets |
| 2 | `ncaaf` / `cfb` | College Football | Seasonal, high volume during CFP |
| 2 | `ncaab` | College Basketball | March Madness spike |
| 3 | `ufc` | UFC / MMA | Moneyline-only (no spreads/totals) |
| 3 | `epl` / `soccer` | Soccer | Growing market, 3-way outcomes |

**Sport-specific notes:**
- UFC/MMA: Only SU and streak metrics apply (no spread or total markets).
- Soccer: Draws are a valid outcome; SU treats a draw as a loss for both sides unless the pick was "Draw."
- All other sports: Standard two-outcome resolution for game markets.

---

## Metric Category: Record Metrics

### SU — Straight Up Record

The win/loss/push record for picks resolved on the moneyline (game winner), ignoring any spread or total.

| Field | Formula |
|-------|---------|
| `su_wins` | `COUNT(*) WHERE status = 'win' AND bet_type = 'moneyline'` |
| `su_losses` | `COUNT(*) WHERE status = 'loss' AND bet_type = 'moneyline'` |
| `su_pushes` | `COUNT(*) WHERE status = 'push' AND bet_type = 'moneyline'` |
| `su_total` | `su_wins + su_losses + su_pushes` |
| `su_win_pct` | `su_wins / (su_wins + su_losses)` — pushes excluded from denominator |

- **Bet type filter:** `bet_type = 'moneyline'` (detected via `detectBetType()`).
- **Pending picks** (`status = 'pending'`) are excluded from all record counts.
- A pick on a futures market (`bet_type = 'future'`) is excluded from SU.

### ATS — Against The Spread Record

The win/loss/push record for picks on spread markets, graded against the closing spread.

| Field | Formula |
|-------|---------|
| `ats_wins` | `COUNT(*) WHERE status = 'win' AND bet_type = 'spread'` |
| `ats_losses` | `COUNT(*) WHERE status = 'loss' AND bet_type = 'spread'` |
| `ats_pushes` | `COUNT(*) WHERE status = 'push' AND bet_type = 'spread'` |
| `ats_total` | `ats_wins + ats_losses + ats_pushes` |
| `ats_win_pct` | `ats_wins / (ats_wins + ats_losses)` — pushes excluded |

- **Grading:** A spread pick wins if `(actual_margin - spread_line) > 0` for the picked side.
- On Polymarket, spread markets embed the line in the market title (e.g., "Chiefs -3.5"). The line is extracted at pick time and stored as `spread_line`.
- See `grading-rules.md` for the exact resolution formula.

### OU — Over/Under Record

The win/loss/push record for picks on total (over/under) markets.

| Field | Formula |
|-------|---------|
| `ou_wins` | `COUNT(*) WHERE status = 'win' AND bet_type = 'total'` |
| `ou_losses` | `COUNT(*) WHERE status = 'loss' AND bet_type = 'total'` |
| `ou_pushes` | `COUNT(*) WHERE status = 'push' AND bet_type = 'total'` |
| `ou_total` | `ou_wins + ou_losses + ou_pushes` |
| `ou_win_pct` | `ou_wins / (ou_wins + ou_losses)` — pushes excluded |

- **Grading:** An "Over" pick wins if `actual_total > total_line`; "Under" wins if `actual_total < total_line`. Equal = push.

---

## Metric Category: Split Dimensions

Split dimensions partition records (SU, ATS, OU) by contextual attributes of the game. Every record metric above can be sliced by each split independently.

### Home / Away

| Value | Rule |
|-------|------|
| `home` | The picked team is the designated home team for the event. |
| `away` | The picked team is the designated away (visiting) team. |
| `neutral` | See edge cases — neutral-site games are tagged separately. |

- **Source:** Derived from event metadata. On Polymarket, the market title convention is "Away @ Home" or "Away vs Home" (home listed second). If the event carries explicit home/away tags, those take precedence.
- **Storage:** `venue_role` enum: `home | away | neutral`.

### Favorite / Dog (Underdog)

| Value | Rule |
|-------|------|
| `favorite` | The picked team is favored by the canonical pregame game line. |
| `dog` | The picked team is the underdog by the canonical pregame game line. |
| `pickem` | Both sides within 0.50 +/- 0.02 (48%–52%). See edge cases. |

- **Source:** Derived from canonical game-line data. Use pregame moneyline if available; otherwise use spread sign/magnitude. If neither exists, leave null.
- Polymarket prices can inform execution analysis, but favorite/dog classification is a game-context concept and should not be inferred from pick-specific fair price.
- **Storage:** `fav_dog_role` enum: `favorite | dog | pickem`.

---

## Metric Category: Margin Metrics

### cover_margin — Spread Cover Margin

How much a spread pick covered (or failed to cover) by.

| Field | Formula |
|-------|---------|
| `cover_margin` | `actual_margin - spread_line` (from the picked side's perspective) |

- **Positive** = covered; **negative** = failed to cover; **zero** = push.
- Only applies to `bet_type = 'spread'`.
- Units: points (or goals/runs depending on sport).

### total_margin — Total Margin

How much the actual game total exceeded or fell short of the total line.

| Field | Formula |
|-------|---------|
| `total_margin` | `actual_total - total_line` |

- For "Over" picks, positive = win; for "Under" picks, negative = win.
- Only applies to `bet_type = 'total'`.

### price_edge — Execution Edge At Entry

How much better or worse the pick price was than the model's estimated fair value.

| Field | Formula |
|-------|---------|
| `price_edge` | `fair_price - fill_price` (or `fair_price - price` if unfilled) |

- Positive = bought below fair value.
- This is an execution-quality metric, not a sports ATS metric.
- Units: implied probability price on a 0–1 scale.

---

## Metric Category: Line Metrics

### opening_price

The earliest available market price for the picked side after the market opens.

| Field | Formula |
|-------|---------|
| `opening_price` | First recorded price from `sharp_money_history` for this `condition_id`, taken from the earliest `recorded_at` entry for the picked side. |

- Applies to execution-quality and line-movement analysis in price space.
- Units: implied probability price on a 0–1 scale.

### closing_price

The final market price for the picked side before market close, game start, or resolution, whichever is earlier.

| Field | Formula |
|-------|---------|
| `closing_price` | `close_price` from the `manual_picks` table, or the last `sharp_money_history` entry before resolution for the picked side. |

- Same unit conventions as `opening_price`.
- Used as the benchmark for CLV (closing line value) calculation.

### CLV — Closing Line Value

Already tracked in the existing system. Included here for completeness.

| Field | Formula |
|-------|---------|
| `clv` | `closing_price - fill_price` |
| `clv_pct` | `(closing_price - fill_price) / fill_price * 100` |

- Positive CLV means the pick captured value vs. the closing market.
- Existing field: `manual_picks.clv`.

---

## Metric Category: Streak Metrics

### streak — Current Consecutive Result Run

| Field | Formula |
|-------|---------|
| `streak_type` | `'W'` or `'L'` — the result of the most recent resolved pick |
| `streak_length` | Count of consecutive picks with the same result, walking backward from most recent. Pushes are skipped (do not break or extend a streak). |
| `streak_label` | `"{streak_type}{streak_length}"` — e.g., `"W5"`, `"L3"` |

- **Scope:** Streaks are computed per-filter context. A streak on "NFL ATS Home Favorites" only counts picks matching all those filters.
- **Global streak:** When no filters are applied, streak counts all resolved picks chronologically.
- See `grading-rules.md` for the detailed streak algorithm.

---

## Metric Category: Push Rate

### push

The rate at which picks land exactly on the line.

| Field | Formula |
|-------|---------|
| `push_count` | `COUNT(*) WHERE status = 'push'` (across all bet types or per bet type) |
| `push_rate` | `push_count / total_resolved_picks` |

- Tracked globally and per bet type (ATS pushes vs. OU pushes).
- Moneyline pushes are rare but possible (e.g., ties in some sports).

---

## Priority Matrix

Metrics ranked by implementation priority for v1:

| Priority | Metric | Rationale |
|----------|--------|-----------|
| P0 | SU record + win_pct | Core performance indicator; requires only existing `status` field |
| P0 | ATS record + win_pct | Primary edge metric for spread bettors |
| P0 | OU record + win_pct | Completes the bet-type trifecta |
| P0 | closing_price, CLV | Already partially implemented; key signal quality metric |
| P1 | opening_price | Enables line movement analysis |
| P1 | cover_margin, total_margin | Quantifies *how much* picks win/lose by |
| P1 | streak | High user engagement; visible on dashboards |
| P1 | home/away split | Standard contextual filter |
| P1 | favorite/dog split | Reveals selection bias patterns |
| P2 | push rate | Diagnostic metric; lower priority |
| P2 | Aggregate ROI by split | Combine existing ROI with new split dimensions |
| P2 | price_edge | Execution diagnostic, separate from sports grading |

**P0** = Must ship in v1 stats tables.
**P1** = Ship in v1 if data is available; degrade gracefully if not.
**P2** = Nice to have; can ship post-v1.

---

## Aggregation Windows

All record and margin metrics support these time windows (consistent with existing `stats.tsx` UI):

| Window | Filter |
|--------|--------|
| Today | `picked_at >= start_of_day_unix` |
| Last 7 days | `picked_at >= now - 604800` |
| Last 30 days | `picked_at >= now - 2592000` |
| Season | `picked_at >= season_start_unix` (per sport) |
| All-time | No time filter |

---

## Existing System Mapping

How new metrics relate to existing polywhaler fields:

| New Metric | Existing Field(s) | New Field(s) Needed |
|------------|--------------------|---------------------|
| SU/ATS/OU records | `manual_picks.status` | `bet_type` plus canonical game facts |
| opening_price | `sharp_money_history` (earliest entry) | `opening_price` on picks table |
| closing_price | `manual_picks.close_price` | None (already stored) |
| CLV | `manual_picks.clv` | None (already stored) |
| cover_margin | — | `spread_line`, `actual_margin` |
| total_margin | — | `total_line`, `actual_total` |
| home/away | — | `venue_role` |
| favorite/dog | — | `fav_dog_role` |
| streak | Computed at query time | None (derived metric) |
| push | `manual_picks.status = 'push'` | None (already stored) |
| price_edge | `manual_picks.fair_price`, `manual_picks.fill_price`, `manual_picks.price` | None (already mostly stored) |
