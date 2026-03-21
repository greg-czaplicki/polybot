// ---------------------------------------------------------------------------
// Ranked Opportunity Table — scored upcoming opportunities with expandable
// score explanations
// ---------------------------------------------------------------------------

import { useState } from "react";
import type { RankedOpportunity } from "../../server/repositories/opportunity-ranking";
import { ScoreExplanation } from "./score-explanation";

/** Tailwind color class for opportunity score. */
function scoreColor(score: number): string {
	if (score >= 70) return "text-emerald-300";
	if (score >= 50) return "text-cyan-300";
	if (score >= 30) return "text-amber-300";
	return "text-red-300";
}

/** Score tier label for quick scanning. */
function scoreTier(score: number): string {
	if (score >= 70) return "Strong";
	if (score >= 50) return "Moderate";
	if (score >= 30) return "Weak";
	return "Avoid";
}

/** Score tier badge color. */
function tierBadgeClass(score: number): string {
	if (score >= 70)
		return "bg-emerald-500/20 text-emerald-300 border-emerald-500/30";
	if (score >= 50) return "bg-cyan-500/20 text-cyan-300 border-cyan-500/30";
	if (score >= 30) return "bg-amber-500/20 text-amber-300 border-amber-500/30";
	return "bg-red-500/20 text-red-300 border-red-500/30";
}

/** Build matchup label from team/opponent names. */
function matchupLabel(opp: RankedOpportunity): string {
	if (opp.teamName && opp.opponentName) {
		return opp.venueRole === "away"
			? `${opp.teamName} @ ${opp.opponentName}`
			: `${opp.teamName} vs ${opp.opponentName}`;
	}
	return opp.marketTitle;
}

/** Top factor summary for the row. */
function topFactorSummary(opp: RankedOpportunity): string {
	const top = opp.scoring.topPositive[0];
	return top ? top.label : "—";
}

export function RankedOpportunityTable({
	data,
	loading,
}: {
	data: RankedOpportunity[];
	loading?: boolean;
}) {
	const [expandedId, setExpandedId] = useState<string | null>(null);

	const toggleExpanded = (id: string) => {
		setExpandedId((prev) => (prev === id ? null : id));
	};

	return (
		<div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
			<div className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
				Ranked Opportunities
			</div>

			{loading && (
				<div className="py-6 text-center text-sm text-slate-500">
					Scoring opportunities...
				</div>
			)}

			{!loading && data.length === 0 && (
				<div className="py-6 text-center text-sm text-slate-500">
					No upcoming opportunities found. Pending picks with canonical context
					will appear here when available.
				</div>
			)}

			{!loading && data.length > 0 && (
				<div className="space-y-2">
					{data.map((opp) => (
						<div
							key={opp.pickId}
							className="rounded-lg border border-slate-800/60 bg-slate-900/40"
						>
							{/* Main row — clickable to expand */}
							<button
								type="button"
								onClick={() => toggleExpanded(opp.pickId)}
								className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-slate-800/30"
							>
								{/* Rank */}
								<div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-800 text-[0.6rem] font-bold text-slate-400">
									{opp.rank}
								</div>

								{/* Matchup */}
								<div className="min-w-0 flex-1">
									<div className="truncate text-[0.7rem] font-semibold text-slate-200">
										{matchupLabel(opp)}
									</div>
									<div className="flex items-center gap-2 text-[0.6rem] text-slate-500">
										{opp.sportTag && <span>{opp.sportTag.toUpperCase()}</span>}
										{opp.betType && <span>{opp.betType}</span>}
										{opp.venueRole && <span>{opp.venueRole}</span>}
										{opp.favDogRole && <span>{opp.favDogRole}</span>}
									</div>
								</div>

								{/* Top factor */}
								<div className="hidden shrink-0 text-[0.6rem] text-slate-500 sm:block">
									{topFactorSummary(opp)}
								</div>

								{/* Warnings count */}
								{opp.scoring.warnings.length > 0 && (
									<div className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[0.5rem] text-amber-400">
										{opp.scoring.warnings.length}⚠
									</div>
								)}

								{/* Score + tier */}
								<div className="shrink-0 text-right">
									<div
										className={`text-sm font-bold ${scoreColor(opp.scoring.score)}`}
									>
										{opp.scoring.score}
									</div>
									<span
										className={`inline-block rounded-full border px-1.5 py-0.5 text-[0.5rem] font-semibold uppercase tracking-[0.15em] ${tierBadgeClass(opp.scoring.score)}`}
									>
										{scoreTier(opp.scoring.score)}
									</span>
								</div>

								{/* Expand indicator */}
								<div className="shrink-0 text-[0.6rem] text-slate-600">
									{expandedId === opp.pickId ? "▼" : "▶"}
								</div>
							</button>

							{/* Expanded explanation */}
							{expandedId === opp.pickId && (
								<div className="border-t border-slate-800/40 px-3 py-2">
									<ScoreExplanation scoring={opp.scoring} />
								</div>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
