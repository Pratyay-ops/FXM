/**
 * What every paged InnerTube list shares: its continuation token, in its two spellings, and the
 * appended items of a continuation response.
 *
 * @module
 */

import { arrayAt, asArray, at, stringAt } from '../json'
import type { Item, TrackRow } from './items'

/** One page of mapped items and the token of the next page, if there is one. */
export interface ListPage {
  /** The items, in order. */
  readonly items: Item[]
  /** The continuation token of the next page. */
  readonly continuation?: string
}

/** A page with only its continuation token set when there is one. */
export function listPage(items: Item[], continuation: string | undefined): ListPage {
  return continuation === undefined ? { items } : { items, continuation }
}

/**
 * The continuation token of a list: a `continuationItemRenderer` at its end (the newer
 * spelling), or the shelf's `continuations` (the older one).
 */
export function continuationOf(contents: readonly unknown[], shelf?: unknown): string | undefined {
  for (const item of contents.toReversed()) {
    const token = stringAt(
      item,
      'continuationItemRenderer',
      'continuationEndpoint',
      'continuationCommand',
      'token',
    )
    if (token !== undefined) return token
  }
  const continuation = at(shelf, 'continuations', 0)
  return (
    stringAt(continuation, 'nextContinuationData', 'continuation') ??
    stringAt(continuation, 'nextRadioContinuationData', 'continuation') ??
    stringAt(continuation, 'reloadContinuationData', 'continuation')
  )
}

/**
 * The items a continuation response appends (`appendContinuationItemsAction` in
 * `onResponseReceivedActions` or `onResponseReceivedCommands`): none when its actions append
 * nothing, which ends a list, and `undefined` when it is not such a response.
 */
export function appendedItems(json: unknown): readonly unknown[] | undefined {
  const lists = [at(json, 'onResponseReceivedActions'), at(json, 'onResponseReceivedCommands')]
  if (!lists.some(Array.isArray)) return undefined
  return lists
    .flatMap((list) => asArray(list))
    .flatMap((action) => asArray(at(action, 'appendContinuationItemsAction', 'continuationItems')))
}

/** The track rows among items, in order. */
export function trackRows(items: readonly Item[]): TrackRow[] {
  return items.flatMap((item) => (item.type === 'track' ? [item.row] : []))
}

/** The contents of the first renderer named `name` among sections, or `undefined`. */
export function firstShelf(
  sections: readonly unknown[],
  ...names: readonly string[]
): { shelf: unknown; contents: readonly unknown[] } | undefined {
  for (const section of sections) {
    for (const name of names) {
      const shelf = at(section, name)
      if (shelf !== undefined) return { shelf, contents: arrayAt(shelf, 'contents') }
    }
  }
  return undefined
}
