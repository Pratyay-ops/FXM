import {
  type ConnectionKind,
  type ConnectionPreference,
  type DownloadFormat,
  type Mp3Bitrate,
  type QualityPrefs,
  type QualityTier,
  type StreamingSettings,
  sanitizeQualityPrefs,
  sanitizeStreamingSettings,
} from '@fxm/core'
import type { StreamLifecycleOptions } from '@fxm/player'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createSafeStorage } from '../../lib/safe-storage'

/** localStorage key. Bump the suffix (and add a migration) on incompatible changes. */
export const QUALITY_STORAGE_KEY = 'fxm.quality.v1'
const QUALITY_VERSION = 1

/** What Download does besides keeping a copy in FXM for offline playback. */
export interface DownloadSettings {
  /**
   * Whether Download also saves a file to the device, in the format the Download dialog asks for
   * (which starts at `prefs.download.format`). Off, Download keeps the copy in FXM only, and a
   * downloaded song's "Save to device…" saves a file later. On by default.
   */
  saveFile: boolean
}

/** The download settings a new install starts with. */
export const DEFAULT_DOWNLOAD_SETTINGS: Readonly<DownloadSettings> = Object.freeze({
  saveFile: true,
})

/** Valid download settings from anything storage holds: the defaults for what isn't valid. */
export function sanitizeDownloadSettings(value: unknown): DownloadSettings {
  const stored: Readonly<Record<string, unknown>> =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const saveFile = Object.hasOwn(stored, 'saveFile') ? stored.saveFile : undefined
  return {
    saveFile: typeof saveFile === 'boolean' ? saveFile : DEFAULT_DOWNLOAD_SETTINGS.saveFile,
  }
}

/** The persisted quality settings, in the shapes `@fxm/core` defines and validates. */
export interface QualitySettings {
  /**
   * The highest tier to stream at on Wi-Fi and on mobile data, and the download format with its
   * MP3 bitrate (`QualityPrefs`).
   */
  prefs: QualityPrefs
  /** Which connection's ceiling streaming follows, and the data saver (`StreamingSettings`). */
  streaming: StreamingSettings
  /** Whether Download also saves a file to the device (the web app's own setting). */
  downloads: DownloadSettings
}

export interface QualityState extends QualitySettings {
  /** Sets the highest tier to stream at on one connection. */
  setStreamingTier: (connection: ConnectionKind, tier: QualityTier) => void
  /** Sets which connection's ceiling streaming follows. */
  setConnection: (connection: ConnectionPreference) => void
  /** Turns the data saver on or off. */
  setDataSaver: (dataSaver: boolean) => void
  /** Sets the format downloads are saved in. */
  setDownloadFormat: (format: DownloadFormat) => void
  /** Sets the bitrate of MP3 downloads. */
  setMp3Bitrate: (kbps: Mp3Bitrate) => void
  /** Sets whether Download also saves a file to the device. */
  setSaveFile: (saveFile: boolean) => void
}

/**
 * Valid quality settings from anything storage or a backup holds: each part goes through its
 * guard (`@fxm/core`'s for `prefs` and `streaming`), which keeps what is valid and uses the
 * defaults for the rest. Settings stored before a part existed get its defaults.
 */
export function sanitizeQualitySettings(value: unknown): QualitySettings {
  const stored: Readonly<Record<string, unknown>> =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const part = (name: keyof QualitySettings) =>
    Object.hasOwn(stored, name) ? stored[name] : undefined
  return {
    prefs: sanitizeQualityPrefs(part('prefs')),
    streaming: sanitizeStreamingSettings(part('streaming')),
    downloads: sanitizeDownloadSettings(part('downloads')),
  }
}

export interface QualityStoreOptions {
  /** Where to persist. Defaults to `localStorage`; tests pass their own. */
  storage?: () => Storage | undefined
}

/** Creates the quality settings store, persisted to Web Storage (one per app; tests make their own). */
export function createQualityStore({ storage }: QualityStoreOptions = {}) {
  return create<QualityState>()(
    persist(
      (set) => ({
        ...sanitizeQualitySettings(undefined),
        setStreamingTier: (connection, tier) =>
          set(({ prefs }) => ({
            prefs: {
              ...prefs,
              streaming:
                connection === 'wifi'
                  ? { ...prefs.streaming, wifi: tier }
                  : { ...prefs.streaming, cellular: tier },
            },
          })),
        setConnection: (connection) =>
          set(({ streaming }) => ({ streaming: { ...streaming, connection } })),
        setDataSaver: (dataSaver) =>
          set(({ streaming }) => ({ streaming: { ...streaming, dataSaver } })),
        setDownloadFormat: (format) =>
          set(({ prefs }) => ({ prefs: { ...prefs, download: { ...prefs.download, format } } })),
        setMp3Bitrate: (mp3Kbps) =>
          set(({ prefs }) => ({ prefs: { ...prefs, download: { ...prefs.download, mp3Kbps } } })),
        setSaveFile: (saveFile) =>
          set(({ downloads }) => ({ downloads: { ...downloads, saveFile } })),
      }),
      {
        name: QUALITY_STORAGE_KEY,
        version: QUALITY_VERSION,
        storage: createSafeStorage<QualitySettings>(storage),
        partialize: ({ prefs, streaming, downloads }) => ({ prefs, streaming, downloads }),
        // Stored data can be from another version, hand-edited or corrupt: keep what is valid.
        migrate: (persisted) => sanitizeQualitySettings(persisted),
        merge: (persisted, current) => ({ ...current, ...sanitizeQualitySettings(persisted) }),
      },
    ),
  )
}

export type QualityStore = ReturnType<typeof createQualityStore>

export const useQualityStore: QualityStore = createQualityStore()

/**
 * Re-reads the quality settings when another tab changes them, so two open tabs never
 * overwrite each other's choices and a tab that plays follows a change made in another.
 * Returns the unsubscribe function.
 */
export function syncQualityAcrossTabs(store: QualityStore = useQualityStore): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === QUALITY_STORAGE_KEY || event.key === null) void store.persist.rehydrate()
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}

/**
 * The quality settings as the stream lifecycle reads them, for the app's `StreamLifecycle`:
 * `new StreamLifecycle({ ...lifecycleQualityOptions(), sources, context, network })`. Both are
 * read afresh for every stream it chooses, so a change applies from the next stream on.
 */
export function lifecycleQualityOptions(
  store: QualityStore = useQualityStore,
): Required<Pick<StreamLifecycleOptions, 'qualityPrefs' | 'streaming'>> {
  return {
    qualityPrefs: () => store.getState().prefs,
    streaming: () => store.getState().streaming,
  }
}
