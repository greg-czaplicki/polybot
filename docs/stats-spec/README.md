# Canonical Stats Spec v1

> Source-of-truth specification for all stats displayed in Polywhaler analytics.
> Every displayed stat traces to an explicit formula defined in these documents.

## Documents

| Document | Purpose |
|----------|---------|
| [metric-definitions.md](./metric-definitions.md) | What each stat means, its formula, priority (P0/P1/P2), v1 sport scope |
| [data-requirements.md](./data-requirements.md) | Required input fields per metric, existing vs new fields, schema migration plan |
| [grading-rules.md](./grading-rules.md) | How each stat is computed in the Polymarket binary-outcome context |
| [edge-cases.md](./edge-cases.md) | Unambiguous rules for every ambiguous scenario |

## Traceability Matrix

Every metric can be traced from definition → grading formula → required inputs → edge cases.

| Metric | Definition | Grading Rule | Data Inputs | Edge Cases |
|--------|-----------|-------------|-------------|------------|
| **SU** (Straight Up) | metric-definitions.md §SU | grading-rules.md §2.1 | status, bet_type, picked_at, sport_tag | §5 (cancelled), §6 (OT), §8 (missing price) |
| **ATS** (Against the Spread) | metric-definitions.md §ATS | grading-rules.md §2.2 | status, bet_type, spread_line, actual_margin | §2 (pick'em), §7 (alt spreads), §9 (missing game line) |
| **OU** (Over/Under) | metric-definitions.md §OU | grading-rules.md §2.3 | status, bet_type, total_line, actual_total, ou_side | §5 (cancelled), §6 (OT) |
| **Home/Away** | metric-definitions.md §Home/Away | grading-rules.md §5.1 | venue_role (parsed from title) | §1 (neutral sites) |
| **Favorite/Dog** | metric-definitions.md §Favorite/Dog | grading-rules.md §5.2 | fav_dog_role (from game lines) | §2 (pick'em), §9 (missing game line) |
| **Streak** | metric-definitions.md §Streak | grading-rules.md §6 | status, picked_at, settled_at | §5 (pushes skip, don't break) |
| **Cover Margin** | metric-definitions.md §cover_margin | grading-rules.md §4.1 | spread_line, actual_margin | §7 (alt spreads), §9 (missing game line) |
| **Total Margin** | metric-definitions.md §total_margin | grading-rules.md §4.2 | total_line, actual_total, ou_side | §6 (OT), §9 (missing game line) |
| **Push** | metric-definitions.md §Push | grading-rules.md §2.4 | status | §5 (cancelled = push) |
| **Closing Price** | metric-definitions.md §closing_price | grading-rules.md §3.2 | sharp_money_history, close_price | §3 (missing closing price) |
| **Opening Price** | metric-definitions.md §opening_price | grading-rules.md §3.1 | sharp_money_history | §4 (missing opening price) |
| **CLV** | metric-definitions.md §CLV | grading-rules.md §3.3 | fill_price, closing_price | §3 (missing closing price), §8 (missing entry price) |

## v1 Sport Scope

Tier 1 (P0): NFL, NBA, MLB
Tier 2 (P1): NHL, NCAAF, NCAAB, UFC
Tier 3 (P2): Soccer/EPL, Golf, Tennis, F1

See metric-definitions.md §v1 Sport Scope for rationale.

## Priority Summary

**P0 — Must ship:**
- SU record + win rate
- ATS record + cover rate
- OU record + hit rate
- Closing line + CLV (already partially implemented)

**P1 — Ship if data available:**
- Opening line
- Cover margin, total margin (ROI)
- Streak
- Home/away and favorite/dog splits

**P2 — Post-v1:**
- Push rate
- Aggregate ROI by split dimensions
- Weighted win rate by grade

## Key Dependencies

1. **Game results data** — ATS/OU grading and margin metrics require `actual_margin` and `actual_total`, which are not currently captured. This is the primary new data source needed. See data-requirements.md §External Data Sources.

2. **Schema migration** — transitional columns on `manual_picks` plus canonical game/team tables in Phase 2. See data-requirements.md §Schema Migration Plan.

3. **Backfill** — `bet_type`, `sport_tag`, and `opening_price` can be derived from existing data. `actual_margin`/`actual_total` require a game results feed.

## Polymarket Context

These metrics are adapted for Polymarket's binary-outcome market model:
- **ATS** = traditional sports grading against a game line and actual result
- **Price edge / CLV** = separate market-price metrics for execution quality
- **Prices** are implied probabilities (0.00–1.00), not American/decimal odds
- Each market resolves to a single winner (price → 1.00) or is cancelled (push)

See grading-rules.md §1 for the full platform context.

## Canonical Entities For Phase 2

Phase 1 definitions are now anchored to these canonical entities, even where
`manual_picks` still carries transitional denormalized fields:

- `team` — stable team identity and alias resolution
- `game` — scheduled event, participants, venue, final scores, season metadata
- `game_line` — spread / total / moneyline snapshots over time
- `team_game_fact` — per-team derived results such as SU, ATS, OU, margin, role
- `team_trend_snapshot` — rolling windows like last 10 away, last 10 as dog, streaks
- `pick_context_feature` — immutable snapshot of team/game context at pick time

Phase 2 should build these entities directly. Extending `manual_picks` alone is
acceptable only as a transitional implementation step.
