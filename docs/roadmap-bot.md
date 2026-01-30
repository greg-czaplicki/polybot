# Manual-First Hardening Roadmap (Bot-Ready)

Owner: TBD
Date: 2026-01-30
Status: Draft

## Goals
- Make grading a reliable, reproducible source of truth.
- Ensure data completeness and freshness for all relevant markets.
- Enable bulk grading for manual workflows (and eventual bot usage).
- Improve manual UI decision-making before automation.

## Phase 1 — Centralize Grading Logic
**Outcome:** One authoritative implementation of signal score + grade.

### Tasks
- Extract `computeSignalScoreFromHistory` and `signalScoreToGradeLabel` from `src/routes/sharp.tsx` into a shared module (e.g., `src/lib/sharp-grade.ts`).
- Include grade floors and constants in the shared module.
- Add unit tests for grade boundaries (A+/A/B/C/D) and signal score calculations.
- Update UI to import shared grading functions (no server changes yet).
- Define shared module contract in `docs/sharp-grade-interface.md`.

### Acceptance
- UI grading matches shared module output for identical inputs.
- Tests cover at least: A+ threshold, downgrade conditions, history/no-history path.

## Phase 2 — Data Completeness + Freshness
**Outcome:** Data used to grade is complete and clearly timestamped.

### Tasks
- Add `computedAt` and `historyUpdatedAt` fields to cache/history records.
- Add freshness logic (e.g., stale if history older than 10–15 minutes).
- Update pipeline to populate freshness timestamps on refresh.
- Add stale warnings in UI (visible to manual users).

### Acceptance
- Every entry has explicit freshness metadata.
- UI clearly indicates stale grades or insufficient data coverage.

## Phase 3 — Bulk Grading Endpoint
**Outcome:** Server provides authoritative bulk grading for manual workflows.

### Tasks
- Implement `POST /sharp/grades` to grade multiple condition IDs at once.
- Compute grades server-side using shared grading module + history.
- Include readiness state, warnings, and freshness metadata in response.
- Document the endpoint contract.

### Acceptance
- UI can fetch grades for multiple events in one request.
- Server response is consistent with UI display.

## Phase 4 — Manual UI Upgrades
**Outcome:** Manual decision-making uses server grades + transparency.

### Tasks
- Replace client-side signal score computation with bulk endpoint results.
- Add filters: `grade`, `isReady`, `freshness`, `start time window`.
- Add a “Why this grade?” panel (edge rating, diff, trend, warnings).

### Acceptance
- Manual view shows exactly the same grade the server would provide to a bot.

## Phase 5 — Validation Loop
**Outcome:** Evidence-based refinement before automation.

### Tasks
- Add manual pick logging with `grade`, inputs, and outcomes.
- Produce weekly summary metrics (win rate, ROI, grade distribution).
- Adjust thresholds based on real outcomes.

### Acceptance
- At least 2 weeks of logged manual picks with results.
- Documented thresholds and rationale for any changes.

---

## TODO Checklist

### Phase 1
- [ ] Create `src/lib/sharp-grade.ts` with grading + signal score logic.
- [ ] Migrate UI grading calls to shared module.
- [ ] Add unit tests for grading and score logic.

### Phase 2
- [ ] Add `computedAt` and `historyUpdatedAt` to cache/history.
- [ ] Add stale calculation and UI warning.
- [ ] Update pipeline refresh to set timestamps.

### Phase 3
- [ ] Add `POST /sharp/grades` bulk endpoint.
- [ ] Implement server-side grading using shared module + history.
- [ ] Add response types and document contract.
- [ ] Implement flow per `docs/server-grading-flow.md`.

### Phase 4
- [ ] UI uses bulk endpoint output for grading display.
- [ ] Add filters: grade, readiness, freshness, event start window.
- [ ] Add “Why this grade?” breakdown panel.

### Phase 5
- [ ] Add manual pick log model and storage.
- [ ] Add weekly performance summary.
- [ ] Adjust thresholds based on data.

---

## Bulk Grading API Contract (Draft)

**Endpoint:** `POST /sharp/grades`

**Request**
```
{
  "conditionIds": ["..."]
}
```

**Response**
```
{
  "results": [
    {
      "conditionId": "...",
      "grade": "A+",
      "signalScore": 95.2,
      "edgeRating": 88,
      "scoreDifferential": 34,
      "isReady": true,
      "warnings": ["low_conviction"],
      "computedAt": 1738200000,
      "historyUpdatedAt": 1738199400
    }
  ]
}
```

**Notes**
- `grade` is computed from `signalScore` and floors.
- `signalScore` is derived from cached history; when insufficient history, fallback uses edge + diff.
- `warnings` should include readiness or quality flags (low coverage, high concentration, no edge).
- Default request cap: 200 conditionIds.

**Error Handling**
- If `conditionIds` is empty or missing, return `400` with `{ "error": "conditionIds_required" }`.
- For unknown conditionIds, return an entry with `"error": "not_found"` and `grade: null`.
- If data is stale (history too old), return `"warnings": ["stale_data"]` and include `historyUpdatedAt`.

**Staleness Defaults**
- `historyUpdatedAt` should reflect the most recent history record timestamp.
- `computedAt` should reflect the server evaluation time.
- Default stale threshold: 15 minutes (configurable).

**Determinism**
- For a given cache entry + history window, the output should be deterministic across UI and bot.
