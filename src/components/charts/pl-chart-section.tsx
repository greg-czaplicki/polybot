import { useEffect, useMemo, useState } from "react";
import {
	buildDayGrid,
	cumulativeByDay,
	eraMarkers,
	rollingByDay,
} from "@/lib/pl-series";
import {
	getPlTimeseriesFn,
	type PlTimeseriesResult,
} from "@/server/api/pl-timeseries";
import { PlLineChart } from "./pl-line-chart";

/** Stored CLV is outcome-clean only from this date (see docs/KNOWN-ISSUES.md). */
const CLV_VALID_FROM_SEC = Math.floor(
	new Date("2026-07-20T00:00:00").getTime() / 1000,
);

const ROLLING_WINDOW_SECS = 30 * 86400;

const SERIES_COLORS = {
	real: "var(--brand-blue)",
	shadow: "var(--series-shadow)",
};

export interface PlRange {
	start: string;
	end: string;
}

type PresetKey = "7d" | "30d" | "90d" | "all";

const PRESETS: { key: PresetKey; label: string; days: number | null }[] = [
	{ key: "7d", label: "7d", days: 7 },
	{ key: "30d", label: "30d", days: 30 },
	{ key: "90d", label: "90d", days: 90 },
	{ key: "all", label: "All", days: null },
];

function toDateInputValue(date: Date): string {
	const y = date.getFullYear();
	const m = `${date.getMonth() + 1}`.padStart(2, "0");
	const d = `${date.getDate()}`.padStart(2, "0");
	return `${y}-${m}-${d}`;
}

