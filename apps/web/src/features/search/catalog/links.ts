/**
 * Links to the album, artist and playlist pages. A page's URL names its entity as
 * `<source>:<native ID>`, e.g. `/album/ytm:MPREb_…` or `/artist/spotify:0OdUWJ0sBjDrqHygGUXeCF`:
 * the kind is already in the path. Build links with these helpers, never by hand.
 *
 * @module
 */

import { type EntityId, formatId, isSourceId, parseId } from '@fxm/core'

/** The entity kinds that have a page. */
export type PageKind = 'album' | 'artist' | 'playlist'

/** The URL segment that names an entity: `<source>:<native ID>`, with the native ID encoded. */
function segment(id: EntityId): string {
  const { source, nativeId } = parseId(id)
  return `${source}:${encodeURIComponent(nativeId)}`
}

/** The album page of `id`, e.g. `/album/ytm:MPREb_abc`. */
export function albumPath(id: EntityId<'album'>): string {
  return `/album/${segment(id)}`
}

/** The artist page of `id`, e.g. `/artist/ytm:UCabc`. */
export function artistPath(id: EntityId<'artist'>): string {
  return `/artist/${segment(id)}`
}

/** The playlist page of `id`, e.g. `/playlist/ytm:PLabc`. */
export function playlistPath(id: EntityId<'playlist'>): string {
  return `/playlist/${segment(id)}`
}

/**
 * The entity a page's route parameter names (React Router has already decoded it), or `null`
 * when it is not `<source>:<native ID>` with a known source and a non-empty ID.
 */
export function parseRouteId<K extends PageKind>(
  param: string | undefined,
  kind: K,
): EntityId<K> | null {
  if (param === undefined) return null
  const separator = param.indexOf(':')
  if (separator <= 0) return null
  const source = param.slice(0, separator)
  const nativeId = param.slice(separator + 1)
  if (!isSourceId(source) || nativeId === '') return null
  return formatId(source, kind, nativeId)
}
