/**
 * The app's single place for music sources: the registered metadata providers, what the
 * platform can reach (the tier) and the user's Spotify switch. Search, album, artist and
 * playlist pages read everything about sources from here, through `useSourcesSnapshot()`.
 *
 * Touch-points with stages that are built in parallel (see the README in this folder):
 *
 * - **1.2 platform:** {@link SourcesPlatform} is the part of `FxmPlatform` this module uses.
 *   Until it is wired in, {@link createStaticPlatform} stands in: the Free-only tier, with a
 *   `fetch` that refuses every request.
 * - **1.3 YouTube Music and 1.5 Spotify:** their providers are plain `MetadataProvider`s from
 *   `@fxm/core`, added with {@link Sources.register}.
 *
 * @module
 */

import {
  type BuiltInSourceId,
  type CatalogMode,
  type Fetch,
  FxmError,
  isBuiltInSourceId,
  type MetadataProvider,
  type NetworkCapabilities,
  type ProviderContext,
  type SourceId,
} from '@fxm/core'

/** The three tiers of the web app (ARCHITECTURE.md §8), by how far YouTube is reachable. */
export type Tier = 'free' | 'lite' | 'full'

/** Typical capabilities of each tier: what a browser without and with FXM Connect reaches. */
export const TIER_CAPABILITIES: Readonly<Record<Tier, NetworkCapabilities>> = {
  free: { youtube: 'none', spotify: 'unreachable', mediaBytes: false, fileSystem: false },
  lite: { youtube: 'simple', spotify: 'unreachable', mediaBytes: false, fileSystem: false },
  full: { youtube: 'full', spotify: 'anonymous', mediaBytes: true, fileSystem: false },
}

/** The tier that `capabilities` amount to. */
export function tierOf(capabilities: NetworkCapabilities): Tier {
  if (capabilities.youtube === 'full') return 'full'
  return capabilities.youtube === 'simple' ? 'lite' : 'free'
}

/**
 * What a provider call is for, highest first: the platform draws the call's YouTube requests
 * from the shared request budget at this priority (`RequestPriority` in `@fxm/platform`).
 */
export type SourcePriority = 'current-track' | 'prefetch' | 'interactive' | 'bulk'

/** What one provider call's context is built from. */
export interface SourceContextOptions {
  /** The catalog mode. */
  mode: CatalogMode
  /**
   * What the call is for. Default `interactive`: search, suggestions and the pages the user
   * opened, which is every call made here.
   */
  priority?: SourcePriority
  /** Cancels the call, e.g. when the user typed on. */
  signal?: AbortSignal
  /** Preferred language as a BCP 47 tag. */
  locale?: string
  /** Content region as an ISO 3166-1 alpha-2 code. */
  region?: string
}

/**
 * What this module needs from the platform layer: the capabilities, kept current, and a
 * `ProviderContext` per provider call. Stage 1.2's `FxmPlatform` has this shape, so it can be
 * passed to {@link Sources.setPlatform} as it is.
 */
export interface SourcesPlatform {
  /** What the platform can reach, kept up to date. */
  readonly capabilities: {
    /** The latest capabilities. */
    readonly current: NetworkCapabilities
    /** Calls `listener` whenever the capabilities change; returns the unsubscribe function. */
    subscribe(listener: (capabilities: NetworkCapabilities) => void): () => void
  }
  /**
   * A context for one provider call, with the platform's `fetch` for the call's priority and the
   * current capabilities. The priority is always given: `FxmPlatform` throws without one.
   */
  context(options: SourceContextOptions & { priority: SourcePriority }): ProviderContext
}

/** A {@link SourcesPlatform} whose capabilities are set by hand: the stand-in and the fake. */
export interface StaticPlatform extends SourcesPlatform {
  /** Changes the capabilities and tells subscribers, as a new detection would. */
  setCapabilities(capabilities: NetworkCapabilities): void
}

/** The `fetch` of a platform that reaches nothing: every request fails as `Unsupported`. */
const refuseFetch: Fetch = () =>
  Promise.reject(new FxmError('Unsupported', 'FXM has no network transport here yet'))

