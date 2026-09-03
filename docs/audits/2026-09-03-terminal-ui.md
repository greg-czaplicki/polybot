# 2026-09-03 — Terminal UI redesign

**Why.** The bot places every pick; the app's job became supervision. The
operator's first-screen questions are now *is the machine alive* and *how is
the book doing*; analyst tooling is opened rarely. A screen audit found nav
living only inside the home page, `/debug` orphaned, `/opportunities`
duplicating `/sharp`, `/runtime` a 3.9k-line single component, and ~600 of
`/shadow`'s 843 lines being explainer prose + 8–13-column raw tables under a
one-line verdict that already answered the question.

**Direction.** Bloomberg workspace for its *structure* (tiled panels, tape
density, terse title bars), not its costume. Palette and type unchanged.
Design context: `.impeccable.md`.

**Shipped (4ad7062, 59b96f8, 94c4a13 + this note).**

| Screen | Now |
|---|---|
| shell | `src/components/terminal/shell.tsx` — nav Terminal · Tape · Book · Verdicts · Bot · Research ▾, UTC clock, per-screen action slot |
| primitives | `src/components/terminal/panel.tsx` — Workspace (12-col hairline grid), Panel, Tape/Row/Cell, Num, VerdictWord, Dot |
| `/` Terminal | alive strip (bot, sync, pipeline, Pinnacle credits, bankroll, lane heartbeat, last pick) + attention line; Book windows 24h/7d/30d + OOS cohorts + CLV vs 3 books; Positions; Settled 48h; Stake ladder; Verdicts; Tape by market; P&L |
| `/shadow` Verdicts | decision line; one gates table (sole-blocker cohort only, per-market rows on click, dormant gates folded); paper lanes; props; drift + raw feed behind `<details>` |
| `/sharp` Tape | `TapeRow` table; the old card is the expanded detail row; rescan in the strip; edge stats collapsed |
| `/stats` Book | range + results bar; flattened P&L; ledger tape; by-grade |
| `/bot` | Service / Config / Logs panels |
| Research | wallets + strategy panelized; runtime sections restyled; canonical inline hex → ink tokens |
| removed | `/debug`, `/opportunities` (+ components) |

**API additions.** `getDashboardFn` now returns `windows` (24h/7d/30d real-fill
results), `tape` (per-sport 24h flow), and health fields for Pinnacle credits
/ fetch age and the paper-lane heartbeat. No picking behaviour changed; no
era bump.

**Left as-is.** `/runtime` internals (7 sections, analyst-only), `/canonical`
structure, `sharp.market.$conditionId` depth ladders. Pre-existing type
errors (80, all server-fn argument typing) untouched.
