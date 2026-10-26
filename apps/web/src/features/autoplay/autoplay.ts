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
 * - **The user's songs first.** Songs anyone else appends to the queue ("Add to queue") while
 *   autoplay's songs wait at its end move before those, so what the user queues plays before
 *   what autoplay suggests ({@link connectAutoplay}'s `keepLast`).
 * - **What it is doing** goes to `autoplay-activity.ts`: whether songs are on their way, and
 *   each change it makes, which the queue panel tells screen readers.
 * - **The queue changing meanwhile.** A plan is dropped when the queue it was planned for
 *   changes before it is ready (another track, an edit, another mode): the new situation is
 *   planned instead. A queue that ended while a plan was on its way plays on with it.
 * - **The sleep timer** (stage 8.1) has the last word. When it ends (at its time, at the end of
 *   the track it waited for, the queue's last too, or cancelled), the songs on their way for a
 *   queue that ended are added without playing on: they wait for Play, as the track after the
 *   one an end-of-track timer waited for does. Crossfade needs nothing here: the player fades
 *   into autoplay's songs as into any other.
 * - **Removed songs.** A song autoplay added that the user removes from the queue before it
 *   played, one by one or with Clear, never comes again in this session.
 * - **Switching it off** stops adding, and takes the songs autoplay added that haven't played
 *   out of the queue, except the ones the user moved (they adopted those). Switching it on
 *   extends a queue that is low.
 *
 * @module
 */

import {
  currentQueueItem,
  type EntityId,
  isTrackSeed,
  type QueueItem,
  type QueueState,
  type RadioPick,
  type RandomSource,
  radioShortfall,
  trackKeys,
  upcomingQueueItems,
} from '@fxm/core'
import type { Player, PlayerState } from '@fxm/player'
import { appHomeServices, canRecommend, type HomeServicesStore } from '../home/services'
import { type AutoplayActivityStore, useAutoplayActivity } from './autoplay-activity'
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
  /** Where autoplay says what it is doing. Default: the app's. */
  readonly activity?: AutoplayActivityStore
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

/** An extension waiting for the queue to settle. */
interface Pending {
  /** The situation of the queue it would extend (see `want`). */
  readonly key: string
  readonly timer: ReturnType<typeof setTimeout>
  /** Whether the extension plays on (see {@link Run}). */
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
  const activity = options.activity ?? useAutoplayActivity
  const plan = options.plan ?? planInApp
  const now = options.now ?? Date.now
  const settleMs = options.settleMs ?? AUTOPLAY_SETTLE_MS
  const onError =
    options.onError ?? ((error: unknown) => console.error('Autoplay could not add songs', error))

  /** Keys of the songs autoplay added that the user removed: they don't come again. */
  const removed = new Set<string>()
  /** The situation waiting for the queue to settle, and its timer. */
  let pending: Pending | undefined
  let run: Run | undefined
  /**
   * The situation whose plan added nothing (or failed): not planned again until something
   * changes. A plan that added songs leaves none, so a queue the user empties again refills.
   */
  let tried: string | undefined
  /** Whether autoplay itself is taking songs out, which is no choice of the user's. */
  let withdrawing = false
  /** Whether autoplay itself is adding songs, which `noteAppend` leaves where they land. */
  let adding = false
  /** The uids of the items someone else just appended, for `keepLast`. */
  let appended: number[] = []
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

  /** Tells the queue panel what autoplay is doing now. */
  function report(): void {
    const status = run !== undefined ? 'planning' : pending !== undefined ? 'waiting' : 'idle'
    if (activity.getState().status !== status) activity.setState({ status })
  }

  /** Decides what to do about the queue as it is now. `resume`: the queue just ended. */
  function evaluate(resume = false): void {
    if (disconnected) return
    decide(resume)
    report()
  }

  function decide(resume: boolean): void {
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
    const waiting: Pending = {
      key,
      resume,
      timer: setTimeout(
        () => {
          pending = undefined
          void extend(key, waiting.resume)
        },
        resume ? 0 : settleMs,
      ),
    }
    pending = waiting
  }

  async function extend(key: string, resume: boolean): Promise<void> {
    const wanted = want(player.getState())
    if (wanted?.key !== key) {
      evaluate(resume)
      return
    }
    const mine: Run = { key, abort: new AbortController(), resume }
    run = mine
    report()
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
      report()
      add(picks, mine.resume)
    } catch (error) {
      if (run !== mine) return
      run = undefined
      tried = key
      report()
      onError(error)
    }
  }

  function add(picks: readonly RadioPick[], resume: boolean): void {
    if (picks.length === 0) return
    const before = player.getState().queue.nextUid
    adding = true
    try {
      player.addToQueue(picks.map((pick) => pick.track))
    } finally {
      adding = false
    }
    const added = player.getState().queue.items.filter((item) => item.uid >= before)
    marks.getState().add(
      added.flatMap((item) => {
        const pick = picks.find((one) => one.track.id === item.track.id)
        return pick === undefined
          ? []
          : [{ uid: item.uid, trackId: item.track.id, seed: seedIdOf(pick) }]
      }),
    )
    if (added.length > 0) {
      activity.setState({
        change: { type: 'added', titles: added.map((item) => item.track.title) },
      })
    }
    if (resume && player.getState().status === 'ended') void player.play()
  }

  /**
   * Notes the items someone else, such as the user's "Add to queue", just appended: once every
   * listener has seen the append, `keepLast` moves them before the songs autoplay added.
   */
  function noteAppend(previous: QueueState, next: QueueState): void {
    if (adding || next.items.length <= previous.items.length) return
    // An append leaves every item where it was.
    if (previous.items.some((item, index) => next.items[index] !== item)) return
    if (appended.length === 0) queueMicrotask(keepLast)
    for (const item of next.items.slice(previous.items.length)) appended.push(item.uid)
  }

  /**
   * Keeps the songs autoplay added behind the songs the user queues: the items just appended
   * that wait behind a run of autoplay's songs at the end of the queue move before that run, so
   * they play first. A move keeps every uid, and so every mark; whichever side is shorter moves.
   */
  function keepLast(): void {
    const uids = new Set(appended)
    appended = []
    if (disconnected) return
    const { queue } = player.getState()
    const { marks: marked } = marks.getState()
    const { items } = queue
    const first = queue.index + 1
    // The items just appended, still at the end, and the run of autoplay's songs before them.
    let appendedFrom = items.length
    while (appendedFrom > first && uids.has((items[appendedFrom - 1] as QueueItem).uid)) {
      appendedFrom--
    }
    let autoplayFrom = appendedFrom
    while (autoplayFrom > first && isAutoplayItem(marked, items[autoplayFrom - 1] as QueueItem)) {
      autoplayFrom--
    }
    const late = items.length - appendedFrom
    const waiting = appendedFrom - autoplayFrom
    if (late === 0 || waiting === 0) return
    if (late <= waiting) {
      for (let moved = 0; moved < late; moved++) {
        player.move(appendedFrom + moved, autoplayFrom + moved)
      }
    } else {
      for (let moved = 0; moved < waiting; moved++) player.move(autoplayFrom, items.length - 1)
    }
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

  /** Takes the songs autoplay added that haven't played yet out of the queue, and says so. */
  function withdraw(): void {
    const { marks: marked } = marks.getState()
    const titles: string[] = []
    withdrawing = true
    try {
      const { queue } = player.getState()
      // From the end, so the indexes still to visit stay where they are.
      for (let index = queue.items.length - 1; index > queue.index; index--) {
        const item = player.getState().queue.items[index]
        if (item === undefined || !isAutoplayItem(marked, item)) continue
        player.remove(index)
        titles.unshift(item.track.title)
      }
    } finally {
      withdrawing = false
    }
    if (titles.length > 0) activity.setState({ change: { type: 'withdrawn', titles } })
  }

  /**
   * The sleep timer ended (see the module documentation): what is on its way, or waiting, for a
   * queue that ended no longer plays on. Called on the player's `sleep`, which an end-of-track
   * timer announces after `queueend`, and as the timer leaves the state, which a timer that
   * ended while nothing played does quietly.
   */
  function stayStopped(): void {
    if (run !== undefined) run.resume = false
    if (pending !== undefined) pending.resume = false
  }

  /** Something autoplay depends on changed: a situation tried before may go better now. */
  function retry(): void {
    tried = undefined
    evaluate()
  }

  const stopPlayer = player.subscribe((state, previous) => {
    if (previous.sleepTimer !== undefined && state.sleepTimer === undefined) stayStopped()
    if (state.queue.items !== previous.queue.items) {
      noteRemovals(previous.queue, state.queue)
      marks.getState().keepOnly(state.queue.items)
      noteAppend(previous.queue, state.queue)
    }
    if (state.queue !== previous.queue) evaluate()
  })
  const stopEnd = player.on('queueend', () => evaluate(true))
  const stopSleep = player.on('sleep', stayStopped)
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
    report()
    for (const disconnect of [
      stopPlayer,
      stopEnd,
      stopSleep,
      stopSettings,
      stopServices,
      stopSync,
    ]) {
      disconnect()
    }
    stopReach()
  }
}
