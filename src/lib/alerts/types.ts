export type AlertChannel = 'web_push' | 'email'

export interface WatcherRule {
  id: string
  userId: string
  walletAddress: string
  nickname?: string | null
  /**
   * Position value step (USD) at which to trigger alerts.
   * Stored in the single_trade_threshold_usd column.
   */
  singleTradeThresholdUsd?: number | null
  accumulationThresholdUsd?: number | null
  accumulationWindowSeconds: number
  minTrades: number
  notifyChannels: AlertChannel[]
  lastTriggeredAt?: number | null
  lastSeenTradeTimestamp?: number | null
  /**
   * Wallet-level position value (USD) as of the last alert.
   */
  lastPositionValueNotified?: number | null
  createdAt: number
  updatedAt: number
}

export interface AlertEventPayload {
  walletAddress: string
  watcherId: string
  triggerType: 'single' | 'accumulation' | 'position_step'
  triggerValue: number
  tradeCount: number
  trades: Array<{
    transactionHash?: string
    timestamp: number
    size: number
    price: number
    side: 'BUY' | 'SELL'
    title?: string
  }>
}

export interface AlertEventRecord extends AlertEventPayload {
  id: string
  status: 'pending' | 'sent' | 'failed'
  triggeredAt: number
  nickname?: string
}
