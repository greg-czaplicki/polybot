// ---------------------------------------------------------------------------
// Feature Safety Legend — explains which canonical features are safe for
// pre-pick modeling vs post-result analysis only.
// ---------------------------------------------------------------------------

const PRE_PICK_FEATURES = [
	{
		name: "Team ATS Win %",
		description: "Team's ATS win percentage at pick time (overall or split)",
	},
	{
		name: "Team ATS Streak",
		description: "Current ATS streak direction and length (e.g., W5, L3)",
	},
	{
		name: "Team OU Win %",
		description: "Team's over/under win percentage at pick time",
	},
	{
		name: "Team OU Streak",
		description: "Current OU streak direction and length",
	},
	{
		name: "Team SU Win %",
		description: "Team's straight-up win percentage at pick time",
	},
	{
		name: "Avg Cover Margin",
		description: "Average margin by which the team covers the spread",
	},
	{
		name: "Avg Total Margin",
		description: "Average margin vs the total line (over/under)",
	},
	{
		name: "Venue Role",
		description: "Whether the picked team is home, away, or neutral",
	},
	{
		name: "Fav/Dog Role",
		description: "Whether the picked team is favorite, underdog, or pick'em",
	},
	{
		name: "Spread Line",
		description: "Pregame spread line at pick time",
	},
	{
		name: "Total Line",
		description: "Pregame total line at pick time",
	},
	{
		name: "Opponent ATS Win %",
		description: "Opponent's ATS win percentage at pick time",
	},
	{
		name: "Opponent ATS Streak",
		description: "Opponent's current ATS streak at pick time",
	},
	{
		name: "Matchup ATS Delta",
		description: "Difference between team and opponent ATS win %",
	},
] as const;

const POST_RESULT_FEATURES = [
	{
		name: "Actual Margin",
		description: "Final score differential — only available after game ends",
	},
	{
		name: "Actual Total",
		description: "Final combined score — only available after game ends",
	},
	{
		name: "Pick Outcome",
		description: "Win/loss/push result — the target variable, never a feature",
	},
	{
		name: "ROI",
		description: "Return on investment — computed from outcome and price",
	},
	{
		name: "CLV",
		description: "Closing line value — requires post-pick line movement data",
	},
] as const;

function SafetyBadge({ level }: { level: "safe" | "unsafe" }) {
	if (level === "safe") {
		return (
			<span className="rounded border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-0.5 text-[0.55rem] font-semibold uppercase tracking-wide text-emerald-300">
				pre_pick
			</span>
		);
	}
	return (
		<span className="rounded border border-red-500/40 bg-red-500/15 px-1.5 py-0.5 text-[0.55rem] font-semibold uppercase tracking-wide text-red-300">
			post_result
		</span>
	);
}

export function FeatureLegend() {
	return (
		<div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
			<div className="mb-1 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
				Feature Safety Reference
			</div>
			<p className="mb-4 text-[0.65rem] text-slate-500">
				Features marked <SafetyBadge level="safe" /> are point-in-time safe and
				can be used for modeling. Features marked{" "}
				<SafetyBadge level="unsafe" /> are only available after the game result
				and must never be used as model inputs.
			</p>

			<div className="grid gap-6 lg:grid-cols-2">
				{/* Pre-pick features */}
				<div>
					<div className="mb-2 text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-emerald-400">
						Safe for Modeling (pre-pick)
					</div>
					<div className="space-y-1.5">
						{PRE_PICK_FEATURES.map((f) => (
							<div
								key={f.name}
								className="flex items-start gap-2 rounded-lg border border-slate-800/50 bg-slate-950/30 px-2.5 py-1.5"
							>
								<SafetyBadge level="safe" />
								<div className="min-w-0">
									<div className="text-[0.7rem] font-semibold text-slate-200">
										{f.name}
									</div>
									<div className="text-[0.6rem] text-slate-500">
										{f.description}
									</div>
								</div>
							</div>
						))}
					</div>
				</div>

				{/* Post-result features */}
				<div>
					<div className="mb-2 text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-red-400">
						Analysis Only (post-result)
					</div>
					<div className="space-y-1.5">
						{POST_RESULT_FEATURES.map((f) => (
							<div
								key={f.name}
								className="flex items-start gap-2 rounded-lg border border-slate-800/50 bg-slate-950/30 px-2.5 py-1.5"
							>
								<SafetyBadge level="unsafe" />
								<div className="min-w-0">
									<div className="text-[0.7rem] font-semibold text-slate-200">
										{f.name}
									</div>
									<div className="text-[0.6rem] text-slate-500">
										{f.description}
									</div>
								</div>
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
