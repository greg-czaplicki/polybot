# CS2 deep dive — 2026-10-02

Question (user): "CS2 seems like it could be promising — deep dive and see if we're not finding all available edges."

Script: `research/sharp/cs2_deep_dive.py` (run on the VPS against `/root/polysharp/data/sharp.db`).
Output: `research/sharp/reads/2026-10-02-cs2_deep_dive.txt`.

## Method (fixed before the first run)

- Unit: one obs per (market, side, cell) = mean ROI of small ($5–100) taker BUY fills at their actual
  executable price, pregame 0–6h (in-play cell: 0–3h after start), price 0.20–0.95, markets resolved 0/1.
- z clustered by `event_key` (coarse — lumps simultaneous matches, so conservative).
- **Discovery** = market start < 2026-09-11 (what the 9/11 cell read saw; 917 markets).
  **Holdout** = start 2026-09-11 … 09-30 (830 markets, never used to choose anything).
- Candidate = discovery n≥50 & |z|≥2 **and** holdout same sign, |z|≥1, n≥30.
- Note: there is no August tape (polysharp backfill gap) — discovery is June–July + Sept 1–10.
- Market kinds are parsed from the question text: `market_type` is unreliable for CS2 (map-winner markets
  are tagged `moneyline`, some match markets `prop`). The 9/11 "moneyline 40-50c" cell therefore mixed
  in map winners; match-only figures below are the relevant ones for the live lane.

## Result

152 cells tested (≈7 chance hits at |z|≥2 expected). Five cells pass the rule and **all five are negative**
(places a taker loses), none bettable by us:

| cell | discovery | holdout |
|---|---|---|
| in-play favourites 60–80c | −9.3% z−9.2 | −3.8% z−2.5 |
| in-play favourites 80–95c | −7.8% z−6.3 | −1.7% z−1.2 |
| group-stage matches (all prices) | −3.7% z−2.6 | −4.6% z−2.3 |
| tier-1 events (all prices) | −6.8% z−2.4 | −11.4% z−1.4 (n=36) |
| BO3 50–60c (mirror of the lane band) | −6.3% z−2.1 | −4.8% z−1.3 |

The live lane's band, match ML 40–50c: discovery +5.3% z1.2 n510, holdout **+3.9% z0.7 n306** — same
direction, not significant (both 5c halves positive in both periods). Still the only positive pocket.

Dead in holdout: games totals (+8.1% → −4.0%, the 9/11 hint), match dogs 20–40c (+2.5% → −12.3%),
in-play dogs 20–40c (+8.2% z3.2 → −4.4%), map handicaps and map winners (holdout flat), following
$500+ takers (no consistent sign). Team identity: corr(discovery residual, holdout residual) = −0.12
over 77 teams — no persistent mispriced teams.

No sub-slice of the 40–50c band (format, tier, stage, start hour, 2h line move) separates reliably;
the playoffs-only and 08–14Z sub-cuts look consistent but are post-hoc and below z 2 in both halves.

## Follow-up the same day

This read parsed market kinds from question text on its own. The
mislabelling it exposed was also inside polysharp's stored `market_type` and
the forward lanes. It was fixed and relabelled on 2026-10-02 (`docs/KNOWN-ISSUES.md`,
`cell-lanes.md` v1.3). After the fix the corrected `cs2_pickem_dog_cell` reads +4.5 % z 0.4 n 98.
Re-running `cell_read.py` on Dota 2, Valorant and LoL with corrected labels
changes no conclusion: no esports match-winner cell is above z 1.2.

## Decision

No new CS2 lanes. The `cs2_pickem_dog` pilot continues unchanged (no mid-pilot band/stage edits from a
post-hoc cut). Re-run this script with the same split rules once the holdout reaches ~1,500 markets.
