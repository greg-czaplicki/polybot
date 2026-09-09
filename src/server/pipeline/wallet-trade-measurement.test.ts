import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client";
import {
	getWalletTradeReport,
	WALLET_EVENT_METRICS_SQL,
	WALLET_FIRST_SIGNAL_SUMMARY_SQL,
} from "../repositories/wallet-trade-report";
import {
	captureWalletCloses,
	parseWalletCloseBook,
	settleWalletTradeCloses,
} from "./wallet-trade-closes";
import type { WalletTrade } from "./wallet-trade-common";
import {
	parseWalletMetadata,
	refreshWalletMetadata,
	resolveWalletIdentity,
} from "./wallet-trade-identity";
import { collectWalletTrades, walletTradeKey } from "./wallet-trades";

const NOW = 1_789_000_000;
const CONDITION = `0x${"a".repeat(64)}`;
const WALLET = `0x${"b".repeat(40)}`;
const TX = `0x${"c".repeat(64)}`;
const TRADE: WalletTrade = {
	wallet: WALLET,
	tx: TX,
	condition: CONDITION,
	token: "123",
	action: "BUY",
	outcome: "Team",
	at: NOW - 3600,
	price: 0.4,
	size: 300,
};
const gamma = {
	conditionId: CONDITION,
	outcomes: '["Team","Other"]',
	clobTokenIds: '["123","456"]',
	sportsMarketType: "moneyline",
	gameStartTime: new Date((NOW + 3600) * 1000).toISOString(),
	events: [{ id: "12", series: [{ id: "3" }] }],
	closed: false,
	acceptingOrders: true,
};
const book = {
	market: CONDITION,
	asset_id: "123",
	timestamp: String(NOW * 1000),
	min_order_size: "5",
	bids: [{ price: ".5", size: "100" }],
	asks: [{ price: ".6", size: "100" }],
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
		"0001_sharp_base.sql",
		"0004_add_sharp_history.sql",
		"0025_add_wallet_entries.sql",
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

function observation(
	key: string,
	options: {
		condition?: string;
		token?: string;
		event?: number;
		wallet?: string;
		eventId?: string | null;
		detected?: number;
		status?: string;
		side?: string;
		version?: number;
	} = {},
) {
	const event = options.event ?? NOW - 120;
	const detected = options.detected ?? event - 3600;
	const snapshot = {
		condition_id: options.condition ?? CONDITION,
		sport_series_id: 3,
		event_time: new Date(event * 1000).toISOString(),
		side_a_label: "Team",
		side_b_label: "Other",
		event_id: options.eventId === undefined ? "12" : options.eventId,
	};
	sqlite
		.prepare(`INSERT INTO wallet_trade_observations
		(trade_key, run_id, wallet_address, transaction_hash, condition_id, token_id, action, outcome,
		 trade_at, detected_at, wallet_price, shares, notional, sport, event_time, market_side,
		 market_snapshot_json, quote_status, quote_received_at, best_ask, follow_price, collection_version)
		VALUES (?, 'run', ?, ?, ?, ?, 'BUY', 'Team', ?, ?, .4, 300, 120, 'mlb', ?, ?, ?, ?, ?, .49, .5, ?)`)
		.run(
			key,
			options.wallet ?? WALLET,
			TX,
			options.condition ?? CONDITION,
			options.token ?? "123",
			detected - 1,
			detected,
			event,
			options.side ?? "A",
			JSON.stringify(snapshot),
			options.status ?? "quoted",
			detected + 1,
			options.version ?? 2,
		);
}
function history(
	condition: string,
	event: number,
	at: number,
	a: number | null,
	b = 0.3,
	labels = ["Team", "Other"],
) {
	sqlite
		.prepare(`INSERT INTO sharp_money_history
		(condition_id, recorded_at, market_title, event_time, sport_series_id, side_a_label, side_b_label, side_a_price, side_b_price)
		VALUES (?, ?, 'game', ?, 3, ?, ?, ?, ?)`)
		.run(
			condition,
			at,
			new Date(event * 1000).toISOString(),
			labels[0],
			labels[1],
			a,
			b,
		);
}
function metadata(
	condition = CONDITION,
	event: number = NOW - 120,
	status = "identified",
	tokens = ["123", "456"],
) {
	sqlite
		.prepare(`INSERT OR REPLACE INTO wallet_trade_market_metadata
		(condition_id, fetched_at, retry_at, status, snapshot_json, error) VALUES (?, ?, ?, ?, ?, NULL)`)
		.run(
			condition,
			NOW - 3000,
			NOW + 3000,
			status,
			status === "identified"
				? JSON.stringify({
						condition_id: condition,
						sport_series_id: 3,
						event_time: new Date(event * 1000).toISOString(),
						side_a_label: "Team",
						side_b_label: "Other",
						token_a: tokens[0],
						token_b: tokens[1],
						event_id: "12",
						identity_source: "gamma_token",
						metadata_at: NOW - 3000,
					})
				: null,
		);
}
function measurement(key: string, clv: number, source = "clob_midpoint") {
	sqlite
		.prepare(`INSERT INTO wallet_trade_measurements
		(trade_key,status,source,close_at,close_price,follow_clv,relative_clv,wallet_clv,best_ask_clv,settled_at)
		VALUES (?, 'measured', ?, ?, ?, ?, ?, ?, ?, ?)`)
		.run(
			key,
			source,
			NOW - 200,
			0.5 + clv,
			clv,
			clv / 0.5,
			clv + 0.1,
			clv + 0.01,
			NOW,
		);
}

describe("future-only stable identity", () => {
	it("requires exact condition, unique binary tokens, event and explicit game time", () => {
		expect(parseWalletMetadata([gamma], CONDITION, NOW)).toMatchObject({
			status: "identified",
			market: { token_a: "123", event_id: "12" },
		});
		for (const override of [
			{ conditionId: TX },
			{ clobTokenIds: '["123","123"]' },
			{ outcomes: '["Team","Team"]' },
		])
			expect(
				parseWalletMetadata([{ ...gamma, ...override }], CONDITION, NOW).status,
			).toBe("invalid_metadata");
		expect(
			parseWalletMetadata(
				[{ ...gamma, gameStartTime: undefined, endDate: gamma.gameStartTime }],
				CONDITION,
				NOW,
			).status,
		).toBe("unknown_event_time");
		expect(
			parseWalletMetadata(
				[{ ...gamma, gameStartTime: "2026-09-10 02:10:00+00" }],
				CONDITION,
				NOW,
			).status,
		).toBe("identified");
		expect(parseWalletMetadata([gamma, gamma], CONDITION, NOW).status).toBe(
			"invalid_metadata",
		);
	});
	it("does not call unknown series non-sports, and excludes known unsupported leagues", () => {
		const unknown = {
			...gamma,
			events: [{ id: "12", series: [{ id: "999999" }] }],
		};
		expect(parseWalletMetadata([unknown], CONDITION, NOW).status).toBe(
			"unsupported_series",
		);
		expect(
			parseWalletMetadata(
				[{ ...unknown, sportsMarketType: undefined }],
				CONDITION,
				NOW,
			).status,
		).toBe("unclassified");
		expect(
			parseWalletMetadata(
				[{ ...gamma, events: [{ id: "12", series: [{ id: "10189" }] }] }],
				CONDITION,
				NOW,
			).status,
		).toBe("unsupported_sport");
		expect(
			parseWalletMetadata([{ ...gamma, closed: true }], CONDITION, NOW).status,
		).toBe("market_inactive");
	});
	it("uses token identity rather than prefixed labels and rejects future/stale/conflicting metadata", () => {
		const parsed = parseWalletMetadata([gamma], CONDITION, NOW);
		if (!parsed.market) throw new Error("fixture");
		const metadata = {
			condition_id: CONDITION,
			fetched_at: NOW,
			status: "identified",
			snapshot_json: JSON.stringify(parsed.market),
		};
		const cached = { ...parsed.market, side_a_label: "Tournament: Team" };
		expect(
			resolveWalletIdentity(TRADE, cached, metadata, NOW).market
				?.identity_source,
		).toBe("gamma_token");
		expect(
			resolveWalletIdentity(
				TRADE,
				cached,
				{ ...metadata, fetched_at: NOW + 1 },
				NOW,
			).market?.identity_source,
		).toBe("cache_label");
		expect(
			resolveWalletIdentity(
				TRADE,
				cached,
				{ ...metadata, fetched_at: NOW - 21601 },
				NOW,
			).market?.identity_source,
		).toBe("cache_label");
		expect(
			resolveWalletIdentity({ ...TRADE, token: "999" }, cached, metadata, NOW)
				.status,
		).toBe("unknown_token");
		expect(
			resolveWalletIdentity(
				TRADE,
				{ ...cached, event_time: new Date(NOW * 1000).toISOString() },
				metadata,
				NOW,
			).status,
		).toBe("metadata_conflict");
	});
	it("retains the cached path when Gamma metadata is unusable, but honors definitive exclusions", () => {
		const parsed = parseWalletMetadata([gamma], CONDITION, NOW);
		if (!parsed.market) throw new Error("fixture");
		const cached = { ...parsed.market, side_a_label: "Tournament: Team" };
		const base = {
			condition_id: CONDITION,
			fetched_at: NOW,
			snapshot_json: null,
		};
		for (const status of [
			"unclassified",
			"unsupported_series",
			"unknown_event_time",
			"invalid_metadata",
		]) {
			const resolved = resolveWalletIdentity(
				TRADE,
				cached,
				{ ...base, status },
				NOW,
			);
			expect(resolved.status).toBeUndefined();
			expect(resolved.market?.identity_source).toBe("cache_label");
			expect(
				resolveWalletIdentity(TRADE, undefined, { ...base, status }, NOW)
					.status,
			).toBe(status);
		}
		for (const status of ["market_inactive", "unsupported_sport"])
			expect(
				resolveWalletIdentity(TRADE, cached, { ...base, status }, NOW).status,
			).toBe(status);
	});
	it("caches unmatched or non-binary Gamma responses for six hours without a run error", async () => {
		observation("one");
		fetchMock.mockResolvedValue(Response.json([]));
		expect(await refreshWalletMetadata(db)).toEqual({
			attempted: 1,
			errors: 0,
		});
		expect(
			sqlite
				.prepare(
					"SELECT status, retry_at, error FROM wallet_trade_market_metadata",
				)
				.get(),
		).toMatchObject({
			status: "invalid_metadata",
			retry_at: NOW + 21600,
			error: null,
		});
	});
	it("limits enrichment to two conditions and backs off failures", async () => {
		observation("one");
		observation("two", { condition: TX, token: "456" });
		fetchMock.mockRejectedValue(new Error("HTTP 429"));
		expect(await refreshWalletMetadata(db)).toEqual({
			attempted: 2,
			errors: 2,
		});
		expect(await refreshWalletMetadata(db)).toEqual({
			attempted: 0,
			errors: 0,
		});
		expect(
			sqlite
				.prepare("SELECT MIN(retry_at) retry FROM wallet_trade_market_metadata")
				.get()?.retry,
		).toBe(NOW + 900);
	});
	it("uses enrichment only for new trades and never substitutes a later first signal", async () => {
		sqlite
			.prepare(`INSERT INTO wallet_entries (wallet_address, condition_id, side, kind, entry_price,
			delta_usd,total_usd,observed_at,event_time,market_title,sport_series_id)
			VALUES (?, ?, 'A', 'increase', .4, 100, 100, ?, ?, 'game', 3)`)
			.run(WALLET, CONDITION, NOW - 1, NOW + 3600);
		const original = {
			proxyWallet: WALLET,
			conditionId: CONDITION,
			transactionHash: TX,
			asset: "123",
			side: "BUY",
			outcome: "Team",
			timestamp: NOW,
			price: 0.4,
			size: 300,
		};
		fetchMock.mockImplementation(async (input) => {
			const url = new URL(String(input));
			if (url.hostname.startsWith("gamma")) return Response.json([gamma]);
			if (url.hostname.startsWith("clob"))
				return Response.json({ ...book, timestamp: String(Date.now()) });
			return Response.json([
				original,
				...(Date.now() > NOW * 1000
					? [{ ...original, timestamp: NOW + 120, size: 301 }]
					: []),
			]);
		});
		expect(await collectWalletTrades(db)).toMatchObject({
			inserted: 1,
			quoted: 0,
		});
		const first = sqlite
			.prepare("SELECT * FROM wallet_trade_observations")
			.get();
		expect(first?.quote_status).toBe("unknown_market");
		vi.setSystemTime((NOW + 120) * 1000);
		expect(await collectWalletTrades(db)).toMatchObject({
			inserted: 1,
			quoted: 1,
		});
		expect(
			sqlite
				.prepare("SELECT * FROM wallet_trade_observations WHERE trade_at=?")
				.get(NOW),
		).toEqual(first);
		expect(sqlite.prepare(WALLET_FIRST_SIGNAL_SUMMARY_SQL).get()).toMatchObject(
			{ first_buys: 1, first_quotes: 0 },
		);
	});
});

describe("pregame close boundaries", () => {
	it("continues recorded close capture after cohort expiry without polling wallets", async () => {
		observation("one", { event: NOW + 300 });
		metadata(CONDITION, NOW + 300);
		sqlite
			.prepare(
				"UPDATE wallet_trade_pilot SET enrolled_at=?, expires_at=?, cohort_json='[]'",
			)
			.run(NOW - 1000, NOW - 1);
		fetchMock.mockResolvedValue(Response.json(book));
		expect(await collectWalletTrades(db)).toMatchObject({
			ran: false,
			reason: "expired",
			maintenance: { closes: { captured: 1 } },
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0][0])).toContain(
			"clob.polymarket.com/book",
		);
	});
	it("operator pause prevents all new pilot requests and reports paused", async () => {
		observation("one", { event: NOW + 300 });
		sqlite.exec("UPDATE wallet_trade_pilot SET enabled=0");
		expect(await collectWalletTrades(db)).toMatchObject({ ran: false });
		expect(fetchMock).not.toHaveBeenCalled();
		expect((await getWalletTradeReport(db)).stage).toBe("paused");
	});
	it("uses an uncrossed midpoint and rejects post-start/stale/wrong-token books", () => {
		expect(
			parseWalletCloseBook(book, CONDITION, "123", NOW + 300, NOW),
		).toMatchObject({ status: "captured", midpoint: 0.55 });
		for (const [raw, event, received] of [
			[book, NOW, NOW],
			[book, NOW + 601, NOW],
			[{ ...book, timestamp: String((NOW - 61) * 1000) }, NOW + 300, NOW],
			[{ ...book, asset_id: "456" }, NOW + 300, NOW],
			[{ ...book, bids: [{ price: ".7", size: "100" }] }, NOW + 300, NOW],
		] as const)
			expect(
				parseWalletCloseBook(raw, CONDITION, "123", event, received).midpoint,
			).toBeNull();
	});
	it("keeps a valid close when a subsequent attempt fails", async () => {
		observation("one", { event: NOW + 300 });
		metadata(CONDITION, NOW + 300);
		fetchMock.mockResolvedValueOnce(Response.json(book));
		expect(await captureWalletCloses(db)).toMatchObject({
			attempted: 1,
			captured: 1,
		});
		vi.setSystemTime((NOW + 120) * 1000);
		fetchMock.mockRejectedValue(new Error("HTTP 500"));
		expect(await captureWalletCloses(db)).toMatchObject({
			captured: 0,
			errors: 1,
		});
		expect(
			sqlite
				.prepare(
					"SELECT close_midpoint, received_at, last_status FROM wallet_trade_close_books",
				)
				.get(),
		).toMatchObject({
			close_midpoint: 0.55,
			received_at: NOW,
			last_status: "request_error",
		});
	});
	it("caps close requests and does not capture at/after start", async () => {
		for (let i = 0; i < 4; i++)
			observation(`row${i}`, { token: String(i), event: NOW + 300 });
		metadata(CONDITION, NOW + 300);
		fetchMock.mockImplementation(async (input) =>
			Response.json({
				...book,
				asset_id: new URL(String(input)).searchParams.get("token_id"),
			}),
		);
		expect(await captureWalletCloses(db)).toMatchObject({
			attempted: 2,
			captured: 2,
		});
		vi.setSystemTime((NOW + 300) * 1000);
		expect(await captureWalletCloses(db)).toMatchObject({ attempted: 0 });
	});
	it("rejects a response received after start even if its source time was before start", async () => {
		observation("one", { event: NOW + 1 });
		metadata(CONDITION, NOW + 1);
		fetchMock.mockImplementation(async () => {
			vi.setSystemTime((NOW + 2) * 1000);
			return Response.json(book);
		});
		expect(await captureWalletCloses(db)).toMatchObject({ captured: 0 });
	});
	it("does not request closes for rows whose frozen start Gamma has not confirmed", async () => {
		observation("unconfirmed", { event: NOW + 300 });
		observation("refuted", { condition: "refuted", event: NOW + 300 });
		metadata("refuted", NOW + 400);
		observation("confirmed", { condition: TX, token: "456", event: NOW + 300 });
		metadata(TX, NOW + 300, "identified", ["456", "789"]);
		fetchMock.mockImplementation(async () =>
			Response.json({ ...book, market: TX, asset_id: "456" }),
		);
		expect(await captureWalletCloses(db)).toMatchObject({
			attempted: 1,
			captured: 1,
		});
		expect(String(fetchMock.mock.calls[0][0])).toContain("token_id=456");
	});
});

