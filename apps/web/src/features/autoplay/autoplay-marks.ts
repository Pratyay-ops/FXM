import { type EntityId, isEntityId, type QueueContext, type QueueItem } from '@fxm/core'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createSafeStorage } from '../../lib/safe-storage'

/**
 * Which queue items autoplay added (stage 3.4), so the queue marks them and a play of one
 * counts as a radio play. A queue item keeps its uid through every edit, shuffle, mode switch
 * and reload (see the queue's README in `@fxm/core`), so a mark follows its item; a mark whose
 * uid holds another track now (a queue that couldn't be saved, then a new one) marks nothing.
 * A song the user moves in the queue is theirs from then on: moving it unmarks it (`adopt`).
 * Saved next to the queue, so a reload keeps them.
 */
export interface AutoplayMark {
  /** The track the item holds. */
  readonly trackId: EntityId<'track'>
  /** The play whose radio suggested it: the radio's seed. */
  readonly seed: EntityId<'track' | 'artist'>
}

/** The marks and what changes them. */
export interface AutoplayMarksState {
  /** The marks, by the item's uid. */
  marks: Readonly<Record<string, AutoplayMark>>
  /** Marks the items autoplay just added. */
  add: (items: readonly ({ uid: number } & AutoplayMark)[]) => void
  /** Keeps only the marks of `items` that still hold their track, e.g. the queue's items. */
  keepOnly: (items: readonly QueueItem[]) => void
  /**
   * Unmarks the item with `uid`: the user moved it, so it is a song they chose now. Switching
   * autoplay off leaves it in the queue, and a play of it counts as one of the queue's.
   */
  adopt: (uid: number) => void
  /** Removes every mark. */
  clear: () => void
}

/** localStorage key. Bump the suffix (and add a migration) on incompatible changes. */
export const AUTOPLAY_MARKS_STORAGE_KEY = 'fxm.autoplay.queue.v1'
const MARKS_VERSION = 1

/** The most marks kept: the queue keeps at most this many items, too. */
export const MAX_AUTOPLAY_MARKS = 1000

/** The title of the radio context of a play of an item autoplay added. */
export const AUTOPLAY_TITLE = 'Autoplay'

type Persisted = Pick<AutoplayMarksState, 'marks'>

function isUid(value: string): boolean {
  return /^(0|[1-9]\d{0,15})$/u.test(value) && Number.isSafeInteger(Number(value))
}

function cleanMark(value: unknown): AutoplayMark | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { trackId, seed } = value as Record<string, unknown>
  if (!isEntityId(trackId, 'track')) return undefined
  if (!isEntityId(seed, 'track') && !isEntityId(seed, 'artist')) return undefined
  return { trackId, seed: seed as EntityId<'track' | 'artist'> }
}

/** Valid persisted marks from an untrusted value: anything malformed is dropped. */
export function sanitizeAutoplayMarks(value: unknown): Persisted {
  const stored =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const marks: Record<string, AutoplayMark> = {}
  const raw = stored.marks
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const [uid, entry] of Object.entries(raw)) {
      if (Object.keys(marks).length >= MAX_AUTOPLAY_MARKS) break
      const mark = cleanMark(entry)
      if (isUid(uid) && mark !== undefined) marks[uid] = mark
    }
  }
  return { marks }
}

/** The mark of `item`, when autoplay added it. */
export function autoplayMarkOf(
  marks: AutoplayMarksState['marks'],
  item: Pick<QueueItem, 'uid' | 'track'>,
): AutoplayMark | undefined {
  const mark = Object.hasOwn(marks, String(item.uid)) ? marks[String(item.uid)] : undefined
  return mark?.trackId === item.track.id ? mark : undefined
}

/** Whether autoplay added `item`. */
export function isAutoplayItem(
  marks: AutoplayMarksState['marks'],
  item: Pick<QueueItem, 'uid' | 'track'>,
): boolean {
  return autoplayMarkOf(marks, item) !== undefined
}

export interface AutoplayMarksStoreOptions {
  /** Where to persist. Defaults to `localStorage`; tests pass their own. */
  storage?: () => Storage | undefined
}

/** Creates the marks store, persisted to Web Storage (one per app; tests make their own). */
export function createAutoplayMarksStore({ storage }: AutoplayMarksStoreOptions = {}) {
  return create<AutoplayMarksState>()(
    persist(
      (set, get) => ({
        marks: {},
        add(items) {
          if (items.length === 0) return
          const marks = { ...get().marks }
          for (const { uid, trackId, seed } of items) marks[String(uid)] = { trackId, seed }
          // The oldest marks go first: uids grow, and objects keep integer keys in order.
          const uids = Object.keys(marks)
          for (const uid of uids.slice(0, Math.max(0, uids.length - MAX_AUTOPLAY_MARKS))) {
            delete marks[uid]
          }
          set({ marks })
        },
        keepOnly(items) {
          const { marks } = get()
          const kept: Record<string, AutoplayMark> = {}
          let dropped = false
          const held = new Map(items.map((item) => [String(item.uid), item.track.id]))
          for (const [uid, mark] of Object.entries(marks)) {
            if (held.get(uid) === mark.trackId) kept[uid] = mark
            else dropped = true
          }
          if (dropped) set({ marks: kept })
        },
        adopt(uid) {
          const { marks } = get()
          if (!Object.hasOwn(marks, String(uid))) return
          const { [String(uid)]: _adopted, ...kept } = marks
          set({ marks: kept })
        },
        clear: () => set({ marks: {} }),
      }),
      {
        name: AUTOPLAY_MARKS_STORAGE_KEY,
        version: MARKS_VERSION,
        storage: createSafeStorage<Persisted>(storage),
        partialize: ({ marks }) => ({ marks }),
        // Stored data can be from another version, hand-edited or corrupt: keep what is valid.
        migrate: (persisted) => sanitizeAutoplayMarks(persisted),
        merge: (persisted, current) => ({ ...current, ...sanitizeAutoplayMarks(persisted) }),
      },
    ),
  )
}

export type AutoplayMarksStore = ReturnType<typeof createAutoplayMarksStore>

export const useAutoplayMarks: AutoplayMarksStore = createAutoplayMarksStore()

/**
 * Where a play of `item` started, for the listening history and scrobbling: for an item
 * autoplay added, its own radio, seeded with the play its radio grew from (scrobbles of it then
 * say the user didn't choose it); for any other item, the queue's `context`.
 */
export function autoplayContextOf(
  item: Pick<QueueItem, 'uid' | 'track'>,
  context: QueueContext | undefined,
  marks: AutoplayMarksState['marks'] = useAutoplayMarks.getState().marks,
): QueueContext | undefined {
  const mark = autoplayMarkOf(marks, item)
  return mark === undefined ? context : { type: 'radio', seed: mark.seed, title: AUTOPLAY_TITLE }
}
