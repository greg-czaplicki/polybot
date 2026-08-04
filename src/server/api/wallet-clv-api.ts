/**
 * Read API for the wallet-CLV foundation (wallet_entries). Powers /wallets:
 * live entry feed + per-wallet closing-line-value leaderboard.
 */

import { createServerFn } from "@tanstack/react-start";
import { all, first } from "../db/client";
import { getDb } from "../env";

export interface WalletClvTotals {
	entries: number;
	distinctWallets: number;
	open: number;
	closed: number;
	voided: number;
	avgClv: number | null;
	entriesLast24h: number;
}

export interface WalletEntryRow {
	walletAddress: string;
	marketTitle: string;
	side: string;
	kind: string;
	deltaUsd: number;
	totalUsd: number;
	entryPrice: number;
	closePrice: number | null;
	clv: number | null;
	status: string;
	observedAt: number;
	eventTime: number;
}

export interface WalletLeaderboardRow {
	walletAddress: string;
	entries: number;
	closed: number;
	avgClv: number;
	beatCloseCount: number;
	totalDeltaUsd: number;
	lastSeenAt: number;
}

export const getWalletClvSummaryFn = createServerFn({ method: "GET" }).handler(
	async ({ context }) => {
		const db = getDb(context);
		const nowSec = Math.floor(Date.now() / 1000);

		const totalsRow = await first<{
			entries: number;
			distinct_wallets: number;
			open: number;
			closed: number;
			voided: number;
			avg_clv: number | null;
			last_24h: number;
		}>(
			db,
			`SELECT COUNT(*) AS entries,
			        COUNT(DISTINCT wallet_address) AS distinct_wallets,
			        SUM(status = 'open') AS open,
			        SUM(status = 'closed') AS closed,
			        SUM(status = 'void') AS voided,
			        AVG(CASE WHEN status = 'closed' THEN clv END) AS avg_clv,
			        SUM(observed_at > ?) AS last_24h
			 FROM wallet_entries`,
			nowSec - 86400,
		);

		const recentRows = await all<{
			wallet_address: string;
			market_title: string;
			side: string;
			kind: string;
			delta_usd: number;
			total_usd: number;
			entry_price: number;
			close_price: number | null;
			clv: number | null;
			status: string;
			observed_at: number;
			event_time: number;
		}>(
			db,
			`SELECT wallet_address, market_title, side, kind, delta_usd, total_usd,
			        entry_price, close_price, clv, status, observed_at, event_time
			 FROM wallet_entries
			 ORDER BY observed_at DESC, id DESC
			 LIMIT 40`,
		);

		// Skill needs repetition: require >=3 settled entries before a wallet
		// earns a leaderboard row, ranked by average CLV.
		const leaderboardRows = await all<{
			wallet_address: string;
			entries: number;
			closed: number;
			avg_clv: number;
			beat_close: number;
			total_delta: number;
			last_seen: number;
		}>(
			db,
			`SELECT wallet_address,
			        COUNT(*) AS entries,
			        SUM(status = 'closed') AS closed,
			        AVG(CASE WHEN status = 'closed' THEN clv END) AS avg_clv,
			        SUM(CASE WHEN status = 'closed' AND clv > 0 THEN 1 ELSE 0 END) AS beat_close,
			        SUM(delta_usd) AS total_delta,
			        MAX(observed_at) AS last_seen
			 FROM wallet_entries
			 GROUP BY wallet_address
			 HAVING SUM(status = 'closed') >= 3
			 ORDER BY avg_clv DESC
			 LIMIT 25`,
		);

		const totals: WalletClvTotals = {
			entries: totalsRow?.entries ?? 0,
			distinctWallets: totalsRow?.distinct_wallets ?? 0,
			open: totalsRow?.open ?? 0,
			closed: totalsRow?.closed ?? 0,
			voided: totalsRow?.voided ?? 0,
			avgClv: totalsRow?.avg_clv ?? null,
			entriesLast24h: totalsRow?.last_24h ?? 0,
		};

		const recent: WalletEntryRow[] = recentRows.map((row) => ({
			walletAddress: row.wallet_address,
			marketTitle: row.market_title,
			side: row.side,
			kind: row.kind,
			deltaUsd: row.delta_usd,
			totalUsd: row.total_usd,
			entryPrice: row.entry_price,
			closePrice: row.close_price,
			clv: row.clv,
			status: row.status,
			observedAt: row.observed_at,
			eventTime: row.event_time,
		}));

		const leaderboard: WalletLeaderboardRow[] = leaderboardRows.map((row) => ({
			walletAddress: row.wallet_address,
			entries: row.entries,
			closed: row.closed,
			avgClv: row.avg_clv,
			beatCloseCount: row.beat_close,
			totalDeltaUsd: row.total_delta,
			lastSeenAt: row.last_seen,
		}));

		return { totals, recent, leaderboard };
	},
);
