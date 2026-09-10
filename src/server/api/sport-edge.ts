/**
 * GET /api/sport-edge?sport=nfl[&split=YYYY-MM-DD][&since=YYYY-MM-DD][&format=text]
 *
 * The pre-registered per-sport read (docs/audits/2026-09-10-football-plan.md):
 * every settled shadow row for the sport, cut into named cells, scored on BOTH
 * readouts (ROI to resolution, CLV to the Polymarket close), ONE ROW PER GAME
 * (first-created row per game per cell, because rows inside one game are
 * correlated), split into train (created before `split`) and test.
 * Public, read-only aggregates; no addresses, no verdict beyond the rule.
 */
import { all } from "../db/client";
import type { Env } from "../env";

const SEASON_START: Record<string, string> = {
	nfl: "2026-09-09",
	ncaaf: "2026-08-23",
	mlb: "2026-07-30",
	nba: "2026-10-20",
	nhl: "2026-10-07",
	ncaab: "2026-11-03",
};

interface Row {
	condition_id: string;
	market_type: string | null;
	market_title: string;
	sharp_side_label: string | null;
	price: number;
	roi: number;
	clv: number | null;
	reject_reason: string;
	created_at: number;
	event_time: number;
	gates_json: string | null;
	signal_score: number | null;
	edge_rating: number | null;
	price_edge: number | null;
}

interface Feat extends Row {
	pos: "home" | "away" | "over" | "under" | null;
	game: string;
	test: boolean;
	line: number | null;
	spread: number | null;
	allpass: boolean | null;
	hourEt: number;
}

function teams(title: string): string[] {
	const seg = title.split(":").find((p) => / vs\.? /.test(p)) ?? title;
	return seg
		.replace(" vs. ", " vs ")
		.split(" vs ")
		.map((x) => x.trim().toLowerCase());
}

function sidePos(title: string, label: string | null): Feat["pos"] {
	const lab = (label ?? "").toLowerCase();
	if (lab === "over") return "over";
	if (lab === "under") return "under";
	const t = teams(title);
	if (t.length === 2 && lab) {
		if (lab.includes(t[0]) || t[0].includes(lab)) return "away";
		if (lab.includes(t[1]) || t[1].includes(lab)) return "home";
	}
	return null;
}

function toFeat(r: Row, split: number): Feat {
	const t = teams(r.market_title);
	const day = new Date(r.event_time * 1000).toISOString().slice(0, 10);
	const line = r.market_title.match(/O\/U\s*([\d.]+)/);
	const spread = r.market_title.match(/\(([-+][\d.]+)\)/);
	let allpass: boolean | null = null;
	if (r.gates_json) {
		try {
			const g = JSON.parse(r.gates_json) as Record<string, { pass?: boolean }>;
			allpass = Object.values(g).every((v) => v?.pass === true);
		} catch {
			allpass = null;
		}
	}
	return {
		...r,
		pos: sidePos(r.market_title, r.sharp_side_label),
		game:
			t.length === 2
				? `${day}:${[...t].sort().join("|")}`
				: `${day}:${r.condition_id.slice(0, 8)}`,
		test: r.created_at >= split,
		line: line ? Number(line[1]) : null,
		spread: spread ? Math.abs(Number(spread[1])) : null,
		allpass,
		hourEt:
			(new Date((r.event_time - 4 * 3600) * 1000).getUTCHours() + 24) % 24,
	};
}

export interface CellStat {
	roiPct: number | null;
	z: number | null;
	clvPct: number | null;
	games: number;
}

