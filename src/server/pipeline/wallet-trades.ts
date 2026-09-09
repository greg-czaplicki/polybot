import { resolveSportTagFromSeriesId } from "../api/series-registry";
import { all, type Db, first, run } from "../db/client";

const SPORTS = new Set(["mlb", "nfl", "ncaaf", "epl", "atp", "wta"]);
const WINDOW = 15 * 60;
const ADDRESS = /^0x[\da-f]{40}$/i;
const HASH = /^0x[\da-f]{64}$/i;
const seconds = () => Math.floor(Date.now() / 1000);

// This seven-day pilot runs in a cold DO without recurring Gamma discovery.
// Verified against Gamma /series/12756 on 2026-09-09; no live registry changes.
function pilotSport(seriesId: number): string | null {
	if (seriesId === 12756) return "ncaaf";
	return resolveSportTagFromSeriesId(seriesId);
}

type Wallet = {
	address: string;
	sport: string;
	priorCount: number;
	priorLastSeen: number;
	lastPoll: number | null;
};
type Pilot = {
	enrolled_at: number | null;
	expires_at: number | null;
	cohort_json: string | null;
	cursor: number;
};
export type WalletTrade = {
	wallet: string;
	tx: string;
	condition: string;
	token: string;
	action: "BUY" | "SELL";
	outcome: string;
	at: number;
	price: number;
	size: number;
};
type Market = {
	condition_id: string;
	sport_series_id: number;
	event_time: string | null;
	side_a_label: string;
	side_b_label: string;
};
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as RecordValue)
		: null;
const positive = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;

export function parseWalletTrade(
	value: unknown,
	wallet: string,
	start: number,
	end: number,
): WalletTrade | null {
	const row = object(value);
	if (
		!row ||
		typeof row.proxyWallet !== "string" ||
		!ADDRESS.test(row.proxyWallet) ||
		row.proxyWallet.toLowerCase() !== wallet.toLowerCase() ||
		typeof row.transactionHash !== "string" ||
		!HASH.test(row.transactionHash) ||
		typeof row.conditionId !== "string" ||
		!HASH.test(row.conditionId) ||
		typeof row.asset !== "string" ||
		!/^\d+$/.test(row.asset) ||
		(row.side !== "BUY" && row.side !== "SELL") ||
		typeof row.outcome !== "string" ||
		!row.outcome.trim() ||
		!positive(row.price) ||
		row.price >= 1 ||
		!positive(row.size) ||
		!Number.isFinite(row.price * row.size) ||
		row.price * row.size < 100 ||
		typeof row.timestamp !== "number" ||
		!Number.isInteger(row.timestamp) ||
		row.timestamp < start ||
		row.timestamp > end
	)
		return null;
	return {
		wallet: row.proxyWallet.toLowerCase(),
		tx: row.transactionHash.toLowerCase(),
		condition: row.conditionId.toLowerCase(),
		token: row.asset,
		action: row.side,
		outcome: row.outcome,
		at: row.timestamp,
		price: row.price,
		size: row.size,
	};
}

export function walletTradeKey(trade: WalletTrade): string {
	return JSON.stringify([
		trade.wallet,
		trade.tx,
		trade.token,
		trade.action,
		trade.at,
		trade.price,
		trade.size,
	]);
}

export function classifyWalletTrade(
	trade: WalletTrade,
	market: Market | undefined,
	now: number,
) {
	const sport = market ? pilotSport(market.sport_series_id) : null;
	const parsedTime = market?.event_time
		? Date.parse(market.event_time) / 1000
		: NaN;
	const eventTime = Number.isFinite(parsedTime) ? Math.floor(parsedTime) : null;
	const label = trade.outcome.trim().toLowerCase();
	const a = market?.side_a_label.trim().toLowerCase() === label;
	const b = market?.side_b_label.trim().toLowerCase() === label;
	let side: "A" | "B" | null = null;
	if (a && !b) side = "A";
	if (b && !a) side = "B";
	let status = "eligible";
	if (!market) status = "unknown_market";
	else if (!sport || !SPORTS.has(sport)) status = "unsupported_sport";
	else if (!side) status = "unknown_outcome";
	else if (trade.action === "SELL") status = "sell_observed";
	else if (eventTime === null) status = "unknown_event_time";
	else if (eventTime - now < WINDOW) status = "too_late";
	return { sport, eventTime, side, status };
}

