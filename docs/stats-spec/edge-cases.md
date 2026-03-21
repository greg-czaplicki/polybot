# Edge Cases — Canonical Stats Spec v1

> Rules for every ambiguous scenario. If a case isn't listed here, it's a bug in
> the spec. File an issue.

---

## 1. Neutral Sites

**Definition:** A game played at neither team's home venue (e.g., Super Bowl,
March Madness, international friendlies, bowl games).

| Rule | Behavior |
|------|----------|
| Detection | Market title/slug contains neutral-site indicators: "Super Bowl", "Final Four", "bowl game", "neutral", or the event is a known neutral-site event |
| Home/Away assignment | `position = null` — neither side is tagged home or away |
| Favorite/Dog | Still computed from `fairPrice` (price-based, not venue-based) |
| Aggregation | Neutral-site picks are **excluded** from home/away breakdowns but **included** in overall SU/ATS/OU records |
| Fallback | If detection is uncertain, default to `position = null` rather than guessing |

---

## 2. Pick'em (Even Money)

**Definition:** A market where neither side has a meaningful edge — fairPrice is
near 0.50 for both sides.

| Rule | Behavior |
|------|----------|
| Threshold | `abs(fairPrice - 0.50) < 0.005` (within 0.5¢ of even) |
| Favorite/Dog | `role = null`, `pick_em = true` |
| ATS grading | Still applies — entry price vs fair price still produces cover/no_cover |
| Aggregation | Pick'em games are **excluded** from favorite/dog breakdowns but **included** in overall records |
| Display | Show as "PK" in line displays instead of a spread number |

---

## 3. Missing Closing Line

**Scenario:** No sharp money history snapshots exist near market close, or the
market resolved without price movement data.

| Rule | Behavior |
|------|----------|
| CLV | `clv = null`, `clv_bps = null` |
| Closing line | `closing_line = null` |
| Aggregation | Pick is **excluded** from CLV averages (`COUNT(clv IS NOT NULL)`) |
| SU/ATS/ROI | Unaffected — these don't depend on closing line |
| Display | Show "—" for CLV column |

**Recovery:** If closing line data becomes available later (e.g., backfill from
history), CLV should be recomputed on the next settlement sweep.

---

## 4. Missing Opening Line

**Scenario:** No early snapshots exist for this market — pick was made before
any history was recorded, or history was not captured.

| Rule | Behavior |
|------|----------|
| Opening line | `opening_line = null` |
| Line movement | Cannot compute `line_movement = closing_line - opening_line` |
| Display | Show "—" for opening line column |
| Impact | No effect on grading or other metrics |

---

## 5. Cancelled / Invalid Markets

**Scenario:** Market is cancelled, invalidated, or resolved as "N/A" by the UMA
oracle. This includes disputed markets and markets that violate Polymarket rules.

| Rule | Behavior |
|------|----------|
| Detection | `resolution` contains "cancel" or "invalid", OR `umaResolutionStatus` contains "cancel" or "invalid" |
| Status | `status = "push"` |
| ROI | `roi = 0` (no gain, no loss — stake returned) |
| CLV | `clv = null` (no meaningful close price) |
| SU record | Counted in `pushes`, **excluded** from wins and losses |
| Win rate | **Excluded** from denominator (`wins + losses` only) |
| ATS | `ats_result = null` — not graded |
| Streaks | **Skipped** — does not break or extend any streak |
| Display | Show "P" or "Push" in result column |

---

## 6. Overtime / Extra Time

**Scenario:** Game goes to overtime (NFL, NBA, NHL), extra innings (MLB), or
extra time/penalties (soccer).

| Rule | Behavior |
|------|----------|
| SU grading | **Includes overtime.** Final result after all periods counts. |
| ATS grading | **Includes overtime.** The market resolves to a final winner regardless of regulation/OT. |
| OU grading | **Includes overtime.** Total points/goals include OT scoring. |
| Rationale | Polymarket binary markets resolve on the actual final outcome, not regulation time. There is no "regulation only" variant in Polymarket. |
| Edge case | If a market explicitly specifies "regulation" in its title, grade against regulation result only. Detection: title contains "regulation" or "reg time". |

---

## 7. Alternate Spreads / Totals

**Scenario:** Market offers a non-standard line (e.g., "Will Team X win by 7+?"
instead of the consensus spread).

| Rule | Behavior |
|------|----------|
| Detection | `betType = "spread"` or `betType = "total"` with a non-standard line embedded in the title |
| Grading | Grade against the **market's own line**, not any external consensus line |
| ATS | Still computed — fair price reflects the alternate line's implied probability |
| Aggregation | Included in overall ATS/OU records (the fair price already accounts for the alternate line) |
| Display | Show the specific line from the market title if parseable |

