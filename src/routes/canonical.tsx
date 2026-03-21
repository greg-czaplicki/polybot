import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { AuthGate } from "@/components/auth-gate";
import {
	getMatchupComparisonFn,
	getPickContextFn,
	getTeamTrendOverviewFn,
} from "../server/api/canonical-analytics";
import {
	type CanonicalFreshnessStatus,
	type SyncRunSummary,
	getCanonicalFreshnessFn,
	triggerCanonicalSyncFn,
} from "../server/api/canonical-sync-api";

export const Route = createFileRoute("/canonical")({
	component: CanonicalPage,
});

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatPercent(value: number | null | undefined): string {
	if (value == null || !Number.isFinite(value)) return "—";
	return `${(value * 100).toFixed(1)}%`;
}

function formatMargin(value: number | null | undefined): string {
	if (value == null || !Number.isFinite(value)) return "—";
	return value >= 0 ? `+${value.toFixed(1)}` : value.toFixed(1);
}

function formatTimestamp(ts: number | null | undefined): string {
	if (!ts) return "—";
	return new Date(ts * 1000).toLocaleString();
}

function StatCard({
	label,
	value,
	sub,
}: { label: string; value: string | number; sub?: string }) {
	return (
		<div
			style={{
				padding: 12,
				border: "1px solid #333",
				borderRadius: 8,
				textAlign: "center",
			}}
		>
			<div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>
				{label}
			</div>
			<div style={{ fontSize: 20, fontWeight: 600 }}>{value}</div>
			{sub && (
				<div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>{sub}</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Team Trend Section
// ---------------------------------------------------------------------------

type TrendOverviewResult = Awaited<
	ReturnType<typeof getTeamTrendOverviewFn>
>["overview"];

function TeamTrendSection() {
	const [alias, setAlias] = useState("");
	const [sportTag, setSportTag] = useState("NCAAB");
	const [overview, setOverview] = useState<TrendOverviewResult>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const search = useCallback(async () => {
		if (!alias.trim()) return;
		setLoading(true);
		setError(null);
		try {
			const res = await getTeamTrendOverviewFn({
				data: { alias: alias.trim(), sportTag },
			});
			if (res.error) {
				setError(res.error);
				setOverview(null);
			} else {
				setOverview(res.overview);
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [alias, sportTag]);

	return (
		<section>
			<h2>Team Trends</h2>
			<div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
				<input
					type="text"
					placeholder="Team name (e.g., Michigan)"
					value={alias}
					onChange={(e) => setAlias(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && search()}
					style={{
						padding: "6px 10px",
						border: "1px solid #444",
						borderRadius: 6,
						background: "#1a1a1a",
						color: "#eee",
						flex: 1,
					}}
				/>
				<select
					value={sportTag}
					onChange={(e) => setSportTag(e.target.value)}
					style={{
						padding: "6px 10px",
						border: "1px solid #444",
						borderRadius: 6,
						background: "#1a1a1a",
						color: "#eee",
					}}
				>
					<option value="NCAAB">NCAAB</option>
					<option value="NCAAF">NCAAF</option>
					<option value="NFL">NFL</option>
					<option value="NBA">NBA</option>
					<option value="MLB">MLB</option>
				</select>
				<button type="button" onClick={search} disabled={loading}>
					{loading ? "..." : "Search"}
				</button>
			</div>
			{error && <div style={{ color: "#f55", marginBottom: 8 }}>{error}</div>}
			{overview && <TrendOverviewTable overview={overview} />}
		</section>
	);
}

function TrendOverviewTable({ overview }: { overview: NonNullable<TrendOverviewResult> }) {
	const splitOrder = [
		"overall",
		"home",
		"away",
		"favorite",
		"dog",
		"home_favorite",
		"home_dog",
		"away_favorite",
		"away_dog",
	] as const;

	return (
		<div>
			<h3>
				{overview.team.name} ({overview.team.sportTag})
			</h3>
			<table
				style={{
					width: "100%",
					borderCollapse: "collapse",
					fontSize: 13,
				}}
			>
				<thead>
					<tr style={{ borderBottom: "2px solid #444" }}>
						<th style={thStyle}>Split</th>
						<th style={thStyle}>SU Record</th>
						<th style={thStyle}>SU Streak</th>
						<th style={thStyle}>ATS Record</th>
						<th style={thStyle}>ATS %</th>
						<th style={thStyle}>ATS Streak</th>
						<th style={thStyle}>Avg Cover</th>
						<th style={thStyle}>OU Record</th>
						<th style={thStyle}>OU %</th>
						<th style={thStyle}>OU Streak</th>
						<th style={thStyle}>Avg Total</th>
						<th style={thStyle}>Source</th>
					</tr>
				</thead>
				<tbody>
					{splitOrder.map((type) => {
						const s = overview.splits[type];
						if (!s) return null;
						return (
							<tr key={type} style={{ borderBottom: "1px solid #333" }}>
								<td style={tdStyle}>{s.split.label}</td>
								<td style={tdStyle}>{s.su.record.display}</td>
								<td style={tdStyle}>{s.su.streak?.display ?? "—"}</td>
								<td style={tdStyle}>{s.ats.record.display}</td>
								<td style={tdStyle}>{formatPercent(s.ats.record.winPct)}</td>
								<td style={tdStyle}>{s.ats.streak?.display ?? "—"}</td>
								<td style={tdStyle}>{formatMargin(s.ats.avgCoverMargin)}</td>
								<td style={tdStyle}>{s.ou.record.display}</td>
								<td style={tdStyle}>{formatPercent(s.ou.record.winPct)}</td>
								<td style={tdStyle}>{s.ou.streak?.display ?? "—"}</td>
								<td style={tdStyle}>{formatMargin(s.ou.avgTotalMargin)}</td>
								<td style={{ ...tdStyle, fontSize: 11, color: "#888" }}>
									{s.snapshotSource}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

const thStyle: React.CSSProperties = {
	textAlign: "left",
	padding: "6px 8px",
	fontSize: 11,
	color: "#aaa",
	fontWeight: 500,
};

const tdStyle: React.CSSProperties = {
	padding: "5px 8px",
};

// ---------------------------------------------------------------------------
// Matchup Comparison Section
// ---------------------------------------------------------------------------

type MatchupResult = Awaited<
	ReturnType<typeof getMatchupComparisonFn>
>["comparison"];

function MatchupComparisonSection() {
	const [teamAlias, setTeamAlias] = useState("");
	const [opponentAlias, setOpponentAlias] = useState("");
	const [sportTag, setSportTag] = useState("NCAAB");
	const [comparison, setComparison] = useState<MatchupResult>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const search = useCallback(async () => {
		if (!teamAlias.trim() || !opponentAlias.trim()) return;
		setLoading(true);
		setError(null);
		try {
			const res = await getMatchupComparisonFn({
				data: {
					teamAlias: teamAlias.trim(),
					opponentAlias: opponentAlias.trim(),
					sportTag,
				},
			});
			if (res.error) {
				setError(res.error);
				setComparison(null);
			} else {
				setComparison(res.comparison);
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [teamAlias, opponentAlias, sportTag]);

	return (
		<section>
			<h2>Matchup Comparison</h2>
			<div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
				<input
					type="text"
					placeholder="Team (e.g., Michigan)"
					value={teamAlias}
					onChange={(e) => setTeamAlias(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && search()}
					style={inputStyle}
				/>
				<span style={{ alignSelf: "center", color: "#666" }}>vs</span>
				<input
					type="text"
					placeholder="Opponent (e.g., Ohio State)"
					value={opponentAlias}
					onChange={(e) => setOpponentAlias(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && search()}
					style={inputStyle}
				/>
				<select
					value={sportTag}
					onChange={(e) => setSportTag(e.target.value)}
					style={selectStyle}
				>
					<option value="NCAAB">NCAAB</option>
					<option value="NCAAF">NCAAF</option>
					<option value="NFL">NFL</option>
					<option value="NBA">NBA</option>
					<option value="MLB">MLB</option>
				</select>
				<button type="button" onClick={search} disabled={loading}>
					{loading ? "..." : "Compare"}
				</button>
			</div>
			{error && <div style={{ color: "#f55", marginBottom: 8 }}>{error}</div>}
			{comparison && <MatchupDisplay comparison={comparison} />}
		</section>
	);
}

function MatchupDisplay({
	comparison,
}: { comparison: NonNullable<MatchupResult> }) {
	return (
		<div>
			<h3>{comparison.headline}</h3>
			{comparison.splits.map((split) => (
				<div
					key={`${split.teamSplit.snapshotType}-${split.opponentSplit.snapshotType}`}
					style={{
						marginBottom: 16,
						padding: 12,
						border: "1px solid #333",
						borderRadius: 8,
					}}
				>
					<div
						style={{
							fontSize: 12,
							color: "#888",
							marginBottom: 8,
							fontWeight: 500,
						}}
					>
						{comparison.team.name} ({split.teamSplit.label}) vs{" "}
						{comparison.opponent.name} ({split.opponentSplit.label})
					</div>
					<table
						style={{
							width: "100%",
							borderCollapse: "collapse",
							fontSize: 13,
						}}
					>
						<thead>
							<tr style={{ borderBottom: "1px solid #444" }}>
								<th style={thStyle}>Metric</th>
								<th style={thStyle}>{comparison.team.name}</th>
								<th style={thStyle}>{comparison.opponent.name}</th>
								<th style={thStyle}>Edge</th>
							</tr>
						</thead>
						<tbody>
							{split.metrics.map((m) => (
								<tr key={m.metric} style={{ borderBottom: "1px solid #222" }}>
									<td style={tdStyle}>{m.metric.toUpperCase()}</td>
									<td style={tdStyle}>
										{m.team.record}
										{m.team.streak && (
											<span style={{ color: "#888", marginLeft: 6 }}>
												{m.team.streak}
											</span>
										)}
									</td>
									<td style={tdStyle}>
										{m.opponent.record}
										{m.opponent.streak && (
											<span style={{ color: "#888", marginLeft: 6 }}>
												{m.opponent.streak}
											</span>
										)}
									</td>
									<td style={tdStyle}>
										<EdgeBadge edge={m.edge} teamName={comparison.team.name} opponentName={comparison.opponent.name} />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			))}
		</div>
	);
}

function EdgeBadge({
	edge,
	teamName,
	opponentName,
}: { edge: string; teamName: string; opponentName: string }) {
	if (edge === "even") {
		return <span style={{ color: "#888" }}>Even</span>;
	}
	const color = edge === "team" ? "#4a9" : "#f84";
	const name = edge === "team" ? teamName : opponentName;
	return <span style={{ color, fontWeight: 500 }}>{name}</span>;
}

// ---------------------------------------------------------------------------
// Pick Context Section
// ---------------------------------------------------------------------------

type PickContextResult = Awaited<
	ReturnType<typeof getPickContextFn>
>["context"];

function PickContextSection() {
	const [pickId, setPickId] = useState("");
	const [pickContext, setPickContext] = useState<PickContextResult>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const search = useCallback(async () => {
		if (!pickId.trim()) return;
		setLoading(true);
		setError(null);
		try {
			const res = await getPickContextFn({ data: { pickId: pickId.trim() } });
			if (res.error) {
				setError(res.error);
				setPickContext(null);
			} else {
				setPickContext(res.context);
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [pickId]);

	return (
		<section>
			<h2>Pick Context</h2>
			<div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
				<input
					type="text"
					placeholder="Pick ID"
					value={pickId}
					onChange={(e) => setPickId(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && search()}
					style={{ ...inputStyle, flex: 1 }}
				/>
				<button type="button" onClick={search} disabled={loading}>
					{loading ? "..." : "Lookup"}
				</button>
			</div>
			{error && <div style={{ color: "#f55", marginBottom: 8 }}>{error}</div>}
			{pickContext && <PickContextDisplay context={pickContext} />}
		</section>
	);
}

function PickContextDisplay({
	context,
}: { context: NonNullable<PickContextResult> }) {
	const e = context.enrichment;
	return (
		<div
			style={{
				border: "1px solid #333",
				borderRadius: 8,
				padding: 12,
			}}
		>
			<div style={{ marginBottom: 12 }}>
				<div style={{ fontSize: 14, fontWeight: 500 }}>
					{context.marketTitle}
				</div>
				<div style={{ fontSize: 12, color: "#888" }}>
					Picked: {formatTimestamp(context.pickedAt)}
				</div>
			</div>

			<div style={{ marginBottom: 12 }}>
				<div
					style={{ fontSize: 12, color: "#888", fontWeight: 500, marginBottom: 4 }}
				>
					Enrichment Fields
				</div>
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(4, 1fr)",
						gap: 6,
						fontSize: 12,
					}}
				>
					<EnrichField label="Game ID" value={e.gameId} />
					<EnrichField
						label="Team"
						value={context.team ? context.team.name : e.teamId}
					/>
					<EnrichField
						label="Opponent"
						value={context.opponent ? context.opponent.name : e.opponentId}
					/>
					<EnrichField label="Bet Type" value={e.betType} />
					<EnrichField label="Sport" value={e.sportTag} />
					<EnrichField label="Venue" value={e.venueRole} />
					<EnrichField label="Fav/Dog" value={e.favDogRole} />
					<EnrichField
						label="Spread"
						value={e.spreadLine != null ? String(e.spreadLine) : null}
					/>
					<EnrichField
						label="Total"
						value={e.totalLine != null ? String(e.totalLine) : null}
					/>
					<EnrichField
						label="Actual Margin"
						value={e.actualMargin != null ? String(e.actualMargin) : null}
					/>
					<EnrichField
						label="Actual Total"
						value={e.actualTotal != null ? String(e.actualTotal) : null}
					/>
				</div>
			</div>

			<div>
				<div
					style={{ fontSize: 12, color: "#888", fontWeight: 500, marginBottom: 4 }}
				>
					Trend Snapshot (at pick time)
				</div>
				<div style={{ display: "flex", gap: 12 }}>
					<SnapshotCard
						label="Overall"
						snapshot={context.trendSnapshot.overall}
					/>
					<SnapshotCard
						label="Contextual"
						snapshot={context.trendSnapshot.contextual}
					/>
				</div>
			</div>
		</div>
	);
}

function EnrichField({
	label,
	value,
}: { label: string; value: string | null | undefined }) {
	return (
		<div>
			<div style={{ color: "#666", fontSize: 10 }}>{label}</div>
			<div style={{ color: value ? "#eee" : "#555" }}>
				{value ?? "—"}
			</div>
		</div>
	);
}

function SnapshotCard({
	label,
	snapshot,
}: {
	label: string;
	snapshot: {
		type: string;
		window: number;
		suPct: number | null;
		atsPct: number | null;
		ouPct: number | null;
		atsStreak: string | null;
	} | null;
}) {
	if (!snapshot) {
		return (
			<div
				style={{
					flex: 1,
					padding: 8,
					border: "1px solid #333",
					borderRadius: 6,
					fontSize: 12,
				}}
			>
				<div style={{ color: "#888", marginBottom: 4 }}>{label}</div>
				<div style={{ color: "#555" }}>No snapshot available</div>
			</div>
		);
	}
	return (
		<div
			style={{
				flex: 1,
				padding: 8,
				border: "1px solid #333",
				borderRadius: 6,
				fontSize: 12,
			}}
		>
			<div style={{ color: "#888", marginBottom: 4 }}>
				{label} ({snapshot.type}, L{snapshot.window})
			</div>
			<div style={{ display: "flex", gap: 12 }}>
				<div>
					SU: <strong>{formatPercent(snapshot.suPct)}</strong>
				</div>
				<div>
					ATS: <strong>{formatPercent(snapshot.atsPct)}</strong>
				</div>
				<div>
					OU: <strong>{formatPercent(snapshot.ouPct)}</strong>
				</div>
				{snapshot.atsStreak && (
					<div>
						Streak: <strong>{snapshot.atsStreak}</strong>
					</div>
				)}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Pipeline Health Section (Phase 6)
// ---------------------------------------------------------------------------

function PipelineHealthSection() {
	const [freshness, setFreshness] = useState<CanonicalFreshnessStatus | null>(
		null,
	);
	const [loading, setLoading] = useState(false);
	const [triggering, setTriggering] = useState(false);
	const [triggerResult, setTriggerResult] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			const res = await getCanonicalFreshnessFn();
			setFreshness(res.freshness);
		} catch (e) {
			console.error("[canonical-health] Failed to load freshness", e);
		} finally {
			setLoading(false);
		}
	}, []);

	const triggerSync = useCallback(
		async (skipSeeding: boolean) => {
			setTriggering(true);
			setTriggerResult(null);
			try {
				const res = await triggerCanonicalSyncFn({
					data: { skipSeeding },
				});
				if (res.success) {
					setTriggerResult("Sync completed successfully");
					refresh();
				} else {
					setTriggerResult(`Failed: ${res.error}`);
				}
			} catch (e) {
				setTriggerResult(
					`Error: ${e instanceof Error ? e.message : String(e)}`,
				);
			} finally {
				setTriggering(false);
			}
		},
		[refresh],
	);

	useEffect(() => {
		refresh();
	}, [refresh]);

	return (
		<section>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 12,
					marginBottom: 12,
				}}
			>
				<h2 style={{ margin: 0 }}>Pipeline Health</h2>
				<button type="button" onClick={refresh} disabled={loading}>
					{loading ? "Loading..." : "Refresh"}
				</button>
				<button
					type="button"
					onClick={() => triggerSync(false)}
					disabled={triggering}
					style={{
						background: "#2a6",
						color: "#fff",
						border: "none",
						padding: "4px 12px",
						borderRadius: 4,
						cursor: triggering ? "not-allowed" : "pointer",
					}}
				>
					{triggering ? "Running..." : "Full Sync"}
				</button>
				<button
					type="button"
					onClick={() => triggerSync(true)}
					disabled={triggering}
					style={{
						background: "#c82",
						color: "#fff",
						border: "none",
						padding: "4px 12px",
						borderRadius: 4,
						cursor: triggering ? "not-allowed" : "pointer",
					}}
				>
					Quick Sync (skip seeding)
				</button>
			</div>

			{triggerResult && (
				<div
					style={{
						padding: 8,
						marginBottom: 12,
						borderRadius: 4,
						background: triggerResult.startsWith("Sync")
							? "#1a3a1a"
							: "#3a1a1a",
						color: triggerResult.startsWith("Sync") ? "#4a9" : "#f55",
						fontSize: 13,
					}}
				>
					{triggerResult}
				</div>
			)}

			{freshness && (
				<>
					<FreshnessIndicator staleness={freshness.staleness} />
					<EntityCountsGrid counts={freshness.counts} />
					{freshness.recentRuns.length > 0 && (
						<RecentSyncRuns runs={freshness.recentRuns} />
					)}
				</>
			)}
		</section>
	);
}

function FreshnessIndicator({
	staleness,
}: {
	staleness: CanonicalFreshnessStatus["staleness"];
}) {
	const color = staleness.isStale ? "#f55" : "#4a9";
	const label = staleness.isStale ? "STALE" : "FRESH";

	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: 12,
				padding: "8px 12px",
				marginBottom: 12,
				border: `1px solid ${color}33`,
				borderRadius: 6,
				background: `${color}11`,
			}}
		>
			<div
				style={{
					width: 10,
					height: 10,
					borderRadius: "50%",
					background: color,
				}}
			/>
			<span style={{ fontWeight: 600, color }}>{label}</span>
			<span style={{ color: "#888", fontSize: 13 }}>
				{staleness.lastSuccessAt
					? `Last success: ${formatRelativeTimestamp(staleness.lastSuccessAt)} (${staleness.minutesSinceLastSuccess}m ago)`
					: "No successful sync recorded"}
			</span>
			<span style={{ color: "#555", fontSize: 12, marginLeft: "auto" }}>
				Threshold: {staleness.staleThresholdMinutes}m
			</span>
		</div>
	);
}

function EntityCountsGrid({
	counts,
}: {
	counts: CanonicalFreshnessStatus["counts"];
}) {
	return (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "repeat(6, 1fr)",
				gap: 10,
				marginBottom: 16,
			}}
		>
			<StatCard label="Teams" value={counts.teams} />
			<StatCard
				label="Games"
				value={`${counts.games.finalized}/${counts.games.total}`}
				sub="finalized/total"
			/>
			<StatCard label="Facts" value={counts.facts} />
			<StatCard label="Snapshots" value={counts.snapshots} />
			<StatCard
				label="Pick Enrichment"
				value={`${counts.picks.enriched}/${counts.picks.total}`}
				sub={formatPercent(counts.picks.enrichmentRate)}
			/>
			<StatCard
				label="Unprocessed"
				value={counts.unprocessedGames}
				sub={
					counts.unprocessedGames > 0
						? "games need processing"
						: "all caught up"
				}
			/>
		</div>
	);
}

function RecentSyncRuns({ runs }: { runs: SyncRunSummary[] }) {
	const [expanded, setExpanded] = useState<string | null>(null);

	return (
		<div>
			<h3 style={{ fontSize: 14, marginBottom: 8, color: "#aaa" }}>
				Recent Sync Runs
			</h3>
			<table
				style={{
					width: "100%",
					borderCollapse: "collapse",
					fontSize: 13,
				}}
			>
				<thead>
					<tr style={{ borderBottom: "2px solid #444" }}>
						<th style={thStyle}>Status</th>
						<th style={thStyle}>Started</th>
						<th style={thStyle}>Duration</th>
						<th style={thStyle}>Processed</th>
						<th style={thStyle}>Details</th>
					</tr>
				</thead>
				<tbody>
					{runs.map((run) => (
						<SyncRunRow
							key={run.id}
							run={run}
							isExpanded={expanded === run.id}
							onToggle={() =>
								setExpanded(expanded === run.id ? null : run.id)
							}
						/>
					))}
				</tbody>
			</table>
		</div>
	);
}

function SyncRunRow({
	run,
	isExpanded,
	onToggle,
}: {
	run: SyncRunSummary;
	isExpanded: boolean;
	onToggle: () => void;
}) {
	const statusColor =
		run.status === "success"
			? "#4a9"
			: run.status === "failed"
				? "#f55"
				: "#fa0";

	return (
		<>
			<tr
				style={{
					borderBottom: "1px solid #333",
					cursor: run.steps.length > 0 ? "pointer" : "default",
				}}
				onClick={run.steps.length > 0 ? onToggle : undefined}
			>
				<td style={tdStyle}>
					<span
						style={{
							color: statusColor,
							fontWeight: 500,
						}}
					>
						{run.status.toUpperCase()}
					</span>
				</td>
				<td style={tdStyle}>
					{formatRelativeTimestamp(run.startedAt)}
				</td>
				<td style={tdStyle}>
					{`${(run.durationMs / 1000).toFixed(1)}s`}
				</td>
				<td style={tdStyle}>
					{run.gamesProcessed}g / {run.factsComputed}f / {run.picksBackfilled}p
				</td>
				<td style={tdStyle}>
					{run.steps.length > 0
						? `${run.steps.length} steps ${isExpanded ? "▼" : "▶"}`
						: "—"}
					{run.errorSummary && (
						<span style={{ color: "#f55", marginLeft: 8 }}>
							{run.errorSummary}
						</span>
					)}
				</td>
			</tr>
			{isExpanded && run.steps.length > 0 && (
				<tr>
					<td colSpan={5} style={{ padding: "8px 16px" }}>
						<SyncStepDetails steps={run.steps} />
					</td>
				</tr>
			)}
		</>
	);
}

function SyncStepDetails({
	steps,
}: { steps: SyncRunSummary["steps"] }) {
	return (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
				gap: 8,
			}}
		>
			{steps.map((step) => {
				const color =
					step.status === "success"
						? "#4a9"
						: step.status === "error"
							? "#f55"
							: "#888";
				return (
					<div
						key={step.step}
						style={{
							padding: 8,
							border: `1px solid ${color}33`,
							borderRadius: 4,
							fontSize: 12,
						}}
					>
						<div
							style={{
								fontWeight: 500,
								color,
								marginBottom: 4,
							}}
						>
							{step.step}
						</div>
						{step.counts && (
							<div style={{ color: "#ccc" }}>
								{Object.entries(step.counts).map(([k, v]) => (
									<div key={k}>{k}: {v}</div>
								))}
							</div>
						)}
						<div style={{ color: "#888" }}>
							{(step.durationMs / 1000).toFixed(1)}s
						</div>
						{step.error && (
							<div style={{ color: "#f55", fontSize: 11 }}>
								{step.error}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}

function formatRelativeTimestamp(ts: number): string {
	const diffMs = Date.now() - ts;
	const diffMin = Math.floor(diffMs / 60000);
	if (diffMin < 1) return "Just now";
	if (diffMin < 60) return `${diffMin}m ago`;
	const diffHours = Math.floor(diffMin / 60);
	if (diffHours < 24) return `${diffHours}h ago`;
	return `${Math.floor(diffHours / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const inputStyle: React.CSSProperties = {
	padding: "6px 10px",
	border: "1px solid #444",
	borderRadius: 6,
	background: "#1a1a1a",
	color: "#eee",
	flex: 1,
};

const selectStyle: React.CSSProperties = {
	padding: "6px 10px",
	border: "1px solid #444",
	borderRadius: 6,
	background: "#1a1a1a",
	color: "#eee",
};

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function CanonicalPage() {
	return (
		<AuthGate>
			<div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
				<h1>Canonical Analytics</h1>
				<p style={{ color: "#888", marginBottom: 24 }}>
					Team trends, matchup comparisons, and pick enrichment inspection.
				</p>

				<PipelineHealthSection />
				<hr style={{ borderColor: "#333", margin: "24px 0" }} />
				<TeamTrendSection />
				<hr style={{ borderColor: "#333", margin: "24px 0" }} />
				<MatchupComparisonSection />
				<hr style={{ borderColor: "#333", margin: "24px 0" }} />
				<PickContextSection />
			</div>
		</AuthGate>
	);
}
