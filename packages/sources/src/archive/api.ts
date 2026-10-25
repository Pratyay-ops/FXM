/**
 * The Internet Archive's advanced search (`/advancedsearch.php`) and metadata API
 * (`/metadata/<identifier>`), called only through the injected `fetch`.
 *
 * Both send `Access-Control-Allow-Origin: *`, and so does the download redirect and the storage
 * host it leads to (measured 2026-10-25), so a browser page reaches the Archive directly, without
 * FXM Connect. Requests send no headers of their own, so they never need a CORS preflight.
 *
 * @module
 */

import { FxmError, type ProviderContext } from '@fxm/core'
import { wordsOf } from '../shared/audio-source'
import { asObject, getJson, releaseDate, statusError, text } from '../shared/json'
import { LoadCache } from '../shared/ttl-cache'
import { ARCHIVE_ORIGIN, type ArchiveItem, parseItem } from './item'

const SERVICE = 'The Internet Archive'

/** An item as advanced search lists it. */
export interface ArchiveSearchDoc {
  /** The item's identifier. */
  identifier: string
  /** Its title. */
  title?: string
  /** Its creators, main one first. */
  creators: string[]
  /** Its date, as `Track.releaseDate` holds it. */
  date?: string
  /** `audio`, or `etree` for the Live Music Archive. */
  mediatype?: string
  /** How often it was downloaded. */
  downloads?: number
}

/** One page of search results. */
export interface ArchiveSearchPage {
  /** How many items match in all. */
  total: number
  /** The items on this page, in order. */
  docs: ArchiveSearchDoc[]
}

/** What to search for. */
export interface ArchiveSearch {
  /** Words that must all match. Everything but letters and digits is dropped. */
  text: string
  /**
   * Alternatives of which at least one must also match, each as words that must all match, e.g.
   * a track's album and its title: the Archive indexes items, not files, so a song is found by
   * its album's name or by its title in the item's description.
   */
  anyOf?: readonly string[]
  /** Media types to search, e.g. `['audio', 'etree']`. */
  mediatypes: readonly string[]
  /** Items per page. */
  rows: number
  /** The page, from 1. */
  page: number
  /** `downloads`: most downloaded first; `relevance`: the Archive's ranking. */
  sort: 'downloads' | 'relevance'
}

/** Settings of an {@link ArchiveApi}. */
export interface ArchiveApiOptions {
  /** The Archive's origin, {@link ARCHIVE_ORIGIN} by default. */
  baseUrl?: string
  /** Abort a request after this many milliseconds. */
  timeoutMs: number
  /** How long to keep search pages. */
  searchTtlMs: number
  /** How long to keep item metadata. */
  itemTtlMs: number
  /** The clock for the caches. `Date.now` by default. */
  now?: () => number
}

/** A media type name as the query may contain it. */
const MEDIATYPE = /^[a-z0-9_-]+$/u

/**
 * The advanced-search query for some words: items of the given media types that have a FLAC
 * file, are not access-restricted, and match every word, plus every word of at least one of the
 * `anyOf` alternatives when there are any. The words are reduced to letters and digits and
 * lower-cased, so nothing a user types can change the query's structure (no fields, operators,
 * quotes, brackets or wildcards). `null` when no word or media type is left.
 */
export function searchQuery(
  words: string,
  mediatypes: readonly string[],
  anyOf: readonly string[] = [],
): string | null {
  const terms = wordsOf(words)
  const types = mediatypes.filter((type) => MEDIATYPE.test(type))
  const alternatives = [...new Set(anyOf.map((option) => wordsOf(option).join(' ')))].filter(
    (option) => option !== '',
  )
  if (terms.length === 0 || types.length === 0) return null
  const parts = [
    `mediatype:(${types.join(' OR ')})`,
    'format:flac',
    'NOT access-restricted-item:true',
    `(${terms.join(' ')})`,
  ]
  if (alternatives.length > 0) {
    parts.push(`(${alternatives.map((option) => `(${option})`).join(' OR ')})`)
  }
  return parts.join(' AND ')
}

