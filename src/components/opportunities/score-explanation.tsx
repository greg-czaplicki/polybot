// ---------------------------------------------------------------------------
// Score Explanation — expandable breakdown of a single opportunity's score
// ---------------------------------------------------------------------------

import type {
	OpportunityScore,
	ScoreFactor,
	ScoreWarning,
} from "../../server/domain/opportunity-scoring";

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
	factors: ScoreFactor[];
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
					key={`${f.category}-${f.label}`}
					className="flex items-center justify-between py-0.5 text-[0.65rem]"
				>
					<span className="text-slate-300">
						{f.label}
						{f.rawValue != null && (
							<span className="ml-1 text-slate-500">
								[
								{typeof f.rawValue === "number"
									? f.rawValue.toFixed(2)
									: f.rawValue}
								]
							</span>
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

function WarningList({ warnings }: { warnings: ScoreWarning[] }) {
	if (warnings.length === 0) return null;
	return (
		<div className="border-t border-slate-700/40 pt-2">
			<div className="mb-1 text-[0.6rem] font-semibold uppercase tracking-[0.15em] text-amber-400/70">
				Warnings
			</div>
			{warnings.map((w) => (
				<div key={w.type} className="py-0.5 text-[0.65rem] text-amber-300/80">
					{w.message}
				</div>
			))}
		</div>
	);
}

/** Data quality indicator based on snapshot availability. */
function DataQualityBadge({
	teamFound,
	opponentFound,
}: {
	teamFound: boolean;
	opponentFound: boolean;
}) {
	if (teamFound && opponentFound) {
		return (
			<span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[0.5rem] text-emerald-300">
				Full context
			</span>
		);
	}
	if (teamFound || opponentFound) {
		return (
			<span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[0.5rem] text-amber-300">
				Partial context
			</span>
		);
	}
	return (
		<span className="rounded-full border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[0.5rem] text-red-300">
			No context
		</span>
	);
}

export function ScoreExplanation({ scoring }: { scoring: OpportunityScore }) {
	const positives = scoring.factors.filter((f) => f.points > 0);
	const negatives = scoring.factors.filter((f) => f.points < 0);
	const neutrals = scoring.factors.filter((f) => f.points === 0);

	return (
		<div className="space-y-3 rounded-lg border border-slate-700/60 bg-slate-900/80 p-3">
			{/* Score summary */}
			<div className="flex items-center justify-between text-[0.65rem]">
				<span className="text-slate-400">
					Raw score: {scoring.rawScore} → normalized: {scoring.score}/100
				</span>
				<DataQualityBadge
					teamFound={scoring.features.teamSnapshotFound}
					opponentFound={scoring.features.opponentSnapshotFound}
				/>
			</div>

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
			<WarningList warnings={scoring.warnings} />
		</div>
	);
}
