#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const useRemote = process.argv.includes('--remote')
const projectRoot = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const wranglerBin = path.join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler')

function runSql(sql) {
  const args = ['d1', 'execute', 'polywhaler', '--json', '--command', sql]
  if (useRemote) {
    args.push('--remote')
  }
  const result = spawnSync(wranglerBin, args, {
    cwd: projectRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout)
    throw new Error('wrangler d1 execute failed')
  }
  const payload = JSON.parse(result.stdout || '[]')
  return payload[0]?.results ?? []
}

function escapeSql(value) {
  return value.replace(/'/g, "''")
}

async function fetchEventTimestamp(slug) {
  const url = new URL('https://gamma-api.polymarket.com/events')
  url.searchParams.set('slug', slug)
  const response = await fetch(url)
  if (!response.ok) {
    console.warn(`Unable to load gamma data for ${slug} (${response.status})`)
    return null
  }
  const payload = await response.json()
  if (!Array.isArray(payload) || payload.length === 0) {
    return null
  }
  const [event] = payload
  if (!event?.endDate) {
    return null
  }
  const parsed = new Date(event.endDate)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  return Math.floor(parsed.getTime() / 1000)
}

async function main() {
  const rows = runSql(
    `SELECT DISTINCT event_slug FROM wallet_results WHERE event_slug IS NOT NULL AND event_end_timestamp IS NULL`,
  )
  const slugs = rows.map((row) => row.event_slug).filter((slug) => typeof slug === 'string')
  if (slugs.length === 0) {
    console.log('No wallet_results rows require backfill.')
    return
  }

  let updated = 0
  for (const slug of slugs) {
    const timestamp = await fetchEventTimestamp(slug)
    if (!timestamp) {
      console.warn(`Skipping ${slug}: unable to determine endDate`)
      continue
    }
    runSql(
      `UPDATE wallet_results SET event_end_timestamp = ${timestamp}, resolved_at = ${timestamp} WHERE event_slug = '${escapeSql(
        slug,
      )}' AND event_end_timestamp IS NULL`,
    )
    updated += 1
    console.log(`Updated ${slug} → ${timestamp}`)
  }

  console.log(`Backfill complete. ${updated} slugs updated (${slugs.length} scanned).`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