/** The strings of a field that may be a string or a list of strings. */
function strings(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value]
  return list.map(text).filter((item) => item !== undefined)
}

/** One search result, or `null` without an identifier. */
function toDoc(value: unknown): ArchiveSearchDoc | null {
  const object = asObject(value)
  const identifier = text(object?.identifier)
  if (object === undefined || identifier === undefined) return null
  const doc: ArchiveSearchDoc = { identifier, creators: strings(object.creator) }
  const title = strings(object.title)[0]
  if (title !== undefined) doc.title = title
  const date = releaseDate(object.date) ?? releaseDate(object.year)
  if (date !== undefined) doc.date = date
  const mediatype = text(object.mediatype)
  if (mediatype !== undefined) doc.mediatype = mediatype
  if (typeof object.downloads === 'number') doc.downloads = object.downloads
  return doc
}

/** The fields FXM asks advanced search for. */
const FIELDS = ['identifier', 'title', 'creator', 'date', 'year', 'mediatype', 'downloads']

/** A client for the Archive's search and item metadata, with in-memory caches. */
export class ArchiveApi {
  private readonly baseUrl: string
  private readonly searches: LoadCache<ArchiveSearchPage>
  private readonly items: LoadCache<ArchiveItem>

  constructor(private readonly options: ArchiveApiOptions) {
    this.baseUrl = (options.baseUrl ?? ARCHIVE_ORIGIN).replace(/\/+$/u, '')
    const now = options.now === undefined ? {} : { now: options.now }
    this.searches = new LoadCache({ maxEntries: 100, ...now })
    this.items = new LoadCache({ maxEntries: 50, ...now })
  }

  /** One page of items matching `search`. Empty, without a request, when no word is left. */
  async search(search: ArchiveSearch, ctx: ProviderContext): Promise<ArchiveSearchPage> {
    const query = searchQuery(search.text, search.mediatypes, search.anyOf)
    if (query === null) return { total: 0, docs: [] }
    const url = new URL('/advancedsearch.php', this.baseUrl)
    url.searchParams.set('q', query)
    for (const field of FIELDS) url.searchParams.append('fl[]', field)
    if (search.sort === 'downloads') url.searchParams.set('sort[]', 'downloads desc')
    url.searchParams.set('rows', String(search.rows))
    url.searchParams.set('page', String(search.page))
    url.searchParams.set('output', 'json')
    const href = url.href
    return this.searches.get(
      href,
      this.options.searchTtlMs,
      async () => {
        const reply = await getJson(ctx, href, {
          service: SERVICE,
          timeoutMs: this.options.timeoutMs,
        })
        if (reply.status !== 200) throw statusError(SERVICE, 'a search', reply)
        const response = asObject(asObject(reply.body)?.response)
        if (response === undefined || !Array.isArray(response.docs)) {
          throw new FxmError(
            'Parse',
            'The Internet Archive sent search results FXM does not understand',
          )
        }
        const docs = response.docs.map(toDoc).filter((doc) => doc !== null)
        const total = typeof response.numFound === 'number' ? response.numFound : docs.length
        return { total, docs }
      },
      ctx.signal,
    )
  }

  /**
   * An item's metadata and files. Rejects with `NotFound` for an unknown or withdrawn item.
   * Concurrent and repeated calls for one item share one request.
   */
  item(identifier: string, ctx: ProviderContext): Promise<ArchiveItem> {
    const href = `${this.baseUrl}/metadata/${encodeURIComponent(identifier)}`
    return this.items.get(
      identifier,
      this.options.itemTtlMs,
      async () => {
        const reply = await getJson(ctx, href, {
          service: SERVICE,
          timeoutMs: this.options.timeoutMs,
        })
        if (reply.status !== 200) throw statusError(SERVICE, 'the item metadata', reply)
        return parseItem(identifier, reply.body)
      },
      ctx.signal,
    )
  }
}