function stat(rows: Feat[]): CellStat {
	const seen = new Set<string>();
	const one: Feat[] = [];
	for (const r of [...rows].sort((a, b) => a.created_at - b.created_at)) {
		if (seen.has(r.game)) continue;
		seen.add(r.game);
		one.push(r);
	}
	const n = one.length;
	if (n < 2) return { roiPct: null, z: null, clvPct: null, games: n };
	const m = one.reduce((s, r) => s + r.roi, 0) / n;
	const sd = Math.sqrt(one.reduce((s, r) => s + (r.roi - m) ** 2, 0) / (n - 1));
	const c = one.filter((r) => r.clv != null).map((r) => r.clv as number);
	return {
		roiPct: m * 100,
		z: sd > 0 ? m / (sd / Math.sqrt(n)) : 0,
		clvPct: c.length ? (c.reduce((s, x) => s + x, 0) / c.length) * 100 : null,
		games: n,
	};
}

const CUTS: {
	name: string;
	fn: (r: Feat, ctx: { hiLine: number }) => boolean;
}[] = [
	{ name: "ALL", fn: () => true },
	{ name: "moneyline", fn: (r) => r.market_type === "moneyline" },
	{ name: "spread", fn: (r) => r.market_type === "spread" },
	{ name: "total", fn: (r) => r.market_type === "total" },
	{ name: "all 5 gates pass", fn: (r) => r.allpass === true },
	{
		name: "probation-reason",
		fn: (r) => r.reject_reason.includes("probation"),
	},
	{
		name: "ML home dog",
		fn: (r) =>
			r.market_type === "moneyline" && r.pos === "home" && r.price < 0.5,
	},
	{
		name: "ML home fav",
		fn: (r) =>
			r.market_type === "moneyline" && r.pos === "home" && r.price >= 0.5,
	},
	{
		name: "ML away dog",
		fn: (r) =>
			r.market_type === "moneyline" && r.pos === "away" && r.price < 0.5,
	},
	{
		name: "ML away fav",
		fn: (r) =>
			r.market_type === "moneyline" && r.pos === "away" && r.price >= 0.5,
	},
	{
		name: "spread home",
		fn: (r) => r.market_type === "spread" && r.pos === "home",
	},
	{
		name: "spread away",
		fn: (r) => r.market_type === "spread" && r.pos === "away",
	},
	{
		name: "spread key 3/7",
		fn: (r) =>
			r.spread != null &&
			((r.spread >= 2.5 && r.spread <= 3.5) ||
				(r.spread >= 6.5 && r.spread <= 7.5)),
	},
	{ name: "spread big (>= 10)", fn: (r) => r.spread != null && r.spread >= 10 },
	{ name: "Total Under", fn: (r) => r.pos === "under" },
	{ name: "Total Over", fn: (r) => r.pos === "over" },
	{
		name: "Under, high line (top third)",
		fn: (r, c) => r.pos === "under" && r.line != null && r.line >= c.hiLine,
	},
	{
		name: "Over, high line (top third)",
		fn: (r, c) => r.pos === "over" && r.line != null && r.line >= c.hiLine,
	},
	{ name: "day (ET < 17)", fn: (r) => r.hourEt < 17 },
	{ name: "primetime (ET >= 19)", fn: (r) => r.hourEt >= 19 },
	{ name: "signal_score >= 90", fn: (r) => (r.signal_score ?? 0) >= 90 },
	{
		name: "edge_rating 80-90",
		fn: (r) =>
			r.edge_rating != null && r.edge_rating >= 80 && r.edge_rating < 90,
	},
	{ name: "price_edge >= .25", fn: (r) => (r.price_edge ?? 0) >= 0.25 },
	{ name: "price >= .6 (big fav)", fn: (r) => r.price >= 0.6 },
	{ name: "price <= .35 (big dog)", fn: (r) => r.price <= 0.35 },
];

