import type { ReactNode } from 'react'
import { Loader2 } from 'lucide-react'

import { useRequireAuth } from '@/lib/auth'

export function AuthGate({ children }: { children: ReactNode }) {
  const isAuthenticated = useRequireAuth()

  if (isAuthenticated === false) {
    return null
  }

  if (isAuthenticated === null) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-white flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-400 mx-auto mb-4" />
          <p className="text-gray-400">Checking authentication...</p>
        </div>
      </div>
    )
  }

  return <>{children}</>
}
