import { useCallback, useState } from "react";

import { getTeamTrendSummaryFn } from "../../server/api/canonical-analytics";
import type {
	FormattedRecord,
	FormattedStreak,
	TeamTrendSummary,
} from "../../server/domain/trend-summary";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function pctDisplay(pct: number | null): string {
	if (pct == null) return "—";
	return `${(pct * 100).toFixed(0)}%`;
}

function marginDisplay(val: number | null): string {
	if (val == null) return "—";
	return val >= 0 ? `+${val.toFixed(1)}` : val.toFixed(1);
}

function RecordCell({
	label,
	record,
	streak,
	avgMargin,
}: {
	label: string;
	record: FormattedRecord;
	streak: FormattedStreak | null;
	avgMargin?: number | null;
}) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-[0.6rem] font-semibold uppercase tracking-[0.15em] text-slate-500">
				{label}
			</span>
			<span className="text-sm font-semibold text-slate-100">
				{record.display}
			</span>
			<div className="flex items-center gap-2 text-[0.65rem] text-slate-400">
				<span>{pctDisplay(record.winPct)}</span>
				{streak && (
					<span
						className={
							streak.type === "W" ? "text-emerald-400" : "text-red-400"
						}
					>
						{streak.display}
					</span>
				)}
				{avgMargin != null && (
					<span className="text-slate-500">{marginDisplay(avgMargin)}</span>
				)}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// TrendSummaryRow — renders one TeamTrendSummary inline
// ---------------------------------------------------------------------------

function TrendSummaryRow({ summary }: { summary: TeamTrendSummary }) {
	return (
		<div className="grid grid-cols-3 gap-3">
			<RecordCell
				label="SU"
				record={summary.su.record}
				streak={summary.su.streak}
			/>
			<RecordCell
				label="ATS"
				record={summary.ats.record}
				streak={summary.ats.streak}
				avgMargin={summary.ats.avgCoverMargin}
			/>
			<RecordCell
				label="O/U"
				record={summary.ou.record}
				streak={summary.ou.streak}
				avgMargin={summary.ou.avgTotalMargin}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------------
// TeamTrendCard — interactive team trend lookup for the stats page
// ---------------------------------------------------------------------------

type SplitTab = "overall" | "home" | "away" | "favorite" | "dog";

const SPLIT_TABS: { key: SplitTab; label: string }[] = [
	{ key: "overall", label: "All" },
	{ key: "home", label: "Home" },
	{ key: "away", label: "Away" },
	{ key: "favorite", label: "Fav" },
	{ key: "dog", label: "Dog" },
];

export function TeamTrendCard() {
	const [teamName, setTeamName] = useState("");
	const [sportTag, setSportTag] = useState("ncaab");
	const [activeSplit, setActiveSplit] = useState<SplitTab>("overall");
	const [summary, setSummary] = useState<TeamTrendSummary | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [lastQueried, setLastQueried] = useState<string | null>(null);

	const lookup = useCallback(async () => {
		const name = teamName.trim();
		if (!name) return;
		setLoading(true);
		setError(null);
		try {
			const res = await getTeamTrendSummaryFn({
				data: { alias: name, sportTag, snapshotType: activeSplit },
			});
			if (res.error) {
				setError(res.error);
				setSummary(null);
			} else {
				setSummary(res.summary ?? null);
				setLastQueried(name);
			}
		} catch {
			setError("Failed to load trend data");
			setSummary(null);
		} finally {
			setLoading(false);
		}
	}, [teamName, sportTag, activeSplit]);

	const switchSplit = useCallback(
		async (split: SplitTab) => {
			setActiveSplit(split);
			const name = lastQueried ?? teamName.trim();
			if (!name) return;
			setLoading(true);
			setError(null);
			try {
				const res = await getTeamTrendSummaryFn({
					data: { alias: name, sportTag, snapshotType: split },
				});
				if (res.error) {
					setError(res.error);
					setSummary(null);
				} else {
					setSummary(res.summary ?? null);
				}
			} catch {
				setError("Failed to load trend data");
				setSummary(null);
			} finally {
				setLoading(false);
			}
		},
		[teamName, sportTag, lastQueried],
	);

	return (
		<div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
			<div className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
				Team Trends
			</div>

			{/* Search controls */}
			<div className="mb-3 flex flex-wrap items-center gap-2">
				<input
					type="text"
					value={teamName}
					onChange={(e) => setTeamName(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && lookup()}
					placeholder="Team name..."
					className="rounded-lg border border-slate-700/60 bg-slate-950/60 px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 outline-none focus:border-cyan-500/50"
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
					disabled={loading || !teamName.trim()}
					className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-[0.6rem] font-semibold uppercase tracking-[0.2em] text-cyan-200 transition-colors hover:bg-cyan-500/20 disabled:opacity-50"
				>
					{loading ? "..." : "Look Up"}
				</button>
			</div>

			{/* Split tabs */}
			{summary && (
				<div className="mb-3 flex flex-wrap items-center gap-1.5">
					{SPLIT_TABS.map((tab) => (
						<button
							type="button"
							key={tab.key}
							onClick={() => switchSplit(tab.key)}
							className={`rounded-full px-2.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-[0.15em] transition-colors ${
								activeSplit === tab.key
									? "bg-cyan-500 text-white"
									: "bg-slate-800/60 text-slate-400 hover:bg-slate-800"
							}`}
						>
							{tab.label}
						</button>
					))}
				</div>
			)}

			{/* Results */}
			{error && <div className="text-[0.65rem] text-red-400">{error}</div>}
			{!error && !summary && !loading && (
				<div className="text-[0.65rem] text-slate-500">
					Enter a team name and sport to view trends.
				</div>
			)}
			{summary && (
				<div>
					<div className="mb-2 flex items-center gap-2">
						<span className="text-sm font-semibold text-slate-100">
							{summary.team.name}
						</span>
						<span className="text-[0.6rem] uppercase tracking-wide text-slate-500">
							{summary.split.label} · L{summary.window}
						</span>
					</div>
					<TrendSummaryRow summary={summary} />
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Compact inline trend used by pick-context-panel
// ---------------------------------------------------------------------------

export function InlineTrendSummary({ summary }: { summary: TeamTrendSummary }) {
	return (
		<div className="flex flex-wrap items-center gap-3 text-[0.65rem] text-slate-400">
			<span className="font-semibold text-slate-300">
				{summary.split.label}
			</span>
			<span>
				SU {summary.su.record.display}
				{summary.su.streak && (
					<span
						className={`ml-1 ${summary.su.streak.type === "W" ? "text-emerald-400" : "text-red-400"}`}
					>
						{summary.su.streak.display}
					</span>
				)}
			</span>
			<span>
				ATS {summary.ats.record.display}
				{summary.ats.streak && (
					<span
						className={`ml-1 ${summary.ats.streak.type === "W" ? "text-emerald-400" : "text-red-400"}`}
					>
						{summary.ats.streak.display}
					</span>
				)}
			</span>
			<span>
				O/U {summary.ou.record.display}
				{summary.ou.streak && (
					<span
						className={`ml-1 ${summary.ou.streak.type === "W" ? "text-emerald-400" : "text-red-400"}`}
					>
						{summary.ou.streak.display}
					</span>
				)}
			</span>
		</div>
	);
}
