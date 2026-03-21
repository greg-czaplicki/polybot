# Data Requirements — Canonical Stats Spec v1

> For each metric defined in `metric-definitions.md`, this document lists the exact
> input fields required, their source, and whether they exist today or must be added.

---

## Field Inventory

### Existing Fields (already in `manual_picks` table)

| Field | Column | Type | Description |
|-------|--------|------|-------------|
| Pick ID | `id` | TEXT PK | Unique pick identifier |
| Condition ID | `condition_id` | TEXT | Polymarket condition/market ID |
| Market Title | `market_title` | TEXT | Raw market title (used for bet type detection) |
| Event Time | `event_time` | TEXT | ISO timestamp of the sporting event |
| Picked At | `picked_at` | INTEGER | Unix timestamp when pick was made |
| Grade | `grade` | TEXT | Signal grade (A+, A, B, C, D) |
| Signal Score | `signal_score` | REAL | Composite signal score (0–100) |
| Edge Rating | `edge_rating` | REAL | Sharp money edge rating (0–100) |
| Score Differential | `score_differential` | REAL | Score differential (0–60) |
| Sharp Side | `sharp_side` | TEXT | Which side sharp money favors |
| Pick Price | `price` | REAL | Price at time of pick (implied probability) |
| Fair Price | `fair_price` | REAL | Model-estimated fair price |
| Price Edge | `price_edge` | REAL | Difference between fair and market price |
| Close Price | `close_price` | REAL | **Closing line** — price at market close |
| ROI | `roi` | REAL | Return on investment for this pick |
| CLV | `clv` | REAL | Closing line value |
| Status | `status` | TEXT | `pending | win | loss | push` |
| Settled At | `settled_at` | INTEGER | Unix timestamp of settlement |
| Fill Price | `fill_price` | REAL | Actual execution price |
| Fill Size | `fill_size` | REAL | Position size |
| Fill Notional | `fill_notional` | REAL | Notional value of fill |
| Fill Slippage | `fill_slippage_bps` | REAL | Slippage in basis points |
| Confidence | `confidence` | TEXT | HIGH / MEDIUM / LOW |
| Strategy Version | `strategy_version` | TEXT | Bot strategy version string |

### Existing Fields (in `sharp_money_history` table)

| Field | Column | Type | Description |
|-------|--------|------|-------------|
| Condition ID | `condition_id` | TEXT | Links to same market |
| Recorded At | `recorded_at` | INTEGER | Unix timestamp of snapshot |
| Edge Rating | `edge_rating` | REAL | Edge rating at snapshot time |
| Score Differential | `score_differential` | REAL | Score diff at snapshot time |
| Side A Value | `side_a_total_value` | REAL | Total money on side A |
| Side B Value | `side_b_total_value` | REAL | Total money on side B |

### New Fields Required

| Field | Proposed Column | Type | Source | Used By |
|-------|----------------|------|--------|---------|
| Bet Type | `bet_type` | TEXT | `detectBetType(market_title)` — computed at pick time | SU, ATS, OU filtering |
| Sport Tag | `sport_tag` | TEXT | `detectSportTag(market_title, slug)` — computed at pick time | Sport filtering, season windows |
| Spread Line | `spread_line` | REAL | Extracted from market title (e.g., "-3.5" from "Chiefs -3.5") | ATS grading, cover_margin |
| Total Line | `total_line` | REAL | Extracted from market title (e.g., "47.5" from "Over 47.5") | OU grading, total_margin |
| Actual Margin | `actual_margin` | REAL | `picked_side_score - opponent_score` (set at settlement) | cover_margin |
| Actual Total | `actual_total` | REAL | `team_a_score + team_b_score` (set at settlement) | total_margin |
| Opening Line | `opening_line` | REAL | Earliest `sharp_money_history` price for this condition | Line movement, fav/dog classification |
| Venue Role | `venue_role` | TEXT | Parsed from market title / event metadata: `home | away | neutral` | Home/away splits |
| Fav/Dog Role | `fav_dog_role` | TEXT | Derived from `opening_line`: `favorite | dog | pickem` | Favorite/dog splits |

