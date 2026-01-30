export type GradeLabel = "A+" | "A" | "B" | "C" | "D";

export type SharpSignalEntry = {
	edgeRating: number;
	scoreDifferential?: number | null;
};

export type SharpSignalHistoryEntry = {
	edgeRating: number;
	scoreDifferential: number;
	sideA: { totalValue: number };
	sideB: { totalValue: number };
};

const EDGE_RATING_MIN = 0;
const EDGE_RATING_MAX = 100;
const SCORE_DIFF_MIN = 0;
const SCORE_DIFF_MAX = 60;
const TREND_MIN = -20;
const TREND_MAX = 20;
const VOLUME_DELTA_MIN = -50_000;
const VOLUME_DELTA_MAX = 150_000;

export const MIN_EDGE_RATING = 66;
export const A_PLUS_EDGE_FLOOR = 80;
export const A_PLUS_DIFF_FLOOR = 30;
export const A_EDGE_FLOOR = 72;
export const A_DIFF_FLOOR = 20;

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export function computeSignalScoreFromHistory(
	entry: SharpSignalEntry,
	history: SharpSignalHistoryEntry[] | undefined,
	minEdgeRating: number = MIN_EDGE_RATING,
): number {
	const edgeScore = clamp(entry.edgeRating, EDGE_RATING_MIN, EDGE_RATING_MAX);
	const diffScore =
		(clamp(entry.scoreDifferential ?? 0, SCORE_DIFF_MIN, SCORE_DIFF_MAX) /
			SCORE_DIFF_MAX) *
		100;

	if (!history || history.length < 2) {
		return clamp(edgeScore * 0.75 + diffScore * 0.25, 0, 100);
	}

	const start = history[0];
	const end = history[history.length - 1];
	const startVolume = start.sideA.totalValue + start.sideB.totalValue;
	const endVolume = end.sideA.totalValue + end.sideB.totalValue;
	const edgeDelta = end.edgeRating - start.edgeRating;
	const diffDelta = end.scoreDifferential - start.scoreDifferential;
	const volumeDelta = endVolume - startVolume;

	let stabilityCount = 0;
	for (let i = history.length - 1; i >= 0; i -= 1) {
		if (history[i].edgeRating < minEdgeRating) break;
		stabilityCount += 1;
	}

	const trendScore = clamp(edgeDelta, TREND_MIN, TREND_MAX) * 1.0;
	const diffTrendScore = clamp(diffDelta, TREND_MIN, TREND_MAX) * 0.5;
	const volumeScore =
		(clamp(volumeDelta, VOLUME_DELTA_MIN, VOLUME_DELTA_MAX) /
			VOLUME_DELTA_MAX) *
		15;
	const stabilityScore = Math.min(stabilityCount, 5) * 2;

	const total =
		edgeScore * 0.7 +
		diffScore * 0.2 +
		trendScore +
		diffTrendScore +
		volumeScore +
		stabilityScore;

	return clamp(total, 0, 100);
}

export function computeSignalScoreFromWindow(
	snapshot: SharpSignalHistoryEntry,
	window: SharpSignalHistoryEntry[],
	minEdgeRating: number = MIN_EDGE_RATING,
): number {
	const edgeScore = clamp(snapshot.edgeRating, EDGE_RATING_MIN, EDGE_RATING_MAX);
	const diffScore =
		(clamp(snapshot.scoreDifferential ?? 0, SCORE_DIFF_MIN, SCORE_DIFF_MAX) /
			SCORE_DIFF_MAX) *
		100;
	if (window.length < 2) {
		return clamp(edgeScore * 0.75 + diffScore * 0.25, 0, 100);
	}
	const start = window[0];
	const end = window[window.length - 1];
	const volumeDelta =
		end.sideA.totalValue +
		end.sideB.totalValue -
		(start.sideA.totalValue + start.sideB.totalValue);
	const edgeDelta = end.edgeRating - start.edgeRating;
	const diffDelta = end.scoreDifferential - start.scoreDifferential;
	let stabilityCount = 0;
	for (let i = window.length - 1; i >= 0; i -= 1) {
		if (window[i].edgeRating < minEdgeRating) break;
		stabilityCount += 1;
	}
	const trendScore = clamp(edgeDelta, TREND_MIN, TREND_MAX) * 1.0;
	const diffTrendScore = clamp(diffDelta, TREND_MIN, TREND_MAX) * 0.5;
	const volumeScore =
		(clamp(volumeDelta, VOLUME_DELTA_MIN, VOLUME_DELTA_MAX) /
			VOLUME_DELTA_MAX) *
		15;
	const stabilityScore = Math.min(stabilityCount, 5) * 2;
	const total =
		edgeScore * 0.7 +
		diffScore * 0.2 +
		trendScore +
		diffTrendScore +
		volumeScore +
		stabilityScore;
	return clamp(total, 0, 100);
}

export function signalScoreToGradeLabel(
	score: number,
	options?: { edgeRating?: number; scoreDifferential?: number | null },
): GradeLabel {
	const edgeRating = options?.edgeRating ?? 0;
	const scoreDifferential = options?.scoreDifferential ?? 0;
	if (score >= 92) {
		if (
			edgeRating < A_PLUS_EDGE_FLOOR ||
			scoreDifferential < A_PLUS_DIFF_FLOOR
		) {
			return "A";
		}
		return "A+";
	}
	if (score >= 85) {
		if (edgeRating < A_EDGE_FLOOR || scoreDifferential < A_DIFF_FLOOR) {
			return "B";
		}
		return "A";
	}
	if (score >= 75) return "B";
	if (score >= 65) return "C";
	return "D";
}

export function gradeWeight(grade: GradeLabel): number {
	switch (grade) {
		case "A+":
			return 100;
		case "A":
			return 80;
		case "B":
			return 60;
		case "C":
			return 40;
		default:
			return 20;
	}
}
