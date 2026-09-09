import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client";
import {
	classifyWalletTrade,
	collectWalletTrades,
	measureWalletBook,
	parseWalletTrade,
	walletTradeKey,
} from "./wallet-trades";

const NOW = 1_789_000_000;
const WALLET = `0x${"a".repeat(40)}`;
const CONDITION = `0x${"b".repeat(64)}`;
const TX = `0x${"c".repeat(64)}`;
const rawTrade = {
	proxyWallet: WALLET,
	transactionHash: TX,
	conditionId: CONDITION,
	asset: "12345",
	side: "BUY",
	outcome: "Yes",
	timestamp: NOW,
	price: 0.5,
	size: 200,
};
const trade = parseWalletTrade(rawTrade, WALLET, NOW - 900, NOW);
if (!trade) throw new Error("Invalid trade fixture");
const market = {
	condition_id: CONDITION,
	sport_series_id: 3,
	event_time: new Date((NOW + 3600) * 1000).toISOString(),
	side_a_label: "Yes",
	side_b_label: "No",
};
const book = {
	market: CONDITION,
	asset_id: "12345",
	timestamp: String(NOW * 1000),
	min_order_size: "5",
	asks: [
		{ price: "0.6", size: "100" },
		{ price: "0.5", size: "10" },
	],
	bids: [{ price: "0.4", size: "100" }],
};
let sqlite: DatabaseSync;
let db: Db;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW * 1000);
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockReset();
	sqlite = new DatabaseSync(":memory:");
	for (const file of [
		"0025_add_wallet_entries.sql",
		"0001_sharp_base.sql",
		"0004_add_sharp_history.sql",
		"0039_wallet_trade_pilot.sql",
		"0040_wallet_trade_measurement.sql",
	])
		sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
	db = {
		prepare(query: string) {
			const statement = sqlite.prepare(query);
			const bound = (params: (string | number | null)[]) => ({
				all: async () => ({ results: statement.all(...params) }),
				run: async () => ({
					meta: { changes: Number(statement.run(...params).changes) },
				}),
				first: async () => statement.get(...params) ?? null,
			});
			return {
				...bound([]),
				bind: (...params: (string | number | null)[]) => bound(params),
			};
		},
	} as unknown as Db;
});
afterEach(() => {
	sqlite.close();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function seed() {
	sqlite
		.prepare(`INSERT INTO wallet_entries (wallet_address, condition_id, side, kind,
		entry_price, delta_usd, total_usd, observed_at, sport_series_id, event_time, market_title)
		VALUES (?, ?, 'A', 'increase', .5, 100, 100, ?, 3, ?, 'game')`)
		.run(WALLET, CONDITION, NOW - 100, NOW + 3600);
	sqlite
		.prepare(`INSERT INTO sharp_money_cache (id, condition_id, market_title, event_time,
		sport_series_id, side_a_label, side_b_label, updated_at) VALUES ('m', ?, 'game', ?, 3, 'Yes', 'No', ?)`)
		.run(CONDITION, market.event_time, NOW);
	fetchMock.mockImplementation(async (input) => {
		const url = new URL(String(input));
		if (url.hostname.startsWith("gamma"))
			return Response.json([
				{
					conditionId: CONDITION,
					outcomes: '["Yes","No"]',
					clobTokenIds: '["12345","67890"]',
					gameStartTime: market.event_time,
					events: [{ id: "12", series: [{ id: "3" }] }],
				},
			]);
		return Response.json(
			url.hostname.startsWith("data-api") ? [rawTrade] : book,
		);
	});
}

describe("trade identity and timing", () => {
	it("validates wallet, cash minimum, timestamp and numeric types", () => {
		expect(trade).not.toBeNull();
		for (const override of [
			{ proxyWallet: `0x${"d".repeat(40)}` },
			{ timestamp: NOW + 1 },
			{ timestamp: NOW - 901 },
			{ size: 199 },
			{ price: "0.5" },
			{ price: Infinity },
			{ asset: "bad" },
			{ transactionHash: "missing" },
			{ side: "REDEEM" },
		])
			expect(
				parseWalletTrade({ ...rawTrade, ...override }, WALLET, NOW - 900, NOW),
			).toBeNull();
	});
	it("distinguishes assets and actions within a transaction", () => {
		expect(walletTradeKey(trade)).not.toBe(
			walletTradeKey({ ...trade, token: "2" }),
		);
		expect(walletTradeKey(trade)).not.toBe(
			walletTradeKey({ ...trade, action: "SELL" }),
		);
	});
	it("requires exact, unique outcomes and pre-event time", () => {
		expect(classifyWalletTrade(trade, market, NOW).status).toBe("eligible");
		expect(
			classifyWalletTrade(trade, { ...market, sport_series_id: 12756 }, NOW)
				.sport,
		).toBe("ncaaf");
		expect(classifyWalletTrade(trade, undefined, NOW).status).toBe(
			"unknown_market",
		);
		expect(
			classifyWalletTrade(trade, { ...market, side_b_label: "Yes" }, NOW)
				.status,
		).toBe("unknown_outcome");
		expect(
			classifyWalletTrade({ ...trade, outcome: "Y" }, market, NOW).status,
		).toBe("unknown_outcome");
		expect(classifyWalletTrade(trade, market, NOW + 2701).status).toBe(
			"too_late",
		);
		expect(
			classifyWalletTrade({ ...trade, action: "SELL" }, market, NOW).status,
		).toBe("sell_observed");
	});
});
describe("executable-price measurement", () => {
	it("walks sorted asks using dollars rather than averaging prices", () => {
		const measured = measureWalletBook(book, trade, NOW);
		expect(measured).toMatchObject({
			status: "quoted",
			bookAt: NOW,
			bid: 0.4,
			ask: 0.5,
			shares: 15,
		});
		expect(measured.price).toBeCloseTo(8 / 15);
	});
	it.each([
		[{ market: TX }, "invalid_book"],
		[{ asset_id: "other" }, "invalid_book"],
		[{ timestamp: String((NOW - 61) * 1000) }, "stale_book"],
		[{ timestamp: String(NOW + 6) }, "stale_book"],
		[{ asks: [] }, "empty_book"],
		[{ bids: [] }, "empty_book"],
		[{ asks: [{ price: "0.3", size: "100" }] }, "crossed_book"],
		[{ asks: [{ price: "0.5", size: "1" }] }, "insufficient_depth"],
		[{ min_order_size: "100" }, "below_minimum"],
		[{ asks: [{ price: "NaN", size: "1" }] }, "invalid_book"],
	])("rejects unusable book %j", (override, status) => {
		expect(measureWalletBook({ ...book, ...override }, trade, NOW).status).toBe(
			status,
		);
	});
});
describe("collector with real SQLite", () => {
	it("freezes prior selection even if newer observations and profits are added", async () => {
		seed();
		await collectWalletTrades(db);
		const before = JSON.parse(
			String(
				sqlite.prepare("SELECT cohort_json FROM wallet_trade_pilot").get()
					?.cohort_json,
			),
		);
		sqlite
			.prepare(`INSERT INTO wallet_entries (wallet_address, condition_id, side, kind,
			entry_price, delta_usd, total_usd, observed_at, sport_series_id, event_time, market_title, clv)
			VALUES (?, ?, 'A', 'increase', .5, 100, 100, ?, 3, ?, 'game', .5)`)
			.run(`0x${"d".repeat(40)}`, CONDITION, NOW + 60, NOW + 3600);
		vi.setSystemTime((NOW + 120) * 1000);
		await collectWalletTrades(db);
		const after = JSON.parse(
			String(
				sqlite.prepare("SELECT cohort_json FROM wallet_trade_pilot").get()
					?.cohort_json,
			),
		);
		expect(
			after.map(
				({ lastPoll: _, ...wallet }: Record<string, unknown>) => wallet,
			),
		).toEqual(
			before.map(
				({ lastPoll: _, ...wallet }: Record<string, unknown>) => wallet,
			),
		);
	});
	it("records sells without requesting a buy quote", async () => {
		seed();
		fetchMock.mockResolvedValue(Response.json([{ ...rawTrade, side: "SELL" }]));
		expect(await collectWalletTrades(db)).toMatchObject({
			inserted: 1,
			eligible: 0,
			quoted: 0,
		});
		expect(fetchMock).toHaveBeenCalledTimes(2); // Trade poll + future-only metadata.
	});
	it("freezes enrollment, captures once, and never substitutes a later quote", async () => {
		seed();
		expect(await collectWalletTrades(db)).toMatchObject({
			inserted: 1,
			quoted: 1,
			errors: 0,
		});
		const original = sqlite
			.prepare("SELECT * FROM wallet_trade_observations")
			.get();
		expect(original).toMatchObject({
			trade_at: NOW,
			detected_at: NOW,
			quote_received_at: NOW,
			quote_status: "quoted",
			follow_shares: 15,
		});
		expect(await collectWalletTrades(db)).toMatchObject({ ran: false });
		vi.setSystemTime((NOW + 120) * 1000);
		expect(await collectWalletTrades(db)).toMatchObject({
			inserted: 0,
			duplicates: 1,
		});
		expect(
			sqlite.prepare("SELECT * FROM wallet_trade_observations").get(),
		).toEqual(original);
		const dataUrl = new URL(String(fetchMock.mock.calls[0][0]));
		expect(dataUrl.searchParams.get("takerOnly")).toBe("false");
		expect(dataUrl.searchParams.get("start")).toBe(String(NOW));
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});
	it("persists quote failures and will not retry them on replay", async () => {
		seed();
		fetchMock
			.mockResolvedValueOnce(Response.json([rawTrade]))
			.mockRejectedValueOnce(new Error("timeout"));
		expect(await collectWalletTrades(db)).toMatchObject({
			errors: 1,
			quoted: 0,
		});
		vi.setSystemTime((NOW + 120) * 1000);
		await collectWalletTrades(db);
		expect(
			sqlite
				.prepare(
					"SELECT quote_status, follow_price FROM wallet_trade_observations",
				)
				.get(),
		).toMatchObject({ quote_status: "quote_error", follow_price: null });
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});
	it("bounds pages, inserts, and quotes; permanently remembers truncated trades", async () => {
		seed();
		const page = Array.from({ length: 100 }, (_, i) => ({
			...rawTrade,
			size: 200 + i,
		}));
		fetchMock.mockImplementation(async (input) =>
			Response.json(String(input).includes("data-api") ? page : book),
		);
		expect(await collectWalletTrades(db)).toMatchObject({
			cappedPages: 1,
			truncated: 90,
			inserted: 10,
			quoted: 6,
			eligible: 10,
		});
		expect(
			sqlite.prepare("SELECT COUNT(*) n FROM wallet_trade_skips").get()?.n,
		).toBe(90);
		vi.setSystemTime((NOW + 120) * 1000);
		expect(await collectWalletTrades(db)).toMatchObject({
			inserted: 0,
			duplicates: 100,
		});
		expect(fetchMock).toHaveBeenCalledTimes(9);
	});
	it("reports trade API failures and poll gaps without fabricating trades", async () => {
		seed();
		await collectWalletTrades(db);
		vi.setSystemTime((NOW + 1000) * 1000);
		fetchMock.mockRejectedValue(new Error("HTTP 429"));
		expect(await collectWalletTrades(db)).toMatchObject({
			gaps: 1,
			errors: 1,
			inserted: 0,
		});
		expect(
			sqlite.prepare("SELECT lease_until FROM wallet_trade_pilot").get()
				?.lease_until,
		).toBe(0);
	});
	it("stops at seven days and does not automatically replace an empty cohort", async () => {
		expect(await collectWalletTrades(db)).toMatchObject({ emptyCohort: true });
		seed();
		vi.setSystemTime((NOW + 120) * 1000);
		expect(await collectWalletTrades(db)).toMatchObject({ emptyCohort: true });
		vi.setSystemTime((NOW + 7 * 86400) * 1000);
		expect(await collectWalletTrades(db)).toMatchObject({
			ran: false,
			reason: "expired",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("does not acquire an occupied lease", async () => {
		seed();
		sqlite
			.prepare("UPDATE wallet_trade_pilot SET lease_until=?")
			.run(NOW + 300);
		expect(await collectWalletTrades(db)).toMatchObject({ ran: false });
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("keeps a claimed quote missing after a simulated crash", async () => {
		seed();
		await collectWalletTrades(db);
		sqlite.exec(
			"UPDATE wallet_trade_observations SET quote_status='pending', follow_price=NULL",
		);
		vi.setSystemTime((NOW + 120) * 1000);
		await collectWalletTrades(db);
		expect(
			sqlite.prepare("SELECT quote_status FROM wallet_trade_observations").get()
				?.quote_status,
		).toBe("pending");
	});
});
