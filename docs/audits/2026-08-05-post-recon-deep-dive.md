# 2026-08-05 — Post-recon deep dive (new subsystems + live-DB sweep)

Multi-agent audit of everything built since the 2026-07-23 recon: shadow
book, wallet CLV, soccer canonical + series registry, football readiness,
signal persistence, the recon fixes themselves, plus a read-only invariant
sweep of production D1. 7 finder dimensions → 37 raw findings → top 12
adversarially verified → **12 confirmed, 0 refuted** (25 lower-severity
unverified, listed at the end). ~1.3M tokens, 19 agents.

Severities: P0 corrupts money/picks/settlement now; P1 wrong
data/analytics decisions rely on; P2 wrong under plausible conditions;
P3 minor.

## Confirmed P1 (7)

### 1. NFL preseason gate (era v5) silently bypassable NOW — series registry never warmed in the request path

`src/server/api/bot.ts:732-734, 791-807` + `src/server/api/series-registry.ts:274-276`
(two findings, one root cause)

Gamma has already minted `nfl-2026` = series **12185** (live-verified;
preseason events Aug 7–22). The dynamic registry that would map 12185→nfl
is populated only inside the sharp-pipeline sync (`sharp-money.ts:161,938`);
the `/api/bot/candidates` path reads the module-level snapshot, which on a
cold isolate is the hardcoded fallback (`nfl=[10187]` only). The static
`SPORT_SERIES_ID_TO_TAG` map also lacks 12185. Result: on any fetch isolate
that hasn't run the sync, `getSportPolicyKey` returns `'default'` and the
`nfl_preseason_excluded` hard reject, the NHL exclusion, and sport-specific
tightenings **silently don't apply** — the bot can bet real money on
exhibition games. First preseason game is **Aug 7** (two days away).
Same root cause nulls `sport_tag` stamping on picks/shadows for new-season
series (NCAAF titles have no keyword fallback). Recurs at every season
boundary. **Fix:** await `resolveSeriesRegistry()` (or a D1-persisted
registry) in `listBotCandidates` and pick creation.

### 2. Doubleheader duplicate-game loop is STILL LIVE — and the 2026-08-05 incident's causal story was backwards

`src/server/pipeline/espn-schedule-ingestion.ts:340-353, 554-611`

Timeline analysis proves **f91dce2 STARTED the 848-row creation loop**
(committed 14:35 UTC 2026-07-23; duplicates began 14:36), and the 3-day
lookback window expiring at 2026-07-25 23:59 UTC — not any fix — stopped
it. Pre-f91dce2 code swallowed the second event (the original recon P1)
but could not create duplicates. The current code is logically identical:
`findExistingGame` orders by `ABS(game_time - eventTime) LIMIT 1` with no
tie-break and no `espn_event_id` preference, so when both halves of a
doubleheader list the same start time (exactly the BAL@BOS case), game 2's
event matches game 1's row → `claimedByOtherEvent` → creates a fresh
duplicate **every cycle for 3 days**. The next same-time-listed MLB
doubleheader recreates the incident; the 06d798a as-of bound does NOT
prevent re-poisoning (duplicate facts at time T still fill windows with
as_of > T). `findGameForPick` has the same tie-unaware ORDER BY (~50%
wrong-game pick linkage on doubleheaders). **Fix:** look up by
`espn_event_id` first, or `ORDER BY (espn_event_id = ?) DESC, ABS(...)`;
consider a UNIQUE constraint. *(Incident doc corrected — see addendum in
2026-08-05-duplicate-game-incident.md.)*

### 3. Soccer home/away inversion — every Polymarket soccer market creates a reversed orphan game; live soccer picks link to the orphan

`src/server/pipeline/team-seeder.ts:2764-2788`

`parseTeamsFromTitle` hard-codes US-sports "first listed = away", but
Polymarket soccer titles are **home-first** (verified against ESPN for
live MLS fixtures). Consequences, all confirmed in production: (1)
game-ingestion's exact-orientation dedup creates a reversed duplicate
`games` row per soccer matchup (2 of 2 so far: NYC FC/Toronto,
Miami/Columbus); (2) the orphan can never finalize (result matching is
orientation-exact); (3) `findGameForPick` links soccer picks to the empty
orphan — the first live MLS pick `pick_1785536240916_hw7hgrs` has
`game_id` pointing at the phantom row while the real ESPN row holds the
matching close line. KNOWN-ISSUES' "soccer picks have game_id=NULL" claim
is stale — they now get a **wrong, non-NULL** one. Must fix before EPL
restart (~Aug 15). **Fix:** home-first parse for soccer tags + orientation-
agnostic game matching; clean up the two orphans and relink the pick.

