# 2026-09-15 — Promotion rule: CLV dropped as a criterion; OddsPapi 404 credit leak

## Decision

Owner decision after the morning sweep: the shadow-book promotion rule
(`src/lib/gate-verdict.ts`) is **n ≥ 50 sole-blocker settled AND
event-clustered z ≥ 2**. `CLV > 0` is no longer a criterion; every CLV
figure stays on `/shadow` and in the digest as a diagnostic.

## Why

- Polymarket is a two-sided exchange whose close tracks Pinnacle within
  ~0.5pt on MLB (2026-09-11 close-calibration read). CLV against that close
  is ~0 for any strategy, edge or not.
- `pin_clv` carries a structural ≈ −0.3%/side offset from the PM spread
  (2026-08-26 audit). "pin_clv > 0" therefore meant "beat Pinnacle net of
  the spread", a bar the live book fails while making money: 14d MLB
  pin_clv −0.46%, +$38.81, out-of-sample +31% since 2026-07-20.
- Holding shadow cohorts to a bar the live book fails was inconsistent.

## What did NOT change

- The z criterion. That is what actually blocks every cohort today, and it
  is the one that has burned the project twice (raw first-fired reads).
- WATCH (n ≥ 25, z ≥ 1, ROI > 0) — informational, authorises nothing.
- The live stake ladder (`pin_move ≥ 0` clause) and charters with their own
  explicit Pinnacle-relative clauses (fade-inversion, pin-edge-gate (b),
  tennis ground-up stage 2).

## State at the amendment (nothing changed retroactively)

Sole-blocker cohorts n ≥ 50, all MLB, 2026-09-15 11:25Z:

| gate | w-l | ROI | clustered z | pin_clv (n) | pin_move (n) | before | after |
|---|---|---|---|---|---|---|---|
| below_policy_grade | 54-49 | +17.7% | 1.56 (row) | −0.69% (37) | −0.30% (15) | HOLD | WATCH |
| signal_score_saturation | 27-24 | +16.9% | 1.19 | −0.45% (23) | −0.58% (12) | HOLD | WATCH |
| price_edge_below_floor | 41-40 | −1.1% | −0.10 | −0.40% (30) | −0.45% (12) | HOLD | HOLD |
| edge_rating_saturation | 32-34 | +0.2% | 0.02 | −0.35% (19) | +0.07% (10) | HOLD | HOLD |

signal_score_saturation trajectory: August 24-15 (+36.5%), September 3-9
(−46.9%), last 20 rows 9-11 (+0.3%). The ROI sits in 10 dog rows < 40c
(6-4, +58.6%); the 41 rows at 40–60c are 21-20 (+6.7%). The gate exists
because the pre-gate signal_score ≥ 90 bucket was a −20% anti-signal at
larger n. Read again at n ≈ 100; at +17% ROI the z ≥ 2 bar is reached
around n ≈ 140.

## Also found and fixed the same day: OddsPapi 404 credit leak

`/odds-by-tournaments` answers **404 FIXTURE_NOT_FOUND** when Pinnacle
prices nothing in the requested tournaments, and OddsPapi bills that
answer. The tennis index (`oddspapi-tennis-index`) held ghost tournaments
— US Open M/W, Eastbourne (June), Estoril (April), Mallorca (June) — because
`/tournaments` never resets their fixture counts. While any ATP/WTA row sat
in its close window the sweep re-asked every 10-minute cron: 29 billed 404s
on 2026-09-14 (15:50Z–21:52Z), credits 118 → 81 in a day. The failure
backoff (10 min) equalled the cron cadence and fail rows were exempt from
caps, so nothing throttled it.

Fix (`src/server/pipeline/pinnacle-odds.ts`):

- A group 404 is a billed "no listing": logged as `oddspapi:<group>` spend
  (caps apply), the group's tags get an empty feed (rows stamp), and a
  marker row `oddspapi-nofixtures:<group>` backs the group off for 6 h.
  It is not a provider failure, so MLB/football closes are not held up.
- On a tennis 404 the index is blanked for the day (next daily re-resolve
  costs one request).
- `selectOddspapiTennisTournaments` skips live-only tournaments (stuck
  ghosts; nothing pregame to capture).

Worst case per dead group is now ~4 requests/day instead of ~30–40.
Tennis Pinnacle coverage has been effectively dead since the US Open ended
(2026-09-07): `atp`/`wta` feed rows empty, WTA paper lane `stale_feed`.
Recorded in KNOWN-ISSUES.
