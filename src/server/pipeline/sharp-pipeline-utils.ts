import type { Env } from '../env'

const PIPELINE_DO_ID = 'sharp-pipeline'

export function getPipelineStub(env: Env) {
  const id = env.SHARP_PIPELINE.idFromName(PIPELINE_DO_ID)
  return env.SHARP_PIPELINE.get(id)
}
