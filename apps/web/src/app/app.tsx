import { QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
// Not 'react-router/dom': under Vitest that entry can load a different build of the
// router than 'react-router' (ESM vs CJS), and hooks then miss the router context.
import { RouterProvider, type RouterProviderProps } from 'react-router'
import { syncSettingsAcrossTabs } from '../features/settings/settings-store'
import { useThemeSync } from '../features/settings/theme'
import { AppErrorBoundary } from './errors'
import { createQueryClient } from './query-client'

/** Applies the theme setting and keeps settings in step with other open tabs. */
function SettingsSync() {
  useThemeSync()
  useEffect(() => syncSettingsAcrossTabs(), [])
  return null
}

/** The app with its providers. main.tsx passes a browser router; tests a memory router. */
export function App({ router }: { router: RouterProviderProps['router'] }) {
  const [queryClient] = useState(createQueryClient)
  return (
    <AppErrorBoundary>
      <SettingsSync />
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AppErrorBoundary>
  )
}
