# Wallet sport-specialization — observational read (2026-08-27)

**Status: exploratory.** No scoring change. This read motivated the
pre-registered test in `docs/charters/wallet-sport-clv.md`; because this peek
happened first, the charter's confirmatory sample starts at entries observed
**after 2026-08-27**.

## Question

Wallet quality in scoring is sport-blind (global leaderboard `pnl_all` tier +
day/week momentum, `sharp-money.ts`). `wallet_entries` stamps
`sport_series_id` and a per-entry CLV, so per-wallet-per-sport records are
derivable. Do they carry signal?

## Data

- `wallet_entries` status=`closed`, clv non-null: **33,234 entries**,
  2026-08-05 → 08-25 (ledger starts at the 8/5 shares-basis wipe).
- `clv = PM close − entry price` (probability points, same side; pre-event
  entries only, ≥$100 delta, shares-based diff). No win/loss stored; no
  Pinnacle reference — PM-close CLV only.
- Deduped robustness set: first entry per (wallet, market, side) = 20,990.
- Sports: MLB 22.0k, ATP 3.6k, WTA 1.8k, NFL 1.8k, EPL 1.7k, La Liga 1.1k,
  UCL/Serie A/MLS/Ligue 1 smaller.

## Findings

1. **Specialization is common.** Of 829 wallets with ≥5 closed entries,
   296 (~36%) bet exactly one sport. The prompting example
   `0xde9f…cd43c` is a pure ATP wallet: 5 closed entries, avg CLV **+11.6pp**
   — but see finding 4.

2. **Aggregate top-20 CLV ≈ 0 everywhere.** Per-sport mean entry CLV sits in
   ±0.2pp of zero for every sport with volume (Serie A −0.74pp on n=432 is
   the largest deviation). Raw top-20 presence has no CLV edge vs the PM
   close; whatever edge the pipeline has must come from the conditioning
   (side agreement, momentum, gates), not from holders being sharp per se.

3. **The seductive artifact (twice-made-mistake class).** Point-in-time
   prior-record splits (prior entries with `settled_at < observed_at`,
   excluding the same market) look spectacular at entry level:
   prior-in-sport-CLV>0 → next-entry CLV +0.22pp vs −0.23pp for prior≤0,
   z≈+16; identical for the global prior. **Wallet-clustered, the effect
   vanishes** (prior+ wallets −0.03pp vs prior− wallets +0.07pp, z=−0.84).
   The entry-level z is co-movement: a wallet's concurrent entries share
   slates/markets that drift together, so its "prior record" and "next
   entry" are not independent draws. Deduping per market does not fix it
   (sibling markets co-move). **Any future read must be wallet-clustered.**

4. **No specialist edge detectable at this horizon.**
   - Specialist (≥90% one sport) vs generalist (<60%) wallet-level mean CLV:
     −0.00pp vs −0.14pp, z=+1.69. Suggestive direction, not significant.
   - Tennis specialists vs tennis tourists (wallet-level, deduped):
     +0.07pp vs +0.12pp, z=−0.34. The example wallet is a tail of ~800
     wallets, not evidence of a specialist class edge.

5. **The current scoring input doesn't predict entry CLV either.** Global
   `pnl_all` quartiles at wallet level are flat (Q4 −0.07pp vs Q1 −0.02pp,
   z=−0.61). (Entry-level it even looks inverted at z=−5.2 — same clustering
   artifact, quoted only as a warning exhibit.)

6. **"Top" per-sport wallets are within chance.** Best (wallet, sport) cells
   at n≥8 run +1.4 to +3.2pp avg CLV on n=8–32 — expected order statistics
   from ~800 wallets under the null.

## Verdict

Three weeks of ledger is not enough: per-sport wallet records show **no
wallet-clustered signal**, and neither does the global record or the current
pnl-tier input. Do not add sport-aware weighting now; do not fade specialists
either. Keep collecting (the ledger accrues with zero extra cost) and take
the confirmatory read under the charter (~mid-October, when NBA/NHL wallets
also start accruing in-sport histories).

Analysis scripts: session scratchpad (`analyze.py`, `analyze2.py`); queries
reproducible from `wallet_entries` + `wallet_pnl_cache`.
