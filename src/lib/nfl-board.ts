/**
 * NFL board — the operator's own against-the-spread picks on the weekly
 * Polymarket NFL slate (2026-09-19). Pure helpers: week arithmetic, spread
 * title parsing, main-line selection and the season stats roll-up. Nothing
 * here touches the bot or the holder book; the picks are a human benchmark
 * graded through the same Gamma resolution as every other row.
 */

export const NFL_SEASON = 2026;
/** Wednesday 00:00Z before week 1 (Thu 2026-09-10). Weeks run Wed→Tue. */
export const NFL_WEEK1_START = Date.UTC(2026, 8, 9) / 1000;
const WEEK_SECONDS = 7 * 86400;

export function nflWeekOf(unixSeconds: number): number {
	return Math.max(1, Math.floor((unixSeconds - NFL_WEEK1_START) / WEEK_SECONDS) + 1);
}

export function nflWeekBounds(week: number): { start: number; end: number } {
	const start = NFL_WEEK1_START + (week - 1) * WEEK_SECONDS;
	return { start, end: start + WEEK_SECONDS };
}

export interface SpreadTitle {
	/** "GB vs NYJ" */
	matchup: string;
	/** Team named in the line, e.g. "Packers". */
	namedTeam: string;
	/** Signed line for the named team, e.g. -3.5. */
	line: number;
}

/** "GB vs NYJ: Spread: Packers (-3.5)" → matchup, named team, line. */
export function parseSpreadTitle(title: string): SpreadTitle | null {
	const m = title.match(/^(.*?):\s*Spread:\s*(.+?)\s*\(([+-]?\d+(?:\.\d+)?)\)\s*$/i);
	if (!m) return null;
	const line = Number.parseFloat(m[3]);
	if (!Number.isFinite(line)) return null;
	return { matchup: m[1].trim(), namedTeam: m[2].trim(), line };
}

/** Signed line for a side label given the parsed title (the other team takes the opposite sign). */
export function lineForSide(parsed: SpreadTitle, sideLabel: string): number {
	const a = parsed.namedTeam.toLowerCase();
	const b = sideLabel.trim().toLowerCase();
	const named = a === b || a.includes(b) || b.includes(a);
	return named ? parsed.line : -parsed.line;
}

export interface SpreadMarket {
	conditionId: string;
	eventSlug: string;
	marketTitle: string;
	eventTime: number;
	sideALabel: string;
	sideBLabel: string;
	sideAPrice: number | null;
	sideBPrice: number | null;
	sharpSide: string | null;
	volume: number | null;
}

/**
 * The main line of a game = the spread market whose two prices sit closest
 * to 50/50; ties go to volume. Alternate lines exist for most games.
 */
export function pickMainLine(markets: SpreadMarket[]): SpreadMarket | null {
	let best: SpreadMarket | null = null;
	let bestGap = Number.POSITIVE_INFINITY;
	for (const m of markets) {
		if (typeof m.sideAPrice !== "number" || typeof m.sideBPrice !== "number") continue;
		const gap = Math.abs(m.sideAPrice - m.sideBPrice);
		if (gap < bestGap - 1e-9 || (Math.abs(gap - bestGap) <= 1e-9 && (m.volume ?? 0) > (best?.volume ?? 0))) {
			best = m;
			bestGap = gap;
		}
	}
	return best;
}

export interface BoardPickRow {
	week: number;
	side: string;
	line: number;
	price: number;
	status: string;
	roi: number | null;
	signalSide: string | null;
	eventTime: number;
}

export interface BoardSplit {
	n: number;
	wins: number;
	losses: number;
	pushes: number;
	/** Sum of per-$1 ROI over settled non-push rows. */
	units: number;
	roiPct: number | null;
}

export interface BoardStats {
	season: BoardSplit;
	byWeek: Array<{ week: number } & BoardSplit>;
	favorites: BoardSplit;
	dogs: BoardSplit;
	/** Picks where the holder signal had sighted the same side / the other side. */
	withSignal: BoardSplit;
	againstSignal: BoardSplit;
	/** The signal's own record on the games the operator picked where it had a side. */
	signalItself: BoardSplit;
	/** Current W/L streak, positive = wins, negative = losses. */
	streak: number;
	pending: number;
}

function emptySplit(): BoardSplit {
	return { n: 0, wins: 0, losses: 0, pushes: 0, units: 0, roiPct: null };
}

function add(split: BoardSplit, status: string, roi: number | null): void {
	if (status === "win") split.wins += 1;
	else if (status === "loss") split.losses += 1;
	else if (status === "push") split.pushes += 1;
	else return;
	split.n += 1;
	if (status !== "push" && typeof roi === "number") split.units += roi;
	const decided = split.wins + split.losses;
	split.roiPct = decided > 0 ? (split.units / decided) * 100 : null;
}

export function boardStats(rows: BoardPickRow[]): BoardStats {
	const season = emptySplit();
	const favorites = emptySplit();
	const dogs = emptySplit();
	const withSignal = emptySplit();
	const againstSignal = emptySplit();
	const signalItself = emptySplit();
	const weeks = new Map<number, BoardSplit>();
	let pending = 0;
	const settled = rows
		.filter((r) => r.status === "win" || r.status === "loss" || r.status === "push")
		.sort((a, b) => a.eventTime - b.eventTime);
	for (const r of rows) if (r.status === "pending") pending += 1;
	for (const r of settled) {
		add(season, r.status, r.roi);
		const wk = weeks.get(r.week) ?? emptySplit();
		add(wk, r.status, r.roi);
		weeks.set(r.week, wk);
		add(r.line < 0 ? favorites : dogs, r.status, r.roi);
		if (r.signalSide === "A" || r.signalSide === "B") {
			const agree = r.signalSide === r.side;
			add(agree ? withSignal : againstSignal, r.status, r.roi);
			// The signal's result on this game: same as ours when it agreed,
			// mirrored otherwise (push stays push). Its ROI is at its own
			// price, which we approximate with the complement of ours.
			const signalStatus = agree
				? r.status
				: r.status === "win"
					? "loss"
					: r.status === "loss"
						? "win"
						: "push";
			const signalPrice = agree ? r.price : 1 - r.price;
			const signalRoi =
				signalStatus === "win" && signalPrice > 0 ? 1 / signalPrice - 1 : signalStatus === "loss" ? -1 : 0;
			add(signalItself, signalStatus, signalRoi);
		}
	}
	let streak = 0;
	for (let i = settled.length - 1; i >= 0; i -= 1) {
		const s = settled[i].status;
		if (s === "push") continue;
		const dir = s === "win" ? 1 : -1;
		if (streak === 0) streak = dir;
		else if (Math.sign(streak) === dir) streak += dir;
		else break;
	}
	return {
		season,
		byWeek: [...weeks.entries()].sort((a, b) => a[0] - b[0]).map(([week, s]) => ({ week, ...s })),
		favorites,
		dogs,
		withSignal,
		againstSignal,
		signalItself,
		streak,
		pending,
	};
}
