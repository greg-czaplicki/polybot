import { describe, expect, it } from "vitest";
import {
	devigTwoWay,
	mapTotalsToPick,
	parseMarketTotalLine,
} from "./book-odds";
import {
	extractPinnaclePrices,
	matchOddsApiEvent,
	type OddsApiEvent,
	parseTitleTeams,
} from "./pinnacle-odds";

const T0 = 1786400000; // arbitrary fixed event time (seconds)

function iso(seconds: number): string {
	return new Date(seconds * 1000).toISOString();
}

function pinnacleEvent(overrides?: Partial<OddsApiEvent>): OddsApiEvent {
	return {
		id: "ev1",
		commence_time: iso(T0),
		home_team: "Houston Astros",
		away_team: "San Diego Padres",
		bookmakers: [
			{
				key: "pinnacle",
				markets: [
					{
						key: "h2h",
						outcomes: [
							{ name: "Houston Astros", price: -130 },
							{ name: "San Diego Padres", price: 110 },
						],
					},
					{
						key: "totals",
						outcomes: [
							{ name: "Over", price: -105, point: 8.5 },
							{ name: "Under", price: -115, point: 8.5 },
						],
					},
				],
			},
		],
		...overrides,
	};
}

describe("parseMarketTotalLine", () => {
	it("parses the O/U line from a Polymarket totals title", () => {
		expect(
			parseMarketTotalLine("Houston Astros vs. San Diego Padres: O/U 9.5"),
		).toBe(9.5);
		expect(parseMarketTotalLine("NYC FC vs. Inter Miami: O/U 2.5")).toBe(2.5);
	});
	it("returns null for non-totals titles", () => {
		expect(parseMarketTotalLine("Houston Astros vs. San Diego Padres")).toBe(
			null,
		);
	});
});

describe("mapTotalsToPick", () => {
	const odds = {
		homeSpread: null,
		totalLine: 8.5,
		homeMoneyline: null,
		awayMoneyline: null,
		overOdds: -105,
		underOdds: -115,
	};
	it("orients over/under prices to the pick side", () => {
		expect(mapTotalsToPick(odds, "Over", 8.5)).toEqual({
			mlSide: -105,
			mlOpp: -115,
		});
		expect(mapTotalsToPick(odds, "Under", 8.5)).toEqual({
			mlSide: -115,
			mlOpp: -105,
		});
	});
	it("refuses a book line different from the market line", () => {
		expect(mapTotalsToPick(odds, "Over", 7.5)).toBe(null);
	});
	it("refuses missing sides/lines/prices", () => {
		expect(mapTotalsToPick(odds, null, 8.5)).toBe(null);
		expect(mapTotalsToPick(odds, "Yes", 8.5)).toBe(null);
		expect(mapTotalsToPick({ ...odds, overOdds: null }, "Over", 8.5)).toBe(
			null,
		);
		expect(mapTotalsToPick({ ...odds, totalLine: null }, "Over", 8.5)).toBe(
			null,
		);
	});
});

describe("matchOddsApiEvent", () => {
	const game = {
		homeName: "Houston Astros",
		awayName: "San Diego Padres",
		eventTime: T0,
	};
	it("matches on team names and commence time", () => {
		expect(matchOddsApiEvent([pinnacleEvent()], game)?.id).toBe("ev1");
	});
	it("matches flipped orientation", () => {
		const flipped = pinnacleEvent({
			home_team: "San Diego Padres",
			away_team: "Houston Astros",
		});
		expect(matchOddsApiEvent([flipped], game)?.id).toBe("ev1");
	});
	it("splits doubleheaders by proximity", () => {
		const game1 = pinnacleEvent({ id: "g1" });
		const game2 = pinnacleEvent({
			id: "g2",
			commence_time: iso(T0 + 4 * 3600),
		});
		expect(matchOddsApiEvent([game2, game1], game)?.id).toBe("g1");
		expect(
			matchOddsApiEvent([game1, game2], { ...game, eventTime: T0 + 4 * 3600 })
				?.id,
		).toBe("g2");
	});
	it("rejects events outside the 45-minute window", () => {
		const far = pinnacleEvent({ commence_time: iso(T0 + 3600) });
		expect(matchOddsApiEvent([far], game)).toBe(null);
	});
	it("rejects different matchups", () => {
		const other = pinnacleEvent({ home_team: "Texas Rangers" });
		expect(matchOddsApiEvent([other], game)).toBe(null);
	});
});

