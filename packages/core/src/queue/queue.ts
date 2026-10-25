/**
 * The play queue: a pure, serializable model of what plays now, what played before and what
 * plays next.
 *
 * A {@link QueueState} is plain data (it survives `JSON.stringify`), and every operation is a
 * pure function that returns a new state, or the same state object when nothing changes. The
 * player facade in `@fxm/player` holds one state and swaps it on every action.
 *
 * - **Play order.** `items` is the order things play in: the shuffled order while shuffle is
 *   on. `index` points at the current item. Items before it are the played part, which
 *   {@link skipToPrevious} walks back through; a jump while shuffled keeps it that way (see
 *   {@link jumpInQueue}).
 * - **Played items.** `playedUids` lists the items that have been current, most recent last.
 *   Turning shuffle on keeps them, in that order, before the current item, so "previous" still
 *   goes back to what actually played. Turning shuffle off restores the original order. This is
 *   the queue's own record for "previous", not the listening history the library keeps.
 * - **Mode.** Tracks the catalog mode hides never enter the queue. Items that play another
 *   track in Music mode stay: an official music video that links its song (verdict
 *   `plays-linked-song`) and one that needs a song match (`needs-song-match`). The playback
 *   policy plays the linked or matched song and records it as the item's `candidate`.
 *
 * The names say what they act on (`setQueueShuffle`, `nextQueueItem`, …) because `@fxm/core`
 * exports everything from one entry point.
 *
 * @module
 */

import type { EntityId } from '../ids'
import { applyModeFilter, type CatalogMode, isCatalogMode, isPlayable, modePolicy } from '../mode'
import type { Track } from '../model'
import type { AudioCandidate } from '../providers'
import { fisherYatesShuffle, type RandomSource } from './random'

/** Every {@link RepeatMode}, in the order a repeat button cycles through them. */
export const REPEAT_MODES = ['off', 'all', 'one'] as const

/**
 * How the queue repeats:
 *
 * - `off`: stop after the last item
 * - `all`: start again from the first item after the last
 * - `one`: replay the current item when it ends. Skipping with next or previous still moves,
 *   and wraps around like `all`
 */
export type RepeatMode = (typeof REPEAT_MODES)[number]

/** Whether `value` is a {@link RepeatMode}, e.g. to validate a stored setting. */
export function isRepeatMode(value: unknown): value is RepeatMode {
  return typeof value === 'string' && (REPEAT_MODES as readonly string[]).includes(value)
}

/** Every {@link QueueContextType}. */
export const QUEUE_CONTEXT_TYPES = [
  'album',
  'playlist',
  'artist',
  'radio',
  'search',
  'library',
] as const

/** What kind of list a queue was started from. */
export type QueueContextType = (typeof QUEUE_CONTEXT_TYPES)[number]

/**
 * What a queue was started from, shown as "Playing from …" and linked back to. One shape per
 * type, so the link target is typed:
 *
 * - `album`, `playlist`, `artist`: the catalog entity's `id`
 * - `radio`: the `seed` the station started from, a track or an artist
 * - `search`: the `query`
 * - `library`: a list in the user's library that has no catalog ID, such as Liked songs,
 *   Downloads, a playlist made in FXM or local files. `id` is the library's own key for it
 *
 * `title` is what to show, e.g. the album name or the query.
 */
export type QueueContext =
  | { readonly type: 'album'; readonly id: EntityId<'album'>; readonly title: string }
  | { readonly type: 'playlist'; readonly id: EntityId<'playlist'>; readonly title: string }
  | { readonly type: 'artist'; readonly id: EntityId<'artist'>; readonly title: string }
  | { readonly type: 'radio'; readonly seed: EntityId<'track' | 'artist'>; readonly title: string }
  | { readonly type: 'search'; readonly query: string; readonly title: string }
  | { readonly type: 'library'; readonly id: string; readonly title: string }

