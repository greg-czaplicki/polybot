import { createServerFn } from '@tanstack/react-start'

import { signAuthToken } from '../auth-token'

export const verifyPasswordFn = createServerFn({ method: 'POST' }).handler(
  async ({ data, context }) => {
    if (!context?.env) {
      throw new Error('Environment not available')
    }

    const password = context.env.APP_PASSWORD
    if (!password) {
      // If no password is set, allow access (backward compatibility)
      const authSecret = context.env.APP_AUTH_SECRET
      if (!authSecret) {
        return { success: true }
      }
      const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000
      const token = await signAuthToken(authSecret, expiresAt)
      return { success: true, token, expiresAt }
    }

    const providedPassword = (data as { password?: string })?.password
    if (!providedPassword) {
      throw new Error('Password is required')
    }

    // Simple password comparison (in production, use proper hashing)
    if (providedPassword !== password) {
      throw new Error('Invalid password')
    }

    const authSecret = context.env.APP_AUTH_SECRET ?? password
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000
    const token = await signAuthToken(authSecret, expiresAt)

    return { success: true, token, expiresAt }
  },
)
