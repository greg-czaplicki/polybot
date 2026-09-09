import { all, type Db, run } from "../db/client";
import { object, positive, publicJson, seconds } from "./wallet-trade-common";

/** A close is a pregame mark, not a guaranteed executable exit. */
export function parseWalletCloseBook(
	value: unknown,
	condition: string,
	token: string,
	event: number,
	received: number,
) {
	const invalid = {
		status: "invalid_book",
		bookAt: null as number | null,
		bid: null as number | null,
		ask: null as number | null,
		midpoint: null as number | null,
	};
	const book = object(value);
	if (!book || book.market !== condition || book.asset_id !== token)
		return invalid;
	const timestamp =
		typeof book.timestamp === "string" || typeof book.timestamp === "number"
			? Number(book.timestamp)
			: NaN;
	if (!positive(timestamp)) return invalid;
	const bookAt = Math.floor(timestamp > 1e12 ? timestamp / 1000 : timestamp);
	if (
		received >= event ||
		received < event - 600 ||
		bookAt >= event ||
		bookAt < event - 600 ||
		received - bookAt > 60 ||
		bookAt > received + 5
	)
		return { ...invalid, status: "outside_close_window", bookAt };
	function best(value: unknown, side: "bid" | "ask"): number | null {
		if (!Array.isArray(value) || value.length === 0) return null;
		let price = side === "bid" ? 0 : 1;
		for (const raw of value) {
			const level = object(raw);
			if (
				!level ||
				!["string", "number"].includes(typeof level.price) ||
				!["string", "number"].includes(typeof level.size)
			)
				return null;
			const p = Number(level.price);
			if (!positive(p) || p >= 1 || !positive(Number(level.size))) return null;
			price = side === "bid" ? Math.max(price, p) : Math.min(price, p);
		}
		return price;
	}
	const bid = best(book.bids, "bid");
	const ask = best(book.asks, "ask");
	if (bid === null || ask === null || bid >= ask) return { ...invalid, bookAt };
	return { status: "captured", bookAt, bid, ask, midpoint: (bid + ask) / 2 };
}

export async function captureWalletCloses(db: Db) {
	const now = seconds();
	const due = await all<{
		condition_id: string;
		token_id: string;
		event_time: number;
	}>(
		db,
		`
		SELECT o.condition_id, o.token_id, o.event_time
		FROM wallet_trade_observations o
		JOIN wallet_trade_market_metadata md ON md.condition_id=o.condition_id
		 AND md.status='identified'
		 AND CAST(strftime('%s', json_extract(md.snapshot_json,'$.event_time')) AS INTEGER)=o.event_time
		LEFT JOIN wallet_trade_close_books c
		ON c.condition_id=o.condition_id AND c.token_id=o.token_id AND c.event_time=o.event_time
		WHERE o.quote_status='quoted' AND o.event_time > ? AND o.event_time <= ?
		GROUP BY o.condition_id, o.token_id, o.event_time
		ORDER BY COALESCE(c.last_attempt_at, 0), o.event_time, o.condition_id, o.token_id LIMIT 2`,
		now,
		now + 600,
	);
	let captured = 0;
	let errors = 0;
	for (const row of due) {
		const attempted = seconds();
		if (attempted >= row.event_time) continue;
		await run(
			db,
			`INSERT INTO wallet_trade_close_books
			(condition_id, token_id, event_time, last_attempt_at, last_status) VALUES (?, ?, ?, ?, 'pending')
			ON CONFLICT(condition_id, token_id, event_time) DO UPDATE SET
			last_attempt_at=excluded.last_attempt_at, last_status='pending'`,
			row.condition_id,
			row.token_id,
			row.event_time,
			attempted,
		);
		let status = "request_error";
		try {
			const url = new URL("https://clob.polymarket.com/book");
			url.searchParams.set("token_id", row.token_id);
			const raw = await publicJson(url);
			const received = seconds();
			const book = parseWalletCloseBook(
				raw,
				row.condition_id,
				row.token_id,
				row.event_time,
				received,
			);
			status = book.status;
			if (book.status === "captured") {
				await run(
					db,
					`UPDATE wallet_trade_close_books SET received_at=?, book_at=?, best_bid=?,
					best_ask=?, close_midpoint=?, book_json=? WHERE condition_id=? AND token_id=? AND event_time=?`,
					received,
					book.bookAt,
					book.bid,
					book.ask,
					book.midpoint,
					JSON.stringify(raw),
					row.condition_id,
					row.token_id,
					row.event_time,
				);
				captured++;
			}
		} catch (error) {
			errors++;
			console.warn("[wallet-closes] Capture failed", String(error));
		}
		await run(
			db,
			`UPDATE wallet_trade_close_books SET last_status=?
			WHERE condition_id=? AND token_id=? AND event_time=?`,
			status,
			row.condition_id,
			row.token_id,
			row.event_time,
		);
	}
	return { attempted: due.length, captured, errors };
}

/**
 * Bind: now-60, now-7days, limit. Missing history never occupies the batch.
 * `confirmed`: the frozen start and token side must be corroborated by Gamma
 * metadata (the cache falls back to the resolution date when a market has no
 * start time, which would let in-game buys through and mark a post-game
 * "close"). 1 = confirmed, 0 = refuted or terminal non-identified metadata,
 * NULL = no usable metadata yet (row waits, then invalidates at expiry).
 */
