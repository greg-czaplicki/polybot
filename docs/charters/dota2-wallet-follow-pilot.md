# Charter — Dota 2 match-winner wallet FOLLOW pilot (`dota2_wallet_follow`, era v26)

Written 2026-10-23, before deploy and before any live row. Rule is code:
`src/lib/dota2-wallet-follow-lane.ts` + `research/sharp/esports_follow_live.py` (VPS, every
10 min) + `research/sharp/wallet_records.py` (desktop, daily, `wallet-daily.sh dota2`).
Owner 2026-10-23: "Yes do it" (option 1: $4 pilot in the existing bot window).
Audit: docs/audits/2026-10-21-dota2-wallet-backtest.md.

## evidence (POST-HOC — the pre-registered read passed 0/15)
Sharp ∪ team-specialist follow, one bet per match, entered at the first fill in the bot
window [max(trigger + 60 s, start − 180 min), start − 60 min): since the 2026-05-06 split
159-83 +10.7 % z 1.7 (n 242, every month May–Oct ≥ 0 except Jun −0 %); full year +4.0 % z 0.8
(n 422; Jan–Apr warm-up negative). Entered right after the trigger it is +16.8 % z 2.9 since
May — the bot window loses part of the edge (per-lane entry windows = a possible later change).

## rule (the contract)
- Records (point-in-time, full maker+taker tape, fills ≥ $50, pregame positions in every
  Dota 2 market, stake ≥ $50, settled at start + 4 h): SHARP = ≥ 30 settled positions at
  ROI ≥ +10 %; TEAM = ≥ 10 settled positions in markets naming one of the match's teams at
  ROI ≥ +15 %.
- Trigger = a wallet's first pregame BUY fill ≥ $100 on a token within 24 h of start,
  qualified with records as of that fill.
- SHARP triggers on exactly one side → follow it; else TEAM triggers on exactly one side →
  follow it; otherwise no bet. Bet label = outcome index (A = first outcome = sideA).
- Execution: in-window Dota 2 match winner (BOn), side price in [0.05, 0.95), $4, one bet per
  match, ≤ 5 open, kill −$40 realized or trailing-100 clustered z < −1 after 30 settled, stake
  ladder. Forward start 2026-10-23T12:00Z. Gamma series 10309.

## read
Forward rows `lane = 'dota2_wallet_follow'`; first look n ≥ 50 (~2 months); promotion beyond
the ladder needs n ≥ 100 and z ≥ 2 forward. Kill per sweep.
