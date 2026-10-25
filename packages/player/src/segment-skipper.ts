/**
 * Skips parts of tracks as playback reaches them: the non-music parts of videos that SponsorBlock
 * marks (stage 8.7), or any other list of segments. The skipper watches a {@link Player} and seeks
 * past a segment when playback enters it. It knows nothing about where segments come from: the
 * app's `segmentsFor` says, item by item, and decides which items have any.
 *
 * @module
 */

import { candidateKey, currentQueueItem, ownCandidate, type QueueItem } from '@fxm/core'
import { callSafely, Emitter, type Listener } from './emitter'
import type { Player, PlayerState, SeekCause, TrackChangeCause } from './player'

/** A part of a track to skip. */
export interface SkipSegment {
  /** Where the part starts, in milliseconds into the track. */
  startMs: number
  /** Where it ends: playback carries on from here. */
  endMs: number
  /**
   * How long the media was that the segment was marked on, in milliseconds, when known. When the
   * track playing is longer or shorter than that by more than `durationToleranceMs`, the segment
   * was marked on another cut (an edited upload, say), so the skipper ignores it.
   */
  mediaDurationMs?: number
}

/** The parts of a {@link Player} the skipper uses. */
export type SkipperPlayer = Pick<Player, 'getState' | 'subscribe' | 'on' | 'seek'>

/** How {@link connectSegmentSkipper} finds segments, and its tuning. */
export interface SegmentSkipperOptions {
  /**
   * The segments to skip in `item`, in any order, or an empty list to skip nothing. Called when
   * an item becomes current or its audio changes, when the player prepares the next item (so
   * its segments are ready when it starts), and on `refresh()`. A rejection counts as an empty
   * list. `signal` aborts when the answer is no longer needed.
   */
  segmentsFor(
    item: QueueItem,
    signal: AbortSignal,
  ): Promise<readonly SkipSegment[]> | readonly SkipSegment[]
  /** Called with each rejection of `segmentsFor`, for logs. Default: nothing. */
  onError?: (error: unknown, item: QueueItem) => void
  /** Segments shorter than this are not worth a jump. Default: 1 s. */
  minSegmentMs?: number
  /** Segments less than this far apart are skipped as one. Default: 1 s. */
  mergeGapMs?: number
  /** A segment ending less than this before the end of the track runs to the end. Default: 1 s. */
  endSnapMs?: number
  /**
   * The least of a track that must be left to play. When the segments cover more, the skipper
   * skips nothing in it: a track that ends as soon as it starts looks broken. Default: 10 s.
   */
  minPlayedMs?: number
  /** How far `mediaDurationMs` may be from the track's duration. Default: 2 s. */
  durationToleranceMs?: number
  /**
   * A seek at least this far into a segment means the user wants to hear it, so the skipper
   * leaves it until the track starts over or the user moves elsewhere. A seek to the very start
   * of a segment, such as the start of the track, doesn't count. Default: 1 s.
   */
  seekIntoMs?: number
  /**
   * When a segment starts within this time while playing, a timer skips it right at its start,
   * instead of at the first position report inside it. Default: 1 s.
   */
  lookaheadMs?: number
  /** The clock, in milliseconds, for timing between position reports. Default: `Date.now`. */
  now?: () => number
}

/** The defaults behind {@link SegmentSkipperOptions}. */
export const SEGMENT_SKIPPER_DEFAULTS = Object.freeze({
  minSegmentMs: 1000,
  mergeGapMs: 1000,
  endSnapMs: 1000,
  minPlayedMs: 10_000,
  durationToleranceMs: 2000,
  seekIntoMs: 1000,
  lookaheadMs: 1000,
})

/** The tuning of a skipper, every value set. */
export type SegmentSkipperConfig = { readonly [K in keyof typeof SEGMENT_SKIPPER_DEFAULTS]: number }

/** One skip, as the `skip` event reports it. */
export interface SegmentSkip {
  /** The queue item it happened in. */
  item: QueueItem
  /** The segment, as the skipper applied it (clamped to the track, merged with its neighbours). */
  segment: SkipSegment
  /** Where playback was, in milliseconds. */
  fromMs: number
  /**
   * Where it carried on: the end of the segment, or for a segment that runs to the end of the
   * track, a moment before the end, from where the track ends by itself.
   */
  toMs: number
}

/** The events a {@link SegmentSkipper} announces. */
export interface SegmentSkipperEventMap {
  /** The skipper jumped past a segment. */
  skip: SegmentSkip
}