type Level = { price: number; size: number };
function levels(value: unknown): Level[] | null {
	if (!Array.isArray(value)) return null;
	const result: Level[] = [];
	for (const entry of value) {
		const row = object(entry);
		if (
			!row ||
			!["string", "number"].includes(typeof row.price) ||
			!["string", "number"].includes(typeof row.size)
		)
			return null;
		const price = Number(row.price);
		const size = Number(row.size);
		if (!positive(price) || price >= 1 || !positive(size)) return null;
		result.push({ price, size });
	}
	return result;
}

export function measureWalletBook(
	value: unknown,
	trade: WalletTrade,
	receivedAt: number,
) {
	const result: {
		status: string;
		bookAt: number | null;
		bid: number | null;
		ask: number | null;
		price: number | null;
		shares: number | null;
	} = {
		status: "invalid_book",
		bookAt: null,
		bid: null,
		ask: null,
		price: null,
		shares: null,
	};
	const book = object(value);
	if (!book || book.market !== trade.condition || book.asset_id !== trade.token)
		return result;
	const rawTime =
		typeof book.timestamp === "string" || typeof book.timestamp === "number"
			? Number(book.timestamp)
			: NaN;
	if (!positive(rawTime)) return result;
	result.bookAt = Math.floor(rawTime > 1e12 ? rawTime / 1000 : rawTime);
	if (receivedAt - result.bookAt > 60 || result.bookAt > receivedAt + 5)
		return { ...result, status: "stale_book" };
	const asks = levels(book.asks)?.sort((a, b) => a.price - b.price);
	const bids = levels(book.bids)?.sort((a, b) => b.price - a.price);
	const minimum =
		typeof book.min_order_size === "string" ||
		typeof book.min_order_size === "number"
			? Number(book.min_order_size)
			: NaN;
	if (!asks || !bids || !positive(minimum)) return result;
	result.ask = asks[0]?.price ?? null;
	result.bid = bids[0]?.price ?? null;
	if (result.ask === null || result.bid === null)
		return { ...result, status: "empty_book" };
	if (result.bid >= result.ask) return { ...result, status: "crossed_book" };
	let remaining = 8;
	let shares = 0;
	for (const level of asks) {
		const spend = Math.min(remaining, level.price * level.size);
		shares += spend / level.price;
		remaining -= spend;
		if (remaining <= 1e-8) break;
	}
	if (remaining > 1e-8) return { ...result, status: "insufficient_depth" };
	if (shares < minimum) return { ...result, status: "below_minimum" };
	return { ...result, status: "quoted", price: 8 / shares, shares };
}

async function enroll(db: Db, now: number): Promise<Wallet[]> {
	const candidates = await all<{
		wallet_address: string;
		sport_series_id: number;
		n: number;
		last_seen: number;
	}>(
		db,
		`WITH activity AS (
		SELECT lower(wallet_address) wallet_address, sport_series_id, COUNT(*) n,
		MAX(observed_at) last_seen FROM wallet_entries
		WHERE observed_at >= ? AND observed_at < ?
		GROUP BY lower(wallet_address), sport_series_id
	), ranked AS (SELECT *, ROW_NUMBER() OVER (
		PARTITION BY sport_series_id ORDER BY last_seen DESC, wallet_address) rank
		FROM activity)
		SELECT * FROM ranked WHERE rank <= 2 ORDER BY last_seen DESC, wallet_address, sport_series_id`,
		now - 7 * 86400,
		now,
	);
	const cohort: Wallet[] = [];
	const counts = new Map<string, number>();
	for (const candidate of candidates) {
		const sport = pilotSport(candidate.sport_series_id);
		if (
			!sport ||
			!SPORTS.has(sport) ||
			(counts.get(sport) ?? 0) >= 2 ||
			!ADDRESS.test(candidate.wallet_address) ||
			cohort.some((wallet) => wallet.address === candidate.wallet_address)
		)
			continue;
		cohort.push({
			address: candidate.wallet_address,
			sport,
			priorCount: candidate.n,
			priorLastSeen: candidate.last_seen,
			lastPoll: null,
		});
		counts.set(sport, (counts.get(sport) ?? 0) + 1);
	}
	return cohort;
}

async function publicJson(url: URL): Promise<unknown> {
	const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.json();
}

