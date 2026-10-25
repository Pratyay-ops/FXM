/**
 * YouTube Music's search results: the pages of a filtered search and their continuations, and
 * the top result of an unfiltered search.
 *
 * @module
 */

import { FxmError } from '@fxm/core'
import { arrayAt, asRecord, at, recordAt } from '../json'
import { type Item, type MapOptions, mapItems, mapTwoRowItem } from './items'
import { appendedItems, continuationOf, firstShelf, type ListPage, listPage } from './lists'
import { runsOf } from './text'

/**
 * The sections of a search's selected tab.
 *
 * @throws FxmError `Parse` when the response has no results tab.
 */
function searchSections(json: unknown): readonly unknown[] {
  const tabs = arrayAt(json, 'contents', 'tabbedSearchResultsRenderer', 'tabs')
  if (tabs.length === 0) throw new FxmError('Parse', 'The search response has no results tab')
  const tab = tabs.find((candidate) => at(candidate, 'tabRenderer', 'selected') === true) ?? tabs[0]
  return arrayAt(tab, 'tabRenderer', 'content', 'sectionListRenderer', 'contents')
}

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
  const shelf = firstShelf(searchSections(json), 'musicShelfRenderer')
  if (shelf === undefined) return { items: [] }
  return listPage(mapItems(shelf.contents, options), continuationOf(shelf.contents, shelf.shelf))
}

/**
 * The top result of an unfiltered YouTube Music search: the card above the other results
 * (`musicCardShelfRenderer`), read like a carousel card, by what its title links to. `undefined`
 * when the answer has no card, e.g. for a query without results.
 *
 * @throws FxmError `Parse` when the response has no results tab.
 */
export function parseTopResult(json: unknown, options: MapOptions): Item | undefined {
  const card = asRecord(firstShelf(searchSections(json), 'musicCardShelfRenderer')?.shelf)
  if (card === undefined) return undefined
  return mapTwoRowItem(
    {
      title: card.title,
      subtitle: card.subtitle,
      thumbnailRenderer: card.thumbnail,
      navigationEndpoint: runsOf(card.title)[0]?.endpoint ?? card.onTap,
      subtitleBadges: card.subtitleBadges,
    },
    options,
  )
}
