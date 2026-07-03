import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState } from "react"

/** TanStack Query provider — server-state cache for all feature modules. */
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
        },
      }),
  )
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
