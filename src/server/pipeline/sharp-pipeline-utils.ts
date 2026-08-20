import type { Env } from '../env'

const PIPELINE_DO_ID = 'sharp-pipeline'

export function getPipelineStub(env: Env) {
  const id = env.SHARP_PIPELINE.idFromName(PIPELINE_DO_ID)
  return env.SHARP_PIPELINE.get(id)
}

const CANONICAL_SYNC_DO_ID = 'canonical-sync-enam-v1'

/**
 * Dedicated DO instance for the canonical sync, pinned near the D1 primary
 * (ENAM region; the primary serves from EWR). locationHint only applies the
 * first time a name is instantiated — if the D1 primary ever moves region,
 * bump the name suffix so a fresh instance is placed under the new hint.
 */
export function getCanonicalSyncStub(env: Env) {
  const id = env.SHARP_PIPELINE.idFromName(CANONICAL_SYNC_DO_ID)
  return env.SHARP_PIPELINE.get(id, { locationHint: 'enam' })
}