describe("settlement against real SQLite", () => {
	it("prefers the captured midpoint and never changes a finalized measurement", async () => {
		const event = NOW + 300;
		observation("one", { event });
		metadata(CONDITION, event);
		fetchMock.mockResolvedValue(Response.json(book));
		await captureWalletCloses(db);
		history(CONDITION, event, event - 1, 0.9);
		vi.setSystemTime((event + 61) * 1000);
		expect(await settleWalletTradeCloses(db)).toEqual({
			checked: 1,
			measured: 1,
			missing: 0,
			invalid: 0,
		});
		const row = sqlite.prepare("SELECT * FROM wallet_trade_measurements").get();
		expect(row).toMatchObject({
			source: "clob_midpoint",
			close_at: NOW,
			close_price: 0.55,
			follow_clv: expect.closeTo(0.05),
			wallet_clv: expect.closeTo(0.15),
			best_ask_clv: expect.closeTo(0.06),
		});
		sqlite.exec("UPDATE sharp_money_history SET side_a_price=.1");
		expect(await settleWalletTradeCloses(db)).toMatchObject({ checked: 0 });
		expect(
			sqlite.prepare("SELECT * FROM wallet_trade_measurements").get(),
		).toEqual(row);
	});
	it("selects the latest valid side price, excluding stale, null and post-start history", async () => {
		const event = NOW - 120;
		observation("one", { side: "B", token: "456" });
		metadata(CONDITION, event);
		history(CONDITION, event, event - 601, 0.1, 0.9);
		history(CONDITION, event, event - 300, 0.4, 0.6);
		history(CONDITION, event, event, 0.2, 0.8);
		expect(await settleWalletTradeCloses(db)).toMatchObject({ measured: 1 });
		expect(
			sqlite
				.prepare(
					"SELECT source,close_price,follow_clv FROM wallet_trade_measurements",
				)
				.get(),
		).toMatchObject({
			source: "history_ask_proxy",
			close_price: 0.6,
			follow_clv: expect.closeTo(0.1),
		});
	});
	it("does not starve newer closes behind 50 missing ones; expires missing without zero CLV", async () => {
		for (let i = 0; i < 50; i++) {
			observation(`missing${i}`, {
				condition: `missing${i}`,
				event: NOW - 86400,
			});
			metadata(`missing${i}`, NOW - 86400);
		}
		observation("valid");
		metadata();
		history(CONDITION, NOW - 120, NOW - 180, 0.6);
		expect(await settleWalletTradeCloses(db)).toMatchObject({
			checked: 1,
			measured: 1,
		});
		vi.setSystemTime((NOW + 7 * 86400) * 1000);
		expect(await settleWalletTradeCloses(db)).toMatchObject({ missing: 50 });
		expect(
			sqlite
				.prepare(
					"SELECT COUNT(*) n FROM wallet_trade_measurements WHERE status='missing_close' AND follow_clv IS NULL",
				)
				.get()?.n,
		).toBe(50);
	});
	it("rejects revised schedules/labels, post-quote timing violations and zero prices", async () => {
		observation("schedule");
		metadata();
		history(CONDITION, NOW - 119, NOW - 180, 0.6);
		observation("labels", { condition: "labels" });
		metadata("labels");
		history("labels", NOW - 120, NOW - 180, 0.6, 0.4, ["Other", "Team"]);
		observation("zero", { condition: "zero" });
		metadata("zero");
		history("zero", NOW - 120, NOW - 180, 0);
		observation("invalid", { condition: "invalid" });
		metadata("invalid");
		sqlite.exec(
			"UPDATE wallet_trade_observations SET quote_received_at=event_time WHERE trade_key='invalid'",
		);
		expect(await settleWalletTradeCloses(db)).toMatchObject({
			checked: 1,
			invalid: 1,
		});
	});
	it("measures only after Gamma confirms the frozen start and token side; unconfirmed rows wait", async () => {
		const event = NOW - 120;
		observation("confirmed");
		metadata(CONDITION, event);
		observation("refuted", { condition: "refuted" });
		metadata("refuted", event + 86400);
		observation("wrongside", { condition: "wrongside" });
		metadata("wrongside", event, "identified", ["456", "123"]);
		observation("unknown", { condition: "unknown" });
		metadata("unknown", event, "unknown_event_time");
		observation("waiting", { condition: "waiting" });
		for (const condition of [
			CONDITION,
			"refuted",
			"wrongside",
			"unknown",
			"waiting",
		])
			history(condition, event, event - 180, 0.6);
		expect(await settleWalletTradeCloses(db)).toEqual({
			checked: 4,
			measured: 1,
			missing: 0,
			invalid: 3,
		});
		expect(
			sqlite
				.prepare(
					"SELECT trade_key FROM wallet_trade_measurements WHERE status='measured'",
				)
				.get()?.trade_key,
		).toBe("confirmed");
		metadata("waiting", event);
		expect(await settleWalletTradeCloses(db)).toMatchObject({
			checked: 1,
			measured: 1,
		});
		observation("expired", { condition: "expired", event: NOW - 8 * 86400 });
		history("expired", NOW - 8 * 86400, NOW - 8 * 86400 - 180, 0.6);
		expect(await settleWalletTradeCloses(db)).toMatchObject({
			checked: 1,
			invalid: 1,
		});
	});
	it("does not turn database failures into missing-close records", async () => {
		observation("old", { event: NOW - 8 * 86400 });
		sqlite.exec("DROP TABLE sharp_money_history");
		await expect(settleWalletTradeCloses(db)).rejects.toThrow();
		expect(
			sqlite.prepare("SELECT COUNT(*) n FROM wallet_trade_measurements").get()
				?.n,
		).toBe(0);
	});
});

