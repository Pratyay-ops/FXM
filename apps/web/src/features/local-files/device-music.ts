/**
 * The `FxmDeviceMusic` Capacitor plugin: the Android device's own music (stage 6.4), the songs
 * MediaStore knows, as the Android app lists them for local files. Its native side is
 * `apps/mobile/android/fxm-downloads` (`FxmDeviceMusicPlugin.kt`, `DeviceAudio.kt`), which
 * documents the same messages.
 *
 * The app may read them only with the user's permission (`READ_MEDIA_AUDIO` on Android 13 and
 * later, `READ_EXTERNAL_STORAGE` before), which it asks for only when the user opens the device's
 * music ({@link FxmDeviceMusicPlugin.requestAccess}), never on its own.
 *
 * @module
 */

/** The plugin's name on the Capacitor bridge (`Capacitor.Plugins.FxmDeviceMusic`). */
export const FXM_DEVICE_MUSIC_PLUGIN = 'FxmDeviceMusic'

/** The most songs one `scan` returns. */
export const FXM_DEVICE_MUSIC_MAX_PAGE = 500

/** The most covers one `artwork` call makes. */
export const FXM_DEVICE_MUSIC_MAX_ALBUMS = 24

/**
 * Whether the app may read the device's music, as Capacitor says it: `granted`; `prompt` or
 * `prompt-with-rationale` (Android asks when the app requests it); `denied` (refused for good:
 * only Android's settings can allow it now).
 */
export type DeviceMusicAccess = 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale'

/** A song on the device, as MediaStore knows it. Absent fields are tags the file lacks. */
export interface FxmDeviceAudio {
  /** MediaStore's id (`_ID`), as a string. */
  readonly id: string
  /** Its MediaStore URI: `content://media/<volume>/audio/media/<id>`. */
  readonly uri: string
  /** The volume: `external_primary` for the phone's own storage, else a memory card's id. */
  readonly volume: string
  /** The path inside the volume, `/`-separated, e.g. `Music/Artist/Album/01 Song.flac`. */
  readonly path: string
  /** The file's size in bytes. */
  readonly size: number
  /** When the file last changed, as epoch milliseconds. */
  readonly modifiedMs: number
  readonly title?: string
  readonly artist?: string
  readonly album?: string
  readonly albumArtist?: string
  /** MediaStore's album id, for the cover. */
  readonly albumId?: string
  readonly track?: number
  readonly disc?: number
  readonly year?: number
  readonly durationMs?: number
  /** The MIME type MediaStore gives the file, lower case, e.g. `audio/flac`. */
  readonly mimeType?: string
  /** The average bitrate in bits per second (Android 11+). */
  readonly bitrate?: number
  /** Whether the file is tagged as part of a compilation (Android 11+). */
  readonly compilation?: boolean
  /** The sample rate in Hz (Android 16+). */
  readonly sampleRate?: number
  /** Bits per sample (Android 16+). */
  readonly bitsPerSample?: number
}

/** A cover the plugin made: the album's volume and id, and a small JPEG in base64. */
export interface FxmDevicePicture {
  readonly volume: string
  readonly id: string
  readonly data: string
  readonly width: number
  readonly height: number
}

/** An album to make the cover of: its volume and id, and one of its songs' ids. */
export interface FxmDeviceAlbum {
  readonly volume: string
  readonly id: string
  readonly track?: string
}

/**
 * The `FxmDeviceMusic` plugin as the Capacitor bridge exposes it. `scan` and `artwork` reject
 * with the code `DENIED` without the permission.
 */
export interface FxmDeviceMusicPlugin {
  /** Whether the app may read the device's music. Never asks. */
  checkAccess(): Promise<{ music: DeviceMusicAccess }>
  /** Asks the user, where Android still asks, and resolves with the answer. */
  requestAccess(): Promise<{ music: DeviceMusicAccess }>
  /** Opens the app's page in Android's settings, where music can be allowed after a refusal. */
  openSettings(): Promise<void>
  /**
   * One page of songs, by MediaStore id: up to `limit` after `after` (none: from the start).
   * `next` continues the scan (`null` at the end); the first page also says the `total`.
   */
  scan(options: {
    readonly after?: string
    readonly limit: number
  }): Promise<{ items: FxmDeviceAudio[]; next: string | null; total?: number }>
  /** The covers of `albums` that have one, at most `size` pixels on their longer side. */
  artwork(options: {
    readonly albums: readonly FxmDeviceAlbum[]
    readonly size: number
  }): Promise<{ pictures: FxmDevicePicture[] }>
}

const PLUGIN_METHODS = ['checkAccess', 'requestAccess', 'openSettings', 'scan', 'artwork']

/** The parts of the WebView's global object the plugin lookup reads. */
interface CapacitorGlobal {
  Capacitor?: {
    isNativePlatform?: () => boolean
    Plugins?: Readonly<Record<string, unknown>>
  }
}

/**
 * The `FxmDeviceMusic` plugin of the Android app, or `undefined` outside it: only on a native
 * Capacitor platform whose bridge has the plugin with all its methods.
 */
export function findFxmDeviceMusicPlugin(
  global: object = globalThis,
): FxmDeviceMusicPlugin | undefined {
  const capacitor = (global as CapacitorGlobal).Capacitor
  if (typeof capacitor?.isNativePlatform !== 'function' || !capacitor.isNativePlatform()) {
    return undefined
  }
  const plugin = capacitor.Plugins?.[FXM_DEVICE_MUSIC_PLUGIN]
  if (typeof plugin !== 'object' || plugin === null) return undefined
  const methods = plugin as Record<string, unknown>
  return PLUGIN_METHODS.every((name) => typeof methods[name] === 'function')
    ? (plugin as FxmDeviceMusicPlugin)
    : undefined
}