function fromDateInputValue(value: string): number | null {
	const parsed = new Date(`${value}T00:00:00`).getTime();
	return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

export function presetRange(
	preset: PresetKey,
	firstSettleSec: number | null,
): PlRange {
	const end = new Date();
	const start = new Date();
	const spec = PRESETS.find((p) => p.key === preset);
	if (spec?.days) {
		start.setDate(start.getDate() - (spec.days - 1));
	} else if (firstSettleSec) {
		start.setTime(firstSettleSec * 1000);
	} else {
		start.setDate(start.getDate() - 89);
	}
	return { start: toDateInputValue(start), end: toDateInputValue(end) };
}

/**
 * Inclusive-start / exclusive-end unix-second bounds for a date range, with
 * the end day fully included. Null when the range is empty or unparsable.
 */
export function rangeBounds(
	range: PlRange,
): { startSec: number; endExclusiveSec: number } | null {
	const startSec = fromDateInputValue(range.start);
	const endSec = fromDateInputValue(range.end);
	if (startSec === null || endSec === null || endSec < startSec) return null;
	const endDate = new Date(endSec * 1000);
	endDate.setDate(endDate.getDate() + 1);
	return { startSec, endExclusiveSec: Math.floor(endDate.getTime() / 1000) };
}

function formatUnits(value: number): string {
	return `${value >= 0 ? "+" : ""}${value.toFixed(1)}u`;
}

function formatDollars(value: number): string {
	return `${value >= 0 ? "+" : "−"}$${Math.abs(value).toFixed(0)}`;
}

function formatClvCents(value: number): string {
	return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(0)}¢`;
}

/**
 * The shared range control: preset pills + custom date inputs. Rendered by
 * the page above everything the range scopes (stats strip, charts, list).
 */
export function PlRangeRow({
	range,
	onChange,
	firstDateSec,
}: {
	range: PlRange;
	onChange: (range: PlRange) => void;
	firstDateSec: number | null;
}) {
	const activePreset = useMemo<PresetKey | null>(() => {
		for (const preset of PRESETS) {
			const candidate = presetRange(preset.key, firstDateSec);
			if (candidate.start === range.start && candidate.end === range.end) {
				return preset.key;
			}
		}
		return null;
	}, [range, firstDateSec]);

	return (
		// biome-ignore lint/a11y/useSemanticElements: role="group" with aria-label is the right ARIA pattern for a non-landmark control cluster.
		<div
			className="flex flex-wrap items-center gap-2"
			role="group"
			aria-label="Date range"
		>
			{PRESETS.map((preset) => {
				const active = activePreset === preset.key;
				return (
					<button
						type="button"
						key={preset.key}
						onClick={() => onChange(presetRange(preset.key, firstDateSec))}
						aria-pressed={active}
						className={`inline-flex h-11 items-center rounded-full px-4 font-mono text-xxs uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue sm:h-8 ${
							active
								? "bg-brand-blue font-bold text-ink-00 ring-1 ring-inset ring-ink-00/20"
								: "bg-ink-10 font-semibold text-ink-70 hover:bg-ink-15 hover:text-ink-95"
						}`}
					>
						{preset.label}
					</button>
				);
			})}
			<span className="ml-1 flex items-center gap-1.5">
				<input
					type="date"
					value={range.start}
					max={range.end}
					aria-label="Range start date"
					onChange={(event) =>
						onChange({ ...range, start: event.target.value })
					}
					className="h-11 rounded-md bg-ink-10 px-2 font-mono text-xs tabular-nums text-ink-85 ring-1 ring-inset ring-ink-15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue sm:h-8"
					style={{ colorScheme: "dark" }}
				/>
				<span aria-hidden className="font-mono text-xs text-ink-55">
					–
				</span>
				<input
					type="date"
					value={range.end}
					min={range.start}
					aria-label="Range end date"
					onChange={(event) => onChange({ ...range, end: event.target.value })}
					className="h-11 rounded-md bg-ink-10 px-2 font-mono text-xs tabular-nums text-ink-85 ring-1 ring-inset ring-ink-15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue sm:h-8"
					style={{ colorScheme: "dark" }}
				/>
			</span>
		</div>
	);
}

export function PlChartSection({
	range,
	compact = false,
}: {
	range: PlRange;
	/** Terminal panel mode: only the units line, no section chrome. */
	compact?: boolean;
}) {
	const [data, setData] = useState<PlTimeseriesResult | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);

	useEffect(() => {
		let cancelled = false;
		const load = async () => {
			try {
				const result = await getPlTimeseriesFn();
				if (!cancelled) setData(result);
			} catch (error) {
				console.error("Failed to load P/L timeseries:", error);
				if (!cancelled) setLoadFailed(true);
			}
		};
		void load();
		return () => {
			cancelled = true;
		};
	}, []);

	const chart = useMemo(() => {
		if (!data) return null;
		const startSec = fromDateInputValue(range.start);
		const endSec = fromDateInputValue(range.end);
		if (startSec === null || endSec === null || endSec < startSec) return null;
		const days = buildDayGrid(startSec, endSec);
		if (days.length === 0) return null;
		const realCum = cumulativeByDay(data.picks, days);
		// The shadow book only exists from its first settle (2026-07-30) — a
		// flat zero line before that would read as "rejects broke even".
		const firstShadowSec = data.shadows[0]?.settledAt ?? null;
		const shadowCum = cumulativeByDay(data.shadows, days, {
			startAt: firstShadowSec ? Math.max(days[0], firstShadowSec) : days[0],
		});
		const rolling = rollingByDay(data.picks, days, ROLLING_WINDOW_SECS);
		const clvCum = cumulativeByDay(data.picks, days, {
			value: (point) => point.clv,
			startAt: Math.max(days[0], CLV_VALID_FROM_SEC),
		});
		// Dollar curve: matched fills only, from the first real-money pick in
		// range. Units × a rising stake is what makes this one bend upward
		// while the units line stays straight — that is the comparison.
		const firstMatched = data.picks.find((p) => p.dollars !== null);
		const dollarCum = cumulativeByDay(data.picks, days, {
			value: (point) => point.dollars,
			startAt: firstMatched
				? Math.max(days[0], firstMatched.settledAt)
				: days[0],
		});
		const stakes = data.picks
			.filter(
				(p) =>
					p.stake !== null &&
					p.settledAt >= days[0] &&
					p.settledAt < endSec + 86400,
			)
			.map((p) => p.stake as number);
		const stakeRange =
			stakes.length > 0
				? { min: Math.min(...stakes), max: Math.max(...stakes) }
				: null;
		const netUnits = [...realCum].reverse().find((v) => v !== null) ?? 0;
		const netDollars = [...dollarCum].reverse().find((v) => v !== null) ?? 0;
		return {
			days,
			realCum,
			dollarCum,
			dollarsAllNull: dollarCum.every((v) => v === null),
			stakeRange,
			netDollars,
			shadowCum,
			rolling,
			clvCum,
			netUnits,
			markers: eraMarkers(data.picks, days),
			clvAllNull: clvCum.every((v) => v === null),
		};
	}, [data, range]);

	if (compact) {
		if (loadFailed)
			return (
				<p className="px-3 py-3 text-sm text-ink-55">chart failed to load.</p>
			);
		if (!chart)
			return <p className="px-3 py-3 text-sm text-ink-55">loading…</p>;
		return (
			<div className="px-3 py-2">
				<PlLineChart
					days={chart.days}
					series={[
						{
							key: "real",
							label: "Real book",
							color: SERIES_COLORS.real,
							values: chart.realCum,
						},
						{
							key: "shadow",
							label: "Shadow book",
							color: SERIES_COLORS.shadow,
							values: chart.shadowCum,
						},
					]}
					markers={chart.markers}
					height={200}
					formatValue={formatUnits}
					ariaLabel="Cumulative profit and loss in units for the real book and the shadow book"
				/>
			</div>
		);
	}

	return (
		<section
			aria-labelledby="pl-charts-heading"
			className="mb-6 flex flex-col gap-4"
		>
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<h2
					id="pl-charts-heading"
					className="font-mono text-xxs font-semibold uppercase tracking-[0.2em] text-ink-55"
				>
					Profit / Loss
				</h2>
				{chart && (
					<span
						className={`font-mono text-lg font-semibold tabular-nums ${
							chart.netUnits >= 0 ? "text-signal-pos" : "text-signal-bad"
						}`}
					>
						{formatUnits(chart.netUnits)}
					</span>
				)}
			</div>

			{loadFailed && (
				<div className="rounded-md bg-ink-05 p-4 font-mono text-sm text-ink-55 ring-1 ring-inset ring-ink-15">
					failed to load chart data.
				</div>
			)}
			{!loadFailed && !chart && (
				<div className="rounded-md bg-ink-05 p-4 font-mono text-sm text-ink-55 ring-1 ring-inset ring-ink-15">
					loading…
				</div>
			)}

			{chart && (
				<>
					<div className="rounded-md bg-ink-05 p-4 ring-1 ring-inset ring-ink-15">
						<h3 className="mb-2 font-sans text-sm font-semibold text-ink-95">
							Cumulative P/L
							<span className="ml-2 font-mono text-xxs font-normal uppercase tracking-wider text-ink-55">
								flat-stake units, from range start
							</span>
						</h3>
						<PlLineChart
							days={chart.days}
							series={[
								{
									key: "real",
									label: "Real book",
									color: SERIES_COLORS.real,
									values: chart.realCum,
								},
								{
									key: "shadow",
									label: "Shadow book (gate rejects)",
									color: SERIES_COLORS.shadow,
									values: chart.shadowCum,
								},
							]}
							markers={chart.markers}
							height={260}
							formatValue={formatUnits}
							ariaLabel="Cumulative profit and loss in units for the real book and the shadow book over the selected range"
						/>
					</div>

					<div className="rounded-md bg-ink-05 p-4 ring-1 ring-inset ring-ink-15">
						<h3 className="mb-2 font-sans text-sm font-semibold text-ink-95">
							Cumulative P/L — dollars
							<span className="ml-2 font-mono text-xxs font-normal uppercase tracking-wider text-ink-55">
								matched fills × ROI, same days as above
								{chart.stakeRange
									? ` · stake $${chart.stakeRange.min.toFixed(0)} → $${chart.stakeRange.max.toFixed(0)}`
									: ""}
							</span>
						</h3>
						{chart.dollarsAllNull ? (
							<div className="py-6 font-mono text-sm text-ink-55">
								no matched fills in this range
							</div>
						) : (
							<>
								<PlLineChart
									days={chart.days}
									series={[
										{
											key: "dollars",
											label: "Real book (dollars)",
											color: SERIES_COLORS.real,
											values: chart.dollarCum,
										},
									]}
									markers={chart.markers}
									height={200}
									formatValue={formatDollars}
									ariaLabel="Cumulative real-money profit and loss in dollars from matched fills over the selected range"
								/>
								<p className="mt-2 text-xs text-ink-55">
									Read the two panels together: units is the system (one unit
									per bet, stake-independent); dollars is units × the stake you
									were running. A straight units line under a curving dollar
									line means the stake rose, not the edge.
								</p>
							</>
						)}
					</div>

					<div className="grid gap-4 lg:grid-cols-2">
						<div className="min-w-0 rounded-md bg-ink-05 p-4 ring-1 ring-inset ring-ink-15">
							<h3 className="mb-2 font-sans text-sm font-semibold text-ink-95">
								Rolling 30-day P/L
								<span className="ml-2 font-mono text-xxs font-normal uppercase tracking-wider text-ink-55">
									trailing window
								</span>
							</h3>
							<PlLineChart
								days={chart.days}
								series={[
									{
										key: "rolling",
										label: "Rolling 30d",
										color: SERIES_COLORS.real,
										values: chart.rolling,
									},
								]}
								height={180}
								formatValue={formatUnits}
								ariaLabel="Units won over the trailing 30 days, plotted daily"
							/>
						</div>

						<div className="min-w-0 rounded-md bg-ink-05 p-4 ring-1 ring-inset ring-ink-15">
							<h3 className="mb-2 font-sans text-sm font-semibold text-ink-95">
								Cumulative CLV
								<span className="ml-2 font-mono text-xxs font-normal uppercase tracking-wider text-ink-55">
									valid from Jul 20
								</span>
							</h3>
							{chart.clvAllNull ? (
								<div className="flex h-[180px] items-center justify-center font-mono text-xs text-ink-55">
									no valid CLV in this range (starts Jul 20, 2026)
								</div>
							) : (
								<PlLineChart
									days={chart.days}
									series={[
										{
											key: "clv",
											label: "Cumulative CLV",
											color: SERIES_COLORS.real,
											values: chart.clvCum,
										},
									]}
									height={180}
									formatValue={formatClvCents}
									ariaLabel="Cumulative closing line value in cents since July 20, 2026"
								/>
							)}
						</div>
					</div>
				</>
			)}
		</section>
	);
}
