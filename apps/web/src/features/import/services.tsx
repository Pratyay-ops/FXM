/**
 * What imports need from the rest of the app: the platform (stage 1.2: provider contexts, the
 * request budget, bot-check reports), the Spotify provider (1.5), MusicBrainz (1.6), the YouTube
 * adapter (1.3, a stand-in until it merges) and the Auto setting (1.12).
 *
 * Pages get them from {@link useImportServices}: tests pass fakes through
 * {@link ImportServicesProvider}, and the app builds its own on first use
 * ({@link loadAppImportServices}). The app's platform and providers should be shared by every
 * feature; until a stage wires them app-wide, the import feature creates its own here, in this
 * one module, so the switch is a few lines.
 *
 * @module
 */

import type { CatalogMode, NetworkCapabilities, ProviderContext } from '@fxm/core'
import type { FxmPlatform, RequestPriority } from '@fxm/platform'
import {
  type ImportMusicBrainz,
  type ImportSpotify,
  type ImportYouTube,
  YOUTUBE_IMPORT_UNAVAILABLE,
} from '@fxm/sources/import'
import { createMusicBrainzClient } from '@fxm/sources/musicbrainz'
import { createSpotifyProvider } from '@fxm/sources/spotify'
import { createContext, type ReactNode, useContext, useMemo } from 'react'

/**
 * Whether imports can find songs here:
 *
 * - `ready`: YouTube Music can be reached
 * - `needs-connect`: this browser cannot reach YouTube Music; FXM Connect (or the desktop or
 *   Android app) would
 * - `unavailable`: this version of FXM cannot search YouTube Music for imports yet (the YouTube
 *   providers of stage 1.3 are not wired in)
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

/**
 * The app's import services, created on first use and shared: the platform, the Spotify
 * provider (on, as the owner decided; the Settings switch arrives with the search stage) and a
 * MusicBrainz client. The YouTube adapter is the stand-in until the YouTube providers merge.
 * Nothing is created until an import needs it, so opening the Import page contacts nothing.
 */
export function loadAppImportServices(): Promise<ImportServices> {
  appServices ??= (async () => {
    // The platform loads only once an import needs it; the rest is in this chunk anyway.
    const { createPlatform } = await import('@fxm/platform')
    const platform = await createPlatform()
    loadedAppServices = createImportServices({
      platform,
      youtube: YOUTUBE_IMPORT_UNAVAILABLE,
      spotify: createSpotifyProvider(),
      musicBrainz: createMusicBrainzClient(),
    })
    return loadedAppServices
  })().catch((error: unknown) => {
    appServices = undefined
    throw error
  })
  return appServices
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
