interface D1Result<T = unknown> {
  success: boolean
  error?: string | null
  results?: Array<T>
  meta?: Record<string, unknown>
}

interface D1PreparedStatement {
  bind(...values: Array<unknown>): D1PreparedStatement
  first<T = unknown>(column?: string): Promise<T | null>
  raw<T = unknown>(): Promise<Array<Array<T>>>
  run<T = unknown>(): Promise<D1Result<T>>
  all<T = unknown>(): Promise<{ results: Array<T> }>
}

interface D1Database {
  prepare(query: string): D1PreparedStatement
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException(): void
}

interface ScheduledEvent {
  readonly type: 'scheduled'
  readonly scheduledTime: number
  readonly cron: string
  noRetry(): void
}
