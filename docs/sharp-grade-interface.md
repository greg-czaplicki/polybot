# Shared Grading Module Interface (Draft)

Owner: TBD
Date: 2026-01-30
Status: Draft

## Purpose
Define a shared grading module used by both UI and server to compute signal score and grades from sharp money data and history.

## File Location (Proposed)
- `src/lib/sharp-grade.ts`

## Types (Draft)

```ts
export type SharpSide = "A" | "B" | "EVEN";

export type SharpMoneySnapshot = {
	conditionId: string;
	recordedAt: number;
	eventTime?: string;
	sharpSide: SharpSide;
	edgeRating: number;
	scoreDifferential: number;
	sideA: { totalValue: number };
	sideB: { totalValue: number };
};

export type GradeLabel = "A+" | "A" | "B" | "C" | "D";

export type GradeInputs = {
	edgeRating: number;
	scoreDifferential: number;
	signalScore: number;
};

export type GradeFloors = {
	minEdgeRating: number;
	aPlusMinEdgeRating: number;
	aPlusMinScoreDifferential: number;
	aMinEdgeRating: number;
	aMinScoreDifferential: number;
};

export type SignalScoreOptions = {
	minEdgeRating: number; // for stability scoring
};

export type GradeResult = {
	grade: GradeLabel;
	signalScore: number;
};

export type CompositeScoreResult = {
	grade: GradeLabel;
	signalScore: number;
	compositeScore: number; // gradeWeight + signalScore (display/sort only)
};
```

## Constants (Draft)

```ts
export const DEFAULT_GRADE_FLOORS: GradeFloors = {
	minEdgeRating: 66,
	aPlusMinEdgeRating: 80,
	aPlusMinScoreDifferential: 30,
	aMinEdgeRating: 72,
	aMinScoreDifferential: 20,
};
```

## Functions (Draft Signatures)

```ts
export function computeSignalScoreFromHistory(
	entry: {
		edgeRating: number;
		scoreDifferential?: number | null;
	},
	history: SharpMoneySnapshot[] | undefined,
	options?: SignalScoreOptions,
): number;

export function signalScoreToGradeLabel(
	inputs: GradeInputs,
	floors?: GradeFloors,
): GradeLabel;

export function gradeWeight(grade: GradeLabel): number;

export function computeCompositeScore(
	inputs: GradeInputs,
	floors?: GradeFloors,
): CompositeScoreResult;
```

## Notes
- `signalScore` is the authoritative score for grading (0-100).
- `compositeScore` exists for display/sorting only; it is not used to determine grade.
- The server should call these functions when serving bulk grading responses.
- The UI should only consume results from the server (Phase 4 of roadmap).