/** Dedicated shadow collector; never imports order placement or live scoring. */
export async function collectWalletTrades(db: Db) {
	const now = seconds();
	const token = crypto.randomUUID();
	const acquired = await run(
		db,
		`UPDATE wallet_trade_pilot
		SET lease_token=?, lease_until=?, last_run_at=?
		WHERE id=1 AND lease_until <= ? AND last_run_at <= ?`,
		token,
		now + 300,
		now,
		now,
		now - 110,
	);
	if (Number(acquired.meta?.changes ?? 0) !== 1)
		return { ran: false, reason: "busy_or_cooldown" };
	const report = {
		wallets: 0,
		received: 0,
		invalid: 0,
		duplicates: 0,
		truncated: 0,
		cappedPages: 0,
		gaps: 0,
		inserted: 0,
		eligible: 0,
		quoted: 0,
		errors: 0,
		statuses: {} as Record<string, number>,
		polls: [] as {
			wallet: string;
			start: number;
			end: number;
			error?: string;
		}[],
	};
	let logged = false;
	try {
		const state = await first<Pilot>(
			db,
			"SELECT * FROM wallet_trade_pilot WHERE id=1",
		);
		if (!state) throw new Error("Missing pilot state");
		if (state.expires_at !== null && state.expires_at <= now)
			return { ran: false, reason: "expired" };
		await run(
			db,
			"INSERT INTO wallet_trade_polls (run_id, started_at) VALUES (?, ?)",
			token,
			now,
		);
		logged = true;
		const cohort: Wallet[] =
			state.cohort_json === null
				? await enroll(db, now)
				: JSON.parse(state.cohort_json);
		const enrolledAt = state.enrolled_at ?? now;
		if (state.cohort_json === null) {
			await run(
				db,
				`UPDATE wallet_trade_pilot SET cohort_json=?, enrolled_at=?, expires_at=?
				WHERE id=1 AND lease_token=?`,
				JSON.stringify(cohort),
				now,
				now + 7 * 86400,
				token,
			);
		}
		let quoteBudget = 6;
		for (let i = 0; i < Math.min(3, cohort.length); i++) {
			const wallet = cohort[(state.cursor + i) % cohort.length];
			const end = seconds();
			const start = Math.max(enrolledAt, end - WINDOW);
			if (end - (wallet.lastPoll ?? enrolledAt) > WINDOW) report.gaps++;
			const poll: (typeof report.polls)[number] = {
				wallet: wallet.address,
				start,
				end,
			};
			report.polls.push(poll);
			report.wallets++;
			try {
				const url = new URL("https://data-api.polymarket.com/trades");
				url.search = new URLSearchParams({
					user: wallet.address,
					takerOnly: "false",
					limit: "100",
					start: String(start),
					end: String(end),
					filterType: "CASH",
					filterAmount: "100",
				}).toString();
				const body = await publicJson(url);
				if (!Array.isArray(body)) throw new Error("Invalid trades response");
				const detected = seconds();
				report.received += body.length;
				if (body.length >= 100) report.cappedPages++;
				const unique = new Map<string, WalletTrade>();
				for (const raw of body.slice(0, 100)) {
					const trade = parseWalletTrade(raw, wallet.address, start, end);
					if (trade) {
						const key = walletTradeKey(trade);
						if (unique.has(key)) report.duplicates++;
						unique.set(key, trade);
					} else report.invalid++;
				}
				const existing = new Set(
					(
						await all<{ trade_key: string }>(
							db,
							`SELECT trade_key FROM wallet_trade_observations WHERE wallet_address=? AND trade_at>=?
					 UNION ALL SELECT trade_key FROM wallet_trade_skips WHERE wallet_address=? AND trade_at>=?`,
							wallet.address,
							start,
							wallet.address,
							start,
						)
					).map((row) => row.trade_key),
				);
				const fresh = [...unique.entries()]
					.filter(([key]) => !existing.has(key))
					.sort(([ak, a], [bk, b]) => b.at - a.at || ak.localeCompare(bk));
				report.duplicates += unique.size - fresh.length;
				report.truncated += Math.max(0, fresh.length - 10);
				// Keep first-sighting exclusions permanent; do not quote dropped trades next poll.
				for (let offset = 10; offset < fresh.length; offset += 20) {
					const skipped = fresh.slice(offset, offset + 20);
					await run(
						db,
						`INSERT OR IGNORE INTO wallet_trade_skips
						(trade_key, wallet_address, trade_at, detected_at) VALUES
						${skipped.map(() => "(?, ?, ?, ?)").join(",")}`,
						...skipped.flatMap(([key, trade]) => [
							key,
							wallet.address,
							trade.at,
							detected,
						]),
					);
				}
				const selected = fresh.slice(0, 10);
				const ids = [...new Set(selected.map(([, trade]) => trade.condition))];
				const markets = ids.length
					? await all<Market>(
							db,
							`SELECT condition_id, sport_series_id, event_time, side_a_label, side_b_label
					 FROM sharp_money_cache WHERE condition_id IN (${ids.map(() => "?").join(",")})`,
							...ids,
						)
					: [];
				for (const [key, trade] of selected) {
					const market = markets.find(
						(row) => row.condition_id === trade.condition,
					);
					const classification = classifyWalletTrade(trade, market, detected);
					const eligible = classification.status === "eligible";
					let status = eligible
						? quoteBudget > 0
							? "pending"
							: "quote_budget"
						: classification.status;
					const inserted = await run(
						db,
						`INSERT OR IGNORE INTO wallet_trade_observations
						(trade_key, run_id, wallet_address, transaction_hash, condition_id, token_id,
						action, outcome, trade_at, detected_at, wallet_price, shares, notional, sport,
						event_time, market_side, market_snapshot_json, quote_status)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						key,
						token,
						trade.wallet,
						trade.tx,
						trade.condition,
						trade.token,
						trade.action,
						trade.outcome,
						trade.at,
						detected,
						trade.price,
						trade.size,
						trade.price * trade.size,
						classification.sport,
						classification.eventTime,
						classification.side,
						market ? JSON.stringify(market) : null,
						status,
					);
					if (Number(inserted.meta?.changes ?? 0) !== 1) continue;
					report.inserted++;
					if (eligible) report.eligible++;
					if (status === "pending") {
						quoteBudget--;
						let book: unknown = null;
						let receivedAt: number | null = null;
						let measured: ReturnType<typeof measureWalletBook> | null = null;
						try {
							const bookUrl = new URL("https://clob.polymarket.com/book");
							bookUrl.searchParams.set("token_id", trade.token);
							book = await publicJson(bookUrl);
							receivedAt = seconds();
							measured = measureWalletBook(book, trade, receivedAt);
							status =
								(classification.eventTime ?? 0) - receivedAt < WINDOW
									? "too_late_at_quote"
									: measured.status;
						} catch (error) {
							status = "quote_error";
							report.errors++;
							console.warn(
								"[wallet-trades] Book request failed",
								String(error),
							);
						}
						await run(
							db,
							`UPDATE wallet_trade_observations SET quote_status=?, quote_received_at=?,
							book_at=?, best_bid=?, best_ask=?, follow_price=?, follow_shares=?, book_json=?
							WHERE trade_key=? AND quote_status='pending'`,
							status,
							receivedAt,
							measured?.bookAt ?? null,
							measured?.bid ?? null,
							measured?.ask ?? null,
							status === "quoted" ? (measured?.price ?? null) : null,
							status === "quoted" ? (measured?.shares ?? null) : null,
							book === null ? null : JSON.stringify(book),
							key,
						);
						if (status === "quoted") report.quoted++;
					}
					report.statuses[status] = (report.statuses[status] ?? 0) + 1;
				}
				wallet.lastPoll = end;
			} catch (error) {
				report.errors++;
				poll.error = String(error).slice(0, 300);
				console.error("[wallet-trades] Poll failed", poll.error);
			}
		}
		await run(
			db,
			`UPDATE wallet_trade_pilot SET cohort_json=?, cursor=? WHERE id=1 AND lease_token=?`,
			JSON.stringify(cohort),
			cohort.length ? (state.cursor + 3) % cohort.length : 0,
			token,
		);
		await run(
			db,
			"UPDATE wallet_trade_polls SET finished_at=?, report_json=? WHERE run_id=?",
			seconds(),
			JSON.stringify(report),
			token,
		);
		return { ran: true, emptyCohort: cohort.length === 0, ...report };
	} catch (error) {
		if (logged)
			await run(
				db,
				"UPDATE wallet_trade_polls SET finished_at=?, report_json=?, error=? WHERE run_id=?",
				seconds(),
				JSON.stringify(report),
				String(error).slice(0, 300),
				token,
			);
		throw error;
	} finally {
		await run(
			db,
			"UPDATE wallet_trade_pilot SET lease_token=NULL, lease_until=0 WHERE id=1 AND lease_token=?",
			token,
		);
	}
}
