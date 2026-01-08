import { useEffect, useState } from 'react'

export function useRequireAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null)

  useEffect(() => {
    const authStatus = sessionStorage.getItem('polywhaler_authenticated') === 'true'
    setIsAuthenticated(authStatus)
    if (!authStatus) {
      window.location.href = '/login'
    }
  }, [])

  return isAuthenticated
}
