import { createContext, type ReactNode, useContext, useSyncExternalStore } from 'react'
import { appActions } from './actions'
import { createSources, type Sources, type SourcesSnapshot } from './sources'
import { createSpotifySwitch, syncSpotifySwitchAcrossTabs } from './spotify-switch'

/** The app's Spotify switch, persisted with the other settings. */
const appSpotifySwitch = createSpotifySwitch()
syncSpotifySwitchAcrossTabs(appSpotifySwitch)

/**
 * The app's sources. Until stage 1.2's platform and the providers of 1.3 and 1.5 are wired in,
 * it reaches nothing: the Free-only tier, with no providers. Wire them in with
 * `appSources.setPlatform(platform)` and `appSources.register(provider)`.
 */
export const appSources: Sources = createSources({ spotifySwitch: appSpotifySwitch })

// Development only (and screenshot builds made with VITE_FXM_FAKE_CATALOG=on): `?fake=full`,
// `lite` or `free` in the URL plugs a fake catalog into the app's sources (see dev-fakes.ts).
// Production builds drop this branch, and with it the fake catalog.
if (import.meta.env.DEV || import.meta.env.VITE_FXM_FAKE_CATALOG === 'on') {
  void import('./dev-fakes').then(({ installDevFakes }) => installDevFakes(appSources, appActions))
}

const SourcesContext = createContext<Sources>(appSources)

/** Provides other sources to the pages below it: tests pass fakes. */
export function SourcesProvider({ sources, children }: { sources: Sources; children: ReactNode }) {
  return <SourcesContext value={sources}>{children}</SourcesContext>
}

/** The sources in use here. */
export function useSources(): Sources {
  return useContext(SourcesContext)
}

/** The current sources state; re-renders on every change (tier, providers, Spotify switch). */
export function useSourcesSnapshot(): SourcesSnapshot {
  const sources = useSources()
  return useSyncExternalStore(sources.subscribe, sources.getSnapshot, sources.getSnapshot)
}
