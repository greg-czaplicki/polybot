export type Db = D1Database

export interface StatementResult<T = unknown> {
  success: boolean
  meta?: Record<string, unknown>
  error?: string | null
  results?: Array<T>
}

function prepare(db: Db, query: string, params: Array<unknown>) {
  const statement = db.prepare(query)
  if (params.length === 0) {
    return statement
  }

  return statement.bind(...params)
}

export async function run<T = unknown>(
  db: Db,
  query: string,
  ...params: Array<unknown>
) {
  const statement = prepare(db, query, params)
  return (await statement.run<T>()) as StatementResult<T>
}

export async function first<T = Record<string, unknown>>(
  db: Db,
  query: string,
  ...params: Array<unknown>
): Promise<T | null> {
  const statement = prepare(db, query, params)
  return (await statement.first<T>()) ?? null
}

export async function all<T = Record<string, unknown>>(
  db: Db,
  query: string,
  ...params: Array<unknown>
): Promise<Array<T>> {
  const statement = prepare(db, query, params)
  const { results } = await statement.all<T>()
  return results ?? []
}