### 4. CFB scoreboard `limit=1000` collapses ESPN response to the Top-25 slate — ~60% of FBS games never ingested

`src/server/pipeline/espn-schedule-ingestion.ts:157-159`

Live-reproduced: for college football, `limit>500` flips ESPN's scoreboard
to its curated Top-25 view (25 events instead of 62 on a week-1 Saturday).
The 2026-07-20 truncation fix added `&limit=1000` unconditionally, so from
the first CFB Saturday most FBS games silently get no ESPN row: no
espn_event_id, no book anchors, no close refresh, no facts/trends, no
season/week stamping — the plumbing the 148-team seeding was built to
feed. HTTP 200, no error. **Fix:** `limit<=500` (verified full slate), or
`groups=80` + small limit for CFB (`groups=50` for NCAAB, which is
curated-only regardless — pre-existing, off-season).

### 5. Wallet CLV price-basis mismatch fabricates entries from spread oscillation

`src/server/pipeline/wallet-clv.ts:89,102` + `sharp-money.ts:2111-2127,2159-2189`

Holder USD amounts are valued with CLOB `token.price` (mid), but shares
are reconstructed by dividing by the stored side price (bestAsk basis).
Reconstructed shares = trueShares × (mid/ask), so any tick-to-tick change
in the mid-to-ask ratio manufactures a positive delta on a static
position; ≥$100 crosses `MIN_DELTA_USD` and inserts a fabricated
`kind='increase'` row (one-way ratchet — only positive deltas record).
Live data shows the signature: 877 increase rows, 58% clustered at the
$100 floor; one wallet has **47 'increase' entries on one market**
averaging ~$504 against a static ~$27.5k position. The leaderboard is
polluted at the source and worsens daily. **Fix:** single price basis for
value and reconstruction (store shares directly, or divide by the same
price used to compute USD value); scrub-or-flag existing wallet_entries.

### 6. Pick `signalComponents` recomputed at POST time from a later snapshot than the decision score

`src/server/api/bot.ts:2919-2935`

Persisted `signal_score`/grade come from the bot's scan-time payload, but
`decision_snapshot.signalComponents` comes from a fresh
`computeSharpMoneyGrades` at POST time (60-min history window anchored at
"now", silent `.catch(() => null)`). Any recompute between scan and POST —
or an outbox replay up to 48h later — yields components that didn't
produce the decision (worst case: outcome-era components). Shadows don't
have this bug, so picks and shadows are silently inconsistent populations.
This defeats the purpose of 7904ed4 (weight recalibration inputs).
Detectable via `signalComponents.total != signal_score`. **Fix:** persist
the components from the same grade result the candidate scan produced
(pass them through the bot payload like shadows do).

### 7. (Same root cause as #1 — second confirmed finding)

The football-readiness finder independently confirmed the cold-isolate
registry gap with the additional detail that pick/shadow `sport_tag`
stamping degrades through the same path.

## Confirmed P2 (3)

- **outside_window shadows bypass every other gate**
  (`shadow-book.ts:218-263`): cron-recorded early shadows skip market-type
  /spread/sport/preseason filters, so ~7.6% of the outside_window
  population (spreads, 'other' markets) could never be picks — the
  window-loosening counterfactual is biased. Worsens when NHL returns.
- **Fallback bot-inspect defaults (15–60m) can contaminate shadow
  windows** (`bot.ts:238-311`): if the bot-control endpoint is down and a
  user opens /sharp or /runtime, the UI-triggered scan records permanent
  shadow rows under a timing window the bot never trades, indistinguishable
  from real ones. No contamination yet (live-checked).
- **Scan-path shadow recording is request-driven only**
  (`bot.ts:1859`): all gate populations except outside_window are recorded
  only while the bot polls; bot downtime silently blanks them with no
  staleness alarm — gate aggregates are conditioned on bot uptime.

## Confirmed P3 (2)

- **Wallet settle sweep head-of-line blocking** (`wallet-clv.ts:229-236`):
  ≥50 unresolvable open entries starve settlement until their 7-day void;
  no attempt counter (shadow_candidates grew one for exactly this).
  Narrow same-slate void path where closes get retention-pruned.
