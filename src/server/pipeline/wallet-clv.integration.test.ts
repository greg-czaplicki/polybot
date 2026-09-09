import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client";
import {
	WALLET_LEADERBOARD_SQL,
	WALLET_SPORT_CLV_SQL,
} from "../repositories/wallet-clv";
import { settleWalletEntries } from "./wallet-clv";

const NOW = 1_789_000_000;
let sqlite: DatabaseSync;
let db: Db;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW * 1000);
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec(readFileSync("migrations/0025_add_wallet_entries.sql", "utf8"));
	sqlite.exec(`CREATE TABLE sharp_money_history (
		condition_id TEXT, recorded_at INTEGER, side_a_price REAL, side_b_price REAL);
		CREATE INDEX history_time ON sharp_money_history(condition_id, recorded_at);`);
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
	vi.useRealTimers();
});

function addEntry(
	market: string,
	options: {
		wallet?: string;
		side?: string;
		price?: number;
		dollars?: number;
		status?: string;
		close?: number | null;
		eventTime?: number;
	} = {},
) {
	const price = options.price ?? 0.5;
	const close = options.close ?? null;
	sqlite
		.prepare(`INSERT INTO wallet_entries
		(wallet_address, condition_id, side, kind, entry_price, delta_usd, total_usd,
		observed_at, event_time, market_title, sport_series_id, status, close_price, clv)
		VALUES (?, ?, ?, 'increase', ?, ?, ?, ?, ?, ?, 3, ?, ?, ?)`)
		.run(
			options.wallet ?? "wallet",
			market,
			options.side ?? "A",
			price,
			options.dollars ?? 100,
			options.dollars ?? 100,
			NOW - 20000,
			options.eventTime ?? NOW - 7200,
			market,
			options.status ?? "open",
			close,
			close === null ? null : close - price,
		);
}

describe("wallet settlement against SQLite", () => {
	it("settles a newer market behind 50 missing closes, then safely replays", async () => {
		for (let i = 0; i < 50; i++)
			addEntry(`missing-${i}`, { eventTime: NOW - 86400 });
		addEntry("available");
		sqlite
			.prepare("INSERT INTO sharp_money_history VALUES (?, ?, ?, ?)")
			.run("available", NOW - 7300, 0.6, 0.4);
		expect(await settleWalletEntries(db)).toEqual({
			checked: 1,
			updated: 1,
			voided: 0,
		});
		expect(
			sqlite
				.prepare(
					"SELECT status, clv FROM wallet_entries WHERE condition_id='available'",
				)
				.get(),
		).toMatchObject({ status: "closed", clv: expect.closeTo(0.1) });
		expect(await settleWalletEntries(db)).toEqual({
			checked: 0,
			updated: 0,
			voided: 0,
		});
	});
	it("uses the correct side and skips stale, post-start and null prices", async () => {
		addEntry("valid", { side: "B" });
		addEntry("stale");
		addEntry("post");
		const insert = sqlite.prepare(
			"INSERT INTO sharp_money_history VALUES (?, ?, ?, ?)",
		);
		insert.run("valid", NOW - 7300, 0.4, 0.6);
		insert.run("valid", NOW - 7201, 0.3, null);
		insert.run("valid", NOW - 7199, 0.1, 0.9);
		insert.run("stale", NOW - 10801, 0.8, 0.2);
		insert.run("post", NOW - 7199, 0.8, 0.2);
		expect(await settleWalletEntries(db)).toEqual({
			checked: 1,
			updated: 1,
			voided: 0,
		});
		expect(
			sqlite
				.prepare(
					"SELECT close_price FROM wallet_entries WHERE condition_id='valid'",
				)
				.get()?.close_price,
		).toBe(0.6);
	});
	it("voids expired missing closes but preserves an available old close", async () => {
		const old = NOW - 8 * 86400;
		addEntry("expired", { eventTime: old });
		addEntry("old-valid", { eventTime: old });
		sqlite
			.prepare("INSERT INTO sharp_money_history VALUES (?, ?, ?, ?)")
			.run("old-valid", old, 0.55, 0.45);
		expect(await settleWalletEntries(db)).toEqual({
			checked: 2,
			updated: 1,
			voided: 1,
		});
	});
	it("does not turn database failures into voids", async () => {
		addEntry("expired", { eventTime: NOW - 8 * 86400 });
		sqlite.exec("DROP TABLE sharp_money_history");
		await expect(settleWalletEntries(db)).rejects.toThrow();
		expect(
			sqlite.prepare("SELECT status FROM wallet_entries").get()?.status,
		).toBe("open");
	});
});

describe("wallet market qualification", () => {
	it("does not change a wallet's score when a position is split into more increments", () => {
		for (const wallet of ["single", "split"]) {
			const count = wallet === "single" ? 1 : 10;
			for (let i = 0; i < count; i++)
				addEntry("one", {
					wallet,
					dollars: 1000 / count,
					status: "closed",
					close: 0.6,
				});
			addEntry("two", { wallet, status: "closed", close: 0.4 });
			addEntry("three", { wallet, status: "closed", close: 0.5 });
		}
		const rows = sqlite.prepare(WALLET_LEADERBOARD_SQL).all();
		expect(rows).toHaveLength(2);
		expect(rows[0].avg_rel_clv).toBeCloseTo(rows[1].avg_rel_clv as number);
		expect(rows[0].avg_clv).toBeCloseTo(rows[1].avg_clv as number);
	});
	it("does not qualify three increments or both sides of just two markets", () => {
		for (let i = 0; i < 3; i++)
			addEntry("one", { status: "closed", close: 0.6 });
		expect(sqlite.prepare(WALLET_LEADERBOARD_SQL).all()).toHaveLength(0);
		addEntry("two", { side: "A", status: "closed", close: 0.6 });
		addEntry("two", { side: "B", status: "closed", close: 0.4 });
		expect(sqlite.prepare(WALLET_LEADERBOARD_SQL).all()).toHaveLength(0);
	});
	it("weights share increments within markets and markets equally", () => {
		addEntry("one", { price: 0.25, status: "closed", close: 0.6 });
		addEntry("one", { price: 0.5, status: "closed", close: 0.6 });
		addEntry("two", { status: "closed", close: 0.5 });
		addEntry("three", { status: "closed", close: 0.5 });
		const row = sqlite.prepare(WALLET_LEADERBOARD_SQL).get();
		expect(row).toMatchObject({
			entries: 4,
			markets: 3,
			closed: 3,
			beat_close: 1,
		});
		expect(row?.avg_clv).toBeCloseTo(160 / 600 / 3);
		expect(row?.avg_rel_clv).toBeCloseTo(0.8 / 3);
		const sport = sqlite.prepare(WALLET_SPORT_CLV_SQL).get();
		expect(sport).toMatchObject({ n: 4, markets: 3, closed: 3, rel_clv_n: 3 });
	});
	it("waits for partial markets and never qualifies void-only markets", () => {
		addEntry("one", { status: "closed", close: 0.6 });
		addEntry("two", { status: "closed", close: 0.6 });
		addEntry("three", { status: "closed", close: 0.6 });
		addEntry("three");
		addEntry("four", { status: "void" });
		expect(sqlite.prepare(WALLET_LEADERBOARD_SQL).all()).toHaveLength(0);
		sqlite.exec(
			"UPDATE wallet_entries SET status='void' WHERE condition_id='three' AND status='open'",
		);
		expect(sqlite.prepare(WALLET_LEADERBOARD_SQL).get()?.closed).toBe(3);
	});
});
