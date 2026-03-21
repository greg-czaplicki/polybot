# Phase 2 Schema Design — Canonical Team/Game/Trend Entities

> Design rationale for the canonical data model introduced in Phase 2.
> Migration: `migrations/0012_add_canonical_entities.sql`

---

## Schema Overview

```
┌──────────┐        ┌──────────┐
│  teams   │◄───┐   │  games   │
│          │    │   │          │
│ id (PK)  │    ├───│ home_team_id (FK) │
│ name     │    └───│ away_team_id (FK) │
│ sport_tag│        │ sport_tag│
└────┬─────┘        └────┬─────┘
     │                   │
     │    ┌──────────────┤
     │    │              │
     │    ▼              ▼
     │  ┌────────────┐  ┌────────────┐
     │  │ game_lines │  │ team_game  │
     │  │            │  │ _facts     │
     │  │ game_id(FK)│  │            │
     │  │ snapshot_  │  │ game_id(FK)│
     │  │  type      │  │ team_id(FK)│
     │  └────────────┘  │ opponent_  │
     │                  │  id (FK)   │
     │                  │ venue_role │
     │                  │ fav_dog_   │
     │                  │  role      │
     │                  │ su/ats/ou  │
     │                  │  results   │
     │                  └────────────┘
     │
     ▼
┌─────────────────┐
│ team_trend_     │
│  snapshots      │
│                 │
│ team_id (FK)    │
│ as_of_game_id   │
│  (FK)           │
│ snapshot_type   │
│ window_size     │
│ su/ats/ou stats │
│ streak info     │
└─────────────────┘
```

**Data flow:** Games produce two `team_game_facts` rows (one per team). After each game finalizes, `team_trend_snapshots` are recomputed from the most recent N `team_game_facts` for each snapshot type.

---

## Table-by-Table Rationale

### `teams`

Stable team identity across all sports. A single team record normalizes all the ways a team name appears in Polymarket market titles (e.g., "Chiefs", "Kansas City Chiefs", "KC").

| Column | Purpose |
|--------|---------|
| `name` | Canonical display name ("Kansas City Chiefs") |
| `short_name` | Short form ("Chiefs") |
| `abbreviation` | Standard abbreviation ("KC") |
| `sport_tag` | Sport identifier matching `detectSportTag()` output |
| `aliases_json` | JSON array of alternate names for fuzzy matching during ingestion |

**Unique constraint:** `(name, sport_tag)` prevents duplicate team entries within a sport. Different sports can share team names (e.g., "Giants" in NFL vs MLB) because `sport_tag` is part of the key.

### `games`

One row per sporting event. Links two teams and stores the final score.

| Column | Purpose |
|--------|---------|
| `sport_tag` | Enables sport-scoped queries without joining teams |
| `season` / `season_type` / `week` | Season context for time-window queries ("last 10 in 2024 regular season") |
| `game_time` | Unix timestamp — primary ordering column |
| `home_team_id` / `away_team_id` | Foreign keys to `teams` — nullable only for neutral-site events where home/away is ambiguous |
| `neutral_site` | Boolean flag per edge-cases.md §1 |
| `home_score` / `away_score` / `total_score` | Final scores; `total_score` is denormalized for OU query convenience |
| `is_final` | Whether the game result is confirmed — prevents computing trends from partial data |
| `went_to_ot` | Flag for overtime per edge-cases.md §6 — grading includes OT by default |

### `game_lines`

Pregame and closing line snapshots for a game. Multiple rows per game are expected (opening, closing, possibly intermediate).

| Column | Purpose |
|--------|---------|
| `source` | Line source identifier — defaults to `'consensus'`; could also be `'polymarket'`, `'pinnacle'`, etc. |
| `snapshot_type` | `'opening'` or `'closing'` — determines which snapshot is used for grading |
| `home_spread` / `away_spread` | Spread from each team's perspective; `away_spread = -home_spread` |
| `total_line` | Over/under line |
| `home_moneyline` / `away_moneyline` | Moneyline prices (implied probability 0–1 scale matching Polymarket convention) |

**Why store both `home_spread` and `away_spread`?** Eliminates sign-convention bugs at query time. The spec requires grading from the picked team's perspective, so having both perspectives stored prevents runtime sign flips.

**Favorite/dog derivation:** A team is the favorite when their moneyline < 0.50 (implied probability > 50%) or when the spread favors them (negative spread = favorite). This is computed at `team_game_facts` insert time, not stored redundantly on `game_lines`.

