/**
 * The Diagnostics self-test's one touch-point with the YouTube stream resolver (stage 1.4,
 * built in parallel): a {@link SongResolver}, the app's current one, and the adapter that turns
 * 1.4's audio source into one.
 *
 * Until 1.4 is wired in, the app's resolver is {@link unavailableResolver}, and the self-test
 * says that this build can't resolve songs yet. Wiring it in is one line, wherever the app
 * creates its YouTube providers:
 *
 * ```ts
 * setSongResolver(fromAudioSource(createYouTubeAudioSource({ session, healthStore })))
 * ```
 *
 * Tests and the development fake mode use `createFakeResolver` (`fake-resolver.ts`).
 *
 * @module
 */

import {
  type AudioCandidate,
  type AudioSource,
  DEFAULT_QUALITY_PREFS,
  FxmError,
  type ProviderContext,
  type QualityPrefs,
  type StreamOption,
} from '@fxm/core'

/** The song the self-test resolves and plays. */
export interface SelfTestSong {
  /** Its YouTube videoId. */
  readonly videoId: string
  /** Its title, for the report. */
  readonly title: string
  /** Its artist, for the report. */
  readonly artist: string
}

/**
 * Radiohead's "Creep", a YouTube Music song (`ATV`) that is widely available. It is the song
 * stage 1.4's live tests resolve: on 2026-10-26 its VISIONOS URLs passed the end-of-file probe
 * from a residential connection.
 */
export const SELF_TEST_SONG: SelfTestSong = {
  videoId: 'zFYEYRcjK2g',
  title: 'Creep',
  artist: 'Radiohead',
}

/** Which rungs of the ladder a resolution tries: all of them, or only the last resort (itag 18). */
export type ResolveRungs = 'all' | 'fallback'

/**
 * Why an option failed in the player, in the words of 1.4's `reportPlaybackFailure`: an
 * unverified URL from the top of the ladder failed its first request (`probe-failed`), or so did
 * the last resort's (`fallback-failed`). Both cool the rung down.
 */
export type PlaybackFailureReason = 'probe-failed' | 'fallback-failed'

/** What the self-test needs from the YouTube stream resolver. */
export interface SongResolver {
  /** Whether the ladder has a last-resort rung to try after the others failed in the player. */
  readonly hasFallback: boolean
  /** Every stream option for the song, best first (`AudioSource.resolve`). */
  resolve(
    song: SelfTestSong,
    ctx: ProviderContext,
    options: { readonly rungs: ResolveRungs },
  ): Promise<StreamOption[]>
  /** Tells the ladder an option reached `playing`, so its rung counts a success. */
  reportPlaybackSuccess?(option: StreamOption, ctx: ProviderContext): void
  /** Tells the ladder an option failed its first request in the player. */
  reportPlaybackFailure?(
    option: StreamOption,
    ctx: ProviderContext,
    reason: PlaybackFailureReason,
  ): void
}

/** The resolver of a build without 1.4's ladder: every resolution fails with `Unsupported`. */
export const unavailableResolver: SongResolver = {
  hasFallback: false,
  async resolve() {
    throw new FxmError('Unsupported', 'This build has no YouTube stream resolver yet (stage 1.4)')
  },
}

/**
 * The parts of stage 1.4's YouTube audio source the self-test uses: `resolve` with its `rungs`
 * option, `hasFallback` and the playback reports. A plain `AudioSource` works too; it then
 * resolves every rung each time and hears no reports.
 */
export interface LadderAudioSource extends AudioSource {
  /** Whether the config has a last-resort rung. */
  readonly hasFallback?: boolean
  resolve(
    candidate: AudioCandidate,
    ctx: ProviderContext,
    prefs: QualityPrefs,
    options?: { readonly rungs?: ResolveRungs },
  ): Promise<StreamOption[]>
  /** Counts a success for the option's rung. */
  reportPlaybackSuccess?(option: StreamOption, ctx: ProviderContext): void
  /** Counts a failure for the option's rung. */
  reportPlaybackFailure?(
    option: StreamOption,
    ctx: ProviderContext,
    reason: PlaybackFailureReason,
  ): void
}

/** The `ytm` candidate for the self-test song: a YouTube Music song's own audio. */
export function songCandidate(song: SelfTestSong): AudioCandidate {
  return {
    source: 'ytm',
    ref: song.videoId,
    kind: 'song',
    title: song.title,
    artists: [song.artist],
    confidence: 1,
    evidence: ['self-test'],
  }
}

/** A {@link SongResolver} over stage 1.4's YouTube audio source. */
export function fromAudioSource(
  audio: LadderAudioSource,
  prefs: QualityPrefs = DEFAULT_QUALITY_PREFS,
): SongResolver {
  return {
    hasFallback: audio.hasFallback === true,
    resolve: (song, ctx, { rungs }) => audio.resolve(songCandidate(song), ctx, prefs, { rungs }),
    reportPlaybackSuccess: (option, ctx) => audio.reportPlaybackSuccess?.(option, ctx),
    reportPlaybackFailure: (option, ctx, reason) =>
      audio.reportPlaybackFailure?.(option, ctx, reason),
  }
}

let appResolver: SongResolver = unavailableResolver

/** The resolver the app's self-test uses. */
export function getSongResolver(): SongResolver {
  return appResolver
}

/** Replaces the app's resolver: 1.4's ladder once it is wired in, or a fake. */
export function setSongResolver(resolver: SongResolver): void {
  appResolver = resolver
}
