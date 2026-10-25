/**
 * Bylines: the second line of a YouTube Music item, such as `Radiohead • Pablo Honey • 3:59`,
 * `Single • Artist A & Artist B • 2021` or `Uploader • 8.6K views • 4:18`.
 *
 * Each run is read by what it links to, never by where it stands: a run linking to an artist or
 * channel page is an artist, one linking to an album page is the album. Of the runs without a
 * link, a duration, a year, a count (anything with a digit, e.g. `2.3B plays`) and a separator
 * are recognized by their text. Bloomee read bylines by position and so mixed up artists,
 * albums and years whenever YouTube added or dropped a field.
 *
 * Only when no run links to an artist do the remaining unlinked words become the artists, minus
 * the item type labels of the config (`Song`, `Video`, `Single`, …), so that an artist without a
 * channel page still has a name.
 *
 * @module
 */

import type { AlbumRef, ArtistRef } from '@fxm/core'
import { type YouTubeSource, youTubeEntityId } from '../ids'
import { browseTarget, isArtistPage, PAGE_TYPES } from './endpoints'
import { isYear, parseDuration, type Run } from './text'

/** What a byline says. */
export interface Byline {
  /** The artists, in order and without repeats. */
  readonly artists: ArtistRef[]
  /** The album, if a run links to one. */
  readonly album?: AlbumRef
  /** The duration, if a run is one. */
  readonly durationMs?: number
  /** The year, if a run is one. */
  readonly year?: number
  /**
   * Unlinked words that are none of the above, in order, e.g. a type label such as `Single`, or
   * the name of an artist without a channel page.
   */
  readonly words: string[]
}

/** A run that only separates others: `•`, `,`, `&` and spaces. */
const SEPARATOR = /^[\s•·|,&、，]*$/u

/**
 * Reads a byline's runs (see the module documentation).
 *
 * @param source The source of the IDs it links, `ytm` or `yt`.
 * @param itemTypes Item type labels in lower case, which are never artists.
 */
export function parseByline(
  runs: readonly Run[],
  source: YouTubeSource,
  itemTypes: readonly string[],
): Byline {
  const artists: ArtistRef[] = []
  const words: string[] = []
  let album: AlbumRef | undefined
  let durationMs: number | undefined
  let year: number | undefined
  for (const run of runs) {
    const text = run.text.trim()
    if (run.endpoint !== undefined) {
      const target = browseTarget(run.endpoint)
      if (text === '' || target === undefined) continue
      if (isArtistPage(target.pageType)) {
        const id = youTubeEntityId(source, 'artist', target.browseId)
        addArtist(artists, id === undefined ? { name: text } : { id, name: text })
      } else if (target.pageType === PAGE_TYPES.album && album === undefined) {
        const id = youTubeEntityId(source, 'album', target.browseId)
        album = id === undefined ? { name: text } : { id, name: text }
      }
      continue
    }
    if (SEPARATOR.test(text)) continue
    const duration = parseDuration(text)
    if (duration !== undefined) durationMs ??= duration
    else if (isYear(text)) year ??= Number(text)
    else if (!/\d/u.test(text)) words.push(text)
  }
  if (artists.length === 0) {
    for (const word of words) {
      if (!itemTypes.includes(word.toLowerCase())) addArtist(artists, { name: word })
    }
  }
  return {
    artists,
    words,
    ...(album === undefined ? {} : { album }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(year === undefined ? {} : { year }),
  }
}

function addArtist(artists: ArtistRef[], artist: ArtistRef): void {
  const repeated = artists.some((known) =>
    artist.id === undefined ? known.name === artist.name : known.id === artist.id,
  )
  if (!repeated) artists.push(artist)
}
