# Stage 1b — Tennis holder-composition study (2026-09-01)

Descriptive study under `docs/charters/tennis-ground-up.md` (Stage 1b).
**Nothing here is a promotion input or a read.** Sole use: decide whether
an R3 (tennis-native wallet rule) addendum is worth pre-registering, and
parameterize it if so.

Population: all ATP/WTA `shadow_candidates` rows with `top_holders_json`
(887 rows, 2026-08-18 → 09-01), deduped to first sighting per
condition_id → **395 distinct markets, 349 settled** (ATP 221, WTA 128).
Snapshots store the top holders of the row's recorded sharp side only.

## Finding 1 — Recurring tennis wallets exist, in force

749 distinct wallets appear in the snapshots: 404 on one market only,
209 on 2–4, **69 on 5–9, 67 on 10+**. The moat's precondition holds —
tennis top-holder slots are not a parade of one-off tourists. 49 of the
136 recurring (≥5) wallets also appear in a 250-row MLB top-holder
sample (generalists); 87 do not (candidate tennis-specialists).

## Finding 2 — The MOST-recurring wallets look like liquidity, not opinion

The extreme recurrers are omnipresent and directionless:

| wallet | on n of 349 settled | record | ROI@$1/row |
|---|---|---|---|
| 0x0d2d845a… | 137 (39%) | 66-71 | −0.1u |
| 0xadfb6cba… | 123 (35%) | 60-63 | −8.6u |
| 0x6d3c5bd1… | 101 (29%) | 42-59 | −15.2u |

Present on a third of all tennis markets with coin-flip records — the
signature of resting inventory / market-making, not betting. **This is a
candidate mechanism for the 68-68**: tennis books are thin (sharp-side
top-holder money median ≈ $6k vs ≈ $16.5k MLB), so omnipresent
liquidity wallets crowd the top-20 that the MLB-bred signal scores as
"smart money holding". The signal read plumbing, not opinion. (MLB's
snapshot shape is otherwise similar: median 10 holders both, top-1 share
0.39–0.43 tennis vs 0.48 MLB.)

## Finding 3 — Selective recurring wallets with strong records exist, and prove nothing yet

Among 136 recurring wallets, e.g.: 0xfe787d2d… 37-26 (+14.8u, avg
position $3.7k, platform all-time PnL $2.2M), 0xcf7379b4… 53-41
(+12.9u), 0x2d6ac4f7… 41-36 (+11.6u). Under 136 correlated coin-flips
(wallets share markets; row-ROI is measured at our sharp-side price, not
the wallet's entry) extremes of this size are expected by chance. These
records are **selection-period data, not evidence** — the twice-made
gates_json mistake applies to wallets exactly as it did to gates.

## Context (diagnostic only)

Deduped top-holder-backed sides: ATP 107-114 (+1.5u), WTA 54-74
(−28.4u) — consistent with the 2026-08-31 verdict read (ATP coin flip,
WTA inverted).

## Proposed R3 shape (for the addendum — NOT active)

1. **Liquidity filter**: exclude wallets whose market-presence rate
   exceeds a threshold (e.g. on >20% of concurrent tennis markets) from
   "smart money" scoring — presence is plumbing, not conviction. This
   filter idea is likely portable to every thin-book sport.
2. **Prospective cohort design**: freeze a followed-wallet cohort
   selected ONLY from data through 2026-09-01 (this study's window),
   pre-register selection criteria in the addendum, then evaluate the
   cohort's forward record on rows created AFTER the addendum date.
   Selection-period performance is never counted.
3. **Coordination**: hold the addendum until the wallet-sport
   specialization confirmatory read (~mid-Oct, ≥600 wallets,
   wallet-clustered) — it tests the same premise with proper power and
   its artifact lessons (slate co-movement) transfer.

Artifacts: analysis script + snapshots in session scratchpad
(`tennis1b/`); raw data remains queryable in `shadow_candidates`.
