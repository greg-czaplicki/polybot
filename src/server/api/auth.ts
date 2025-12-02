import { createServerFn } from '@tanstack/react-start'
import { getDb } from '../env'

export const verifyPasswordFn = createServerFn({ method: 'POST' }).handler(
  async ({ data, context }) => {
    if (!context?.env) {
      throw new Error('Environment not available')
    }

    const password = context.env.APP_PASSWORD
    if (!password) {
      // If no password is set, allow access (backward compatibility)
      return { success: true }
    }

    const providedPassword = (data as { password?: string })?.password
    if (!providedPassword) {
      throw new Error('Password is required')
    }

    // Simple password comparison (in production, use proper hashing)
    if (providedPassword !== password) {
      throw new Error('Invalid password')
    }

    return { success: true }
  },
)