/** A skipper connected to a player, as {@link connectSegmentSkipper} returns it. */
export interface SegmentSkipper {
  /**
   * Asks `segmentsFor` again for the current item, and forgets what it prepared for the next
   * one. Call it when what `segmentsFor` answers changes, e.g. after a setting changed.
   */
  refresh(): void
  /**
   * Goes back to where the last skip in the current item jumped from, and leaves that segment
   * alone until the track starts over. Returns whether there was such a skip: not after the
   * track changed, nor after the user moved playback since.
   */
  undo(): boolean
  /** The current item's segments as the skipper applies them, e.g. to mark them. */
  segments(): readonly SkipSegment[]
  /** Adds a listener. Returns a function that removes it. */
  on<K extends keyof SegmentSkipperEventMap>(
    type: K,
    listener: Listener<SegmentSkipperEventMap[K]>,
  ): () => void
  /** Stops skipping, cancels what it asked for and drops every listener. */
  disconnect(): void
}

/** A jump shorter than this, near the end of a segment, is not worth a seek. */
const MIN_JUMP_MS = 500

/**
 * How far before the end of the track a skip to the end lands. Playback then reaches the end by
 * itself, which every engine reports, while a media element seeked to its very end restarts the
 * track from the top when it is played.
 */
const END_LEAD_MS = 100

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function config(options: Partial<SegmentSkipperConfig>): SegmentSkipperConfig {
  const value = (key: keyof SegmentSkipperConfig): number => {
    const given = options[key]
    return given !== undefined && isTime(given) && given >= 0
      ? given
      : SEGMENT_SKIPPER_DEFAULTS[key]
  }
  return {
    minSegmentMs: value('minSegmentMs'),
    mergeGapMs: value('mergeGapMs'),
    endSnapMs: value('endSnapMs'),
    minPlayedMs: value('minPlayedMs'),
    durationToleranceMs: value('durationToleranceMs'),
    seekIntoMs: value('seekIntoMs'),
    lookaheadMs: value('lookaheadMs'),
  }
}

/**
 * The segments of a track as a skipper applies them, in order:
 *
 * 1. Segments with times that aren't finite numbers are dropped, and so, when `durationMs` is
 *    known, are segments marked on media of another duration (`mediaDurationMs`).
 * 2. The rest are clamped to the track; what is left shorter than `minSegmentMs` is dropped.
 * 3. Segments that overlap, or are less than `mergeGapMs` apart, become one.
 * 4. A last segment ending less than `endSnapMs` before the end runs to the end.
 * 5. When less than `minPlayedMs` of the track would be left, nothing is skipped at all.
 *
 * Steps 4 and 5, the clamping at the end and the duration check need `durationMs`, which the
 * player knows from the engine or the track's metadata.
 */
export function activeSkipSegments(
  segments: readonly SkipSegment[],
  durationMs: number | undefined,
  tuning: Partial<SegmentSkipperConfig> = {},
): SkipSegment[] {
  const { minSegmentMs, mergeGapMs, endSnapMs, minPlayedMs, durationToleranceMs } = config(tuning)
  const duration = isTime(durationMs) && durationMs > 0 ? durationMs : undefined
  const ranges: SkipSegment[] = []
  for (const segment of segments) {
    if (!isTime(segment.startMs) || !isTime(segment.endMs)) continue
    const { mediaDurationMs } = segment
    if (
      duration !== undefined &&
      isTime(mediaDurationMs) &&
      Math.abs(mediaDurationMs - duration) > durationToleranceMs
    ) {
      continue
    }
    const startMs = Math.max(0, segment.startMs)
    const endMs = duration === undefined ? segment.endMs : Math.min(segment.endMs, duration)
    if (endMs - startMs >= Math.max(minSegmentMs, 1)) ranges.push({ startMs, endMs })
  }
  ranges.sort((a, b) => a.startMs - b.startMs)
  const merged: SkipSegment[] = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (last !== undefined && range.startMs - last.endMs < mergeGapMs) {
      last.endMs = Math.max(last.endMs, range.endMs)
    } else {
      merged.push(range)
    }
  }
  if (duration === undefined) return merged
  const last = merged.at(-1)
  if (last !== undefined && duration - last.endMs < endSnapMs) last.endMs = duration
  const skippedMs = merged.reduce((total, range) => total + range.endMs - range.startMs, 0)
  return duration - skippedMs < minPlayedMs ? [] : merged
}

/**
 * Which audio an item plays, for knowing when its segments need asking again: its candidate, or
 * else its own audio. A video that resolves to itself keeps its key.
 */