**Rationale:** On Polymarket, every market is self-contained. The "spread" IS the
market's binary question. There's no separate consensus line to compare against.

---

## 8. Missing Entry Price

**Scenario:** A pick was logged without a recorded entry price (e.g., manual
tracking before execution, or a signal-only pick not actually traded).

| Rule | Behavior |
|------|----------|
| ROI | `roi = null` |
| CLV | `clv = null` (requires entry price for the delta) |
| Cover margin | `cover_margin = null` |
| ATS | `ats_result = null` (requires entry price vs fair price comparison) |
| SU | **Still graded** — win/loss only requires resolved side vs picked side |
| Streaks | **Still counted** — streaks use SU result, not price data |

---

## 9. Missing Fair Price

**Scenario:** Sharp signal model did not produce a fair price for this market
(e.g., insufficient data, new market type, model failure).

| Rule | Behavior |
|------|----------|
| ATS | `ats_result = null` — cannot grade without fair price |
| Cover margin | `cover_margin = null` |
| Favorite/Dog | `role = null` — cannot determine without fair price |
| SU/ROI/CLV | **Unaffected** — these don't require fair price |
| Aggregation | Excluded from ATS and favorite/dog breakdowns |

---

## 10. Duplicate / Re-picked Markets

**Scenario:** Same condition_id is picked more than once (e.g., averaging into
a position, or re-entering after a partial exit).

| Rule | Behavior |
|------|----------|
| Storage | Each pick is stored as a separate row with its own `id` |
| Grading | Each pick is graded independently against its own entry price |
| Aggregation | All picks count separately in records and averages |
| Streaks | Each pick is a separate event in the streak sequence |
| Display | Show all picks; optionally group by condition_id in detailed views |

---

## 11. Side A/B Ambiguity

**Scenario:** It's unclear which side (A or B) the pick corresponds to, or
`sharpSide` is not "A" or "B".

| Rule | Behavior |
|------|----------|
| Detection | `sharpSide` is null, empty, or not in `{"A", "B"}` |
| Resolution | Pick **cannot be graded** — return `null` for all resolution fields |
| Status | Remains `"pending"` even if market has resolved |
| Display | Flag as "unresolvable" in admin views |

---

## 12. Extremely Low/High Entry Prices

**Scenario:** Entry price is near 0 or near 1 (e.g., 0.01 or 0.99), creating
extreme ROI values.

| Rule | Behavior |
|------|----------|
| ROI cap | No artificial cap — report actual ROI. Entry at 0.01, win = +9900% ROI. |
| CLV | Computed normally — small absolute CLV can still be meaningful at extremes |
| Aggregation | Use **median ROI** alongside mean for summary stats when extreme outliers exist |
| Display | Consider separate display for picks with entry price < 0.10 or > 0.90 |
| Signal quality | These picks typically have low `edge_rating` (strong consensus = low edge), so grade filtering naturally de-emphasizes them |

---

## 13. Market Resolved but Resolution Data Incomplete

**Scenario:** Market shows `resolved = true` but `resolution` is null and outcome
prices don't clearly indicate a winner.

| Rule | Behavior |
|------|----------|
| Fallback chain | 1. Check `resolution` (number or string) → 2. Check `outcomePrices` (≥0.98/≤0.02 threshold) → 3. Check `umaResolutionStatus` for cancel/invalid |
| If all fail | Pick remains `"pending"` — do not guess the outcome |
| Retry | Re-check on next settlement sweep (resolution data may arrive late) |
| Staleness | If pending > 7 days after `resolved = true`, flag for manual review |

---

## 14. Multiple Sports Tags

**Scenario:** A market could match multiple sport tags (e.g., "Giants" appears
in both NFL and MLB keyword lists).

| Rule | Behavior |
|------|----------|
| Priority | Slug markers take priority over title keywords (more specific) |
| First match | `detectSportTag` returns the first matching tag from the ordered definitions list |
| Override | If misclassified, manual `sportTag` override on the pick takes precedence |
| Aggregation | Each pick belongs to exactly one sport tag for breakdown purposes |

---

## 15. Time Zone and Timestamp Edge Cases

| Scenario | Rule |
|----------|------|
| `picked_at` is in the future | Reject — likely clock skew. Use server time. |
| `event_time` is null | Exclude from time-to-start buckets; include in all other metrics |
| `settled_at < picked_at` | Flag as anomalous but still grade normally (settlement data may backfill) |
| Timestamps are in seconds vs milliseconds | All internal timestamps use **Unix seconds**. Validate on ingestion. |
