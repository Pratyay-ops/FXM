/**
 * Home's data as a TanStack Query: the feed is built once and kept for ten minutes, so the
 * shelves don't reshuffle while the user looks at them or plays from them, and coming back to
 * Home later builds it again. A change of catalog mode, of what the platform reaches, of the
 * Spotify switch, of the wired-in services or of the onboarding picks builds it at once.
 *
 * @module
 */

import { useQuery } from '@tanstack/react-query'
import { getLibrary } from '../../db/repo'
import { useSettingsStore } from '../settings/settings-store'
import { buildHomeFeed, type HomeFeedResult } from './feed'
import { type HomeServices, useHomeReach, useHomeServices } from './services'
import { createStableStore } from './stable-storage'
import { useTasteStore } from './taste-store'

/** How long a built Home is shown before it is built again. */
export const HOME_STALE_MS = 10 * 60_000

/** The app's store of the lists kept for their period. */
const appStableStore = createStableStore()

const versions = new WeakMap<HomeServices, number>()
let lastVersion = 0

/**
 * A number per services object, for query keys: wiring other services in builds Home (and
 * its onboarding suggestions) again.
 */
export function versionOf(services: HomeServices): number {
  let version = versions.get(services)
  if (version === undefined) {
    version = ++lastVersion
    versions.set(services, version)
  }
  return version
}

/** Home, built from the library and the services in use. */
export function useHomeFeed() {
  const services = useHomeServices()
  const reach = useHomeReach(services)
  const mode = useSettingsStore((state) => state.catalogMode)
  const picks = useTasteStore((state) => state.picks)
  const { youtube, spotify, mediaBytes } = reach.capabilities
  return useQuery<HomeFeedResult>({
    queryKey: [
      'home',
      'feed',
      mode,
      youtube,
      spotify,
      mediaBytes,
      reach.spotifyEnabled,
      picks?.at ?? 0,
      versionOf(services),
    ],
    queryFn: ({ signal }) =>
      buildHomeFeed({
        mode,
        services,
        repo: getLibrary(),
        stable: appStableStore,
        signal,
        ...(picks === undefined ? {} : { picks }),
      }),
    staleTime: HOME_STALE_MS,
    // The library is local: a failure is something like IndexedDB blocked, which a retry
    // rarely fixes.
    retry: false,
  })
}