/**
 * A platform with fixed capabilities, the Free-only tier unless told otherwise. It stands in
 * for stage 1.2's platform until that is wired in, and tests and the dev fake catalog use it
 * to pick a tier. Its `fetch` refuses every request unless one is given.
 */
export function createStaticPlatform(
  initial: NetworkCapabilities = TIER_CAPABILITIES.free,
  fetch: Fetch = refuseFetch,
): StaticPlatform {
  let current = initial
  const listeners = new Set<(capabilities: NetworkCapabilities) => void>()
  return {
    capabilities: {
      get current() {
        return current
      },
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    context: ({ mode, signal, locale, region }) => ({
      fetch,
      platform: 'web',
      capabilities: current,
      mode,
      ...(signal === undefined ? {} : { signal }),
      ...(locale === undefined ? {} : { locale }),
      ...(region === undefined ? {} : { region }),
    }),
    setCapabilities(capabilities) {
      current = capabilities
      for (const listener of [...listeners]) listener(capabilities)
    },
  }
}

/**
 * The user's Spotify on/off switch, as {@link createSources} reads it: a store whose state
 * says whether Spotify is switched on (see `spotify-switch.ts`).
 */
export interface SpotifySwitch {
  /** The current state. */
  getState(): { readonly enabled: boolean; setEnabled(enabled: boolean): void }
  /** Calls `listener` after every change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
}

/** An in-memory {@link SpotifySwitch}, on unless told otherwise. */
export function createMemorySpotifySwitch(enabled = true): SpotifySwitch {
  const listeners = new Set<() => void>()
  const state = {
    enabled,
    setEnabled(next: boolean) {
      if (state.enabled === next) return
      state.enabled = next
      for (const listener of [...listeners]) listener()
    },
  }
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** Everything about sources at one moment. A new object after every change. */
export interface SourcesSnapshot {
  /** What the platform can reach. */
  readonly capabilities: NetworkCapabilities
  /**
   * Counts the platforms set with {@link Sources.setPlatform}. A new platform can reach more than
   * the one before it with the same capabilities (the stand-in reaches nothing at all), so
   * results fetched through the old one must not be reused: query keys hold this number.
   */
  readonly platformRevision: number
  /** Whether the user switched Spotify on (it is used only when it is also reachable). */
  readonly spotifyEnabled: boolean
  /** The registered metadata providers, by source. */
  readonly providers: ReadonlyMap<SourceId, MetadataProvider>
  /**
   * Whether the tier is still being worked out: FXM Connect's marker is on the page, but it has
   * not answered yet (a service worker waking up can take a second or two). Meanwhile the pages
   * say they are connecting rather than offering to install it. Absent means `false`.
   */
  readonly detecting?: boolean
}

/** The app's sources: see the module documentation. */
export interface Sources {
  /** The current state. The same object until something changes, for `useSyncExternalStore`. */
  getSnapshot(): SourcesSnapshot
  /** Calls `listener` after every change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /**
   * Adds a metadata provider for its source, replacing any provider registered for that source
   * before. Returns a function that removes it again.
   */
  register(provider: MetadataProvider): () => void
  /**
   * Uses another platform, e.g. stage 1.2's once `createPlatform()` resolves. Results fetched
   * through the platform before are fetched again (see {@link SourcesSnapshot.platformRevision}).
   */
  setPlatform(platform: SourcesPlatform): void
  /** Switches Spotify on or off (the setting, not whether it is reachable). */
  setSpotifyEnabled(enabled: boolean): void
  /** Says whether the tier is still being worked out (see {@link SourcesSnapshot.detecting}). */
  setDetecting(detecting: boolean): void
  /** A context for one provider call. */
  context(options: SourceContextOptions): ProviderContext
}

/** Options for {@link createSources}. */
export interface SourcesOptions {
  /** The platform. Default: {@link createStaticPlatform}, the Free-only tier. */
  platform?: SourcesPlatform
  /** Providers to register at once. */
  providers?: readonly MetadataProvider[]
  /** The Spotify switch. Default: an in-memory one that is on. */
  spotifySwitch?: SpotifySwitch
}

function sameCapabilities(a: NetworkCapabilities, b: NetworkCapabilities): boolean {
  return (
    a.youtube === b.youtube &&
    a.spotify === b.spotify &&
    a.mediaBytes === b.mediaBytes &&
    a.fileSystem === b.fileSystem
  )
}

/** Creates the sources registry: one for the app, and one per test. */
export function createSources(options: SourcesOptions = {}): Sources {
  let platform = options.platform ?? createStaticPlatform()
  const spotifySwitch = options.spotifySwitch ?? createMemorySpotifySwitch()
  const providers = new Map<SourceId, MetadataProvider>()
  for (const provider of options.providers ?? []) providers.set(provider.id, provider)
  const listeners = new Set<() => void>()

  let snapshot: SourcesSnapshot = {
    capabilities: platform.capabilities.current,
    platformRevision: 0,
    spotifyEnabled: spotifySwitch.getState().enabled,
    providers: new Map(providers),
    detecting: false,
  }

  function update(changes: Partial<SourcesSnapshot>) {
    snapshot = { ...snapshot, ...changes }
    for (const listener of [...listeners]) listener()
  }

  function onCapabilities() {
    const capabilities = platform.capabilities.current
    if (!sameCapabilities(capabilities, snapshot.capabilities)) update({ capabilities })
  }

  let stopPlatform = platform.capabilities.subscribe(onCapabilities)
  spotifySwitch.subscribe(() => {
    const spotifyEnabled = spotifySwitch.getState().enabled
    if (spotifyEnabled !== snapshot.spotifyEnabled) update({ spotifyEnabled })
  })

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    register(provider) {
      providers.set(provider.id, provider)
      update({ providers: new Map(providers) })
      return () => {
        if (providers.get(provider.id) !== provider) return
        providers.delete(provider.id)
        update({ providers: new Map(providers) })
      }
    },
    setPlatform(next) {
      if (next === platform) return
      stopPlatform()
      platform = next
      stopPlatform = platform.capabilities.subscribe(onCapabilities)
      // A new snapshot even when the capabilities stay the same: see platformRevision.
      update({
        capabilities: platform.capabilities.current,
        platformRevision: snapshot.platformRevision + 1,
      })
    },
    setSpotifyEnabled(enabled) {
      spotifySwitch.getState().setEnabled(enabled)
    },
    setDetecting(detecting) {
      if (detecting !== snapshot.detecting) update({ detecting })
    },
    context: ({ priority = 'interactive', ...contextOptions }) =>
      platform.context({ ...contextOptions, priority }),
  }
}

/** Whether a source is YouTube: YouTube Music (`ytm`) or plain YouTube (`yt`). */
export function isYouTubeSource(source: SourceId): boolean {
  return source === 'ytm' || source === 'yt'
}

/**
 * Whether a source has videos to search for: only YouTube's. A Videos tab for any other source
 * would always be empty.
 */
export function hasVideos(source: SourceId): boolean {
  return isYouTubeSource(source)
}

/**
 * Whether a source can be used, and if not, why:
 *
 * - `available`: its provider is registered and the platform reaches it
 * - `needs-youtube`: a YouTube source while YouTube can't be reached (the Free-only tier).
 *   The UI shows the onboarding entry point instead of empty results
 * - `spotify-off`: Spotify, while the user has switched it off
 * - `spotify-unreachable`: Spotify, which the platform can't reach (no FXM Connect)
 * - `missing`: no provider is registered for the source
 */
export type SourceAvailability =
  | { readonly status: 'available'; readonly provider: MetadataProvider }
  | { readonly status: 'needs-youtube' | 'spotify-off' | 'spotify-unreachable' | 'missing' }

/**
 * The provider registered for a source. Plain YouTube (`yt`) shares YouTube Music's ID space, so
 * the YouTube Music provider answers for it when no `yt` provider is registered.
 */
export function providerFor(
  snapshot: SourcesSnapshot,
  source: SourceId,
): MetadataProvider | undefined {
  return (
    snapshot.providers.get(source) ?? (source === 'yt' ? snapshot.providers.get('ytm') : undefined)
  )
}

/** Whether `source` can be used now, and if not, why (see {@link SourceAvailability}). */
export function sourceAvailability(
  snapshot: SourcesSnapshot,
  source: SourceId,
): SourceAvailability {
  const { capabilities } = snapshot
  if (isYouTubeSource(source) && capabilities.youtube === 'none') return { status: 'needs-youtube' }
  if (source === 'spotify') {
    if (!snapshot.spotifyEnabled) return { status: 'spotify-off' }
    if (capabilities.spotify === 'unreachable') return { status: 'spotify-unreachable' }
  }
  const provider = providerFor(snapshot, source)
  return provider === undefined ? { status: 'missing' } : { status: 'available', provider }
}

/**
 * Whether the search page may ask `provider` for completions as the user types: when it has
 * `suggest`, and is not a source to call only on request (`requestPolicy: 'explicit'`, such as
 * Jamendo, whose one shared `client_id` has a small monthly budget). The user never asked that
 * source for suggestions.
 */
export function canSuggest(provider: MetadataProvider): boolean {
  return provider.suggest !== undefined && provider.requestPolicy !== 'explicit'
}

/** The order sources are offered in. Plugin sources follow, by name. */
const SOURCE_ORDER: readonly SourceId[] = ['ytm', 'spotify', 'archive', 'jamendo', 'local']

function sourceRank(source: SourceId): number {
  const index = SOURCE_ORDER.indexOf(source)
  return index === -1 ? SOURCE_ORDER.length : index
}

/**
 * The sources the search page offers, in order. YouTube Music always comes first, even when it
 * can't be reached, so that the page can show how to reach it. The others are listed only when
 * they can be used: Spotify only when it is switched on and reachable.
 */
export function searchSourceIds(snapshot: SourcesSnapshot): SourceId[] {
  const others = [...snapshot.providers.keys()]
    .filter((source) => !isYouTubeSource(source))
    .filter((source) => sourceAvailability(snapshot, source).status === 'available')
    .sort((a, b) => sourceRank(a) - sourceRank(b) || a.localeCompare(b))
  return ['ytm', ...others]
}

const SOURCE_LABELS: Readonly<Record<BuiltInSourceId, string>> = {
  ytm: 'YouTube Music',
  yt: 'YouTube',
  spotify: 'Spotify',
  archive: 'Internet Archive',
  jamendo: 'Jamendo',
  local: 'This device',
}

/** A source's name for people, e.g. `YouTube Music`, or a plugin's name. Text only, no logos. */
export function sourceLabel(source: SourceId): string {
  return isBuiltInSourceId(source) ? SOURCE_LABELS[source] : source.slice('plugin.'.length)
}

/** What an item from one source allows on this platform, beyond playing it. */
export interface ItemFeatures {
  /** Whether the item can be downloaded. */
  readonly download: boolean
  /** Whether the equalizer can process the item's audio. */
  readonly equalizer: boolean
}

/**
 * What an item from `source` allows. Downloads and the equalizer need the audio's bytes:
 *
 * - YouTube items need `mediaBytes`, which only `full` YouTube access has. So in the Lite tier
 *   (`simple`), download and equalizer are hidden on YouTube items.
 * - Spotify items play from a matched song, usually on YouTube, so they follow the same rule.
 * - Internet Archive, Jamendo and local files are always readable. A local file is on the
 *   device already: it gets the equalizer, but nothing to download.
 * - Plugin sources are unknown, so they get neither.
 */
export function itemFeatures(capabilities: NetworkCapabilities, source: SourceId): ItemFeatures {
  const readable =
    isYouTubeSource(source) || source === 'spotify'
      ? capabilities.mediaBytes
      : source === 'archive' || source === 'jamendo' || source === 'local'
  return { download: readable && source !== 'local', equalizer: readable }
}
