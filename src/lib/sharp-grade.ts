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

/**
 * Score differential below 20 has historically returned -77% ROI / 11% WR
 * (n=9 settled picks, 2026-05-11 calibration). Cheap hard floor.
 */
export const MIN_SCORE_DIFFERENTIAL = 20;

/**
 * Edge rating ≥ 90 saturates and inverts: -16% ROI / 40% WR (n=15) while the
 * 80-90 band returns +25% ROI / 63% WR. Treat as an overconfidence cliff.
 */
export const EDGE_RATING_SATURATION_FLOOR = 90;

/**
 * Edge rating in [72, 80) is a "dead zone" between the two profitable bands:
 * 66-72 returns +4.5% ROI (n=23), 80-90 returns +25% ROI (n=49), but 72-80
 * returns -7.5% ROI (n=43). Accepted bands: [MIN_EDGE_RATING, 72) ∪ [80, SATURATION).
 */
export const EDGE_RATING_DEAD_ZONE_MIN = 72;
export const EDGE_RATING_DEAD_ZONE_MAX = 80;

/**
 * Composite signalScore saturates and inverts at ≥90. Out-of-sample
 * (2026-06-25 audit, 275 settled picks) the bands split cleanly at 90:
 *   75-80: +7.9% ROI / +3.6% CLV (n=105)
 *   80-85: -0.6% ROI / -0.2% CLV (n=42)
 *   85-90: +7.2% ROI / +3.2% CLV (n=44)
 *   90-95: -20.2% ROI / -10.7% CLV (n=28)
 *   95+:   -11.4% ROI / -5.7% CLV (n=56)
 * Everything <90 is net-positive; everything ≥90 loses with strongly negative
 * CLV in BOTH totals and moneyline. This is distinct from EDGE_RATING_SATURATION
 * (which gates the raw edge): signalScore can reach ≥90 via diff/volume/novelty
 * terms while raw edge stays <90, so the existing edge gate misses it. The
 * mechanism is consensus saturation — by the time the whale signal is maximal,
 * the market has priced it and we are last to the trade (hence the negative CLV).
 * This single gate flips the historical book from -0.76u to ~+11u.
 */
export const SIGNAL_SCORE_SATURATION_FLOOR = 90;

export function isAcceptableSignalScore(score: number): boolean {
	return score < SIGNAL_SCORE_SATURATION_FLOOR;
}

/**
 * priceEdge (fairPrice − entryPrice, the expected-value gap) is the single
 * most CLV-predictive feature we have, and unlike signalScore it is monotonic
 * AND stable month-over-month. Within the sig<90 population (2026-06-25 audit):
 *   <0.15:     -6.9 CLV / -14.2% ROI (n=43)
 *   0.15-0.25: -3.9 CLV /  -8.8% ROI (n=54)
 *   0.25-0.35: +10.1 CLV / +22.1% ROI (n=69)
 *   0.35+:     +12.9 CLV / +27.6% ROI (n=25)
 * The 0.25 break held EVERY month (Apr/May/Jun all show hi≥0.25 positive,
 * lo<0.25 negative or flat) — it did not flip the way bet_type did. The
 * <0.25 half is a net -10.8u loser; the ≥0.25 half is the +22.1u profit
 * engine. Grade should be driven by realized edge (priceEdge), not signal
 * strength; this floor is the eligibility half of that rebuild.
 */
export const MIN_PRICE_EDGE = 0.25;

export function isAcceptablePriceEdge(priceEdge: number): boolean {
	return priceEdge >= MIN_PRICE_EDGE;
}

/**
 * Minimum sharp-side entry price (era v9). fairPrice is a holder-quality
 * score RATIO, not a probability: on lopsided-price markets almost no
 * sharp capital holds the expensive side (single-digit max payoff), so
 * the cheap side's quality share → ~1 and fair/priceEdge/scoreDiff/grade
 * all inflate together — phantom edges ("fair 0.97" on Under 0.5 goals
 * at 9¢), surfaced by the EPL restart's alt lines. Shadow truth
 * (2026-08-24, all settled rows): price <0.15 went 2-58 while the model
 * claimed avg pe 0.63; 0.15–0.25 went 4-32; every profitable segment
 * lives in [0.25, 0.75]. The expensive side cannot generate phantom
 * positive pe (its fair share deflates), so a floor alone closes the
 * mechanism. No live pick was ever priced below 0.25 — prospective only.
 */
export const MIN_ENTRY_PRICE = 0.25;

export function isAcceptableEntryPrice(price: number): boolean {
	return price >= MIN_ENTRY_PRICE;
}

