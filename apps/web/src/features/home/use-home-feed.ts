/**
 * Home's data as TanStack Queries. A build first hands over the user's own shelves, from the
 * library alone, which show while the sources are asked (the feed query's placeholder), then
 * the whole of Home. A built Home is kept for ten minutes, so the shelves don't reshuffle while
 * the user looks at them or plays from them, and coming back to Home later builds it again (a
 * Home that missed a slow or failing source, after two minutes). A change of catalog mode, of
 * what the platform reaches, of the Spotify switch, of the wired-in services, of the onboarding
 * picks, or of the listening history's start (cleared, restored, imported) builds it at once.
 *
 * @module
 */

import { skipToken, useQuery } from '@tanstack/react-query'
import { useLive } from '../../db/hooks'
import { getLibrary } from '../../db/repo'
import { useSettingsStore } from '../settings/settings-store'
import { buildHomeFeed, type HomeFeedResult } from './feed'
import { type HomeServices, useHomeReach, useHomeServices } from './services'
import { createStableStore, type HistoryBasis } from './stable-storage'
import { useTasteStore } from './taste-store'

/** How long a built Home is shown before it is built again. */
export const HOME_STALE_MS = 10 * 60_000

/** How long a Home that missed some of its sources is shown before it is built again. */
export const PARTIAL_STALE_MS = 2 * 60_000

/** How long a built Home is kept once no page shows it: longer than it stays fresh. */
export const HOME_GC_MS = 30 * 60_000

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

/** Where Home's query keys hold the listening history's start. */
const BASIS_AT = 3

/** When the listening history starts, kept current (see `stable-storage.ts`). */
function useHistoryBasis() {
  return useLive(async (repo): Promise<HistoryBasis> => (await repo.historyStart()) ?? null, [])
}

/**
 * Home, built from the library and the services in use. While it is being built,
 * `isPlaceholderData` is true and the data is its first pass (`phase` is `local`) or, for a
 * moment before that, the Home shown before.
 */
export function useHomeFeed() {
  const services = useHomeServices()
  const reach = useHomeReach(services)
  const mode = useSettingsStore((state) => state.catalogMode)
  const picks = useTasteStore((state) => state.picks)
  const history = useHistoryBasis()
  const { youtube, spotify, mediaBytes } = reach.capabilities
  // A history that can't be read (IndexedDB blocked) leaves the build to report the failure.
  const basis = history.status === 'ready' ? history.data : history.status
  const base = ['home', mode, picks?.at ?? 0, basis, versionOf(services)]
  const localKey = [...base, 'local']
  // Filled by the build itself, with its first pass.
  const local = useQuery<HomeFeedResult>({
    queryKey: localKey,
    queryFn: skipToken,
    gcTime: HOME_GC_MS,
  })
  return useQuery<HomeFeedResult>({
    queryKey: [...base, 'feed', youtube, spotify, mediaBytes, reach.spotifyEnabled],
    queryFn: ({ signal, client }) =>
      buildHomeFeed({
        mode,
        services,
        repo: getLibrary(),
        stable: appStableStore,
        signal,
        onLocal: (feed) => client.setQueryData(localKey, feed),
        ...(picks === undefined ? {} : { picks }),
      }),
    enabled: history.status !== 'loading',
    // The first pass, once there; until then the Home shown before (in another mode, say), so
    // the page doesn't flash empty for the moment the library takes. Not one built from plays
    // the history has since forgotten.
    placeholderData: (previous, previousQuery) =>
      local.data ?? (previousQuery?.queryKey[BASIS_AT] === basis ? previous : undefined),
    staleTime: (query) => (query.state.data?.complete === false ? PARTIAL_STALE_MS : HOME_STALE_MS),
    gcTime: HOME_GC_MS,
    // The library is local: a failure is something like IndexedDB blocked, which a retry
    // rarely fixes.
    retry: false,
  })
}
