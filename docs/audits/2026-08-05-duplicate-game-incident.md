# 2026-08-05 — Duplicate-game incident (BAL@BOS doubleheader) + snapshot lookahead fix

Discovered while implementing the recon-audit trend-snapshot lookahead fix:
a contamination scan of `team_trend_snapshots` surfaced ~5,400 suspicious
rows that all traced back to one runaway duplicate-game loop.

## What happened

The 2026-07-22 BAL@BOS **doubleheader** (ESPN events `401898715`, BOS 6–3;
`401816216`, BAL 5–1) listed both games at the same start time
(23:10 UTC). Before the doubleheader-aware matching fix (`f91dce2`,
deployed ~2026-07-25), ingestion could not match game 2 to the existing row
(which carried game 1's `espn_event_id`), so it created a fresh `games` row
on every ~2-minute cycle from **2026-07-23 14:36 to 2026-07-25 23:59**:

- **848 duplicate game rows** (all `espn_event_id 401816216`, all final)
- **1,696 duplicate `team_game_facts`** rows (2 per dup game)
- **847 duplicate `game_lines`** rows
- **15,258 `team_trend_snapshots`** rows keyed to dup games
- Worse: every BAL/BOS snapshot computed 2026-07-23 → 2026-08-05 had its
  last-10 window filled with **copies of that single game** (the window
  query takes the 10 most recent facts, and 850 facts shared one game_time)

`f91dce2` stopped the creation loop; the data damage sat undetected until
today. Two additional 2-row duplicate pairs from the known creation race
(2026-07-05 HOU/TB and OAK/MIA, ids created <1.5s apart, no espn id) were
found and cleaned in the same pass.

## Blast radius

- **Zero picks** referenced duplicate game rows directly.
- **Three picks** were made on BAL/BOS games while their snapshots were
  poisoned — `pick_1785197348845_5gck6mk` (BOS/ATH O/U 10.5, 07-28),
  `pick_1785531552200_ns3ve7v` (PHI/BAL O/U 8.5, 07-31),
  `pick_1785622207476_beejpwc` (BOS/LAD O/U 7.5, 08-01) — all totals, all
  losses. Totals don't consume trend snapshots in scoring, so the decisions
  were unaffected, but their stored pick-time trend context is garbage:
  **exclude these three from trend-bucket analyses** (noted in
  KNOWN-ISSUES).

## Fix (commit `06d798a`, deployed 2026-08-05)

1. **Lookahead bound (recon P2 closed):** `computeSnapshotsForGame` now
   passes `beforeGameTime = gameTime + 1`, so a snapshot's window can never
   contain facts from games played after its `as_of_time`.
2. **Late-game repair pass:** `processGame` recomputes any existing
   snapshots stamped *after* a late-processed game so their windows pick it
   up (no-op in normal chronological processing).
3. **Repair endpoint:** `POST /_canonical/rebuild-team-snapshots?teamId=&
   sportTag=&sinceGameTime=` (ops-authed) rebuilds a team's snapshot
   history one as-of game at a time with correct bounds.

## Cleanup (remote D1, 2026-08-05)

1. Deleted dependents then dup games, keeping the earliest row per
   `espn_event_id` (848 + 2 games, 1,700 facts, 849 lines, 15,294
   snapshots).
2. Rebuilt snapshot history via the new endpoint for all six affected
   teams (BAL, BOS since 07-22; HOU, TB, OAK, MIA since 07-05) —
   117 as-of games, 1,053 snapshots recomputed.

## Verification

- No duplicate `(home, away, game_time)` groups remain except the two
  legitimate doubleheader rows (distinct ESPN ids).
- BAL/BOS fact counts back to 98 each (from 946).
- Rebuilt windows show sane 10-game records (e.g. BAL overall 4-6).
- Post-rebuild contamination scan flags only the fresh rebuilds
  (expected: the created_at heuristic can't see the window bound; the
  bound itself guarantees content correctness).

## Follow-ups

- The `as_of_time = game start` half of the recon timing finding is still
  open (mid-game as-of reads can see that game's result) — tracked in
  KNOWN-ISSUES.
- The contamination scan used here is a useful periodic check but only
  valid for snapshots written by pre-`06d798a` code; don't re-run it
  naively against rebuilt rows.