export async function handleSportEdgeRequest(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const url = new URL(request.url);
	if (url.pathname !== "/api/sport-edge") return null;
	if (request.method !== "GET")
		return new Response("method not allowed", { status: 405 });
	const sport = (url.searchParams.get("sport") ?? "").toLowerCase();
	if (!/^[a-z0-9]{2,12}$/.test(sport))
		return new Response("bad sport", { status: 400 });
	const since =
		url.searchParams.get("since") ?? SEASON_START[sport] ?? "2026-07-30";
	const sinceTs = Date.parse(`${since}T00:00:00Z`) / 1000;
	if (!Number.isFinite(sinceTs))
		return new Response("bad since", { status: 400 });
	const now = Math.floor(Date.now() / 1000);
	const splitParam = url.searchParams.get("split");
	const split = splitParam
		? Date.parse(`${splitParam}T00:00:00Z`) / 1000
		: sinceTs + (now - sinceTs) / 2;
	if (!Number.isFinite(split))
		return new Response("bad split", { status: 400 });

	const rows = await all<Row>(
		env.POLYWHALER_DB,
		`SELECT condition_id, market_type, market_title, sharp_side_label, price, roi, clv, reject_reason,
		        created_at, event_time, gates_json, signal_score, edge_rating, price_edge
		 FROM shadow_candidates
		 WHERE sport_tag = ? AND roi IS NOT NULL AND event_time >= ? AND price IS NOT NULL
		 ORDER BY created_at`,
		sport,
		sinceTs,
	);
	const feats = rows.map((r) => toFeat(r, split));
	const lines = feats
		.filter((f) => f.line != null)
		.map((f) => f.line as number)
		.sort((a, b) => a - b);
	const hiLine = lines.length
		? lines[Math.floor(lines.length * (2 / 3))]
		: Number.POSITIVE_INFINITY;
	const games = new Set(feats.map((f) => f.game)).size;
	const cells = CUTS.map(({ name, fn }) => {
		const train = stat(feats.filter((f) => !f.test && fn(f, { hiLine })));
		const test = stat(feats.filter((f) => f.test && fn(f, { hiLine })));
		const holds =
			train.games >= 40 &&
			test.games >= 40 &&
			(train.roiPct ?? 0) > 0 &&
			(test.roiPct ?? 0) > 0 &&
			(train.clvPct ?? 0) > 0 &&
			(test.clvPct ?? 0) > 0;
		return { name, train, test, holds };
	});
	const payload = {
		sport,
		since,
		split: new Date(split * 1000).toISOString().slice(0, 10),
		generatedAt: new Date().toISOString(),
		rows: feats.length,
		games,
		hiLine: Number.isFinite(hiLine) ? hiLine : null,
		rule: "HOLD = ROI > 0 and CLV > 0 in both halves with >= 40 games each; one row per game per cell; ~1 in 16 cuts holds by chance",
		cells,
	};
	if (url.searchParams.get("format") === "text") {
		const f = (s: CellStat) =>
			s.games < 2
				? `${"n/a".padStart(8)} ${"".padStart(5)} ${"".padStart(7)} ${String(s.games).padStart(5)}`
				: `${(s.roiPct ?? 0).toFixed(1).padStart(7)}% ${(s.z ?? 0).toFixed(1).padStart(5)} ${(s.clvPct ?? 0).toFixed(2).padStart(6)}c ${String(s.games).padStart(5)}`;
		const out = [
			`${sport.toUpperCase()} shadow read — since ${since}, split ${payload.split}, ${feats.length} rows / ${games} games, high-line cutoff ${payload.hiLine ?? "n/a"}`,
			`${"cut (one row per game)".padEnd(32)} | ${"TRAIN roi".padStart(8)} ${"z".padStart(5)} ${"clv".padStart(7)} ${"games".padStart(5)} | ${"TEST roi".padStart(8)} ${"z".padStart(5)} ${"clv".padStart(7)} ${"games".padStart(5)} | verdict`,
			...cells.map(
				(c) =>
					`${c.name.padEnd(32)} | ${f(c.train)} | ${f(c.test)} | ${c.holds ? "HOLDS" : ""}`,
			),
			"",
			payload.rule,
		];
		return new Response(out.join("\n"), {
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	}
	return new Response(JSON.stringify(payload), {
		headers: { "content-type": "application/json" },
	});
}
