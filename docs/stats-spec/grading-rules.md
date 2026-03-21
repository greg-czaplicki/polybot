# Grading Rules — Canonical Stats Spec v1

> Every displayed stat traces to an explicit formula. This document defines the
> grading math for all core metrics in the Polywhaler stats system.

## 1. Platform Context

Polywhaler operates on **Polymarket binary-outcome markets**. Each market has two
sides (A and B) with prices in the range **[0.00, 1.00]** that sum to ~1.00.
A "pick" is buying one side at an entry price; the market later resolves to one
winner (price → 1.00, loser → 0.00) or is cancelled/invalidated (push).

---

## 2. Core Outcome Metrics

### 2.1 Straight Up (SU) — Win/Loss Record

The simplest record: did the picked side win?

| Field | Formula |
|-------|---------|
| `result` | `resolvedSide === pickedSide ? "win" : "loss"` |
| `su_wins` | `COUNT(result = "win")` over scope |
| `su_losses` | `COUNT(result = "loss")` over scope |
| `su_pushes` | `COUNT(status = "push")` over scope |
| `su_record` | `"{wins}-{losses}-{pushes}"` |
| `win_rate` | `wins / (wins + losses)` — pushes excluded from denominator |

**Notes:**
- Pushes (cancelled/invalid markets) are excluded from win rate but tracked separately.
- Pending picks are excluded from all SU calculations.

### 2.2 Against The Spread (ATS)

In Polymarket context, "the spread" is the **fair price** (implied probability) at
pick time. ATS measures whether the pick beat the market's implied probability.

| Field | Formula |
|-------|---------|
| `spread` | `fairPrice` at time of pick (from sharp signal model) |
| `ats_result` | See grading table below |
| `ats_wins` | `COUNT(ats_result = "cover")` over scope |
| `ats_losses` | `COUNT(ats_result = "no_cover")` over scope |
| `ats_pushes` | `COUNT(ats_result = "push")` over scope |
| `ats_record` | `"{covers}-{no_covers}-{pushes}"` |
| `cover_rate` | `ats_wins / (ats_wins + ats_losses)` — pushes excluded |

**ATS Grading Table:**

| Outcome | Entry Price | Fair Price | ATS Result |
|---------|------------|------------|------------|
| Win | `price < fairPrice` | — | `cover` (bought below fair value, won) |
| Win | `price >= fairPrice` | — | `no_cover` (overpaid, still won) |
| Win | `price == fairPrice` | — | `push` |
| Loss | — | — | `no_cover` (always) |

**Rationale:** A "cover" means you got positive expected value AND the pick won.
Buying below fair price and winning = beating the spread. Overpaying even on a
win = not beating the spread, because the position had negative expected value.

### 2.3 Over/Under (OU)

For Polymarket, OU applies to **totals markets** (detected via `BetType = "total"`).
The "total" is the line set by the market, and the pick is either Over or Under.

| Field | Formula |
|-------|---------|
| `ou_side` | `"over"` or `"under"` (derived from market title/outcome parsing) |
| `ou_result` | `resolvedSide === pickedSide ? "hit" : "miss"` |
| `ou_hits` | `COUNT(ou_result = "hit")` over scope |
| `ou_misses` | `COUNT(ou_result = "miss")` over scope |
| `ou_record` | `"{hits}-{misses}-{pushes}"` |
| `ou_hit_rate` | `ou_hits / (ou_hits + ou_misses)` |

**Applicability:** Only computed for picks where `betType = "total"`. For non-total
markets, OU fields are `null`.

---

## 3. Line Metrics

### 3.1 Opening Line

| Field | Formula |
|-------|---------|
| `opening_line` | First recorded `outcomePrices[pickedSideIndex]` from sharp money history for this condition |
| Source | `sharp_money_history` table, `MIN(snapshot_time)` for the condition |

### 3.2 Closing Line

| Field | Formula |
|-------|---------|
| `closing_line` | Last recorded `outcomePrices[pickedSideIndex]` before market resolution |
| Source | `sharp_money_history` table, `MAX(snapshot_time)` where `snapshot_time < resolved_at` |
| Fallback | If no history available: `close_price` from resolution data |