---

## Metric → Input Mapping

Each metric and the exact fields it reads:

### SU (Straight Up)

| Input | Source | Required? |
|-------|--------|-----------|
| `status` | `manual_picks.status` | Yes |
| `bet_type` | **NEW** `manual_picks.bet_type` | Yes — must equal `'moneyline'` |
| `picked_at` | `manual_picks.picked_at` | Yes (for time windows) |
| `sport_tag` | **NEW** `manual_picks.sport_tag` | Yes (for sport filtering) |

### ATS (Against The Spread)

| Input | Source | Required? |
|-------|--------|-----------|
| `status` | `manual_picks.status` | Yes |
| `bet_type` | **NEW** `manual_picks.bet_type` | Yes — must equal `'spread'` |
| `spread_line` | **NEW** `manual_picks.spread_line` | Yes (for grading and margin) |
| `actual_margin` | **NEW** `manual_picks.actual_margin` | Yes (for grading) |
| `picked_at` | `manual_picks.picked_at` | Yes (for time windows) |
| `sport_tag` | **NEW** `manual_picks.sport_tag` | Yes (for sport filtering) |

### OU (Over/Under)

| Input | Source | Required? |
|-------|--------|-----------|
| `status` | `manual_picks.status` | Yes |
| `bet_type` | **NEW** `manual_picks.bet_type` | Yes — must equal `'total'` |
| `total_line` | **NEW** `manual_picks.total_line` | Yes (for grading and margin) |
| `actual_total` | **NEW** `manual_picks.actual_total` | Yes (for grading) |
| `picked_at` | `manual_picks.picked_at` | Yes (for time windows) |
| `sport_tag` | **NEW** `manual_picks.sport_tag` | Yes (for sport filtering) |

### cover_margin

| Input | Source | Required? |
|-------|--------|-----------|
| `actual_margin` | **NEW** `manual_picks.actual_margin` | Yes |
| `spread_line` | **NEW** `manual_picks.spread_line` | Yes |
| `bet_type` | **NEW** `manual_picks.bet_type` | Yes — filter to `'spread'` |

### total_margin

| Input | Source | Required? |
|-------|--------|-----------|
| `actual_total` | **NEW** `manual_picks.actual_total` | Yes |
| `total_line` | **NEW** `manual_picks.total_line` | Yes |
| `bet_type` | **NEW** `manual_picks.bet_type` | Yes — filter to `'total'` |

### opening_line

| Input | Source | Required? |
|-------|--------|-----------|
| `condition_id` | `manual_picks.condition_id` | Yes (join key) |
| Earliest snapshot | `sharp_money_history` WHERE `condition_id` matches, `ORDER BY recorded_at ASC LIMIT 1` | Preferred |
| `opening_line` | **NEW** `manual_picks.opening_line` | Fallback — denormalized at pick time |

### closing_line

| Input | Source | Required? |
|-------|--------|-----------|
| `close_price` | `manual_picks.close_price` | Yes (already exists) |

### CLV

| Input | Source | Required? |
|-------|--------|-----------|
| `fill_price` | `manual_picks.fill_price` | Yes (already exists) |
| `close_price` | `manual_picks.close_price` | Yes (already exists) |
| `clv` | `manual_picks.clv` | Yes (already computed) |

### Home / Away Split

| Input | Source | Required? |
|-------|--------|-----------|
| `venue_role` | **NEW** `manual_picks.venue_role` | Yes |
| Market title | `manual_picks.market_title` | Yes (parsing source) |

### Favorite / Dog Split

| Input | Source | Required? |
|-------|--------|-----------|
| `fav_dog_role` | **NEW** `manual_picks.fav_dog_role` | Yes |
| `opening_line` | **NEW** `manual_picks.opening_line` | Yes (derivation source) |
| `close_price` | `manual_picks.close_price` | Fallback if opening unavailable |

### Streak

| Input | Source | Required? |
|-------|--------|-----------|
| `status` | `manual_picks.status` | Yes |
| `picked_at` | `manual_picks.picked_at` | Yes (ordering) |
| `settled_at` | `manual_picks.settled_at` | Yes (ordering — use settled order, not pick order) |
| All split fields | Various | Optional (for filtered streaks) |