describe("extractPinnaclePrices", () => {
	it("extracts ML prices side-aware via venue role", () => {
		const prices = extractPinnaclePrices(pinnacleEvent(), {
			betType: "moneyline",
			venueRole: "home",
			sideLabel: null,
			marketTotalLine: null,
		});
		expect(prices.mlSide).toBe(-130);
		expect(prices.mlOpp).toBe(110);
		expect(prices.fairProb).toBeCloseTo(devigTwoWay(-130, 110) as number, 10);
		// raw totals stored regardless of bet type
		expect(prices.totalLine).toBe(8.5);
	});
	it("de-vigs totals only when the line matches the market", () => {
		const match = extractPinnaclePrices(pinnacleEvent(), {
			betType: "total",
			venueRole: null,
			sideLabel: "Under",
			marketTotalLine: 8.5,
		});
		expect(match.fairProb).toBeCloseTo(devigTwoWay(-115, -105) as number, 10);

		const mismatch = extractPinnaclePrices(pinnacleEvent(), {
			betType: "total",
			venueRole: null,
			sideLabel: "Under",
			marketTotalLine: 7.5,
		});
		expect(mismatch.fairProb).toBe(null);
		// raw prices still captured for line-movement analysis
		expect(mismatch.overOdds).toBe(-105);
		expect(mismatch.totalLine).toBe(8.5);
	});
	it("returns empty when pinnacle is absent from the event", () => {
		const noPin = pinnacleEvent({ bookmakers: [] });
		const prices = extractPinnaclePrices(noPin, {
			betType: "moneyline",
			venueRole: "home",
			sideLabel: null,
			marketTotalLine: null,
		});
		expect(prices.mlSide).toBe(null);
		expect(prices.fairProb).toBe(null);
	});
	it("de-vigs soccer three-way h2h including the draw", () => {
		const soccer = pinnacleEvent({
			home_team: "Arsenal",
			away_team: "Chelsea",
			bookmakers: [
				{
					key: "pinnacle",
					markets: [
						{
							key: "h2h",
							outcomes: [
								{ name: "Arsenal", price: 120 },
								{ name: "Chelsea", price: 240 },
								{ name: "Draw", price: 230 },
							],
						},
					],
				},
			],
		});
		const prices = extractPinnaclePrices(soccer, {
			betType: "moneyline",
			venueRole: "home",
			sideLabel: null,
			marketTotalLine: null,
		});
		expect(prices.mlSide).toBe(120);
		expect(prices.mlOpp).toBe(240);
		// implied: side 100/220, opp 100/340, draw 100/330 — normalized share
		const ps = 100 / 220;
		const po = 100 / 340;
		const pd = 100 / 330;
		expect(prices.fairProb).toBeCloseTo(ps / (ps + po + pd), 10);
		// and strictly below the draw-blind two-way de-vig
		expect(prices.fairProb as number).toBeLessThan(
			devigTwoWay(120, 240) as number,
		);
	});
	it("returns no ML fair prob without a venue role", () => {
		const prices = extractPinnaclePrices(pinnacleEvent(), {
			betType: "moneyline",
			venueRole: null,
			sideLabel: null,
			marketTotalLine: null,
		});
		expect(prices.fairProb).toBe(null);
	});
});