/** One entry of the queue. The same track can be queued more than once. */
export interface QueueItem {
  /**
   * Identifies this entry within its queue, so duplicates of a track stay apart. uids are
   * comparable only within one queue and the queues built from it by this module's functions:
   * a restored or newly created queue numbers its items from 0 again.
   */
  readonly uid: number
  /** The track to play. */
  readonly track: Track
  /**
   * The audio to play for the track, once the playback policy has resolved one, or the
   * version the user picked. For a music video in Music mode it is the song: the one the video
   * links (verdict `plays-linked-song`) or the one the matching engine mapped it to
   * (`needs-song-match`). Always playable in the queue's mode.
   */
  readonly candidate?: AudioCandidate
}

/**
 * The whole queue as plain, serializable data. Build one with {@link createQueue} and change it
 * only through this module's functions, which keep these invariants:
 *
 * - `index` is `-1` exactly when `items` is empty, else a valid index into `items`
 * - every `uid` is unique and below `nextUid`
 * - `playedUids` holds the uids of items in the queue, each at most once, never the current one
 * - `unshuffled` is present exactly when `shuffle` is on, and holds every item's uid once
 * - no item is hidden by `mode`, except the current one after a mode change, until another item
 *   becomes current
 */
export interface QueueState {
  /** The items in play order: the shuffled order while shuffle is on. */
  readonly items: readonly QueueItem[]
  /** The current item's position in `items`, or `-1` when the queue is empty. */
  readonly index: number
  /**
   * uids of the items that have been current, oldest first, without the current one. Only for
   * "previous" and shuffling; the library keeps the listening history.
   */
  readonly playedUids: readonly number[]
  /** What the queue was started from, when known. */
  readonly context?: QueueContext
  /** The catalog mode that decides which tracks may join. */
  readonly mode: CatalogMode
  /** How the queue repeats. */
  readonly repeat: RepeatMode
  /** Whether the play order is shuffled. */
  readonly shuffle: boolean
  /** While shuffle is on: every item's uid in the original order, restored when it turns off. */
  readonly unshuffled?: readonly number[]
  /** The uid the next added item gets. */
  readonly nextUid: number
}

/** Settings for a new queue. */
export interface QueueOptions {
  /** The catalog mode. Default: `music`. */
  mode?: CatalogMode
  /** How the queue repeats. Default: `off`. */
  repeat?: RepeatMode
  /** Whether new queues start shuffled. Default: `false`. */
  shuffle?: boolean
}

/** Options for {@link setQueue}. */
export interface SetQueueOptions {
  /**
   * Index into the tracks of the one to start with. Fractions are truncated and out-of-range
   * values are clamped. Default: the first track, or a random one when the queue is shuffled.
   */
  startIndex?: number
  /** What the tracks come from. Leaving it out clears the previous context. */
  context?: QueueContext
  /**
   * Turns shuffle on or off, for this queue and the ones after it, like the shuffle button.
   * Default: the queue's current setting.
   */
  shuffle?: boolean
  /** Randomness for shuffling and for a random start. Default: `Math.random`. */
  random?: RandomSource
}

/**
 * How far into a track, in milliseconds, "previous" restarts it instead of going back to the
 * previous item. At exactly this position it still goes back.
 */
export const PREVIOUS_RESTART_MS = 3000

/** Changes to a state; `undefined` for `context` or `unshuffled` removes that field. */
type QueuePatch = Partial<Omit<QueueState, 'context' | 'unshuffled'>> & {
  context?: QueueContext | undefined
  unshuffled?: readonly number[] | undefined
}

/** `state` with `patch` applied; optional fields set to `undefined` are left out. */
function update(state: QueueState, patch: QueuePatch): QueueState {
  const { context, unshuffled, ...rest } = { ...state, ...patch }
  return {
    ...rest,
    ...(context === undefined ? {} : { context }),
    ...(unshuffled === undefined ? {} : { unshuffled }),
  }
}

function uidOf(item: QueueItem): number {
  return item.uid
}

