/**
 * Wallet CLV foundation (2026-08-04 grading deep dive follow-up).
 *
 * Records per-wallet market ENTRIES by diffing each market's top-holder
 * snapshot against the previous pipeline tick, then settles them against
 * the pre-event closing price from sharp_money_history. The output —
 * per-wallet CLV over many graded entries — is a far stronger skill signal
 * than leaderboard PnL, but it is data collection only: nothing in the
 * picking path reads wallet_entries yet.
 *
 * Diff semantics: holder `amount` is USD (shares × price), so a price move
 * alone changes it. Diffs are therefore computed in SHARES — preferring the
 * raw `shares` field carried from the CLOB holders API. Reconstructing
 * shares as amount/price is only a legacy fallback for pre-2026-08-05
 * cache rows: amount is valued at token.price (mid) while the stored side
 * price is ask-based, so the division mixes bases and spread oscillation
 * on a static position fabricates deltas (see the 2026-08-05 deep-dive
 * audit, confirmed finding #5).
 */

import type { Db } from "../db/client";
import { all, run } from "../db/client";
import { nowUnixSeconds } from "../env";
import { findPriceAtOrBefore } from "../repositories/manual-picks";
import { listSharpMoneyHistoryByConditionIds } from "../repositories/sharp-money";

/** Ignore position growth below this — dust and rounding noise. */
const MIN_DELTA_USD = 100;
/** Only record entries observed before the event starts. */
const MIN_LEAD_SECONDS = 60;
/** A close older than this relative to event start is stale coverage. */
const CLOSE_MAX_STALENESS_SECONDS = 3600;
/** Entries with no resolvable close after this long are voided. */
const VOID_AFTER_SECONDS = 7 * 86400;

export interface HolderPosition {
	proxyWallet: string;
	amount: number;
	/** Raw share count; present on snapshots written after 2026-08-05. */
	shares?: number | null;
}

export interface SideSnapshot {
	price?: number | null;
	topHolders: HolderPosition[];
}

export interface MarketSnapshot {
	sideA: SideSnapshot;
	sideB: SideSnapshot;
}

export interface WalletEntryDiff {
	walletAddress: string;
	side: "A" | "B";
	kind: "increase" | "new_top20";
	entryPrice: number;
	deltaUsd: number;
	totalUsd: number;
}

function validPrice(price: number | null | undefined): price is number {
	return (
		typeof price === "number" &&
		Number.isFinite(price) &&
		price > 0 &&
		price < 1
	);
}

/**
 * Pure diff of one market's holder snapshots. Returns entries (new or
 * increased positions) observed in `next` relative to `prev`. A null `prev`
 * is the market's baseline snapshot and yields no entries — pre-existing
 * positions have unknown entry prices.
 */
export function computeWalletEntryDiffs(
	prev: MarketSnapshot | null,
	next: MarketSnapshot,
): WalletEntryDiff[] {
	if (!prev) return [];
	const diffs: WalletEntryDiff[] = [];

	for (const side of ["A", "B"] as const) {
		const prevSide = side === "A" ? prev.sideA : prev.sideB;
		const nextSide = side === "A" ? next.sideA : next.sideB;
		const nextPrice = nextSide.price;
		if (!validPrice(nextPrice)) continue;

		const holderShares = (
			holder: HolderPosition,
			sidePrice: number | null | undefined,
		): number | null => {
			if (typeof holder.shares === "number" && Number.isFinite(holder.shares)) {
				return holder.shares;
			}
			// Legacy fallback (pre-shares cache rows): basis-mixed, see header.
			return validPrice(sidePrice) ? holder.amount / sidePrice : null;
		};

		const prevByWallet = new Map<string, number>();
		let prevUnderivable = false;
		for (const holder of prevSide.topHolders) {
			if (!holder.proxyWallet || !Number.isFinite(holder.amount)) continue;
			const shares = holderShares(holder, prevSide.price);
			if (shares === null) {
				// Previous shares unrecoverable; skip the side rather than
				// record price-move artifacts as entries.
				prevUnderivable = true;
				break;
			}
			prevByWallet.set(holder.proxyWallet.toLowerCase(), shares);
		}
		if (prevUnderivable) continue;

		for (const holder of nextSide.topHolders) {
			if (!holder.proxyWallet || !Number.isFinite(holder.amount)) continue;
			if (holder.amount <= 0) continue;
			const wallet = holder.proxyWallet.toLowerCase();
			const nextShares = holderShares(holder, nextPrice);
			if (nextShares === null) continue;
			const prevShares = prevByWallet.get(wallet);

			if (prevShares === undefined) {
				if (holder.amount >= MIN_DELTA_USD) {
					diffs.push({
						walletAddress: wallet,
						side,
						kind: "new_top20",
						entryPrice: nextPrice,
						deltaUsd: holder.amount,
						totalUsd: holder.amount,
					});
				}
				continue;
			}

			const deltaUsd = (nextShares - prevShares) * nextPrice;
			if (deltaUsd >= MIN_DELTA_USD) {
				diffs.push({
					walletAddress: wallet,
					side,
					kind: "increase",
					entryPrice: nextPrice,
					deltaUsd,
					totalUsd: holder.amount,
				});
			}
		}
	}

	return diffs;
}