describe("parseTitleTeams", () => {
	it("parses a plain moneyline title", () => {
		expect(parseTitleTeams("Houston Astros vs. San Francisco Giants")).toEqual({
			teamA: "Houston Astros",
			teamB: "San Francisco Giants",
		});
	});

	it("strips the totals suffix after the colon", () => {
		expect(
			parseTitleTeams("Colorado Rockies vs. Arizona Diamondbacks: O/U 9.5"),
		).toEqual({ teamA: "Colorado Rockies", teamB: "Arizona Diamondbacks" });
	});

	it("keeps the matchup when the colon precedes it (prop-style titles)", () => {
		expect(
			parseTitleTeams(
				"Will there be a run scored in the first inning?: Milwaukee Brewers vs. San Diego Padres",
			),
		).toEqual({ teamA: "Milwaukee Brewers", teamB: "San Diego Padres" });
	});

	it("returns null when there is no matchup", () => {
		expect(parseTitleTeams("Some unrelated market")).toBe(null);
		expect(parseTitleTeams("A vs. B vs. C")).toBe(null);
	});

	it("parses tennis titles with bare ' vs ' and a tournament prefix", () => {
		expect(
			parseTitleTeams(
				"US Open, Qualification ATP: Alex Bolt vs Pablo Llamas Ruiz",
			),
		).toEqual({ teamA: "Alex Bolt", teamB: "Pablo Llamas Ruiz" });
		expect(
			parseTitleTeams("Monterrey Open: Clara Tauson vs Renata Zarazua"),
		).toEqual({ teamA: "Clara Tauson", teamB: "Renata Zarazua" });
	});
});

describe("matchOddsApiEvent maxGapSeconds", () => {
	it("honors a widened gap for session-timed tennis events", () => {
		const threeHoursOff = pinnacleEvent({
			commence_time: iso(T0 + 3 * 3600),
			home_team: "Alex Bolt",
			away_team: "Pablo Llamas Ruiz",
		});
		const game = {
			homeName: "Alex Bolt",
			awayName: "Pablo Llamas Ruiz",
			eventTime: T0,
		};
		expect(matchOddsApiEvent([threeHoursOff], game)).toBe(null);
		expect(
			matchOddsApiEvent([threeHoursOff], { ...game, maxGapSeconds: 6 * 3600 })
				?.id,
		).toBe("ev1");
	});
});

// ---- pinnapi adapter -------------------------------------------------------
import {
	decimalToAmerican,
	type PinnapiEvent,
	pinnapiLeagueMatches,
	pinnapiToOddsApiEvent,
} from "./pinnacle-odds";

function pinnapiEvent(overrides?: Partial<PinnapiEvent>): PinnapiEvent {
	return {
		event_id: 1634328785,
		league_name: "MLB",
		starts: iso(T0),
		home: "Detroit Tigers",
		away: "Tampa Bay Rays",
		is_have_odds: true,
		periods: {
			num_0: {
				money_line: { home: 1.8547, away: 2.08, draw: null },
				totals: {
					"7": { points: 7, over: 1.6667, under: 2.3 },
					"8": { points: 8, over: 2.1, under: 1.7937 },
					"7.5": { points: 7.5, over: 1.87, under: 1.99 },
				},
			},
		},
		...overrides,
	};
}

describe("decimalToAmerican", () => {
	it("converts favourites and underdogs to one decimal place", () => {
		expect(decimalToAmerican(2.08)).toBe(108);
		expect(decimalToAmerican(1.8547)).toBe(-117);
		expect(decimalToAmerican(2)).toBe(100);
		expect(decimalToAmerican(1.5)).toBe(-200);
	});
	it("rejects impossible prices", () => {
		expect(decimalToAmerican(1)).toBeNull();
		expect(decimalToAmerican(0)).toBeNull();
		expect(decimalToAmerican(Number.NaN)).toBeNull();
	});
});

