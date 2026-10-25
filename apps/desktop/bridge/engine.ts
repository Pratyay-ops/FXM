/**
 * The desktop app's audio engine (stage 7.3): the direct audio engine of `@fxm/player`, two
 * `<audio>` elements, with two rules of the desktop app on top. Both act through `canPlay`,
 * which the player consults before it hands a stream to the engine and which the playback
 * policy uses to choose among a resolution's streams:
 *
 * - **`<audio src>` only for URLs that passed the probe.** The desktop app reads stream bytes
 *   through Rust, so the YouTube resolver probes the end of every file before it offers a URL
 *   (`fullLength` `verified`), and a capped URL is never played. An IP-bound URL that is still
 *   `unverified` (its probe failed to answer) is refused like a capped one: the playback policy
 *   then takes the fallback rung (itag 18), then resolves again. When no rung's probe answers,
 *   the song has `no-stream`, which the desktop player retries rather than skips
 *   (`desktopClassifyFailure` in `options.ts`). Free sources (Internet Archive, Jamendo) are not
 *   IP-bound, never capped and never probed, so they play as they are.
 * - **The codec per `canPlayType`, AAC on macOS before 15.4.** The policy plays Opus 251 only
 *   where the engine says `probably`, otherwise AAC 140. WebKit plays Opus in WebM only from
 *   macOS 15.4, so on earlier versions an Opus stream counts as `maybe` at best, whatever the
 *   webview answers: AAC wins whenever the resolution has it, and Opus remains the fallback.
 *
 * @module
 */

import type { StreamOption } from '@fxm/core'
import { DirectAudioEngine, type DirectAudioEngineOptions, type PlaySupport } from '@fxm/player'
import type { DesktopEnvironment } from './shell'

/** The first macOS version whose WebKit plays Opus in WebM: 15.4. */
export const MACOS_OPUS_VERSION: readonly [major: number, minor: number] = [15, 4]

/** The numbers of a version such as `15.4.1`, or `undefined` if it isn't one. */
export function parseVersion(version: string | undefined): number[] | undefined {
  if (version === undefined || !/^\d+(?:\.\d+)*$/.test(version)) return undefined
  return version.split('.').map(Number)
}

/**
 * Whether `environment` is a macOS older than 15.4, whose WebKit doesn't play Opus in WebM.
 * `false` when the environment or its version is unknown: the webview's answer then decides.
 */
export function lacksOpus(environment: DesktopEnvironment | undefined): boolean {
  if (environment?.os !== 'macos') return false
  const version = parseVersion(environment.osVersion)
  if (version === undefined) return false
  const [major = 0, minor = 0] = version
  const [opusMajor, opusMinor] = MACOS_OPUS_VERSION
  return major < opusMajor || (major === opusMajor && minor < opusMinor)
}

/**
 * How sure the desktop app is that it can play `stream`, given what the direct audio engine
 * said (`support`) and where the app runs. See the module documentation for the two rules.
 */
export function desktopPlaySupport(
  stream: StreamOption,
  support: PlaySupport,
  environment: DesktopEnvironment | undefined,
): PlaySupport {
  if (support === 'no') return 'no'
  if (stream.ipBound && stream.fullLength !== 'verified') return 'no'
  if (support === 'probably' && stream.codec === 'opus' && lacksOpus(environment)) return 'maybe'
  return support
}

/** Options for {@link DesktopAudioEngine}. */
export interface DesktopAudioEngineOptions extends DirectAudioEngineOptions {
  /**
   * Where the app runs, read whenever a stream is rated: the shell answers asynchronously, and
   * until it has, only the probe rule applies.
   */
  environment?: () => DesktopEnvironment | undefined
}

/** The direct audio engine with the desktop app's rules (see the module documentation). */
export class DesktopAudioEngine extends DirectAudioEngine {
  readonly #environment: () => DesktopEnvironment | undefined

  constructor(options: DesktopAudioEngineOptions = {}) {
    const { environment, ...engine } = options
    super(engine)
    this.#environment = environment ?? (() => undefined)
  }

  override canPlay(stream: StreamOption): PlaySupport {
    return desktopPlaySupport(stream, super.canPlay(stream), this.#environment())
  }
}
