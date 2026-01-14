import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { verifyPasswordFn } from '../server/api/auth'

export const Route = createFileRoute('/login')({
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const AUTH_TTL_DAYS = 30

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    setIsLoading(true)

    try {
      await verifyPasswordFn({ data: { password } })
      // Store authentication in localStorage with TTL
      const expiresAt = Date.now() + AUTH_TTL_DAYS * 24 * 60 * 60 * 1000
      localStorage.setItem('polywhaler_authenticated', 'true')
      localStorage.setItem('polywhaler_auth_expires_at', String(expiresAt))
      // Redirect to primary app
      navigate({ to: '/sharp' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid password')
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-slate-950/70 border border-slate-900 rounded-2xl p-8 space-y-6">
          <div className="text-center space-y-2">
            <div className="mb-4 flex flex-col items-center gap-3">
              <img
                src="/logo-trans.png"
                alt="Polywhaler"
                className="h-22 w-auto"
              />
              <h1 className="text-3xl font-black text-white uppercase tracking-wider">
                Poly<span className="text-cyan-400">whaler</span>
              </h1>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="password" className="block text-sm font-semibold text-gray-300 mb-2">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-xl border border-slate-800 bg-slate-950/50 px-4 py-3 text-white placeholder-gray-500 focus:border-cyan-400 focus:outline-none focus:ring-2 focus:ring-cyan-400/20"
                placeholder="Enter password"
                disabled={isLoading}
              />
            </div>

            {error && (
              <div className="bg-rose-950/40 border border-rose-900 text-rose-200 px-4 py-3 rounded-xl text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading || !password}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-500 px-4 py-3 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isLoading ? 'Verifying...' : 'Access Dashboard'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