/** Whether `index` is an integer pointing at an item. */
function isItemIndex(state: QueueState, index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < state.items.length
}

/**
 * A uniform random index in `[0, size)`. Values outside `[0, 1)` from a faulty source are
 * clamped instead of producing an index out of range.
 */
function randomIndex(random: RandomSource, size: number): number {
  const value = random()
  const index = Math.floor((Number.isFinite(value) ? value : 0) * size)
  return Math.min(Math.max(index, 0), size - 1)
}

/** New items for `tracks`, numbered from the state's `nextUid`. */
function createItems(
  state: QueueState,
  tracks: readonly Track[],
): { items: QueueItem[]; nextUid: number } {
  const items = tracks.map((track, offset) => ({ uid: state.nextUid + offset, track }))
  return { items, nextUid: state.nextUid + items.length }
}

/** An empty queue. */
export function createQueue(options: QueueOptions = {}): QueueState {
  const shuffle = options.shuffle === true
  return {
    items: [],
    index: -1,
    playedUids: [],
    mode: isCatalogMode(options.mode) ? options.mode : 'music',
    repeat: isRepeatMode(options.repeat) ? options.repeat : 'off',
    shuffle,
    ...(shuffle ? { unshuffled: [] } : {}),
    nextUid: 0,
  }
}

/** The current item, or `undefined` when the queue is empty. */
export function currentQueueItem(state: QueueState): QueueItem | undefined {
  return state.items[state.index]
}

/**
 * The items after the current one, in play order. It does not wrap around for repeat `all`, so
 * at the last item it is empty even though {@link nextQueueItem} is the first one again.
 */
export function upcomingQueueItems(state: QueueState): readonly QueueItem[] {
  return state.index < 0 ? [] : state.items.slice(state.index + 1)
}

/** Where {@link skipToNext} goes: the following index, or the first when repeat wraps. */
function nextIndex(state: QueueState): number | undefined {
  if (state.items.length === 0) return undefined
  if (state.index < state.items.length - 1) return state.index + 1
  return state.repeat === 'off' ? undefined : 0
}

/**
 * The item {@link skipToNext} would make current, or `undefined` at the end of the queue with
 * repeat off. With repeat on, the item after the last is the first (in a one-item queue, the
 * current item itself).
 */
export function nextQueueItem(state: QueueState): QueueItem | undefined {
  const index = nextIndex(state)
  return index === undefined ? undefined : state.items[index]
}

/** Whether {@link skipToNext} would move, i.e. there is a {@link nextQueueItem}. */
export function hasNextQueueItem(state: QueueState): boolean {
  return nextIndex(state) !== undefined
}

/**
 * Makes `target` current and records the item it replaces as played. An item the mode hides
 * (kept only because it was current during a mode switch, see {@link setQueueMode}) leaves the
 * queue instead, now that it is done.
 */
function moveTo(state: QueueState, target: number): QueueState {
  const from = state.items[state.index]
  const to = state.items[target]
  if (from === undefined || to === undefined || from === to) return update(state, { index: target })
  const playedUids = state.playedUids.filter((uid) => uid !== from.uid && uid !== to.uid)
  if (modePolicy(from.track, state.mode) !== 'hidden') {
    return update(state, { index: target, playedUids: [...playedUids, from.uid] })
  }
  const items = state.items.filter((item) => item !== from)
  return update(state, {
    items,
    index: items.indexOf(to),
    playedUids,
    unshuffled: state.unshuffled?.filter((uid) => uid !== from.uid),
  })
}

/**
 * Replaces the queue with `tracks`. Tracks the mode hides are left out. The played items are
 * cleared; repeat and mode carry over, and so does shuffle unless `options.shuffle` sets it.
 *
 * - **Start.** The track at `options.startIndex` becomes current. If the mode hides it, the
 *   queue starts at the next track the mode keeps (or the last one before it). Without a start
 *   index it is the first track, or a random kept track while the queue is shuffled.
 * - **Shuffle.** While shuffle is on, the start track comes first and the rest are shuffled with
 *   `options.random`; turning shuffle off later restores the order of `tracks`.
 */
