/**
 * What imports need from the rest of the app: the platform (stage 1.2: provider contexts, the
 * request budget, bot-check reports), the Spotify provider (1.5), MusicBrainz (1.6), the YouTube
 * adapter (1.3) and the Auto setting (1.12).
 *
 * Pages get them from {@link useImportServices}: tests pass fakes through
 * {@link ImportServicesProvider}, and the app's come from its composition root (stage 2.9,
 * `src/app/services/imports.ts`), which connects them with {@link connectAppImportServices}: the
 * app's one platform and providers, shared with search and playback.
 *
 * @module
 */

import type { CatalogMode, MatchingConfig, NetworkCapabilities, ProviderContext } from '@fxm/core'
import type { FxmPlatform, RequestPriority } from '@fxm/platform'
import {
  type ImportMusicBrainz,
  type ImportSpotify,
  type ImportYouTube,
  YOUTUBE_IMPORT_UNAVAILABLE,
} from '@fxm/sources/import'
import { createContext, type ReactNode, useContext, useMemo } from 'react'

/**
 * Whether imports can find songs here:
 *
 * - `ready`: YouTube Music can be reached
 * - `needs-connect`: this browser cannot reach YouTube Music; FXM Connect (or the desktop or
 *   Android app) would
 * - `unavailable`: this version of FXM cannot search YouTube Music for imports (services built
 *   without the YouTube providers of stage 1.3, as some tests build them)
 */
export type MatchingAvailability = 'ready' | 'needs-connect' | 'unavailable'

/** What imports need from the app. */
export interface ImportServices {
  /**
   * A provider context for an import's calls, in `mode`: the budget's `bulk` priority, or
   * `interactive` for a load the user waits for (a playlist link).
   */
  context(mode: CatalogMode, signal?: AbortSignal, priority?: RequestPriority): ProviderContext
  /** Waits until the request budget allows the next bulk call. */
  waitForBulkSlot(signal: AbortSignal): Promise<void>
  /** When the budget's next bulk call can start, as epoch milliseconds. */
  nextBulkSlotAt(): number
  /** Passes a provider error on to the platform: bot checks pause bulk work. */
  report(error: unknown): void
  /** What the platform reaches now. */
  capabilities(): NetworkCapabilities
  /** Calls `listener` when the capabilities change. Returns a function that stops it. */
  subscribeCapabilities(listener: () => void): () => void
  /** Whether imports can find songs here now. */
  matching(): MatchingAvailability
  /** Whether the device is online (`navigator.onLine`). */
  isOnline(): boolean
  /** YouTube Music and YouTube. */
  youtube: ImportYouTube
  /** Spotify, when it is built in and switched on. */
  spotify: ImportSpotify | undefined
  /** MusicBrainz's exact path. */
  musicBrainz: ImportMusicBrainz | undefined
  /** The Auto setting: whether matches may play without asking. Off until stage 1.12 turns it on. */
  autoMatch(): boolean
  /**
   * The matching config imports match with (stage 1.12): its thresholds and measured fallback,
   * and whether the Auto band is available at all. Default: the one FXM ships with, which keeps
   * Auto off. Tests pass one that makes it available.
   */
  matchingConfig?: MatchingConfig
}

/** Whether the device is online, as the browser says; `true` where it cannot say. */
export function browserOnline(): boolean {
  return (globalThis.navigator as { onLine?: boolean } | undefined)?.onLine !== false
}

/** The parts {@link createImportServices} builds on. */
export interface ImportServiceParts {
  /** The app's platform. */
  platform: Pick<FxmPlatform, 'context' | 'report' | 'budget' | 'capabilities'>
  /** The YouTube adapter. */
  youtube: ImportYouTube
  /** The Spotify provider, when Spotify is switched on. */
  spotify?: ImportSpotify
  /** The MusicBrainz client. */
  musicBrainz?: ImportMusicBrainz
  /** The Auto setting. Default: off. */
  autoMatch?: () => boolean
}