- Live invariant sweep: all other checked invariants hold (clean bill
  otherwise).

## Unverified tail (25, P2/P3 — triage later)

Highlights worth an early look:
- **'New York Red Bulls' resolves to Newcastle United** via the 'New' →
  NEW abbreviation word-fallback (`team-seeder.ts`, P2) — wrong-team
  linkage, not just a miss.
- **Soccer line ingestion from Polymarket is dead code**: raw epl/mls tag
  bound against games.sport_tag='soccer' (`canonical-sync.ts`, P2).
- **shadow_candidates.sport_tag stores epl/mls while manual_picks stores
  'soccer'** — sport-bucketed shadow-vs-pick comparisons silently
  mismatch (P2).
- **10 phantom NCAAF exhibition 'teams'**; 'SOUTH FLORIDA STARS' collides
  with USF Bulls on short_name with unordered LIMIT 1 (P2).
- **Post-kickoff close refresh can replace a complete DK close with a
  partial/non-DK line**, NULLing absent fields (P2, 924a4bd regression).
- **Straggler finalization is doubleheader-unsafe** (team-only first-match
  scoring; P2, activated by the 1f95b2f Eastern-date fix).
- topHoldersSharpSide captured from re-fetched cache (P2, same family as
  confirmed #6); wallet-address case not normalized in rosters (P2);
  degraded-price 1.0 sentinel accepted as close (P2); series discovery 6h
  blindness window (P2); soccer PK/shootout scores unread (P3); shadow
  void-before-final-attempt + backoff-counts-normal-checks (P3s);
  computeSharpMoneyGrades 200-id truncation drops candidates silently
  (P3); 'ml' substring matches 'MLB'/'MLS' (P3); leaderboard mixes kinds
  and counts open rows in volume (P3); empty-vs-failed capture markers
  (P3); misc doc/marker nits.

Full agent transcripts: session workflow `wf_e39c0131-16a`.

## Resolution — all six P1s FIXED same day (2026-08-05)

App commits `1c1cb4d` + follow-up (deployed); bot branch `c87f2e4`
(pulled + restarted on the VPS):

1. **Registry warm-up** — `warmSeriesRegistry()` (bounded 5s wait, shared
   in-flight discovery) awaited in `listBotCandidates`, `handleBotRequest`,
   and the cron shadow path; `nfl-2026` (12185) added to fallbackIds and
   the static map as a deterministic floor. Verify: watch the first
   preseason slate (Aug 7) rejects with `nfl_preseason_excluded`.
2. **Doubleheader tie-break** — `findExistingGame` prefers the row already
   stamped with the processing event's `espn_event_id`, then unclaimed
   (NULL) rows, then nearest-by-time; `findGameForPick` prefers
   ESPN-linked rows, accepts either team orientation, deterministic
   ordering. Verify at the next same-time MLB doubleheader.
3. **Soccer orientation** — `parseTeamsFromTitle` is sport-aware (soccer =
   home-first); Polymarket game dedup matches either orientation with
   ESPN-linked preference; New York Red Bulls seeded. Both reversed
   orphans deleted; the live MLS pick relinked to the real ESPN game row
   (which has the close line). Verify on the next MLS slate + EPL restart.
4. **CFB limit** — scoreboard `limit=500` + `groups=80` (CFB) /
   `groups=50` (NCAAB); live-verified full slates (62/45/146 events).
5. **Wallet CLV basis** — raw `shares` carried from the holders API
   through cache JSON into the diff; cross-basis (legacy×shares)
   comparisons refused during the transition tick. All 1,467 polluted
   wallet_entries rows wiped (backup in session scratchpad); collection
   restarted clean. Leaderboard/CLV data valid from 2026-08-05 only.
6. **signalComponents provenance** — candidates response now carries
   `signalComponents`; the bot echoes them in `decision_snapshot` (bot
   `c87f2e4`); the server prefers the echo and stamps
   `signalComponentsProvenance` ('scan_payload' | 'post_recompute') so
   calibration can filter recomputed vectors. Picks created before
   2026-08-05 have post-hoc components (filter `total != signal_score`).

## Still open from this audit

- 3 confirmed P2 shadow-book epistemics items (gate-parity for cron
  shadows, fallback-defaults marker, recording-staleness alarm).
- The 25-item unverified tail above.