export function setQueue(
  state: QueueState,
  tracks: readonly Track[],
  options: SetQueueOptions = {},
): QueueState {
  const random = options.random ?? Math.random
  const shuffle = options.shuffle ?? state.shuffle
  const keptIndexes: number[] = []
  tracks.forEach((track, index) => {
    if (modePolicy(track, state.mode) !== 'hidden') keptIndexes.push(index)
  })
  let current = 0
  if (options.startIndex !== undefined) {
    const start = Math.min(Math.max(Math.trunc(options.startIndex) || 0, 0), tracks.length - 1)
    current = keptIndexes.findIndex((index) => index >= start)
    if (current < 0) current = keptIndexes.length - 1
  } else if (shuffle && keptIndexes.length > 0) {
    current = randomIndex(random, keptIndexes.length)
  }
  const kept = keptIndexes.map((index) => tracks[index] as Track)
  const { items, nextUid } = createItems(state, kept)
  const first = items[current]
  const base: QueuePatch = {
    items,
    index: first === undefined ? -1 : current,
    playedUids: [],
    context: options.context,
    shuffle,
    nextUid,
  }
  if (!shuffle) return update(state, { ...base, unshuffled: undefined })
  if (first === undefined) return update(state, { ...base, unshuffled: [] })
  const others = items.filter((_, index) => index !== current)
  return update(state, {
    ...base,
    items: [first, ...fisherYatesShuffle(others, random)],
    index: 0,
    unshuffled: items.map(uidOf),
  })
}

/**
 * Inserts `tracks` right after the current item, in the order given, so they play next. Tracks
 * the mode hides are left out. While shuffle is on they are not shuffled, and they also follow
 * the current item in the original order. On an empty queue the first of them becomes current.
 */
export function playNext(state: QueueState, tracks: readonly Track[]): QueueState {
  const kept = applyModeFilter(tracks, state.mode)
  if (kept.length === 0) return state
  const { items: added, nextUid } = createItems(state, kept)
  const addedUids = added.map(uidOf)
  const current = currentQueueItem(state)
  if (current === undefined) {
    return update(state, {
      items: added,
      index: 0,
      nextUid,
      unshuffled: state.shuffle ? addedUids : undefined,
    })
  }
  const at = state.index + 1
  const items = [...state.items.slice(0, at), ...added, ...state.items.slice(at)]
  let unshuffled = state.unshuffled
  if (unshuffled !== undefined) {
    const after = unshuffled.indexOf(current.uid) + 1
    unshuffled = [...unshuffled.slice(0, after), ...addedUids, ...unshuffled.slice(after)]
  }
  return update(state, { items, nextUid, unshuffled })
}

/**
 * Appends `tracks` to the end of the queue, in the order given. Tracks the mode hides are left
 * out. While shuffle is on they are not shuffled, and they also go to the end of the original
 * order. On an empty queue the first of them becomes current.
 */
export function addToQueue(state: QueueState, tracks: readonly Track[]): QueueState {
  const kept = applyModeFilter(tracks, state.mode)
  if (kept.length === 0) return state
  const { items: added, nextUid } = createItems(state, kept)
  return update(state, {
    items: [...state.items, ...added],
    index: state.items.length === 0 ? 0 : state.index,
    nextUid,
    unshuffled:
      state.unshuffled === undefined ? undefined : [...state.unshuffled, ...added.map(uidOf)],
  })
}

/**
 * Removes the item at `index` (in play order). Removing the current item makes the following
 * item current, or the preceding one when it was the last. An invalid index changes nothing.
 */