function audioKey(item: QueueItem): string {
  const audio = item.candidate ?? ownCandidate(item.track)
  return audio === undefined ? `track:${item.track.id}` : candidateKey(audio)
}

/** Segments asked for ahead, for the item the player prepares next. */
interface Prepared {
  readonly uid: number
  readonly trackId: string
  readonly audio: string
  readonly abort: AbortController
  readonly promise: Promise<readonly SkipSegment[]>
}

class Skipper implements SegmentSkipper {
  readonly #player: SkipperPlayer
  readonly #segmentsFor: SegmentSkipperOptions['segmentsFor']
  readonly #onError: SegmentSkipperOptions['onError']
  readonly #config: SegmentSkipperConfig
  readonly #now: () => number
  readonly #events = new Emitter<SegmentSkipperEventMap>()
  readonly #detach: (() => void)[]
  /** The current item, as last seen. */
  #item: QueueItem | undefined
  /** The audio its segments were asked for (see `audioKey`). */
  #audio: string | undefined
  /** Its segments as `segmentsFor` answered; `undefined` while asked. */
  #raw: readonly SkipSegment[] | undefined
  /** Cancels the request for its segments. */
  #abort: AbortController | undefined
  #prepared: Prepared | undefined
  /** Where the user last put playback in the current item: a seek, or a restored position. */
  #placedAt: number | undefined
  /** Whether the next check takes the position as one the user chose (a restored queue). */
  #placeOnCheck = false
  /** The starts of the segments the user undid, until the track starts over. */
  readonly #undone = new Set<number>()
  #lastSkip: { uid: number; skip: SegmentSkip } | undefined
  /** When the player last reported a new position, by `now`. */
  #reportedAt = 0
  /** Whether the skipper is seeking itself, so its own `seek` events don't count as the user's. */
  #seeking = false
  #checkQueued = false
  #timer: ReturnType<typeof setTimeout> | undefined
  #disconnected = false