/** The services over the app's platform and providers. */
export function createImportServices(parts: ImportServiceParts): ImportServices {
  const { platform } = parts
  return {
    context: (mode, signal, priority = 'bulk') =>
      platform.context({ mode, priority, ...(signal === undefined ? {} : { signal }) }),
    waitForBulkSlot: (signal) => platform.budget.whenAvailable('bulk', { signal }),
    nextBulkSlotAt: () => platform.budget.nextSlotAt('bulk'),
    report: (error) => {
      platform.report(error)
    },
    capabilities: () => platform.capabilities.current,
    subscribeCapabilities: (listener) => platform.capabilities.subscribe(() => listener()),
    matching() {
      if (parts.youtube === YOUTUBE_IMPORT_UNAVAILABLE) return 'unavailable'
      return platform.capabilities.current.youtube === 'none' ? 'needs-connect' : 'ready'
    },
    isOnline: browserOnline,
    youtube: parts.youtube,
    spotify: parts.spotify,
    musicBrainz: parts.musicBrainz,
    autoMatch: parts.autoMatch ?? (() => false),
  }
}

let appServices: Promise<ImportServices> | undefined
let loadedAppServices: ImportServices | undefined
/** Where the app's import services come from, once the composition root connected them. */
let appSource: (() => Promise<ImportServices>) | undefined
/** The source {@link appServices} was built from, `undefined` while it waits for one. */
let appServicesSource: (() => Promise<ImportServices>) | undefined
/** Loads waiting for {@link appSource}. */
const waitingForSource = new Set<() => void>()

/**
 * Makes the app's import services come from `source`: the composition root's (stage 2.9), on
 * the app's one platform and providers. Imports that asked before it was connected get them
 * then. Returns a function that disconnects it, which leaves a source connected after it alone.
 */
export function connectAppImportServices(source: () => Promise<ImportServices>): () => void {
  appSource = source
  // Services built from another source are that source's; a load still waiting takes this one.
  if (appServices !== undefined && appServicesSource !== undefined) {
    appServices = undefined
    loadedAppServices = undefined
  }
  for (const wake of [...waitingForSource]) wake()
  return () => {
    if (appSource !== source) return
    appSource = undefined
    appServices = undefined
    appServicesSource = undefined
    loadedAppServices = undefined
  }
}

/** The connected source, or the next one to be connected. */
function connectedSource(): Promise<() => Promise<ImportServices>> {
  if (appSource !== undefined) return Promise.resolve(appSource)
  return new Promise((resolve) => {
    const wake = () => {
      if (appSource === undefined) return
      waitingForSource.delete(wake)
      resolve(appSource)
    }
    waitingForSource.add(wake)
  })
}

/**
 * The app's import services, created on first use and shared: the composition root's, on the
 * app's one platform with its YouTube, Spotify and MusicBrainz providers. Until the composition
 * root has connected them (it loads beside the first render), this waits. Nothing reaches the
 * network until an import runs or a link loads, so opening the Import page contacts nothing.
 */
export function loadAppImportServices(): Promise<ImportServices> {
  if (appServices !== undefined) return appServices
  appServicesSource = appSource
  const loading: Promise<ImportServices> = connectedSource()
    .then((source) => {
      appServicesSource = source
      return source()
    })
    .then((services) => {
      if (appServices === loading) loadedAppServices = services
      return services
    })
    .catch((error: unknown) => {
      if (appServices === loading) appServices = undefined
      throw error
    })
  appServices = loading
  return loading
}

const ImportServicesContext = createContext<ImportServices | null>(null)

/** Gives the import pages these services instead of the app's (tests). */
export function ImportServicesProvider({
  value,
  children,
}: {
  value: ImportServices
  children: ReactNode
}) {
  return <ImportServicesContext.Provider value={value}>{children}</ImportServicesContext.Provider>
}

/** How the import pages reach the services. */
export interface ImportServicesAccess {
  /** The services, created on first use. */
  get(): Promise<ImportServices>
  /** The services when they exist already: given by a provider, or the app's once created. */
  readonly current: ImportServices | undefined
}

const APP_ACCESS: ImportServicesAccess = {
  get: loadAppImportServices,
  get current() {
    return loadedAppServices
  },
}

/** The import services: from {@link ImportServicesProvider}, else the app's. */
export function useImportServices(): ImportServicesAccess {
  const given = useContext(ImportServicesContext)
  return useMemo(
    () => (given === null ? APP_ACCESS : { get: async () => given, current: given }),
    [given],
  )
}
