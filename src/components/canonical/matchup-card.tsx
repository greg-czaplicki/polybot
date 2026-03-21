import { useCallback, useState } from "react";

import { getMatchupComparisonFn } from "../../server/api/canonical-analytics";
import type {
	MatchupComparison,
	MatchupSplitComparison,
} from "../../server/domain/matchup-comparison";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const METRIC_LABELS: Record<string, string> = {
	su: "SU",
	ats: "ATS",
	ou: "O/U",
};

// ---------------------------------------------------------------------------
// SplitComparisonRow
// ---------------------------------------------------------------------------

function SplitComparisonRow({ split }: { split: MatchupSplitComparison }) {
	return (
		<div className="space-y-1.5">
			<div className="flex items-center gap-2 text-[0.6rem] uppercase tracking-[0.15em] text-slate-500">
				<span>{split.teamSplit.label}</span>
				<span className="text-slate-700">vs</span>
				<span>{split.opponentSplit.label}</span>
			</div>
			<div className="grid grid-cols-3 gap-2">
				{split.metrics.map((m) => (
					<div
						key={m.metric}
						className="rounded-lg border border-slate-800/50 bg-slate-950/30 px-2 py-1.5"
					>
						<div className="mb-1 text-[0.55rem] font-semibold uppercase tracking-[0.15em] text-slate-500">
							{METRIC_LABELS[m.metric]}
						</div>
						<div className="flex items-center justify-between gap-1">
							<div className="text-[0.65rem]">
								<span
									className={
										m.edge === "team"
											? "font-semibold text-cyan-300"
											: "text-slate-300"
									}
								>
									{m.team.record}
								</span>
								{m.team.streak && (
									<span className="ml-1 text-slate-500">{m.team.streak}</span>
								)}
							</div>
							<span className="text-[0.55rem] text-slate-600">vs</span>
							<div className="text-[0.65rem]">
								<span
									className={
										m.edge === "opponent"
											? "font-semibold text-amber-300"
											: "text-slate-300"
									}
								>
									{m.opponent.record}
								</span>
								{m.opponent.streak && (
									<span className="ml-1 text-slate-500">
										{m.opponent.streak}
									</span>
								)}
							</div>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// MatchupCard — interactive matchup comparison lookup
// ---------------------------------------------------------------------------

export function MatchupCard() {
	const [teamName, setTeamName] = useState("");
	const [opponentName, setOpponentName] = useState("");
	const [sportTag, setSportTag] = useState("ncaab");
	const [comparison, setComparison] = useState<MatchupComparison | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const lookup = useCallback(async () => {
		const team = teamName.trim();
		const opp = opponentName.trim();
		if (!team || !opp) return;
		setLoading(true);
		setError(null);
		try {
			const res = await getMatchupComparisonFn({
				data: { teamAlias: team, opponentAlias: opp, sportTag },
			});
			if (res.error) {
				setError(res.error);
				setComparison(null);
			} else {
				setComparison(res.comparison ?? null);
				if (!res.comparison) setError("No comparison data found");
			}
		} catch {
			setError("Failed to load matchup data");
			setComparison(null);
		} finally {
			setLoading(false);
		}
	}, [teamName, opponentName, sportTag]);

	return (
		<div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
			<div className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
				Matchup Comparison
			</div>

			{/* Search controls */}
			<div className="mb-3 flex flex-wrap items-center gap-2">
				<input
					type="text"
					value={teamName}
					onChange={(e) => setTeamName(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && lookup()}
					placeholder="Team..."
					className="w-28 rounded-lg border border-slate-700/60 bg-slate-950/60 px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 outline-none focus:border-cyan-500/50"
				/>
				<span className="text-[0.6rem] text-slate-600">vs</span>
				<input
					type="text"
					value={opponentName}
					onChange={(e) => setOpponentName(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && lookup()}
					placeholder="Opponent..."
					className="w-28 rounded-lg border border-slate-700/60 bg-slate-950/60 px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 outline-none focus:border-cyan-500/50"
				/>
				<select
					value={sportTag}
					onChange={(e) => setSportTag(e.target.value)}
					className="rounded-lg border border-slate-700/60 bg-slate-950/60 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-cyan-500/50"
				>
					<option value="ncaab">NCAAB</option>
					<option value="ncaaf">NCAAF</option>
					<option value="nba">NBA</option>
					<option value="nfl">NFL</option>
					<option value="mlb">MLB</option>
					<option value="nhl">NHL</option>
				</select>
				<button
					type="button"
					onClick={lookup}
					disabled={loading || !teamName.trim() || !opponentName.trim()}
					className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-[0.6rem] font-semibold uppercase tracking-[0.2em] text-cyan-200 transition-colors hover:bg-cyan-500/20 disabled:opacity-50"
				>
					{loading ? "..." : "Compare"}
				</button>
			</div>

			{/* Results */}
			{error && <div className="text-[0.65rem] text-red-400">{error}</div>}
			{!error && !comparison && !loading && (
				<div className="text-[0.65rem] text-slate-500">
					Enter two teams and a sport to compare trends.
				</div>
			)}
			{comparison && (
				<div>
					<div className="mb-3 text-sm font-semibold text-slate-100">
						{comparison.headline}
					</div>
					<div className="space-y-3">
						{comparison.splits.map((split) => (
							<SplitComparisonRow
								key={`${split.teamSplit.snapshotType}-${split.opponentSplit.snapshotType}`}
								split={split}
							/>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Compact inline matchup used by pick-context-panel
// ---------------------------------------------------------------------------

export function InlineMatchupComparison({
	comparison,
}: {
	comparison: MatchupComparison;
}) {
	const overall = comparison.splits.find(
		(s) => s.teamSplit.snapshotType === "overall",
	);
	if (!overall) return null;

	return (
		<div className="space-y-1">
			<div className="text-[0.6rem] font-semibold uppercase tracking-[0.15em] text-slate-500">
				{comparison.team.name} vs {comparison.opponent.name}
			</div>
			<div className="flex flex-wrap gap-3 text-[0.65rem]">
				{overall.metrics.map((m) => (
					<span key={m.metric} className="text-slate-400">
						<span className="text-slate-500">{METRIC_LABELS[m.metric]}</span>{" "}
						<span
							className={m.edge === "team" ? "text-cyan-300" : "text-slate-300"}
						>
							{m.team.record}
						</span>{" "}
						<span className="text-slate-600">v</span>{" "}
						<span
							className={
								m.edge === "opponent" ? "text-amber-300" : "text-slate-300"
							}
						>
							{m.opponent.record}
						</span>
					</span>
				))}
			</div>
		</div>
	);
}
