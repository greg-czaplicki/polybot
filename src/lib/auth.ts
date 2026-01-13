import { useEffect, useState } from 'react'

export function useRequireAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null)

  useEffect(() => {
    const expiresAt = Number(localStorage.getItem('polywhaler_auth_expires_at') ?? 0)
    const authStatus = localStorage.getItem('polywhaler_authenticated') === 'true'
      && Number.isFinite(expiresAt)
      && expiresAt > Date.now()
    setIsAuthenticated(authStatus)
    if (!authStatus) {
      window.location.href = '/login'
    }
  }, [])

  return isAuthenticated
}
