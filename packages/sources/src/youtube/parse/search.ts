/**
 * YouTube Music's filtered search results and their continuation pages.
 *
 * @module
 */

import { FxmError } from '@fxm/core'
import { arrayAt, at, recordAt } from '../json'
import { type MapOptions, mapItems } from './items'
import { appendedItems, continuationOf, firstShelf, type ListPage, listPage } from './lists'

/**
 * One page of a filtered YouTube Music search: the first page (a `musicShelfRenderer` in the
 * selected tab) or a continuation (`musicShelfContinuation`). A search without results is an
 * empty page.
 *
 * @throws FxmError `Parse` when the response is neither.
 */
export function parseMusicSearch(json: unknown, options: MapOptions): ListPage {
  const continued = recordAt(json, 'continuationContents', 'musicShelfContinuation')
  if (continued !== undefined) {
    const contents = arrayAt(continued, 'contents')
    return listPage(mapItems(contents, options), continuationOf(contents, continued))
  }
  const appended = appendedItems(json)
  if (appended !== undefined) return listPage(mapItems(appended, options), continuationOf(appended))
  const tabs = arrayAt(json, 'contents', 'tabbedSearchResultsRenderer', 'tabs')
  if (tabs.length === 0) throw new FxmError('Parse', 'The search response has no results tab')
  const tab = tabs.find((candidate) => at(candidate, 'tabRenderer', 'selected') === true) ?? tabs[0]
  const sections = arrayAt(tab, 'tabRenderer', 'content', 'sectionListRenderer', 'contents')
  const shelf = firstShelf(sections, 'musicShelfRenderer')
  if (shelf === undefined) return { items: [] }
  return listPage(mapItems(shelf.contents, options), continuationOf(shelf.contents, shelf.shelf))
}