### `team_game_facts`

The core analytics table. Two rows per finalized game — one for each team. Each row captures the team's perspective on the game result and grading outcomes.

| Column | Purpose |
|--------|---------|
| `venue_role` | `'home'` / `'away'` / `'neutral'` — split dimension per metric-definitions.md |
| `fav_dog_role` | `'favorite'` / `'dog'` / `'pickem'` — derived from `game_lines` at insert time |
| `team_score` / `opponent_score` | From this team's perspective |
| `actual_margin` | `team_score - opponent_score` (positive = won) |
| `su_result` | `'win'` / `'loss'` / `'push'` |
| `spread_line` | Spread from this team's perspective (from closing `game_lines`) |
| `cover_margin` | `actual_margin - spread_line` per grading-rules.md §2.2 |
| `ats_result` | `'cover'` / `'no_cover'` / `'push'` |
| `total_line` | Over/under line (same for both teams) |
| `actual_total` | `home_score + away_score` (same for both teams) |
| `ou_result` | `'over'` / `'under'` / `'push'` |
| `game_time` | Denormalized from `games` for index efficiency |
| `sport_tag` | Denormalized from `games` for index efficiency |

**Why denormalize `game_time` and `sport_tag`?** The primary query pattern is "team X last 10 games matching filters, ordered by time." Without denormalization, every such query requires joining `games`, which adds complexity and hurts SQLite/D1 performance for the most frequent access pattern.

### `team_trend_snapshots`

Precomputed rolling windows that answer questions like "Michigan last 10 as home favorite ATS" without scanning `team_game_facts` at query time.

| Column | Purpose |
|--------|---------|
| `as_of_game_id` | Which game this snapshot was computed after — enables point-in-time lookups |
| `as_of_time` | Unix timestamp for ordering and time-based joins |
| `snapshot_type` | Composite key identifying the filter combination: `'overall'`, `'home'`, `'away'`, `'favorite'`, `'dog'`, `'home_favorite'`, `'home_dog'`, `'away_favorite'`, `'away_dog'` |
| `window_size` | Number of games in the rolling window (default 10) |
| `su_*` / `ats_*` / `ou_*` | Precomputed record counts and win percentages |
| `*_streak_*` | Current streak type and length per grading-rules.md §6 |
| `avg_cover_margin` / `avg_total_margin` | Rolling average margins for trend analysis |

**`snapshot_type` values:** Each team gets up to 9 snapshot types recomputed after every game:

| `snapshot_type` | Filter |
|-----------------|--------|
| `overall` | All games |
| `home` | `venue_role = 'home'` |
| `away` | `venue_role = 'away'` |
| `favorite` | `fav_dog_role = 'favorite'` |
| `dog` | `fav_dog_role = 'dog'` |
| `home_favorite` | `venue_role = 'home' AND fav_dog_role = 'favorite'` |
| `home_dog` | `venue_role = 'home' AND fav_dog_role = 'dog'` |
| `away_favorite` | `venue_role = 'away' AND fav_dog_role = 'favorite'` |
| `away_dog` | `venue_role = 'away' AND fav_dog_role = 'dog'` |

---

## Index Strategy

Each index is justified by a specific query pattern from the swarm goal:

| Index | Query Pattern |
|-------|---------------|
| `idx_teams_sport_tag` | List all teams for a sport |
| `idx_teams_name_sport` | Unique lookup by name within a sport during ingestion |
| `idx_games_sport_season` | List games for a sport/season combination |
| `idx_games_game_time` | Time-ordered game listing across all sports |
| `idx_games_home_team` / `idx_games_away_team` | "All games for team X" (union of home + away) |
| `idx_game_lines_game` | Fetch opening/closing lines for a game |
| `idx_tgf_team` | "Team X last 10 games" — the most common query |
| `idx_tgf_team_venue` | "Team X last 10 as home/away" |
| `idx_tgf_team_favdog` | "Team X last 10 as favorite/dog" |
| `idx_tgf_team_sport` | "Team X last 10 in NFL" |
| `idx_tgf_game` | Join facts back to game for detail views |
| `idx_tts_team_type` | "Team X latest overall/home/away_dog snapshot" |
| `idx_tts_team_game` | "What was team X's trend when game Y happened?" (join to picks) |
| `idx_tts_sport` | "All teams' home ATS last 10" for league-wide dashboards |