export function isAcceptableEdgeRating(rating: number): boolean {
	if (rating < MIN_EDGE_RATING) return false;
	if (rating >= EDGE_RATING_SATURATION_FLOOR) return false;
	if (rating >= EDGE_RATING_DEAD_ZONE_MIN && rating < EDGE_RATING_DEAD_ZONE_MAX)
		return false;
	return true;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/**
 * Component breakdown of the composite signal score. Persisted per pick and
 * shadow row (2026-08-04 deep-dive follow-up) so the blend weights can be
 * recalibrated against outcomes later — the blended total alone can't be
 * decomposed after the fact.
 */
export interface SignalScoreBreakdown {
	total: number;
	/** True when history had <2 snapshots and the degenerate blend was used. */
	degenerate: boolean;
	edgeScore: number;
	diffScore: number;
	trendScore: number;
	diffTrendScore: number;
	volumeScore: number;
	noveltyScore: number;
	snapshotCount: number;
	stabilityCount: number;
}

export function computeSignalScoreBreakdownFromHistory(
	entry: SharpSignalEntry,
	history: SharpSignalHistoryEntry[] | undefined,
	minEdgeRating: number = MIN_EDGE_RATING,
): SignalScoreBreakdown {
	const edgeScore = clamp(entry.edgeRating, EDGE_RATING_MIN, EDGE_RATING_MAX);
	const diffScore =
		(clamp(entry.scoreDifferential ?? 0, SCORE_DIFF_MIN, SCORE_DIFF_MAX) /
			SCORE_DIFF_MAX) *
		100;

	if (!history || history.length < 2) {
		return {
			total: clamp(edgeScore * 0.75 + diffScore * 0.25, 0, 100),
			degenerate: true,
			edgeScore,
			diffScore,
			trendScore: 0,
			diffTrendScore: 0,
			volumeScore: 0,
			noveltyScore: 0,
			snapshotCount: history?.length ?? 0,
			stabilityCount: 0,
		};
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
	const noveltyScore = computeNoveltyScore(stabilityCount);

	const total =
		edgeScore * 0.7 +
		diffScore * 0.2 +
		trendScore +
		diffTrendScore +
		volumeScore +
		noveltyScore;

	return {
		total: clamp(total, 0, 100),
		degenerate: false,
		edgeScore,
		diffScore,
		trendScore,
		diffTrendScore,
		volumeScore,
		noveltyScore,
		snapshotCount: history.length,
		stabilityCount,
	};
}

export function computeSignalScoreFromHistory(
	entry: SharpSignalEntry,
	history: SharpSignalHistoryEntry[] | undefined,
	minEdgeRating: number = MIN_EDGE_RATING,
): number {
	return computeSignalScoreBreakdownFromHistory(entry, history, minEdgeRating)
		.total;
}

/**
 * Rewards signals that have just confirmed (1-3 stable snapshots) and
 * penalizes signals that have been stable for 5+ snapshots — by which point
 * the market has typically adjusted and the whale edge is priced in. Replaces
 * the old stabilityScore (+0 to +10), which reliably pushed stale high-edge
 * picks into the saturated 95-100 band. Historical data: picks with
 * signal_score ≥ 95 had avg ROI -12%; picks with 75-80 had avg ROI +34%.
 */
function computeNoveltyScore(stabilityCount: number): number {
	if (stabilityCount === 0) return 0;
	if (stabilityCount === 1) return 4;
	if (stabilityCount === 2) return 6;
	if (stabilityCount === 3) return 3;
	if (stabilityCount === 4) return 0;
	if (stabilityCount === 5) return -3;
	return -5;
}

export function computeSignalScoreFromWindow(
	snapshot: SharpSignalHistoryEntry,
	window: SharpSignalHistoryEntry[],
	minEdgeRating: number = MIN_EDGE_RATING,
): number {
	const edgeScore = clamp(
		snapshot.edgeRating,
		EDGE_RATING_MIN,
		EDGE_RATING_MAX,
	);
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
	const noveltyScore = computeNoveltyScore(stabilityCount);
	const total =
		edgeScore * 0.7 +
		diffScore * 0.2 +
		trendScore +
		diffTrendScore +
		volumeScore +
		noveltyScore;
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

/**
 * Full gate-vector evaluation for shadow-book rows (2026-08-06).
 *
 * The bot's gate chain early-returns on the first failing gate, so a shadow
 * row's reject_reason alone cannot say whether the candidate would have
 * passed the OTHER gates — which is what "what did this gate cost us" needs:
 * a candidate rejected by two gates is not admitted by loosening one. This
 * evaluates every global calibration gate independently from recorded
 * values; `pass: null` means the input was unavailable at record time, NOT
 * a pass. Policy-segment gates (per-segment min grade, microstructure
 * threshold) are not reproducible here; grade is checked against the BASE
 * min grade and named grade_vs_base to make the approximation explicit.
 */
export interface GateCheck {
	value: number | string | null;
	pass: boolean | null;
}

export interface GateVector {
	price_edge: GateCheck;
	edge_rating: GateCheck;
	signal_score: GateCheck;
	score_differential: GateCheck;
	grade_vs_base: GateCheck & { threshold: string | null };
}

const GRADE_LABELS: ReadonlySet<string> = new Set(["A+", "A", "B", "C", "D"]);

export function computeGateVector(input: {
	priceEdge?: number | null;
	edgeRating?: number | null;
	signalScore?: number | null;
	scoreDifferential?: number | null;
	grade?: string | null;
	baseMinGrade?: string | null;
}): GateVector {
	const check = (
		value: number | null | undefined,
		predicate: (v: number) => boolean,
	): GateCheck =>
		typeof value === "number" && Number.isFinite(value)
			? { value, pass: predicate(value) }
			: { value: null, pass: null };
	const gradeKnown =
		typeof input.grade === "string" && GRADE_LABELS.has(input.grade);
	const baseKnown =
		typeof input.baseMinGrade === "string" &&
		GRADE_LABELS.has(input.baseMinGrade);
	return {
		price_edge: check(input.priceEdge, isAcceptablePriceEdge),
		edge_rating: check(input.edgeRating, isAcceptableEdgeRating),
		signal_score: check(input.signalScore, isAcceptableSignalScore),
		score_differential: check(
			input.scoreDifferential,
			(v) => v >= MIN_SCORE_DIFFERENTIAL,
		),
		grade_vs_base: {
			value: gradeKnown ? (input.grade as string) : null,
			threshold: baseKnown ? (input.baseMinGrade as string) : null,
			pass:
				gradeKnown && baseKnown
					? gradeWeight(input.grade as GradeLabel) >=
						gradeWeight(input.baseMinGrade as GradeLabel)
					: null,
		},
	};
}