### Push Rate

| Input | Source | Required? |
|-------|--------|-----------|
| `status` | `manual_picks.status` | Yes — count where `= 'push'` |
| `bet_type` | **NEW** `manual_picks.bet_type` | Optional (for per-bet-type push rate) |

---

## Schema Migration Plan

New columns to add to `manual_picks` table:

```sql
ALTER TABLE manual_picks ADD COLUMN bet_type TEXT;
ALTER TABLE manual_picks ADD COLUMN sport_tag TEXT;
ALTER TABLE manual_picks ADD COLUMN spread_line REAL;
ALTER TABLE manual_picks ADD COLUMN total_line REAL;
ALTER TABLE manual_picks ADD COLUMN actual_margin REAL;
ALTER TABLE manual_picks ADD COLUMN actual_total REAL;
ALTER TABLE manual_picks ADD COLUMN opening_line REAL;
ALTER TABLE manual_picks ADD COLUMN venue_role TEXT;
ALTER TABLE manual_picks ADD COLUMN fav_dog_role TEXT;
```

**Indexes for query performance:**

```sql
CREATE INDEX idx_manual_picks_bet_type ON manual_picks(bet_type);
CREATE INDEX idx_manual_picks_sport_tag ON manual_picks(sport_tag);
CREATE INDEX idx_manual_picks_venue_role ON manual_picks(venue_role);
CREATE INDEX idx_manual_picks_fav_dog_role ON manual_picks(fav_dog_role);
CREATE INDEX idx_manual_picks_stats ON manual_picks(sport_tag, bet_type, status);
```

**Backfill strategy:**
1. `bet_type` and `sport_tag` can be backfilled from existing `market_title` using `detectBetType()` and `detectSportTag()`.
2. `opening_line` can be backfilled by joining on `sharp_money_history` (earliest snapshot per condition_id).
3. `spread_line`, `total_line`: Backfill by parsing `market_title` for embedded numbers.
4. `actual_margin`, `actual_total`: Require game result data — must come from an external results feed or manual entry. Cannot be backfilled from existing data.
5. `venue_role`: Parse from `market_title` ("Away @ Home" convention) or event metadata.
6. `fav_dog_role`: Derive from `opening_line` after backfill.

---

## Data Availability Matrix

Which metrics can be computed from existing data vs. requiring new data sources:

| Metric | Existing Data Sufficient? | New Data Source Needed? |
|--------|--------------------------|------------------------|
| SU record | Partial — need `bet_type` column (derivable from `market_title`) | No |
| ATS record | No — need `spread_line` + `actual_margin` | Game results feed |
| OU record | No — need `total_line` + `actual_total` | Game results feed |
| closing_line | Yes — `close_price` exists | No |
| CLV | Yes — `clv` exists | No |
| opening_line | Partial — derivable from `sharp_money_history` | No |
| cover_margin | No — need `actual_margin` | Game results feed |
| total_margin | No — need `actual_total` | Game results feed |
| streak | Yes — needs only `status` + `picked_at` | No |
| home/away | Partial — parseable from `market_title` | No (heuristic parsing) |
| favorite/dog | Partial — needs `opening_line` (derivable) | No |
| push rate | Yes — `status = 'push'` exists | No |

**Key dependency:** ATS grading, OU grading, cover_margin, and total_margin all require game result data (`actual_margin`, `actual_total`) that is **not currently captured**. This is the primary new data source needed for v1 stats.

---

## External Data Sources (v1)

For metrics requiring game results:

| Data Point | Needed For | Possible Sources |
|------------|-----------|-----------------|
| Final score (both teams) | `actual_margin`, `actual_total` | Polymarket resolution data, ESPN API, odds-api.com |
| Opening lines | `opening_line` (validation) | `sharp_money_history` (already captured), odds-api.com |
| Home/away designation | `venue_role` | Market title parsing (primary), event metadata |

**Recommendation:** Since Polymarket resolves markets with final results, the resolution event data should be the primary source for game scores. Supplement with `sharp_money_history` for line data.
