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
			<div className="flex items-baseline gap-2 font-mono text-xxs uppercase tracking-[0.15em] text-ink-55">
				<span>{split.teamSplit.label}</span>
				<span className="text-ink-25">vs</span>
				<span>{split.opponentSplit.label}</span>
			</div>
			<div className="grid grid-cols-3 gap-2">
				{split.metrics.map((m) => (
					<div
						key={m.metric}
						className="rounded-md bg-ink-00/40 px-2 py-1.5 ring-1 ring-inset ring-ink-15"
					>
						<div className="mb-1 font-mono text-xxs font-semibold uppercase tracking-[0.15em] text-ink-55">
							{METRIC_LABELS[m.metric]}
						</div>
						<div className="flex items-baseline justify-between gap-1 font-mono text-xxs tabular-nums">
							<div>
								<span
									className={
										m.edge === "team"
											? "font-semibold text-brand-cyan"
											: "text-ink-70"
									}
								>
									{m.team.record}
								</span>
								{m.team.streak && (
									<span className="ml-1 text-ink-55">{m.team.streak}</span>
								)}
							</div>
							<span className="text-ink-40">vs</span>
							<div>
								<span
									className={
										m.edge === "opponent"
											? "font-semibold text-signal-warn"
											: "text-ink-70"
									}
								>
									{m.opponent.record}
								</span>
								{m.opponent.streak && (
									<span className="ml-1 text-ink-55">{m.opponent.streak}</span>
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
		<section
			aria-labelledby="matchup-heading"
			className="rounded-md bg-ink-05 p-4 ring-1 ring-inset ring-ink-15"
		>
			<h2
				id="matchup-heading"
				className="mb-3 font-mono text-xxs font-semibold uppercase tracking-[0.2em] text-ink-55"
			>
				Matchup Comparison
			</h2>

			{/* Search controls */}
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void lookup();
				}}
				className="mb-3 flex flex-wrap items-center gap-2"
			>
				<label className="flex-1 min-w-[8rem]">
					<span className="sr-only">Team</span>
					<input
						type="text"
						value={teamName}
						onChange={(e) => setTeamName(e.target.value)}
						placeholder="Team…"
						aria-label="Team"
						className="w-full rounded-md bg-ink-00 px-3 py-1.5 text-sm text-ink-95 placeholder:text-ink-55 ring-1 ring-inset ring-ink-25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
					/>
				</label>
				<span className="font-mono text-xxs text-ink-40" aria-hidden>
					vs
				</span>
				<label className="flex-1 min-w-[8rem]">
					<span className="sr-only">Opponent</span>
					<input
						type="text"
						value={opponentName}
						onChange={(e) => setOpponentName(e.target.value)}
						placeholder="Opponent…"
						aria-label="Opponent"
						className="w-full rounded-md bg-ink-00 px-3 py-1.5 text-sm text-ink-95 placeholder:text-ink-55 ring-1 ring-inset ring-ink-25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
					/>
				</label>
				<label>
					<span className="sr-only">Sport</span>
					<select
						value={sportTag}
						onChange={(e) => setSportTag(e.target.value)}
						aria-label="Sport"
						className="rounded-md bg-ink-00 px-2 py-1.5 text-sm text-ink-95 ring-1 ring-inset ring-ink-25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
					>
						<option value="ncaab">NCAAB</option>
						<option value="ncaaf">NCAAF</option>
						<option value="nba">NBA</option>
						<option value="nfl">NFL</option>
						<option value="mlb">MLB</option>
						<option value="nhl">NHL</option>
					</select>
				</label>
				<button
					type="submit"
					disabled={loading || !teamName.trim() || !opponentName.trim()}
					className="inline-flex h-9 items-center rounded-md bg-brand-blue px-3 font-mono text-xxs font-semibold uppercase tracking-wider text-ink-00 transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue disabled:opacity-40"
				>
					{loading ? "…" : "Compare"}
				</button>
			</form>

			{/* Results */}
			{error && (
				<div className="font-mono text-xxs text-signal-bad">{error}</div>
			)}
			{!error && !comparison && !loading && (
				<div className="font-mono text-xxs text-ink-55">
					Enter two teams and a sport to compare trends.
				</div>
			)}
			{comparison && (
				<div>
					<div className="mb-3 font-sans text-sm font-semibold text-ink-95">
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
		</section>
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
			<div className="font-mono text-xxs font-semibold uppercase tracking-[0.15em] text-ink-55">
				{comparison.team.name} vs {comparison.opponent.name}
			</div>
			<div className="flex flex-wrap gap-3 font-mono text-xxs tabular-nums">
				{overall.metrics.map((m) => (
					<span key={m.metric} className="text-ink-70">
						<span className="text-ink-55">{METRIC_LABELS[m.metric]}</span>{" "}
						<span
							className={m.edge === "team" ? "text-brand-cyan" : "text-ink-70"}
						>
							{m.team.record}
						</span>{" "}
						<span className="text-ink-40">v</span>{" "}
						<span
							className={
								m.edge === "opponent" ? "text-signal-warn" : "text-ink-70"
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
