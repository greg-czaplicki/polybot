# 2026-09-15 — Do live MLB picks do better when the hot-record wallets agree? (exploratory)

Owner question after the hot-record lane's in-sample run came back ≈ 0 while the
live MLB book had gone eleven straight positive weeks: does per-sport record
hotness add anything ON TOP of the book's selection?

## Method
`research/sharp/pick_agreement.py` (mirror `/root/polysharp/pick_agreement.py`).
All 372 settled live MLB picks (2026-04-13 → 2026-09-14, exported from
`manual_picks`) joined to the polysharp tape by `condition_id`. For each pick,
at the pick's OWN decision time (`picked_at`): wallet net positions from fills
before that time, each wallet's record in MLB over its last 12 settled
positions (settled ≥ 6 h before), hot per `hot_record.py` (variant `record`
= ≥75 % wins; `units` = ROI sum > 0), side per the lane rule (≥3 hot & 2×
USD) and a soft hot-USD majority. Outcome = the pick's own settled ROI.
z event-clustered. Checks: 372/372 picks in the tape; side-A = token0
mapping verified (median |tape price − pick price| = 0.005 = the entry
offset); median 84 wallets positioned per market at pick time.

This is an exploratory feature read, not a pre-registered test — 16 cuts.

## Result: no usable feature

| cut (all 372 picks, baseline +9.1 %) | agree | disagree | agree − disagree |
|---|---|---|---|
| record, lane rule | +1.8 % (n 86) | +8.3 % (n 61) | −6.5 pts, z −0.4 |
| record, USD majority | +12.5 % (n 186) | +4.3 % (n 142) | +8.1 pts, z +0.7 |
| units, lane rule | +17.1 % (n 131) | +11.1 % (n 139) | +6.0 pts, z +0.5 |
| units, USD majority | +16.5 % (n 179) | +4.1 % (n 180) | +12.3 pts, z +1.1 |

Out-of-sample era (post-2026-07-20, 127 picks, baseline +26.7 %): the
best-looking variant above (units majority) is +26.7 % agree vs +26.7 %
disagree — zero difference. Record lane rule: +23.0 % vs +10.2 %, z +0.5.

Hot-count ladder (record variant), hot wallets ON the pick side: 0 → +3.9 %
(n 91), 1–2 → +20.7 % (n 154, z 2.5), 3–5 → +5.6 % (n 85), 6+ → −15.0 %
(n 42). AGAINST the pick side: 0 → +18.0 % (n 129), any → +3–5 %.

## Reading
- Agreement of the hot-record side with the pick is worth nothing that
  survives a z of 1.2 in any cut, and nothing at all in the era the streak
  lives in. Not a feature.
- The one recurring shape is the inverted U: a pick with 1–2 hot wallets on
  its side does best, a pick with 6+ hot wallets on its side loses. That is
  the same finding as `signal_score_saturation` (June 2026) in a different
  costume — crowded "smart" sides are bad sides. Consistent with the gate
  we already have; not evidence for a new one (n 42, exploratory).
- The book's edge is where the 9/11 counterparty read put it: in the
  selection stack, not in any single wallet-quality ingredient.

No action. The forward hot-record lane keeps running per its charter.
