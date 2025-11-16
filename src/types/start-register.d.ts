import type { RequestContext } from '../server/env'

declare module '@tanstack/react-start' {
  interface Register {
    server: {
      requestContext: RequestContext
    }
  }
}