export function removeFromQueue(state: QueueState, index: number): QueueState {
  const removed = isItemIndex(state, index) ? state.items[index] : undefined
  if (removed === undefined) return state
  const items = state.items.filter((_, i) => i !== index)
  let current = state.index
  if (items.length === 0) current = -1
  else if (index < state.index) current -= 1
  else if (index === state.index) current = Math.min(index, items.length - 1)
  const currentUid = items[current]?.uid
  return update(state, {
    items,
    index: current,
    playedUids: state.playedUids.filter((uid) => uid !== removed.uid && uid !== currentUid),
    unshuffled: state.unshuffled?.filter((uid) => uid !== removed.uid),
  })
}

/**
 * Moves the item at `from` to `to` (both in play order; `to` is its index afterwards). The
 * current item stays current wherever it ends up. While shuffle is on only the play order
 * changes, so turning shuffle off restores the original order. Invalid indexes change nothing.
 */
export function moveInQueue(state: QueueState, from: number, to: number): QueueState {
  if (!isItemIndex(state, from) || !isItemIndex(state, to) || from === to) return state
  const items = [...state.items]
  const [moved] = items.splice(from, 1)
  if (moved !== undefined) items.splice(to, 0, moved)
  const currentUid = currentQueueItem(state)?.uid
  return update(state, { items, index: items.findIndex((item) => item.uid === currentUid) })
}

/** Removes every item after the current one. The current and played items stay. */
export function clearUpcoming(state: QueueState): QueueState {
  if (state.index < 0 || state.index >= state.items.length - 1) return state
  const items = state.items.slice(0, state.index + 1)
  const kept = new Set(items.map(uidOf))
  return update(state, {
    items,
    playedUids: state.playedUids.filter((uid) => kept.has(uid)),
    unshuffled: state.unshuffled?.filter((uid) => kept.has(uid)),
  })
}

/**
 * Moves to the next item. After the last item it wraps to the first when repeat is `all` or
 * `one` (skipping always moves, even with repeat `one`), and changes nothing when repeat is
 * `off`. Use {@link hasNextQueueItem} to tell those apart.
 */
export function skipToNext(state: QueueState): QueueState {
  const target = nextIndex(state)
  return target === undefined ? state : moveTo(state, target)
}

/**
 * "Previous": more than {@link PREVIOUS_RESTART_MS} into the track it returns `state` unchanged,
 * meaning "restart the current item". Otherwise it moves to the item before the current one,
 * wrapping from the first item to the last when repeat is on. When there is nothing to go back
 * to it also returns `state` unchanged.
 *
 * @param positionMs How far into the current item playback is.
 */
export function skipToPrevious(state: QueueState, positionMs = 0): QueueState {
  if (state.items.length === 0 || positionMs > PREVIOUS_RESTART_MS) return state
  if (state.index > 0) return moveTo(state, state.index - 1)
  if (state.repeat !== 'off' && state.items.length > 1) {
    return moveTo(state, state.items.length - 1)
  }
  return state
}

/**
 * Makes the item at `index` (in play order) current. An invalid index changes nothing.
 *
 * While shuffle is on, the item first moves to just after the current one, so the items before
 * the new current item are still the ones that played: "previous" goes back to the item that was
 * playing, and the items jumped over still play later. Without shuffle the order stays, as in an
 * album, and "previous" goes to the item before.
 */
export function jumpInQueue(state: QueueState, index: number): QueueState {
  if (!isItemIndex(state, index) || index === state.index) return state
  const target = state.items[index]
  const current = state.items[state.index]
  if (
    !state.shuffle ||
    index === state.index + 1 ||
    target === undefined ||
    current === undefined
  ) {
    return moveTo(state, index)
  }
  const items = state.items.filter((item) => item !== target)
  const at = items.indexOf(current) + 1
  items.splice(at, 0, target)
  return moveTo(update(state, { items, index: at - 1 }), at)
}

