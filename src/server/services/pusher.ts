import type { Env } from '../env'

interface PusherBeamsPayload {
  interests: string[]
  web?: {
    notification: {
      title: string
      body: string
      icon?: string
      data?: Record<string, unknown>
    }
  }
  data?: Record<string, unknown>
}

/**
 * Sends a push notification via Pusher Beams API.
 * This works even when the app is closed or the screen is locked.
 */
export async function sendPusherNotification(
  env: Env,
  payload: {
    interests: string[]
    title: string
    body: string
    data?: Record<string, unknown>
  },
) {
  const instanceId = env.PUSHER_BEAMS_INSTANCE_ID
  const secretKey = env.PUSHER_BEAMS_SECRET_KEY

  if (!instanceId || !secretKey) {
    console.warn('Pusher Beams configuration is missing; skipping notification')
    return
  }

  // Build notification payload - icon must be a full URI, not a relative path
  const notificationPayload: PusherBeamsPayload['web'] = {
    notification: {
      title: payload.title,
      body: payload.body,
      data: payload.data,
    },
  }

  // Only include icon if we can construct a full URL
  // For now, we'll omit it since we don't have the origin in the server context
  // You can add it later if needed by passing the origin or using a CDN URL

  const beamsPayload: PusherBeamsPayload = {
    interests: payload.interests,
    web: notificationPayload,
    data: payload.data,
  }

  const url = `https://${instanceId}.pushnotifications.pusher.com/publish_api/v1/instances/${instanceId}/publishes/interests`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secretKey}`,
    },
    body: JSON.stringify(beamsPayload),
  })

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText)
    console.error('Pusher Beams notification failed', response.status, message)
    throw new Error(`Pusher Beams API error: ${response.status} - ${message}`)
  }

  const responseData = await response.json().catch(() => null)
  console.log('Pusher Beams notification sent successfully:', responseData)
  return responseData
}