export interface RecordWalletEntriesInput {
	conditionId: string;
	marketTitle: string;
	eventTime?: string | null;
	sportSeriesId?: number | null;
	prev: MarketSnapshot | null;
	next: MarketSnapshot;
}

/**
 * Diff and persist entries for one market snapshot pair. Best-effort by
 * design: callers wrap it so a failure never blocks the cache update.
 */
export async function recordWalletEntries(
	db: Db,
	input: RecordWalletEntriesInput,
): Promise<{ recorded: number }> {
	const eventTimeMs = input.eventTime ? Date.parse(input.eventTime) : NaN;
	if (!Number.isFinite(eventTimeMs)) return { recorded: 0 };
	const eventTimeSec = Math.floor(eventTimeMs / 1000);
	const now = nowUnixSeconds();
	// Post-start position changes aren't pre-close entries; CLV against the
	// closing line is only meaningful before the event starts.
	if (eventTimeSec - now < MIN_LEAD_SECONDS) return { recorded: 0 };

	const diffs = computeWalletEntryDiffs(input.prev, input.next);
	if (diffs.length === 0) return { recorded: 0 };

	// A wallet that hovers around the top-20 cutoff would re-record a
	// 'new_top20' entry on every re-appearance; only its first sighting per
	// (wallet, side) on this market is informative.
	const existing = await all<{ wallet_address: string; side: string }>(
		db,
		`SELECT DISTINCT wallet_address, side FROM wallet_entries WHERE condition_id = ?`,
		input.conditionId,
	);
	const seen = new Set(
		existing.map((row) => `${row.wallet_address}|${row.side}`),
	);
	const toInsert = diffs.filter(
		(diff) =>
			diff.kind === "increase" ||
			!seen.has(`${diff.walletAddress}|${diff.side}`),
	);
	if (toInsert.length === 0) return { recorded: 0 };

	for (const diff of toInsert) {
		await run(
			db,
			`INSERT INTO wallet_entries (
				wallet_address, condition_id, side, kind, entry_price, delta_usd,
				total_usd, observed_at, event_time, market_title, sport_series_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			diff.walletAddress,
			input.conditionId,
			diff.side,
			diff.kind,
			diff.entryPrice,
			diff.deltaUsd,
			diff.totalUsd,
			now,
			eventTimeSec,
			input.marketTitle,
			input.sportSeriesId ?? null,
		);
	}
	return { recorded: toInsert.length };
}

/**
 * Settle open entries whose events have started: stamp the pre-event close
 * from sharp_money_history and compute clv = close − entry. D1-only (no
 * external fetches), so it is cheap inside the shared cron budget. Entries
 * that never find a close are voided after VOID_AFTER_SECONDS.
 */
export async function settleWalletEntries(
	db: Db,
	options?: { limit?: number },
): Promise<{ checked: number; updated: number; voided: number }> {
	const limit =
		typeof options?.limit === "number" && options.limit > 0
			? Math.min(options.limit, 200)
			: 50;
	const now = nowUnixSeconds();

	const open = await all<{
		id: number;
		condition_id: string;
		side: string;
		entry_price: number;
		event_time: number;
	}>(
		db,
		`SELECT id, condition_id, side, entry_price, event_time
		 FROM wallet_entries
		 WHERE status = 'open' AND event_time < ?
		 ORDER BY event_time ASC
		 LIMIT ?`,
		now - CLOSE_MAX_STALENESS_SECONDS,
		limit,
	);
	if (open.length === 0) return { checked: 0, updated: 0, voided: 0 };

	const conditionIds = Array.from(new Set(open.map((row) => row.condition_id)));
	const earliestEvent = Math.min(...open.map((row) => row.event_time));
	let history: Awaited<ReturnType<typeof listSharpMoneyHistoryByConditionIds>> =
		{};
	try {
		history = await listSharpMoneyHistoryByConditionIds(
			db,
			conditionIds,
			earliestEvent - 4 * 3600,
		);
	} catch (error) {
		console.warn("[wallet-clv] history lookup failed", error);
		return { checked: open.length, updated: 0, voided: 0 };
	}

	let updated = 0;
	let voided = 0;
	for (const row of open) {
		const rows = history[row.condition_id];
		const close =
			rows && rows.length > 0 && (row.side === "A" || row.side === "B")
				? findPriceAtOrBefore(
						rows,
						row.side,
						row.event_time,
						CLOSE_MAX_STALENESS_SECONDS,
					)
				: null;
		if (close !== null) {
			await run(
				db,
				`UPDATE wallet_entries
				 SET status = 'closed', close_price = ?, clv = ?, settled_at = ?
				 WHERE id = ?`,
				close,
				close - row.entry_price,
				now,
				row.id,
			);
			updated += 1;
		} else if (now - row.event_time > VOID_AFTER_SECONDS) {
			await run(
				db,
				`UPDATE wallet_entries SET status = 'void', settled_at = ? WHERE id = ?`,
				now,
				row.id,
			);
			voided += 1;
		}
	}
	return { checked: open.length, updated, voided };
}
