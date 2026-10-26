/**
 * Endless autoplay (stage 3.4): keeps the app's queue going. The app's playback connects it to
 * its player (`features/now-playing/playback.ts`).
 *
 * - **When.** Once fewer than three tracks remain after the current one (`radioShortfall`),
 *   repeat is off, autoplay is on, and the recommendation sources can run (`canRecommend`:
 *   wired in, and YouTube Music reachable). It waits {@link AUTOPLAY_SETTLE_MS} for the queue
 *   to settle, so a burst of edits or skips plans once. A situation of the queue (what plays,
 *   what follows, the mode) whose extension found nothing is tried again only when the queue
 *   moves on, the setting, the services or what they reach change, or the queue ends.
 * - **What.** `extend.ts` plans the songs with the radio of `@fxm/core`: one radio fetch per
 *   extension, cached. They are added at the end of the queue and marked
 *   (`autoplay-marks.ts`), for the queue panel and for the listening history, which records a
 *   play of one as a play of the radio.
 * - **The queue changing meanwhile.** A plan is dropped when the queue it was planned for
 *   changes before it is ready (another track, an edit, another mode): the new situation is
 *   planned instead. A queue that ended while a plan was on its way plays on with it.
 * - **Removed songs.** A song autoplay added that the user removes from the queue before it
 *   played never comes again in this session.
 * - **Switching it off** stops adding, and takes the songs autoplay added that haven't played
 *   out of the queue. Switching it on extends a queue that is low.
 *
 * @module
 */

import {
  currentQueueItem,
  type EntityId,
  isTrackSeed,
  type QueueState,
  type RadioPick,
  type RandomSource,
  radioShortfall,
  trackKeys,
  upcomingQueueItems,
} from '@fxm/core'
import type { Player, PlayerState } from '@fxm/player'
import { appHomeServices, canRecommend, type HomeServicesStore } from '../home/services'
import { type AutoplayMarksStore, isAutoplayItem, useAutoplayMarks } from './autoplay-marks'
import { type AutoplayStore, syncAutoplayAcrossTabs, useAutoplayStore } from './autoplay-store'
import type { AppExtensionRequest, Extension } from './extend'

/** How long the queue must stay low, and unchanged, before autoplay extends it. */
export const AUTOPLAY_SETTLE_MS = 1_500

/** The most keys of removed songs a session remembers: about 500 songs, two keys each. */
const MAX_REMOVED_KEYS = 1_000

/** Plans one extension: the app's (`extend.ts`, loaded on first use), or a fake in tests. */
export type PlanExtension = (request: AppExtensionRequest) => Promise<Extension>

const planInApp: PlanExtension = async (request) =>
  (await import('./extend')).planAppExtension(request)

/** What autoplay works with. Every field has a default; tests pass fakes. */
export interface AutoplayOptions {
  /** The recommendation sources and what the platform reaches. Default: Home's (`appHomeServices`). */
  readonly services?: HomeServicesStore
  /** The setting. Default: the app's. */
  readonly settings?: AutoplayStore
  /** The marks of the songs autoplay added. Default: the app's. */
  readonly marks?: AutoplayMarksStore
  /** Plans an extension. Default: the app's (`extend.ts`). */
  readonly plan?: PlanExtension
  /** The clock, as epoch milliseconds. Default: `Date.now`. */
  readonly now?: () => number
  /** Noise for the scores. Default: the engine's, seeded with the time. */
  readonly random?: RandomSource
  /** How long the queue must stay low before autoplay extends it. Default {@link AUTOPLAY_SETTLE_MS}. */
  readonly settleMs?: number
  /** How long the radio fetch of an extension may take. Default: `extend.ts`'s. */
  readonly deadlineMs?: number
  /** Hears what went wrong with an extension. Default: `console.error`. */
  readonly onError?: (error: unknown) => void
  /** Whether to follow the setting's changes in other tabs. Default: true. */
  readonly syncTabs?: boolean
}

