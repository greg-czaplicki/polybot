import { useCallback, useState } from "react";

import { getTeamTrendSummaryFn } from "../../server/api/canonical-analytics";
import type {
	FormattedRecord,
	FormattedStreak,
	TeamTrendSummary,
} from "../../server/domain/trend-summary";
import { formatMargin, formatPercent } from "./formatters";

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
			<span className="font-mono text-xxs font-semibold uppercase tracking-[0.15em] text-ink-55">
				{label}
			</span>
			<span className="font-sans text-sm font-semibold text-ink-95">
				{record.display}
			</span>
			<div className="flex items-baseline gap-2 font-mono text-xxs tabular-nums text-ink-70">
				<span>{formatPercent(record.winPct)}</span>
				{streak && (
					<span
						className={
							streak.type === "W" ? "text-signal-pos" : "text-signal-bad"
						}
					>
						{streak.display}
					</span>
				)}
				{avgMargin != null && (
					<span className="text-ink-55">{formatMargin(avgMargin)}</span>
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
		<section
			aria-labelledby="team-trend-heading"
			className="rounded-md bg-ink-05 p-4 ring-1 ring-inset ring-ink-15"
		>
			<h2
				id="team-trend-heading"
				className="mb-3 font-mono text-xxs font-semibold uppercase tracking-[0.2em] text-ink-55"
			>
				Team Trends
			</h2>

			{/* Search controls */}
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void lookup();
				}}
				className="mb-3 flex flex-wrap items-center gap-2"
			>
				<label className="flex-1 min-w-[10rem]">
					<span className="sr-only">Team name</span>
					<input
						type="text"
						value={teamName}
						onChange={(e) => setTeamName(e.target.value)}
						placeholder="Team name…"
						aria-label="Team name"
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
					disabled={loading || !teamName.trim()}
					className="inline-flex h-9 items-center rounded-md bg-brand-blue px-3 font-mono text-xxs font-semibold uppercase tracking-wider text-ink-00 transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue disabled:opacity-40"
				>
					{loading ? "…" : "Look up"}
				</button>
			</form>

			{/* Split tabs */}
			{summary && (
				<div
					className="mb-3 flex flex-wrap items-center gap-1.5"
					role="tablist"
					aria-label="Trend split"
				>
					{SPLIT_TABS.map((tab) => (
						<button
							type="button"
							key={tab.key}
							onClick={() => switchSplit(tab.key)}
							aria-pressed={activeSplit === tab.key}
							role="tab"
							className={`inline-flex h-7 items-center rounded-full px-3 font-mono text-xxs font-semibold uppercase tracking-[0.15em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue ${
								activeSplit === tab.key
									? "bg-brand-blue text-ink-00"
									: "bg-ink-10 text-ink-70 hover:bg-ink-15 hover:text-ink-95"
							}`}
						>
							{tab.label}
						</button>
					))}
				</div>
			)}

			{/* Results */}
			{error && (
				<div className="font-mono text-xxs text-signal-bad">{error}</div>
			)}
			{!error && !summary && !loading && (
				<div className="font-mono text-xxs text-ink-55">
					Enter a team name and sport to view trends.
				</div>
			)}
			{summary && (
				<div>
					<div className="mb-2 flex items-baseline gap-2">
						<span className="font-sans text-sm font-semibold text-ink-95">
							{summary.team.name}
						</span>
						<span className="font-mono text-xxs uppercase tracking-wider text-ink-55">
							{summary.split.label} · L{summary.window}
						</span>
					</div>
					<TrendSummaryRow summary={summary} />
				</div>
			)}
		</section>
	);
}

// ---------------------------------------------------------------------------
// Compact inline trend used by pick-context-panel
// ---------------------------------------------------------------------------

export function InlineTrendSummary({ summary }: { summary: TeamTrendSummary }) {
	return (
		<div className="flex flex-wrap items-baseline gap-3 font-mono text-xxs tabular-nums text-ink-70">
			<span className="font-semibold text-ink-85">{summary.split.label}</span>
			<span>
				<span className="text-ink-55">SU</span> {summary.su.record.display}
				{summary.su.streak && (
					<span
						className={`ml-1 ${summary.su.streak.type === "W" ? "text-signal-pos" : "text-signal-bad"}`}
					>
						{summary.su.streak.display}
					</span>
				)}
			</span>
			<span>
				<span className="text-ink-55">ATS</span> {summary.ats.record.display}
				{summary.ats.streak && (
					<span
						className={`ml-1 ${summary.ats.streak.type === "W" ? "text-signal-pos" : "text-signal-bad"}`}
					>
						{summary.ats.streak.display}
					</span>
				)}
			</span>
			<span>
				<span className="text-ink-55">O/U</span> {summary.ou.record.display}
				{summary.ou.streak && (
					<span
						className={`ml-1 ${summary.ou.streak.type === "W" ? "text-signal-pos" : "text-signal-bad"}`}
					>
						{summary.ou.streak.display}
					</span>
				)}
			</span>
		</div>
	);
}
