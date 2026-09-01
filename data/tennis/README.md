# Tennis historical data snapshot — Stage 1 (tennis-v2 charter)

Downloaded **2026-09-01** for `docs/charters/tennis-ground-up.md` Stage 1.

## tennisdata/ — tennis-data.co.uk season files (committed, checksummed)

`http://www.tennis-data.co.uk/{YYYY}/{YYYY}.xlsx` (ATP) and
`{YYYY}w/{YYYY}.xlsx` (WTA), 2021–2026. SHA256 in `tennisdata/SHA256SUMS`.
One row per completed/retired/walkover match; includes date, tournament,
series/tier, surface, round, winner/loser, entry ranks+points, score,
`Comment` (Completed/Retired/Walkover), and odds columns: `B365*`, `PS*`
(Pinnacle), `Max*`/`Avg*` (Oddsportal cross-book max/average).

Normalized by `convert.py` (deterministic) → `matches_{atp,wta}.csv`
(NOT committed; rebuild with `.venv/bin/python convert.py`). Row counts
at snapshot: ATP 15,194 / WTA 14,250 (2021→2026 YTD).

### Provenance caveats (for the leakage pre-audit)

- **Odds timing**: the site's `notes.txt` was unreachable at snapshot
  time (404). Per long-standing site documentation, odds are collected
  shortly before match start; PS is Pinnacle's quote, Max/Avg are
  Oddsportal-derived. Treat all odds as "late pre-match", NOT verified
  tick-level closes. The market-implied baseline is therefore "book
  quote near close", and CLV claims in Stage 1 inherit this imprecision.
- **2026 source shift**: Pinnacle (PS) coverage collapses in the 2026
  files (ATP 3.5%, WTA 5.2%, vs 95–99.7% in 2021–2025) — consistent
  with Pinnacle's 2026 data-distribution clampdown (same event family
  that killed our worker-side feeds). Locked baseline definition, set
  before any fitting: **PS when present, else Avg**. The 2026 test-year
  baseline is therefore mostly Avg — softer than Pinnacle; documented
  distribution shift, do not silently compare across.
- Coverage blocker-check (charter: ≥90% with odds): PASS — "any odds"
  ≥99.8% every year/tour.

## sackmann/ — EMPTY (canonical source gone)

`github.com/JeffSackmann/tennis_atp` + `tennis_wta` return 404 as of
2026-09-01 (repos deleted or private; post-cutoff event). Not required:
tennis-data.co.uk carries results, surface, and entry ranks. Candidate
mirror if player metadata is ever needed: `Aneeshers/tennis-sackmann-archive`
(unverified). License note: Sackmann data was CC BY-NC-SA 4.0;
tennis-data.co.uk is free for personal/research use.

## .venv/ — uv-managed Python 3.14 env (openpyxl only; not committed)