export const WALLET_TRADE_SETTLEMENT_SQL = `WITH due AS (
	SELECT o.*,
		CASE WHEN o.action='BUY' AND o.follow_price>0 AND o.follow_price<1
		 AND o.wallet_price>0 AND o.wallet_price<1 AND o.best_ask>0 AND o.best_ask<1
		 AND o.quote_received_at>=o.detected_at AND o.detected_at>=o.trade_at
		 AND o.quote_received_at<=o.event_time-900 THEN 1 ELSE 0 END valid,
		CASE WHEN md.status='identified' THEN
		 CASE WHEN CAST(strftime('%s', json_extract(md.snapshot_json,'$.event_time')) AS INTEGER)=o.event_time
		  AND CASE o.market_side WHEN 'A' THEN json_extract(md.snapshot_json,'$.token_a')
		   WHEN 'B' THEN json_extract(md.snapshot_json,'$.token_b') END=o.token_id THEN 1 ELSE 0 END
		 WHEN md.status IS NULL OR md.status='lookup_error' THEN NULL ELSE 0 END confirmed,
		c.received_at book_close_at, c.close_midpoint book_close_price,
		(SELECT h.recorded_at FROM sharp_money_history h
		 WHERE h.condition_id=o.condition_id
		 AND h.recorded_at >= o.event_time-600 AND h.recorded_at < o.event_time
		 AND h.recorded_at > o.quote_received_at
		 AND CAST(strftime('%s', h.event_time) AS INTEGER)=o.event_time
		 AND h.side_a_label=json_extract(o.market_snapshot_json,'$.side_a_label')
		 AND h.side_b_label=json_extract(o.market_snapshot_json,'$.side_b_label')
		 AND CASE o.market_side WHEN 'A' THEN h.side_a_price WHEN 'B' THEN h.side_b_price END > 0
		 AND CASE o.market_side WHEN 'A' THEN h.side_a_price WHEN 'B' THEN h.side_b_price END < 1
		 ORDER BY h.recorded_at DESC LIMIT 1) history_close_at
	FROM wallet_trade_observations o
	LEFT JOIN wallet_trade_measurements m USING(trade_key)
	LEFT JOIN wallet_trade_market_metadata md ON md.condition_id=o.condition_id
	LEFT JOIN wallet_trade_close_books c ON c.condition_id=o.condition_id
	 AND c.token_id=o.token_id AND c.event_time=o.event_time
	 AND c.received_at>=o.event_time-600 AND c.received_at<o.event_time
	 AND c.received_at>o.quote_received_at
	 AND c.book_at>=o.event_time-600 AND c.book_at<o.event_time
	 AND c.close_midpoint>0 AND c.close_midpoint<1
	WHERE o.quote_status='quoted' AND m.trade_key IS NULL AND o.event_time < ?
), priced AS (
	SELECT due.*, CASE WHEN book_close_price IS NOT NULL THEN 'clob_midpoint'
	 WHEN history_close_at IS NOT NULL THEN 'history_ask_proxy' END source,
	 COALESCE(book_close_at, history_close_at) close_at,
	 COALESCE(book_close_price, CASE due.market_side WHEN 'A' THEN h.side_a_price
	 WHEN 'B' THEN h.side_b_price END) close_price
	FROM due LEFT JOIN sharp_money_history h
	 ON h.condition_id=due.condition_id AND h.recorded_at=due.history_close_at
)
SELECT trade_key, valid, confirmed, source, close_at, close_price, follow_price, wallet_price, best_ask
FROM priced WHERE valid=0 OR confirmed=0 OR (confirmed=1 AND close_price IS NOT NULL) OR event_time < ?
ORDER BY event_time, trade_key LIMIT ?`;

export async function settleWalletTradeCloses(db: Db) {
	const now = seconds();
	const rows = await all<{
		trade_key: string;
		valid: number;
		confirmed: number | null;
		source: string | null;
		close_at: number | null;
		close_price: number | null;
		follow_price: number;
		wallet_price: number;
		best_ask: number;
	}>(db, WALLET_TRADE_SETTLEMENT_SQL, now - 60, now - 7 * 86400, 50);
	let measured = 0;
	let missing = 0;
	let invalid = 0;
	for (const row of rows) {
		let status = "measured";
		if (!row.valid || row.confirmed !== 1) status = "invalid_snapshot";
		else if (row.close_price === null) status = "missing_close";
		const close = status === "measured" ? row.close_price : null;
		const inserted = await run(
			db,
			`INSERT OR IGNORE INTO wallet_trade_measurements
			(trade_key, status, source, close_at, close_price, follow_clv, relative_clv, wallet_clv, best_ask_clv, settled_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			row.trade_key,
			status,
			close === null ? null : row.source,
			close === null ? null : row.close_at,
			close,
			close === null ? null : close - row.follow_price,
			close === null ? null : (close - row.follow_price) / row.follow_price,
			close === null ? null : close - row.wallet_price,
			close === null ? null : close - row.best_ask,
			now,
		);
		if (Number(inserted.meta?.changes ?? 0) !== 1) continue;
		if (status === "measured") measured++;
		else if (status === "missing_close") missing++;
		else invalid++;
	}
	return { checked: rows.length, measured, missing, invalid };
}
