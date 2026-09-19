import { describe, expect, it } from "vitest";
import {
	type BoardPickRow,
	boardStats,
	lineForSide,
	nflWeekBounds,
	nflWeekOf,
	parseSpreadTitle,
	pickMainLine,
	type SpreadMarket,
} from "./nfl-board";

describe("nfl week arithmetic", () => {
	it("week 1 = Thu 2026-09-10 through Tue; week 2 starts Wed 2026-09-16", () => {
		expect(nflWeekOf(Date.UTC(2026, 8, 10, 0, 20) / 1000)).toBe(1);
		expect(nflWeekOf(Date.UTC(2026, 8, 15, 23, 59) / 1000)).toBe(1);
		expect(nflWeekOf(Date.UTC(2026, 8, 16, 0, 0) / 1000)).toBe(2);
		expect(nflWeekOf(Date.UTC(2026, 8, 20, 17, 0) / 1000)).toBe(2);
		expect(nflWeekBounds(2).start).toBe(Date.UTC(2026, 8, 16) / 1000);
	});
});

describe("parseSpreadTitle / lineForSide", () => {
	it("parses matchup, named team and line", () => {
		expect(parseSpreadTitle("GB vs NYJ: Spread: Packers (-3.5)")).toEqual({
			matchup: "GB vs NYJ",
			namedTeam: "Packers",
			line: -3.5,
		});
		expect(parseSpreadTitle("GB vs NYJ: O/U 44.5")).toBeNull();
	});
	it("gives the other team the opposite sign", () => {
		const p = parseSpreadTitle("NO vs BAL: Spread: BAL (-8.5)")!;
		expect(lineForSide(p, "BAL")).toBe(-8.5);
		expect(lineForSide(p, "NO")).toBe(8.5);
	});
});

describe("pickMainLine", () => {
	const mk = (id: string, a: number, b: number, volume = 0): SpreadMarket => ({
		conditionId: id,
		eventSlug: "nfl-x-y-2026-09-20",
		marketTitle: `X vs Y: Spread: X (${id})`,
		eventTime: 0,
		sideALabel: "X",
		sideBLabel: "Y",
		sideAPrice: a,
		sideBPrice: b,
		sharpSide: null,
		volume,
	});
	it("takes the line priced closest to 50/50, volume breaks ties", () => {
		expect(
			pickMainLine([
				mk("-9.5", 0.34, 0.67),
				mk("-4.5", 0.5, 0.51),
				mk("-5.5", 0.47, 0.54),
			])?.conditionId,
		).toBe("-4.5");
		expect(
			pickMainLine([mk("a", 0.5, 0.51, 10), mk("b", 0.5, 0.51, 90)])
				?.conditionId,
		).toBe("b");
		expect(pickMainLine([])).toBeNull();
	});
});

describe("boardStats", () => {
	const row = (p: Partial<BoardPickRow>): BoardPickRow => ({
		week: 1,
		side: "A",
		line: -3.5,
		price: 0.5,
		status: "pending",
		roi: null,
		signalSide: null,
		eventTime: 1,
		...p,
	});
	it("rolls up record, ROI, fav/dog, signal agreement and streak", () => {
		const s = boardStats([
			row({ status: "win", roi: 1, eventTime: 1, signalSide: "A" }),
			row({
				status: "loss",
				roi: -1,
				eventTime: 2,
				line: 3.5,
				signalSide: "B",
			}),
			row({ status: "push", roi: 0, eventTime: 3 }),
			row({ status: "win", roi: 1.2, eventTime: 4, week: 2 }),
			row({ status: "win", roi: 0.8, eventTime: 5, week: 2 }),
			row({ eventTime: 6, week: 2 }),
		]);
		expect(s.season).toMatchObject({ n: 5, wins: 3, losses: 1, pushes: 1 });
		expect(s.season.roiPct).toBeCloseTo(50, 5);
		expect(s.byWeek.map((w) => [w.week, w.wins, w.losses])).toEqual([
			[1, 1, 1],
			[2, 2, 0],
		]);
		expect(s.favorites.n).toBe(4);
		expect(s.dogs.n).toBe(1);
		expect(s.withSignal).toMatchObject({ wins: 1, losses: 0 });
		expect(s.againstSignal).toMatchObject({ wins: 0, losses: 1 });
		// signal: agreed on the win (win), disagreed on our loss (its win)
		expect(s.signalItself).toMatchObject({ wins: 2, losses: 0 });
		expect(s.streak).toBe(2);
		expect(s.pending).toBe(1);
	});
});