### 3.3 Closing Line Value (CLV)

CLV measures whether you got a better price than the market's final consensus.

| Field | Formula |
|-------|---------|
| `clv` | `closing_line - entry_price` (in price units, 0.00–1.00 scale) |
| `clv_bps` | `clv * 10000` (in basis points for display) |
| Interpretation | Positive = bought cheaper than close (good). Negative = overpaid vs close (bad). |

**Example:** Entry at 0.55, close at 0.62 → CLV = +0.07 (+700 bps). You captured
7¢ of value the market later priced in.

---

## 4. Margin Metrics

### 4.1 Cover Margin

How far the pick beat (or missed) the spread.

| Field | Formula |
|-------|---------|
| `cover_margin` | `fairPrice - entry_price` (positive = bought below fair value) |
| Interpretation | Positive margin = got a bargain. Negative = overpaid. |
| Units | Price units (0.00–1.00 scale) |

**Note:** This is the pre-resolution expected-value margin. It measures edge at
entry, independent of outcome.

### 4.2 Total Margin (ROI)

The actual profit/loss on the pick.

| Field | Formula |
|-------|---------|
| `roi` (win) | `(1 / entry_price) - 1` |
| `roi` (loss) | `-1` (total loss of stake) |
| `roi` (push) | `0` |
| `roi` (no entry price) | `null` |
| `avg_roi` | `SUM(roi) / COUNT(roi IS NOT NULL)` over scope |
| `total_roi` | `SUM(roi)` over scope |

**Example:** Entry at 0.40, win → ROI = (1/0.40) - 1 = 1.50 = +150%.
Entry at 0.40, loss → ROI = -1 = -100%.

---

## 5. Positional Metrics

### 5.1 Home / Away

| Field | Formula |
|-------|---------|
| `position` | `"home"` or `"away"` — derived from market title parsing |
| Detection | Side A is typically the first-listed team. In "X vs Y" or "X at Y" formats, X = away, Y = home. In "X at Y", Y = home. |
| `home_record` | SU record filtered to `position = "home"` |
| `away_record` | SU record filtered to `position = "away"` |

**Fallback:** If position cannot be determined from title parsing, field is `null`.
See edge-cases.md §1 (Neutral Sites) for additional rules.

### 5.2 Favorite / Dog

| Field | Formula |
|-------|---------|
| `role` | `"favorite"` if `fairPrice >= 0.50`, `"dog"` if `fairPrice < 0.50` |
| `pick_em` | `true` if `abs(fairPrice - 0.50) < 0.005` (within 0.5¢ of even) |
| `favorite_record` | SU record filtered to `role = "favorite"` |
| `dog_record` | SU record filtered to `role = "dog"` |

**Note:** Role is determined by the **fair price** at pick time, not entry price.
A side with fairPrice = 0.60 is a -150 favorite; fairPrice = 0.35 is a +186 dog.

---

## 6. Streak Logic

### 6.1 Current Streak

| Field | Formula |
|-------|---------|
| `streak_type` | `"W"` or `"L"` |
| `streak_length` | Count of consecutive same-result picks, most recent first |
| `streak_display` | `"{type}{length}"` (e.g., "W5", "L3") |

**Algorithm:**
```
streak = 0
streak_type = null
for each pick in reverse chronological order (most recent first):
    skip if status = "pending" or status = "push"
    if streak_type is null:
        streak_type = pick.status  // "win" or "loss"
        streak = 1
    else if pick.status == streak_type:
        streak += 1
    else:
        break
```

**Rules:**
- Pushes are **skipped** (do not break or extend a streak).
- Pending picks are ignored.
- A streak of 0 (no settled picks) displays as "—".

### 6.2 Streak Scoping

Streaks can be computed at multiple scopes:

| Scope | Filter |
|-------|--------|
| Overall | All settled picks |
| By sport | `sportTag = {tag}` |
| By bet type | `betType = {type}` |
| By grade | `grade = {label}` |

