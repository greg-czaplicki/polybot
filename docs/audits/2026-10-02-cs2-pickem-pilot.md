# CS2 pickem-dog pilot — first readout (30 settled), 2026-10-02

Charter: `docs/charters/cs2-pickem-dog-pilot.md` (era v14, amendment v1.1 era v15).
Readout trigger: 30 settled picks reached 2026-10-01. Window 2026-09-18 → 2026-10-01.

## Execution (what the pilot exists to measure)

| metric | value |
|---|---|
| candidates the bot considered | 34 |
| filled | **34 (100 %)**: no rejections, no failed or unknown-state orders, no drift-guard skips |
| slippage vs sighted price | mean **−69 bps** (in our favour), median 0; 28 at quote, 4 better, 2 worse (+171, +112 bps) |
| largest deviation | 2026-09-28 struggletony/MASONIC: sighted .40, filled .33 (price improvement, not a band leak) |
| pick → fill | at submission (≤ 1 s) |
| pick time before start | median 179 min, min 73 min (picks land as soon as the market enters the 60–180 min window) |
| settlement lag after scheduled start | median 3.9 h, p90 6.6 h |
| resolution incidents | **4 of 34 voided 50/50 → push** (12 %): paiN Academy/Semente do Mal 9/23, BASEMENT BOYS/Gothboiclique 9/24, Walczaki/BET-M 33 9/26, FORZE Reload/megoshort 9/28. The first two sat pending 31–49 h until the void fix (09fe025, 2026-09-25); later voids settle normally. |

Execution criteria for scaling (fill rate ≥ 80 %, mean slippage < 150 bps over ≥ 30 fills): **met.**

## Results (kill rule only, never evidence)

15-15 with 4 pushes, **+$13.25 on $120 settled stake (+11.0 %)**. Average fill 44.5c → about 13.3 wins
expected at the prices paid; 15 is noise (binomial z +0.61; the app's kill estimator, event-clustered ROI z
over the trailing 30, is +0.53). Drawdown never approached −$40. **Kill not triggered; the pilot continues.**

## Evidence lane (`cs2_pickem_dog_cell`), and a data bug found during this readout

The polysharp daily report showed the forward lane at **+20.5 %, z 2.0, n 125**, 25 rows short of its
n ≥ 150 read. That figure was wrong. polysharp's `classify()` labelled single-map markets
("A vs B - Map 1 Winner") as `moneyline`. It also labelled match markets whose event name contains a
colon ("(BO3) - Stake Ranked Episode 5: Closed Qualifier") as `prop`. The lane selects `moneyline`, so it
was counting map winners, which the charter excludes ("CS2 match-winner markets only"):

| forward rows (start ≥ 2026-09-18) | ROI | z | n |
|---|---|---|---|
| as reported (mislabelled) | +20.5 % | +2.00 | 125 |
| …of which map winners | +56.9 % | +3.30 | 35 |
| …of which match winners | +6.4 % | +0.54 | 90 |
| **corrected lane (match winners incl. the colon-named ones)** | **+4.5 %** | **+0.4** | **98** |

The fix and the relabel are described in `docs/KNOWN-ISSUES.md` and in `cell-lanes.md` amendment v1.3. The
correction follows the charter's written population and was decided by that text. It lowers the read.
The 35 map-winner rows went 25-10. They were never a pre-registered population, so that result is noted
and not used. The 2026-10-02 deep dive found map winners 40–50c flat on the wider holdout (+4.3 %, n 96).

At ~49 match sides/week the lane reaches n = 150 around 2026-10-13. At +4.5 % it would need a large
swing to reach z ≥ 2, so a PASS is not expected.

## Decision

- Pilot continues unchanged ($4, ≤ 3/day, band 0.40–0.50, kill −$40 or z < −1).
- **No scaling.** The execution half of the scaling test passes and the evidence half does not.
- Next readout: when the forward lane reaches n ≥ 150 (≈ 2026-10-13), or 2026-11-01, whichever comes first.

See also `docs/audits/2026-10-02-cs2-deep-dive.md` (152-cell discovery/holdout search: no new CS2 edges).
