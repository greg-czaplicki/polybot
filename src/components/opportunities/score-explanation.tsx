// ---------------------------------------------------------------------------
// Score Explanation — expandable breakdown of a single opportunity's score
// ---------------------------------------------------------------------------

import type { ScoringFactor } from "../../server/repositories/opportunity-ranking";

/** Color class based on factor contribution direction. */
function factorColor(points: number): string {
	if (points > 0) return "text-emerald-300";
	if (points < 0) return "text-red-300";
	return "text-slate-400";
}

/** Format signed points (e.g., +12, -5). */
function formatPoints(points: number): string {
	if (Number.isInteger(points)) {
		return points >= 0 ? `+${points}` : `${points}`;
	}
	return points >= 0 ? `+${points.toFixed(1)}` : `${points.toFixed(1)}`;
}

function FactorList({
	title,
	titleColor,
	factors,
}: {
	title: string;
	titleColor: string;
	factors: ScoringFactor[];
}) {
	if (factors.length === 0) return null;
	return (
		<div>
			<div
				className={`mb-1 text-[0.6rem] font-semibold uppercase tracking-[0.15em] ${titleColor}`}
			>
				{title}
			</div>
			{factors.map((f) => (
				<div
					key={`${f.name}-${f.label}`}
					className="flex items-center justify-between py-0.5 text-[0.65rem]"
				>
					<span className="text-slate-300">
						{f.label}
						{f.detail && (
							<span className="ml-1 text-slate-500">({f.detail})</span>
						)}
					</span>
					<span className={`font-mono font-semibold ${factorColor(f.points)}`}>
						{formatPoints(f.points)}
					</span>
				</div>
			))}
		</div>
	);
}

export function ScoreExplanation({
	factors,
	warnings,
	totalScore,
	rawScore,
}: {
	factors: ScoringFactor[];
	warnings: string[];
	totalScore: number;
	rawScore?: number;
}) {
	const positives = factors.filter((f) => f.points > 0);
	const negatives = factors.filter((f) => f.points < 0);
	const neutrals = factors.filter((f) => f.points === 0);

	return (
		<div className="space-y-3 rounded-lg border border-slate-700/60 bg-slate-900/80 p-3">
			{/* Score summary */}
			{rawScore != null && (
				<div className="text-[0.65rem] text-slate-400">
					Raw score: {rawScore} → normalized: {totalScore}/100
				</div>
			)}

			<FactorList
				title="Positive Factors"
				titleColor="text-emerald-400/70"
				factors={positives}
			/>
			<FactorList
				title="Negative Factors"
				titleColor="text-red-400/70"
				factors={negatives}
			/>
			<FactorList
				title="Neutral"
				titleColor="text-slate-500"
				factors={neutrals}
			/>

			{/* Warnings */}
			{warnings.length > 0 && (
				<div className="border-t border-slate-700/40 pt-2">
					<div className="mb-1 text-[0.6rem] font-semibold uppercase tracking-[0.15em] text-amber-400/70">
						Warnings
					</div>
					{warnings.map((w) => (
						<div key={w} className="py-0.5 text-[0.65rem] text-amber-300/80">
							{w}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
