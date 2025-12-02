import type { Env } from '../env'

interface PusherPayload {
  channel: string
  event: string
  data: unknown
}

const textEncoder = new TextEncoder()

function toHex(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function hashMd5(payload: string) {
  const data = textEncoder.encode(payload)
  const digest = await crypto.subtle.digest('MD5', data)
  return toHex(digest)
}

async function hmacSha256(secret: string, message: string) {
  const keyData = textEncoder.encode(secret)
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(message))
  return toHex(signature)
}

export async function sendPusherNotification(env: Env, payload: PusherPayload) {
  const appId = env.PUSHER_APP_ID
  const key = env.PUSHER_KEY
  const secret = env.PUSHER_SECRET
  const cluster = env.PUSHER_CLUSTER

  if (!appId || !key || !secret || !cluster) {
    console.warn('Pusher configuration is missing; skipping notification')
    return
  }

  const body = JSON.stringify({
    name: payload.event,
    channel: payload.channel,
    data: JSON.stringify(payload.data),
  })
  const timestamp = Math.floor(Date.now() / 1000)
  const bodyMd5 = await hashMd5(body)
  const path = `/apps/${appId}/events`
  const query = new URLSearchParams({
    auth_key: key,
    auth_timestamp: String(timestamp),
    auth_version: '1.0',
    body_md5: bodyMd5,
  })
  const stringToSign = ['POST', path, query.toString()].join('\n')
  const signature = await hmacSha256(secret, stringToSign)
  query.set('auth_signature', signature)

  const url = `https://api-${cluster}.pusher.com${path}?${query.toString()}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText)
    console.error('Pusher notification failed', response.status, message)
  }
}
