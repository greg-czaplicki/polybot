import { DurableObject } from 'cloudflare:workers'
import type { DurableObjectState } from 'cloudflare:workers'
import type { Env } from '../env'
import { fetchTrendingSportsMarkets } from '../api/sharp-money'
import { refreshMarketSharpness } from '../api/sharp-money'
import { getPipelineStub } from './sharp-pipeline-utils'

export type SharpPipelineJob = {
  conditionId: string
  marketTitle: string
  marketSlug?: string
  eventSlug?: string
  sportSeriesId?: number
  outcomes?: string[]
  bestBid?: number
  bestAsk?: number
  endDate?: string
}

type PipelineStatus = {
  inProgress: boolean
  startedAt?: number
  updatedAt?: number
  totalQueued?: number
  processed?: number
}

const DEFAULT_INTERVAL_MS = 2 * 60 * 1000
const QUEUE_BATCH_SIZE = 100

export class SharpPipeline extends DurableObject {
  private state: DurableObjectState
  private env: Env

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    this.state = state
    this.env = env
  }

  async fetch(request: Request) {
    const url = new URL(request.url)
    if (url.pathname === '/status') {
      const status =
        (await this.state.storage.get<PipelineStatus>('status')) ??
        ({ inProgress: false } as PipelineStatus)
      return Response.json(status)
    }

    if (url.pathname === '/progress') {
      const body = request.method === 'POST'
        ? await request.json().catch(() => ({})) as { processed?: number }
        : {}
      const current =
        (await this.state.storage.get<PipelineStatus>('status')) ??
        ({ inProgress: false } as PipelineStatus)
      const processed = (current.processed ?? 0) + (body.processed ?? 1)
      const totalQueued = current.totalQueued ?? 0
      const updatedAt = Date.now()
      const nextStatus: PipelineStatus = {
        ...current,
        processed,
        updatedAt,
        inProgress: totalQueued > 0 ? processed < totalQueued : current.inProgress ?? false,
      }
      await this.state.storage.put('status', nextStatus)
      return Response.json(nextStatus)
    }

    if (url.pathname !== '/tick') {
      return new Response('Not found', { status: 404 })
    }

    const body = request.method === 'POST'
      ? await request.json().catch(() => ({})) as { force?: boolean }
      : {}

    const now = Date.now()
    const lastRun = (await this.state.storage.get<number>('lastRun')) ?? 0
    if (!body.force && now - lastRun < DEFAULT_INTERVAL_MS) {
      return Response.json({
        queued: false,
        reason: 'cooldown',
        nextInMs: Math.max(0, DEFAULT_INTERVAL_MS - (now - lastRun)),
      })
    }

    await this.state.storage.put('lastRun', now)

    const { markets } = await fetchTrendingSportsMarkets({
      includeAllMarkets: false,
    })

    if (!markets || markets.length === 0) {
      await this.state.storage.put('status', {
        inProgress: false,
        updatedAt: Date.now(),
        totalQueued: 0,
        processed: 0,
      } satisfies PipelineStatus)
      return Response.json({ queued: false, reason: 'no_markets' })
    }

    const jobs: SharpPipelineJob[] = markets.map((market) => ({
      conditionId: market.conditionId,
      marketTitle: market.title,
      marketSlug: market.slug,
      eventSlug: market.eventSlug,
      sportSeriesId: market.sportSeriesId ?? undefined,
      outcomes: market.outcomes,
      bestBid: market.bestBid,
      bestAsk: market.bestAsk,
      endDate: market.endDate,
    }))

    for (let i = 0; i < jobs.length; i += QUEUE_BATCH_SIZE) {
      const chunk = jobs.slice(i, i + QUEUE_BATCH_SIZE)
      await this.env.SHARP_PIPELINE_QUEUE.sendBatch(
        chunk.map((job) => ({ body: job })),
      )
    }

    await this.state.storage.put('status', {
      inProgress: true,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      totalQueued: jobs.length,
      processed: 0,
    } satisfies PipelineStatus)

    return Response.json({
      queued: true,
      jobs: jobs.length,
    })
  }
}

export async function handleSharpQueue(
  batch: MessageBatch<SharpPipelineJob>,
  env: Env,
  executionCtx: ExecutionContext,
) {
  for (const message of batch.messages) {
    try {
      await refreshMarketSharpness(env, message.body)
      const stub = getPipelineStub(env)
      await stub.fetch('https://sharp-pipeline/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processed: 1 }),
      })
      message.ack()
    } catch (error) {
      console.error('[sharp-pipeline] Job failed', message.body.conditionId, error)
      message.retry()
    }
  }
}