  constructor(player: SkipperPlayer, options: SegmentSkipperOptions) {
    this.#player = player
    this.#segmentsFor = options.segmentsFor
    this.#onError = options.onError
    this.#config = config(options)
    this.#now = options.now ?? Date.now
    this.#reportedAt = this.#now()
    this.#detach = [
      player.subscribe((state, previous) => this.#onState(state, previous)),
      player.on('trackchange', ({ item, cause }) => this.#onTrackChange(item, cause)),
      player.on('seek', ({ positionMs, cause }) => this.#onSeek(positionMs, cause)),
      player.on('preload', ({ next }) => this.#prepare(next)),
    ]
    this.#switchTo(currentQueueItem(player.getState().queue), false)
    // A player that already holds a track, e.g. a restored queue, is where the user left it.
    this.#placeOnCheck = this.#item !== undefined
    this.#queueCheck()
  }

  refresh(): void {
    if (this.#disconnected) return
    this.#dropPrepared()
    if (this.#item !== undefined) this.#reload(this.#item)
  }

  undo(): boolean {
    const last = this.#lastSkip
    const item = this.#item
    if (this.#disconnected || last === undefined || item === undefined) return false
    if (
      last.uid !== item.uid ||
      currentQueueItem(this.#player.getState().queue)?.uid !== item.uid
    ) {
      return false
    }
    this.#lastSkip = undefined
    this.#undone.add(last.skip.segment.startMs)
    this.#seek(last.skip.fromMs)
    this.#queueCheck()
    return true
  }

  segments(): readonly SkipSegment[] {
    return activeSkipSegments(this.#raw ?? [], this.#player.getState().durationMs, this.#config)
  }

  on<K extends keyof SegmentSkipperEventMap>(
    type: K,
    listener: Listener<SegmentSkipperEventMap[K]>,
  ): () => void {
    return this.#events.on(type, listener)
  }

  disconnect(): void {
    if (this.#disconnected) return
    this.#disconnected = true
    for (const detach of this.#detach) detach()
    this.#cancelRequest()
    this.#dropPrepared()
    this.#clearTimer()
    this.#events.clear()
  }

  // --- Player events -------------------------------------------------------------------------

  #onState(state: PlayerState, previous: PlayerState): void {
    if (this.#disconnected) return
    if (state.positionMs !== previous.positionMs) this.#reportedAt = this.#now()
    const item = currentQueueItem(state.queue)
    const current = this.#item
    // A new current item arrives with `trackchange`, right after this state.
    if (
      item !== undefined &&
      current !== undefined &&
      item.uid === current.uid &&
      item !== current
    ) {
      this.#item = item
      if (audioKey(item) !== this.#audio) this.#reload(item)
    }
    this.#queueCheck()
  }

  #onTrackChange(item: QueueItem | undefined, cause: TrackChangeCause): void {
    if (this.#disconnected) return
    // A restored queue numbers its items afresh, so a prepared uid may name another item.
    if (cause === 'restore') this.#dropPrepared()
    this.#switchTo(item, true)
    // The restored position arrives right after this event.
    this.#placeOnCheck = cause === 'restore' && item !== undefined
    this.#queueCheck()
  }

  #onSeek(positionMs: number, cause: SeekCause): void {
    if (this.#disconnected || this.#seeking) return
    this.#lastSkip = undefined
    this.#placeOnCheck = false
    if (cause === 'user') {
      this.#placedAt = positionMs
    } else {
      // The track starts over (restart, repeat): every segment is skipped again.
      this.#placedAt = undefined
      this.#undone.clear()
    }
    this.#clearTimer()
    this.#queueCheck()
  }

  /** Asks for the segments of the item the player prepares next. */
  #prepare(next: QueueItem): void {
    if (this.#disconnected) return
    const audio = audioKey(next)
    const prepared = this.#prepared
    if (
      prepared?.uid === next.uid &&
      prepared.trackId === next.track.id &&
      prepared.audio === audio
    ) {
      return
    }
    prepared?.abort.abort()
    const abort = new AbortController()
    const promise = this.#ask(next, abort.signal)
    // Handled once the item comes up; until then, a rejection is nobody's business.
    promise.catch(() => undefined)
    this.#prepared = { uid: next.uid, trackId: next.track.id, audio, abort, promise }
  }

  // --- Segments ------------------------------------------------------------------------------

  /** Makes `item` the current one, with what was prepared for it or a new request. */
  #switchTo(item: QueueItem | undefined, usePrepared: boolean): void {
    this.#cancelRequest()
    this.#clearTimer()
    this.#item = item
    this.#audio = undefined
    this.#raw = undefined
    this.#placedAt = undefined
    this.#placeOnCheck = false
    this.#undone.clear()
    this.#lastSkip = undefined
    const prepared = this.#prepared
    this.#prepared = undefined
    if (item === undefined) {
      prepared?.abort.abort()
      return
    }
    if (
      usePrepared &&
      prepared !== undefined &&
      prepared.uid === item.uid &&
      prepared.trackId === item.track.id &&
      prepared.audio === audioKey(item)
    ) {
      this.#adopt(item, prepared.abort, prepared.promise)
      return
    }
    prepared?.abort.abort()
    const abort = new AbortController()
    this.#adopt(item, abort, this.#ask(item, abort.signal))
  }

  /** Asks again for the segments of the current `item`, e.g. after its audio changed. */
  #reload(item: QueueItem): void {
    this.#cancelRequest()
    this.#clearTimer()
    this.#raw = undefined
    const abort = new AbortController()
    this.#adopt(item, abort, this.#ask(item, abort.signal))
  }

  /** Calls `segmentsFor`, turning a throw into a rejection. */
  #ask(item: QueueItem, signal: AbortSignal): Promise<readonly SkipSegment[]> {
    try {
      return Promise.resolve(this.#segmentsFor(item, signal))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /** Takes `promise` as the answer for the current `item`, unless `abort` fires first. */
  #adopt(item: QueueItem, abort: AbortController, promise: Promise<readonly SkipSegment[]>): void {
    this.#abort = abort
    this.#audio = audioKey(item)
    const current = () => !this.#disconnected && this.#abort === abort && !abort.signal.aborted
    promise.then(
      (segments) => {
        if (!current()) return
        this.#raw = Array.isArray(segments) ? [...segments] : []
        this.#queueCheck()
      },
      (error: unknown) => {
        if (!current()) return
        this.#raw = []
        const onError = this.#onError
        if (onError !== undefined) callSafely(onError, error, item)
      },
    )
  }

  #cancelRequest(): void {
    this.#abort?.abort()
    this.#abort = undefined
  }

  #dropPrepared(): void {
    this.#prepared?.abort.abort()
    this.#prepared = undefined
  }

  // --- Skipping ------------------------------------------------------------------------------

  /** Checks the position once the current call stack is done, so the player's state is settled. */
  #queueCheck(): void {
    if (this.#checkQueued || this.#disconnected) return
    this.#checkQueued = true
    queueMicrotask(() => {
      this.#checkQueued = false
      if (!this.#disconnected) this.#check()
    })
  }

  /** Skips the segment playback is in, or sets a timer for the one it is about to enter. */
  #check(): void {
    this.#clearTimer()
    const state = this.#player.getState()
    if (this.#placeOnCheck) {
      this.#placeOnCheck = false
      this.#placedAt = state.positionMs
    }
    const item = this.#item
    const raw = this.#raw
    if (item === undefined || raw === undefined || raw.length === 0) return
    if (currentQueueItem(state.queue)?.uid !== item.uid) return
    // Only while playing or about to: a paused track waits where the user left it.
    if (state.status !== 'playing' && state.status !== 'loading') return
    const segments = activeSkipSegments(raw, state.durationMs, this.#config)
    const position = state.positionMs
    const inside = segments.find(
      (segment) => segment.startMs <= position && position < segment.endMs - MIN_JUMP_MS,
    )
    if (inside !== undefined && !this.#ignores(inside)) {
      // A skip to the end waits until the track plays: the player would start the engine at
      // the end of the track and then play it, which restarts a media element from the top.
      if (state.status === 'loading' && this.#endsTrack(inside, state)) return
      this.#skip(item, inside, position, state)
      return
    }
    this.#schedule(state, segments, item)
  }

  /** Whether `segment` runs to the end of the track. */
  #endsTrack(segment: SkipSegment, state: PlayerState): boolean {
    const { durationMs } = state
    return durationMs !== undefined && segment.endMs >= durationMs
  }

  /** Sets a timer that skips the next segment right at its start, when it is close. */
  #schedule(state: PlayerState, segments: readonly SkipSegment[], item: QueueItem): void {
    if (state.status !== 'playing' || state.buffering) return
    // The position moves on between the player's reports.
    const position = state.positionMs + Math.max(0, this.#now() - this.#reportedAt)
    const next = segments.find((segment) => segment.startMs > position && !this.#ignores(segment))
    if (next === undefined || next.startMs - position > this.#config.lookaheadMs) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      const now = this.#player.getState()
      if (this.#disconnected || this.#item?.uid !== item.uid || this.#ignores(next)) return
      if (now.status !== 'playing' || now.buffering) return
      this.#skip(item, next, next.startMs, now)
    }, next.startMs - position)
  }

  /** Whether the user chose to hear `segment`: they undid its skip, or moved playback into it. */
  #ignores(segment: SkipSegment): boolean {
    if (this.#undone.has(segment.startMs)) return true
    const at = this.#placedAt
    return at !== undefined && at >= segment.startMs + this.#config.seekIntoMs && at < segment.endMs
  }

  /** Seeks past `segment`, or close to the end of the track when it runs to the end. */
  #skip(item: QueueItem, segment: SkipSegment, fromMs: number, state: PlayerState): void {
    const toMs = this.#endsTrack(segment, state)
      ? Math.max(segment.startMs, segment.endMs - END_LEAD_MS)
      : segment.endMs
    const skip: SegmentSkip = {
      item,
      segment: { startMs: segment.startMs, endMs: segment.endMs },
      fromMs,
      toMs,
    }
    this.#lastSkip = { uid: item.uid, skip }
    this.#seek(toMs)
    this.#events.emit('skip', skip)
  }

  /** Seeks without taking it for the user's seek. */
  #seek(positionMs: number): void {
    this.#clearTimer()
    this.#seeking = true
    try {
      this.#player.seek(positionMs)
    } finally {
      this.#seeking = false
    }
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return
    clearTimeout(this.#timer)
    this.#timer = undefined
  }
}

/**
 * Connects a segment skipper to `player`. While a track plays (or loads to play), the skipper
 * seeks past each of its segments when playback reaches it: at once when playback is in one,
 * and by a timer right at its start when it is near. So an intro at the start of a track is
 * skipped before the track starts playing, when the segments are known by then.
 *
 * What it leaves alone:
 *
 * - a segment the user moved playback into (see `seekIntoMs`), or whose skip they undid, until
 *   the track starts over (repeat, or "previous" restarting it);
 * - everything while paused;
 * - a track whose segments would leave less than `minPlayedMs` to play.
 *
 * A segment that runs to the end of the track ends it: the skipper seeks to a moment before the
 * end, and the player moves on as at any end (repeat one plays it again). The skipper announces
 * each skip with the `skip` event, e.g. for an "Undo" button.
 */
export function connectSegmentSkipper(
  player: SkipperPlayer,
  options: SegmentSkipperOptions,
): SegmentSkipper {
  return new Skipper(player, options)
}