**Composite index ordering:** Indexes on `team_game_facts` and `team_trend_snapshots` lead with `team_id` because queries always filter by team first, then by split dimension, then order by time. The `DESC` on `game_time` / `as_of_time` columns optimizes "most recent N" queries without requiring a sort step.

---

## Transitional Linkage to Picks

`manual_picks` remains the source of truth for pick-level data (entry price, CLV, execution quality). The canonical entities provide the game-context layer that picks currently lack.

**Join path:** `manual_picks` → `team_game_facts` / `team_trend_snapshots`

The join is indirect and will be established in Phase 3 via:

1. **`manual_picks.game_id`** (new column, Phase 3) — links a pick to its canonical game
2. **`manual_picks.team_id`** (new column, Phase 3) — links a pick to the picked team
3. **Time-based join** — `team_trend_snapshots` can be joined to a pick by matching `team_id` and finding the snapshot with `as_of_time <= manual_picks.picked_at`

**Phase 3 will also backfill** these transitional columns on `manual_picks`:
- `bet_type` — from `detectBetType(market_title)` (derivable now)
- `sport_tag` — from `detectSportTag(market_title)` (derivable now)
- `venue_role` — from canonical `team_game_facts.venue_role`
- `fav_dog_role` — from canonical `team_game_facts.fav_dog_role`
- `spread_line`, `total_line`, `actual_margin`, `actual_total` — from canonical game data

These denormalized fields on `manual_picks` serve as query-time convenience columns so that pick-level analytics don't require joining canonical tables for every query. The canonical tables remain the source of truth.

---

## Risks and Assumptions

### Assumptions to validate before Phase 3

1. **Team name parsing** — `market_title` contains enough structure to reliably extract team names. Assumption: Polymarket titles follow "TeamA vs TeamB" or "TeamA @ TeamB" patterns. If not, team matching will need fuzzy logic or manual mapping.

2. **Game deduplication** — Multiple Polymarket markets can reference the same game (spread, total, moneyline). We assume a reliable way to group markets by game exists (via `event_slug` or `condition_id` patterns). If not, game deduplication must be manual.

3. **Line source availability** — The schema assumes pregame lines will come from an external API (odds-api.com, ESPN) or Polymarket-derived heuristics. If no line source is available, `game_lines` will be empty and `fav_dog_role` will be null for all facts.

4. **Score data source** — `actual_margin` and `actual_total` require final scores. These could come from Polymarket resolution data, ESPN API, or manual entry. The schema is source-agnostic, but Phase 3 must choose a source.

5. **D1 row limits** — With ~32 teams × ~16 weeks × 9 snapshot types = ~4,600 snapshot rows per season per sport. Over multiple seasons and sports this is well within D1 limits.

### Risks

| Risk | Mitigation |
|------|------------|
| Team alias ambiguity ("Giants" = NYG or SF?) | `aliases_json` + `sport_tag` scoping; manual review for edge cases |
| Neutral site detection is heuristic | Conservative: default to `neutral` when uncertain (per edge-cases.md §1) |
| Snapshot staleness if recompute fails | `as_of_game_id` makes it easy to detect stale snapshots vs. the latest game |
| Multiple sport tags for same team name | Unique constraint `(name, sport_tag)` prevents cross-sport collision |

---

## Phase 3 Next Steps

1. **Team ingestion** — Seed `teams` table from a sport reference dataset or by parsing existing `market_title` values in `manual_picks`.

2. **Game ingestion** — Populate `games` from Polymarket event data, grouping related markets by game. Add final scores from resolution data or an external API.

3. **Line ingestion** — Populate `game_lines` with opening/closing lines from an odds feed or by deriving from `sharp_money_history` market prices.

4. **Fact computation** — After games finalize, compute `team_game_facts` rows for each team. Derive `su_result`, `ats_result`, `ou_result`, `fav_dog_role` from game data + lines.

5. **Snapshot computation** — After each `team_game_facts` insert, recompute `team_trend_snapshots` for all 9 snapshot types for the affected team.

6. **Pick backfill** — Add `game_id`, `team_id`, `bet_type`, `sport_tag`, `venue_role`, `fav_dog_role` columns to `manual_picks` (new migration). Backfill from canonical entities.

7. **Repository integration** — Wire repository functions (implemented by T2) into server functions for the analytics UI.

8. **Validation** — Compare canonical-derived stats against manually verified results for a sample of games to confirm grading correctness.