/**
 * Turns shuffle on or off.
 *
 * - **On:** the items that already played (oldest first) come first, then the current item,
 *   then every other item in random order (Fisher-Yates with `random`). So "previous" still goes
 *   back to what played, and everything not yet heard plays before any repeat. The current item
 *   keeps playing.
 * - **Off:** the original order comes back, including items added while shuffled, minus the
 *   ones removed. The current item keeps playing at its original position.
 */
export function setQueueShuffle(
  state: QueueState,
  shuffle: boolean,
  random: RandomSource = Math.random,
): QueueState {
  if (shuffle === state.shuffle) return state
  const current = currentQueueItem(state)
  if (!shuffle) {
    const order = new Map((state.unshuffled ?? []).map((uid, position) => [uid, position]))
    const rank = (item: QueueItem) => order.get(item.uid) ?? Number.MAX_SAFE_INTEGER
    const items = [...state.items].sort((a, b) => rank(a) - rank(b))
    const index = current === undefined ? -1 : items.indexOf(current)
    return update(state, { items, index, shuffle: false, unshuffled: undefined })
  }
  const unshuffled = state.items.map(uidOf)
  if (current === undefined) return update(state, { shuffle: true, unshuffled })
  const byUid = new Map(state.items.map((item) => [item.uid, item]))
  const playedUids = new Set(state.playedUids.filter((uid) => uid !== current.uid))
  const played = [...playedUids].flatMap((uid) => byUid.get(uid) ?? [])
  const rest = state.items.filter((item) => item !== current && !playedUids.has(item.uid))
  return update(state, {
    items: [...played, current, ...fisherYatesShuffle(rest, random)],
    index: played.length,
    shuffle: true,
    unshuffled,
  })
}

/** Sets how the queue repeats. An invalid value changes nothing. */
export function setQueueRepeat(state: QueueState, repeat: RepeatMode): QueueState {
  return isRepeatMode(repeat) && repeat !== state.repeat ? update(state, { repeat }) : state
}

/** The item without its candidate when `mode` does not let that candidate play. */
function dropUnplayableCandidate(item: QueueItem, mode: CatalogMode): QueueItem {
  if (item.candidate === undefined || isPlayable(item.candidate, mode)) return item
  return { uid: item.uid, track: item.track }
}

/**
 * Switches the catalog mode. Items the new mode hides leave the queue, except the current one,
 * so a mode switch never cuts off what is playing; that one leaves as soon as another item
 * becomes current. Candidates the new mode does not let play are dropped, so the playback policy
 * matches those items again. An unknown mode counts as `music`.
 */
export function setQueueMode(state: QueueState, mode: CatalogMode): QueueState {
  const next: CatalogMode = isCatalogMode(mode) ? mode : 'music'
  if (next === state.mode) return state
  const current = currentQueueItem(state)
  const items = state.items
    .filter((item) => item === current || modePolicy(item.track, next) !== 'hidden')
    .map((item) => dropUnplayableCandidate(item, next))
  const kept = new Set(items.map(uidOf))
  return update(state, {
    mode: next,
    items,
    index: current === undefined ? -1 : items.findIndex((item) => item.uid === current.uid),
    playedUids: state.playedUids.filter((uid) => kept.has(uid)),
    unshuffled: state.unshuffled?.filter((uid) => kept.has(uid)),
  })
}

/**
 * Records the audio candidate for the item with `uid`: the one the playback policy resolved, or
 * the version the user picked. Leaving `candidate` out clears it. A candidate the queue's mode
 * does not let play is ignored (the mode may have changed while it was being matched), and so
 * is an unknown uid.
 */
export function setQueueCandidate(
  state: QueueState,
  uid: number,
  candidate?: AudioCandidate,
): QueueState {
  const index = state.items.findIndex((item) => item.uid === uid)
  const item = state.items[index]
  if (item === undefined || candidate === item.candidate) return state
  if (candidate !== undefined && !isPlayable(candidate, state.mode)) return state
  const items = [...state.items]
  items[index] =
    candidate === undefined ? { uid, track: item.track } : { uid, track: item.track, candidate }
  return update(state, { items })
}