### 6.3 Best/Worst Streak (Historical)

| Field | Formula |
|-------|---------|
| `best_win_streak` | `MAX(consecutive win runs)` across all settled picks |
| `worst_loss_streak` | `MAX(consecutive loss runs)` across all settled picks |

**Algorithm:** Scan all settled picks chronologically, tracking run lengths of
consecutive wins and losses (skipping pushes), recording the maximum of each.

---

## 7. Signal Score & Grade

These are the existing grading formulas from `src/lib/sharp-grade.ts`, documented
here for completeness and traceability.

### 7.1 Signal Score

**Without history** (< 2 snapshots):
```
signal_score = clamp(edge_score * 0.75 + diff_score * 0.25, 0, 100)
```

**With history** (≥ 2 snapshots):
```
edge_score      = clamp(edge_rating, 0, 100)
diff_score      = (clamp(score_differential, 0, 60) / 60) * 100
trend_score     = clamp(edge_delta, -20, 20) * 1.0
diff_trend      = clamp(diff_delta, -20, 20) * 0.5
volume_score    = (clamp(volume_delta, -50000, 150000) / 150000) * 15
stability_score = min(consecutive_above_threshold, 5) * 2

signal_score    = clamp(
    edge_score * 0.7
    + diff_score * 0.2
    + trend_score
    + diff_trend
    + volume_score
    + stability_score,
    0, 100
)
```

### 7.2 Grade Labels

| Grade | Signal Score | Additional Requirements |
|-------|-------------|----------------------|
| A+ | ≥ 92 | edge_rating ≥ 80 AND score_differential ≥ 30 |
| A | ≥ 85 (or ≥ 92 without A+ floors) | edge_rating ≥ 72 AND score_differential ≥ 20 |
| B | ≥ 75 (or ≥ 85 without A floors) | — |
| C | ≥ 65 | — |
| D | < 65 | — |

### 7.3 Grade Weight

Used for weighted aggregations:

| Grade | Weight |
|-------|--------|
| A+ | 100 |
| A | 80 |
| B | 60 |
| C | 40 |
| D | 20 |

---

## 8. Aggregation Rules

### 8.1 Win Rate

```
win_rate = wins / (wins + losses)
```

Pushes are **always excluded** from the denominator. If `wins + losses = 0`,
win_rate is `null`.

### 8.2 Average ROI

```
avg_roi = SUM(roi) / COUNT(roi IS NOT NULL)
```

Only settled picks with a known entry price contribute.

### 8.3 Average CLV

```
avg_clv_bps = SUM(clv_bps) / COUNT(clv IS NOT NULL)
```

Only picks with both entry price and closing line contribute.

### 8.4 Weighted Win Rate (by grade)

```
weighted_win_rate = SUM(grade_weight * is_win) / SUM(grade_weight)
```

Where `is_win = 1` for wins, `0` for losses. Pushes excluded.

---

## 9. v1 Sport Scope

The following sports are in-scope for v1 stat tracking, prioritized by typical
Polymarket betting volume:

| Priority | Sport Tag | Label | Bet Types |
|----------|-----------|-------|-----------|
| P0 | `nfl` | NFL | moneyline, spread, total, future, prop |
| P0 | `nba` | NBA | moneyline, spread, total, future, prop |
| P0 | `mlb` | MLB | moneyline, total, future |
| P1 | `nhl` | NHL | moneyline, total, future |
| P1 | `ufc` | UFC / MMA | moneyline |
| P1 | `ncaaf` | College Football | moneyline, spread, total |
| P1 | `ncaab` | College Basketball | moneyline, spread, total |
| P2 | `soccer` | Soccer (all leagues) | moneyline, total |
| P2 | `epl` | Premier League | moneyline, total |
| P2 | `golf` | Golf | future |
| P2 | `tennis` | Tennis | moneyline |
| P2 | `f1` | F1 | future |

All other sports tracked in `sports.ts` are **deferred to v2** but their picks
are still stored and graded — just not surfaced in dashboard breakdowns.
