/**
 * YouTube Music's search suggestions (`music/get_search_suggestions`).
 *
 * @module
 */

import { arrayAt, recordAt, stringAt } from '../json'
import { textOf } from './text'

/**
 * The query completions of a suggestions response, best first and without repeats: the query
 * each suggestion searches for, else its text. The rich suggestions YouTube Music adds (an
 * artist, a few songs) are left out, since a search finds them.
 */
export function parseSuggestions(json: unknown): string[] {
  const suggestions: string[] = []
  for (const section of arrayAt(json, 'contents')) {
    for (const item of arrayAt(section, 'searchSuggestionsSectionRenderer', 'contents')) {
      const renderer = recordAt(item, 'searchSuggestionRenderer')
      if (renderer === undefined) continue
      const text = (
        stringAt(renderer, 'navigationEndpoint', 'searchEndpoint', 'query') ??
        textOf(renderer.suggestion)
      )?.trim()
      if (text !== undefined && text !== '' && !suggestions.includes(text)) suggestions.push(text)
    }
  }
  return suggestions
}