/** An extension on its way. */
interface Run {
  /** The situation of the queue it extends (see `want`). */
  readonly key: string
  readonly abort: AbortController
  /** Whether to play on once the songs are added, if the queue has ended by then. */
  resume: boolean
}

/** What autoplay would do now: extend the situation `key` by `count` tracks. */
interface Want {
  readonly key: string
  readonly count: number
}

/** The seed a pick's radio grew from, as a queue context names it. */
function seedIdOf(pick: RadioPick): EntityId<'track' | 'artist'> {
  const { seed } = pick.seed
  return isTrackSeed(seed) ? seed.id : (seed.id ?? pick.track.id)
}

/**
 * Connects endless autoplay to `player` (see the module documentation). Returns a function
 * that disconnects it; an extension on its way is dropped.
 */
export function connectAutoplay(player: Player, options: AutoplayOptions = {}): () => void {
  const services = options.services ?? appHomeServices
  const settings = options.settings ?? useAutoplayStore
  const marks = options.marks ?? useAutoplayMarks
  const plan = options.plan ?? planInApp
  const now = options.now ?? Date.now
  const settleMs = options.settleMs ?? AUTOPLAY_SETTLE_MS
  const onError =
    options.onError ?? ((error: unknown) => console.error('Autoplay could not add songs', error))

  /** Keys of the songs autoplay added that the user removed: they don't come again. */
  const removed = new Set<string>()
  /** The situation waiting for the queue to settle, and its timer. */
  let pending: { readonly key: string; readonly timer: ReturnType<typeof setTimeout> } | undefined
  let run: Run | undefined
  /**
   * The situation whose plan added nothing (or failed): not planned again until something
   * changes. A plan that added songs leaves none, so a queue the user empties again refills.
   */
  let tried: string | undefined
  /** Whether autoplay itself is taking songs out, which is no choice of the user's. */
  let withdrawing = false
  let disconnected = false

  function want(state: PlayerState): Want | undefined {
    if (!settings.getState().enabled) return undefined
    const current = services.get()
    if (!canRecommend(current, current.sources.getSnapshot())) return undefined
    const { queue } = state
    const count = radioShortfall(queue)
    const playing = currentQueueItem(queue)
    if (count === 0 || playing === undefined) return undefined
    const upcoming = upcomingQueueItems(queue).map((item) => item.uid)
    return { key: [queue.mode, playing.uid, ...upcoming].join(' '), count }
  }

  function clearPending(): void {
    if (pending !== undefined) clearTimeout(pending.timer)
    pending = undefined
  }

  function stop(): void {
    clearPending()
    run?.abort.abort()
    run = undefined
  }

  /** Decides what to do about the queue as it is now. `resume`: the queue just ended. */
  function evaluate(resume = false): void {
    if (disconnected) return
    const wanted = want(player.getState())
    if (wanted === undefined) {
      stop()
      return
    }
    if (run !== undefined) {
      if (run.key === wanted.key) {
        run.resume ||= resume
        return
      }
      // The queue changed under the plan: plan the queue as it is now instead.
      run.abort.abort()
      run = undefined
    }
    if (!resume && (wanted.key === tried || wanted.key === pending?.key)) {
      // Planned once already, or waiting to: a new state of the same queue changes nothing.
      if (wanted.key === tried) clearPending()
      return
    }
    clearPending()
    const { key } = wanted
    pending = {
      key,
      timer: setTimeout(
        () => {
          pending = undefined
          void extend(key, resume)
        },
        resume ? 0 : settleMs,
      ),
    }
  }

  async function extend(key: string, resume: boolean): Promise<void> {
    const wanted = want(player.getState())
    if (wanted?.key !== key) {
      evaluate(resume)
      return
    }
    const mine: Run = { key, abort: new AbortController(), resume }
    run = mine
    try {
      const { picks } = await plan({
        queue: player.getState().queue,
        count: wanted.count,
        services: services.get(),
        exclude: removed,
        now: now(),
        signal: mine.abort.signal,
        ...(options.random === undefined ? {} : { random: options.random }),
        ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      })
      // Dropped meanwhile: the queue changed, autoplay went off, or it was disconnected.
      if (run !== mine || mine.abort.signal.aborted) return
      run = undefined
      tried = picks.length > 0 ? undefined : key
      add(picks, mine.resume)
    } catch (error) {
      if (run === mine) run = undefined
      if (mine.abort.signal.aborted) return
      tried = key
      onError(error)
    }
  }

  function add(picks: readonly RadioPick[], resume: boolean): void {
    if (picks.length === 0) return
    const before = player.getState().queue.nextUid
    player.addToQueue(picks.map((pick) => pick.track))
    const added = player.getState().queue.items.filter((item) => item.uid >= before)
    marks.getState().add(
      added.flatMap((item) => {
        const pick = picks.find((one) => one.track.id === item.track.id)
        return pick === undefined
          ? []
          : [{ uid: item.uid, trackId: item.track.id, seed: seedIdOf(pick) }]
      }),
    )
    if (resume && player.getState().status === 'ended') void player.play()
  }

  /**
   * Remembers the songs autoplay added that the user took out of the queue before they played.
   * Not when a new queue replaced the old one, when the catalog mode hid them, nor when
   * autoplay withdrew them itself.
   */
  function noteRemovals(previous: QueueState, next: QueueState): void {
    const playing = currentQueueItem(previous)
    if (withdrawing || playing === undefined || next.mode !== previous.mode) return
    const uids = new Set(next.items.map((item) => item.uid))
    if (!uids.has(playing.uid)) return
    const { marks: marked } = marks.getState()
    for (const item of upcomingQueueItems(previous)) {
      if (uids.has(item.uid) || !isAutoplayItem(marked, item)) continue
      for (const key of trackKeys(item.track)) removed.add(key)
    }
    // The oldest go first.
    for (const key of removed) {
      if (removed.size <= MAX_REMOVED_KEYS) break
      removed.delete(key)
    }
  }

  /** Takes the songs autoplay added that haven't played yet out of the queue. */
  function withdraw(): void {
    const { marks: marked } = marks.getState()
    withdrawing = true
    try {
      const { queue } = player.getState()
      // From the end, so the indexes still to visit stay where they are.
      for (let index = queue.items.length - 1; index > queue.index; index--) {
        const item = player.getState().queue.items[index]
        if (item !== undefined && isAutoplayItem(marked, item)) player.remove(index)
      }
    } finally {
      withdrawing = false
    }
  }

  /** Something autoplay depends on changed: a situation tried before may go better now. */
  function retry(): void {
    tried = undefined
    evaluate()
  }

  const stopPlayer = player.subscribe((state, previous) => {
    if (state.queue.items !== previous.queue.items) {
      noteRemovals(previous.queue, state.queue)
      marks.getState().keepOnly(state.queue.items)
    }
    if (state.queue !== previous.queue) evaluate()
  })
  const stopEnd = player.on('queueend', () => evaluate(true))
  const stopSettings = settings.subscribe((state, previous) => {
    if (state.enabled === previous.enabled) return
    if (!state.enabled) {
      stop()
      withdraw()
    }
    retry()
  })
  let stopReach = services.get().sources.subscribe(retry)
  const stopServices = services.subscribe(() => {
    stopReach()
    stopReach = services.get().sources.subscribe(retry)
    retry()
  })
  const stopSync = options.syncTabs === false ? () => {} : syncAutoplayAcrossTabs(settings)

  // A restored queue: its marks, and whether it is low already.
  marks.getState().keepOnly(player.getState().queue.items)
  evaluate()

  return () => {
    disconnected = true
    stop()
    for (const disconnect of [stopPlayer, stopEnd, stopSettings, stopServices, stopSync]) {
      disconnect()
    }
    stopReach()
  }
}
