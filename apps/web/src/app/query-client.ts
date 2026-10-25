import { QueryClient } from '@tanstack/react-query'

/**
 * The TanStack Query client. Nothing is queried yet: the providers that run in
 * the page (stages 1.x and 2.4) add the queries.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Catalog metadata changes slowly; avoid refetching on every visit.
        staleTime: 5 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  })
}