describe("pinnapiToOddsApiEvent", () => {
	it("converts the full-game moneyline and every total line", () => {
		const ev = pinnapiToOddsApiEvent(pinnapiEvent());
		expect(ev).not.toBeNull();
		expect(ev?.id).toBe("1634328785");
		expect(ev?.home_team).toBe("Detroit Tigers");
		expect(ev?.commence_time).toBe(iso(T0));
		const book = ev?.bookmakers[0];
		expect(book?.key).toBe("pinnacle");
		const h2h = book?.markets.find((m) => m.key === "h2h");
		expect(h2h?.outcomes).toEqual([
			{ name: "Detroit Tigers", price: -117 },
			{ name: "Tampa Bay Rays", price: 108 },
		]);
		const totals = book?.markets.find((m) => m.key === "totals");
		expect(totals?.outcomes.map((o) => o.point)).toEqual([
			7, 7, 7.5, 7.5, 8, 8,
		]);
		expect(totals?.outcomes[0]).toEqual({
			name: "Over",
			price: -150,
			point: 7,
		});
	});
	it("adds the draw for three-way soccer moneylines", () => {
		const ev = pinnapiToOddsApiEvent(
			pinnapiEvent({
				league_name: "Spain - La Liga",
				home: "Barcelona",
				away: "Athletic Bilbao",
				periods: {
					num_0: {
						money_line: { home: 1.303, away: 9.28, draw: 6.14 },
						totals: {},
					},
				},
			}),
		);
		const h2h = ev?.bookmakers[0].markets.find((m) => m.key === "h2h");
		expect(h2h?.outcomes.map((o) => o.name)).toEqual([
			"Barcelona",
			"Athletic Bilbao",
			"Draw",
		]);
		expect(
			ev?.bookmakers[0].markets.find((m) => m.key === "totals"),
		).toBeUndefined();
	});
	it("returns null without full-game prices", () => {
		expect(pinnapiToOddsApiEvent(pinnapiEvent({ periods: {} }))).toBeNull();
		expect(
			pinnapiToOddsApiEvent(
				pinnapiEvent({
					periods: { num_0: { money_line: null, totals: null } },
				}),
			),
		).toBeNull();
	});
});

describe("extractPinnaclePrices with a total ladder", () => {
	const ladder = pinnapiToOddsApiEvent(pinnapiEvent()) as OddsApiEvent;
	it("de-vigs the line the market is priced on, not only the main line", () => {
		const prices = extractPinnaclePrices(ladder, {
			betType: "total",
			venueRole: null,
			sideLabel: "Under",
			marketTotalLine: 8,
		});
		expect(prices.totalLine).toBe(8);
		expect(prices.overOdds).toBe(110);
		expect(prices.underOdds).toBe(-126);
		expect(prices.fairProb).toBeCloseTo(devigTwoWay(-126, 110) as number, 6);
	});
	it("reports the most balanced line as the main line when the market line is absent", () => {
		const prices = extractPinnaclePrices(ladder, {
			betType: "moneyline",
			venueRole: "home",
			sideLabel: null,
			marketTotalLine: null,
		});
		expect(prices.totalLine).toBe(7.5);
		expect(prices.fairProb).toBeCloseTo(devigTwoWay(-117, 108) as number, 6);
	});
	it("refuses a total the ladder does not price", () => {
		const prices = extractPinnaclePrices(ladder, {
			betType: "total",
			venueRole: null,
			sideLabel: "Over",
			marketTotalLine: 9.5,
		});
		expect(prices.fairProb).toBeNull();
		expect(prices.totalLine).toBe(7.5);
	});
});

describe("pinnapiLeagueMatches", () => {
	it("maps exact league labels and excludes derivative boards", () => {
		expect(pinnapiLeagueMatches("laliga", "Spain - La Liga")).toBe(true);
		expect(pinnapiLeagueMatches("laliga", "Spain - La Liga Corners")).toBe(
			false,
		);
		expect(
			pinnapiLeagueMatches("epl", "England - Premier League Cup U21"),
		).toBe(false);
		expect(
			pinnapiLeagueMatches("ucl", "UEFA - Champions League Qualifiers"),
		).toBe(true);
		expect(pinnapiLeagueMatches("ucl", "UEFA - Champions League Women")).toBe(
			false,
		);
		expect(pinnapiLeagueMatches("nfl", "NFL Pre Season")).toBe(false);
		expect(pinnapiLeagueMatches("ncaaf", "NCAA")).toBe(true);
	});
	it("takes every tour-level tennis tournament but not doubles", () => {
		expect(pinnapiLeagueMatches("atp", "ATP US Open - Qualifiers")).toBe(true);
		expect(pinnapiLeagueMatches("atp", "ATP Winston Salem - Doubles")).toBe(
			false,
		);
		expect(pinnapiLeagueMatches("wta", "WTA Monterrey - R16")).toBe(true);
		expect(pinnapiLeagueMatches("wta", "ITF Women Hurghada - R1")).toBe(false);
		expect(pinnapiLeagueMatches("unknown", "MLB")).toBe(false);
	});
});