describe("first-signal and event-weighted report", () => {
	it("separates collection versions and preserves unfinished run version", async () => {
		observation("v1", { token: "v1", version: 1 });
		measurement("v1", 0.2);
		observation("v2", { token: "v2", version: 2 });
		measurement("v2", -0.2);
		sqlite
			.prepare(
				"INSERT INTO wallet_trade_polls (run_id,started_at,collection_version) VALUES ('crash',?,2)",
			)
			.run(NOW);
		const report = await getWalletTradeReport(db);
		expect(report.eventMetrics).toHaveLength(2);
		expect(report.polls[0]).toMatchObject({
			collection_version: 2,
			unfinished: 1,
		});
	});
	it("does not replace a missing first buy with a later successful quote", () => {
		observation("first", { detected: NOW - 4000, status: "quote_error" });
		observation("later", { detected: NOW - 3500 });
		measurement("later", 0.2);
		expect(sqlite.prepare(WALLET_FIRST_SIGNAL_SUMMARY_SQL).get()).toMatchObject(
			{ first_buys: 1, first_quotes: 0, measured: 0 },
		);
		expect(sqlite.prepare(WALLET_EVENT_METRICS_SQL).all()).toHaveLength(0);
	});
	it("keeps earlier locally truncated buys from being replaced", () => {
		observation("later");
		measurement("later", 0.2);
		sqlite
			.prepare("INSERT INTO wallet_trade_skips VALUES (?, ?, ?, ?)")
			.run(walletTradeKey(TRADE), WALLET, NOW - 5000, NOW - 4500);
		expect(sqlite.prepare(WALLET_FIRST_SIGNAL_SUMMARY_SQL).get()).toMatchObject(
			{ prior_truncation: 1, measured: 0 },
		);
	});
	it("weights known events equally and separates sources and missing event IDs", () => {
		for (let i = 0; i < 10; i++) {
			observation(`many${i}`, { token: String(i), eventId: "many" });
			measurement(`many${i}`, 0.1);
		}
		observation("other", { token: "other", eventId: "other" });
		measurement("other", -0.1);
		observation("unknown", { token: "unknown", eventId: null });
		measurement("unknown", 0.4);
		observation("proxy", { token: "proxy", eventId: "proxy" });
		measurement("proxy", 0.3, "history_ask_proxy");
		const rows = sqlite.prepare(WALLET_EVENT_METRICS_SQL).all();
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.source === "clob_midpoint")).toMatchObject({
			measured_events: 2,
			first_signals: 11,
			event_mean_follow_clv: expect.closeTo(0),
		});
	});
	it("exposes aggregates without addresses or a live-ready verdict", async () => {
		observation("one");
		measurement("one", 0.1);
		const report = await getWalletTradeReport(db);
		expect(report.liveEligible).toBe(false);
		expect(JSON.stringify(report)).not.toContain(WALLET);
		expect(JSON.stringify(report)).not.toContain(CONDITION);
	});
});
