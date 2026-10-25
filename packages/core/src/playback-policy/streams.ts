/**
 * Choosing the stream to play from what a source resolved, and how long a resolved stream URL
 * may be handed out again.
 *
 * @module
 */

import type { StreamOption } from '../providers'
import { pickStream, type QualityTier } from '../quality'

/**
 * How sure the player is that it can play a stream, like a browser's `canPlayType`: `probably`,
 * `maybe` or `no`. The same values as the player's `PlaySupport`.
 */
export type StreamSupport = 'probably' | 'maybe' | 'no'

/** How {@link choosePlaybackStream} chooses. */
export interface StreamChoice {
  /** How sure the player is that it can play each stream (`canPlayType` in a browser). */
  support: (stream: StreamOption) => StreamSupport
  /**
   * The highest tier to stream at on the current connection: `prefs.streaming.wifi`, or
   * `prefs.streaming.cellular` on mobile data (see `pickStream`).
   */
  ceiling: QualityTier
  /**
   * Prefer audio-only streams to a muxed video (YouTube's itag 18), even of a lower tier,
   * because the video costs data: on mobile data. Without it, the tier decides first.
   */
  preferAudioOnly?: boolean
  /** Streams to leave out, e.g. URLs that already failed on this network. */
  exclude?: (stream: StreamOption) => boolean
}

/**
 * The stream to play from a source's options, or `undefined` when none can play:
 *
 * 1. Capped streams, excluded ones and those the player says `no` to are left out.
 * 2. Streams the player says `probably` to come before `maybe` ones: Opus 251 plays only where
 *    the browser is sure of Opus in WebM, otherwise AAC 140 does (ARCHITECTURE.md §10, "Format").
 * 3. Among those, `pickStream` applies the tier ceiling, audio-only streams first with
 *    `preferAudioOnly`.
 */
export function choosePlaybackStream<T extends StreamOption>(
  options: readonly T[],
  choice: StreamChoice,
): T | undefined {
  const exclude = choice.exclude ?? (() => false)
  const rated: [T, StreamSupport][] = []
  for (const option of options) {
    if (option.fullLength === 'capped' || exclude(option)) continue
    const support = choice.support(option)
    if (support === 'probably' || support === 'maybe') rated.push([option, support])
  }
  const sure = rated.filter(([, support]) => support === 'probably')
  const group = (sure.length > 0 ? sure : rated).map(([option]) => option)
  if (choice.preferAudioOnly === true) {
    const audio = group.filter((option) => option.media !== 'muxed-video')
    if (audio.length > 0) return pickStream(audio, choice.ceiling)
  }
  return pickStream(group, choice.ceiling)
}

/**
 * How long before a stream URL expires FXM stops handing it out: 10 minutes, so a track that
 * starts on a cached URL can play to its end, and the player refreshes a loaded stream this
 * close to its `expiresAt` before it plays again.
 */
export const URL_REFRESH_MARGIN_MS = 10 * 60_000

/**
 * Until when, in epoch milliseconds, the options of one resolution may be handed out again: the
 * earliest limit among them. An option that expires (`expiresAt`, as YouTube's do) may be handed
 * out until `marginMs` before it expires; one without an expiry (Internet Archive, Jamendo) for
 * `maxAgeMs` after it was resolved. A non-finite `expiresAt`, which only bad data has, counts as
 * already expired. With no options, `maxAgeMs` after `resolvedAt`.
 */
export function streamsUsableUntil(
  options: readonly Pick<StreamOption, 'expiresAt'>[],
  resolvedAt: number,
  limits: { marginMs: number; maxAgeMs: number },
): number {
  let until = Number.POSITIVE_INFINITY
  for (const { expiresAt } of options) {
    let limit = resolvedAt + limits.maxAgeMs
    if (expiresAt !== undefined) {
      limit = Number.isFinite(expiresAt) ? expiresAt - limits.marginMs : resolvedAt
    }
    until = Math.min(until, limit)
  }
  return Number.isFinite(until) ? until : resolvedAt + limits.maxAgeMs
}
