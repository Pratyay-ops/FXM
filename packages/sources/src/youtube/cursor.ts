/**
 * The opaque cursors of the YouTube providers' pages: base64url-encoded JSON that says which
 * list a page continues and where. They are self-contained, so a cursor works after a reload,
 * and every field is checked when one comes back, since it may come from storage or a URL.
 *
 * @module
 */

import { FxmError, type SearchType } from '@fxm/core'
import { isYouTubeId, VIDEO_ID } from './ids'

/** The cursor of a search page. */
export interface SearchCursor {
  readonly k: 'search'
  /** The result type. */
  readonly t: SearchType
  /** The query, trimmed. */
  readonly q: string
  /** The continuation token of the YouTube page to read; absent for the first page. */
  readonly c?: string
  /** How many items of that page earlier pages returned, when a `limit` split it. */
  readonly o?: number
}

/** The cursor of a page of a playlist's tracks. */
export interface PlaylistCursor {
  readonly k: 'playlist'
  /** The playlistId. */
  readonly p: string
  /** The continuation token of the YouTube page to read; absent for the first page. */
  readonly c?: string
  /** How many items of that page earlier pages returned, when a `limit` split it. */
  readonly o?: number
}

/**
 * The cursor of a radio page. It belongs to its seed and catalog mode: the provider refuses it
 * for another seed, and in Music mode an official video's radio starts from its linked song.
 */
export interface RadioCursor {
  readonly k: 'radio'
  /** What the radio started from: `track:<videoId>` or `artist:<channelId>`. */
  readonly s: string
  /**
   * The continuation token of the YouTube page to read; absent for the seed's first page. When a
   * `limit` split a page, the next cursor names the same page again, whose tracks not yet
   * returned come next.
   */
  readonly c?: string
  /**
   * The videoIds the radio's pages returned, the newest {@link RADIO_MEMORY} of them, newest
   * last, joined without separators.
   */
  readonly seen: string
}

/** Any cursor. */
export type Cursor = SearchCursor | PlaylistCursor | RadioCursor

/** At most this many videoIds are remembered in a radio cursor. */
export const RADIO_MEMORY = 200

const SEARCH_TYPES: readonly SearchType[] = ['track', 'video', 'album', 'artist', 'playlist']
const MAX_CURSOR = 8192
const MAX_TOKEN = 4096
const MAX_QUERY = 500
const MAX_OFFSET = 1000

function toBase64Url(text: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function fromBase64Url(text: string): string {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/** Encodes a cursor for a page's `nextCursor`. */
export function encodeCursor(cursor: Cursor): string {
  return toBase64Url(JSON.stringify(cursor))
}

function bad(why: string): never {
  throw new FxmError('NotFound', `Not a cursor of this list: ${why}`)
}

function token(value: unknown, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || value === '' || value.length > MAX_TOKEN) bad('token')
  return value
}

function offset(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_OFFSET) {
    bad('offset')
  }
  return value as number
}

/** The videoIds a radio cursor remembers. */
export function seenIds(cursor: RadioCursor): string[] {
  return cursor.seen.match(/.{11}/gu) ?? []
}

/** The `seen` field for these videoIds: the newest {@link RADIO_MEMORY} of them. */
export function seenField(ids: Iterable<string>): string {
  return [...ids].slice(-RADIO_MEMORY).join('')
}

function check(value: unknown): Cursor {
  if (typeof value !== 'object' || value === null) bad('not an object')
  const raw = value as Record<string, unknown>
  switch (raw.k) {
    case 'search': {
      if (!(SEARCH_TYPES as readonly unknown[]).includes(raw.t)) bad('type')
      if (typeof raw.q !== 'string' || raw.q.length > MAX_QUERY) bad('query')
      const c = token(raw.c, false)
      const o = offset(raw.o)
      return {
        k: 'search',
        t: raw.t as SearchType,
        q: raw.q,
        ...(c === undefined ? {} : { c }),
        ...(o === undefined ? {} : { o }),
      }
    }
    case 'playlist': {
      if (!isYouTubeId('playlist', raw.p)) bad('playlist')
      const c = token(raw.c, false)
      const o = offset(raw.o)
      return {
        k: 'playlist',
        p: raw.p,
        ...(c === undefined ? {} : { c }),
        ...(o === undefined ? {} : { o }),
      }
    }
    case 'radio': {
      if (typeof raw.s !== 'string' || !/^(?:track|artist):[A-Za-z0-9_-]{11,24}$/u.test(raw.s)) {
        bad('seed')
      }
      const seen = raw.seen
      if (
        typeof seen !== 'string' ||
        seen.length % 11 !== 0 ||
        seen.length > RADIO_MEMORY * 11 ||
        !(seen.match(/.{11}/gu) ?? []).every((id) => VIDEO_ID.test(id))
      ) {
        bad('seen')
      }
      const c = token(raw.c, false)
      return { k: 'radio', s: raw.s, ...(c === undefined ? {} : { c }), seen }
    }
    default:
      return bad('kind')
  }
}

/**
 * Decodes a cursor of the given kind.
 *
 * @throws FxmError `NotFound` when the text is not a well-formed cursor of that kind: there is no
 * such page.
 */
export function decodeCursor<K extends Cursor['k']>(
  text: string,
  kind: K,
): Extract<Cursor, { k: K }> {
  if (text.length === 0 || text.length > MAX_CURSOR || !/^[A-Za-z0-9_-]+$/u.test(text)) {
    bad('format')
  }
  let value: unknown
  try {
    value = JSON.parse(fromBase64Url(text))
  } catch {
    bad('encoding')
  }
  const cursor = check(value)
  if (cursor.k !== kind) bad(`a ${cursor.k} cursor`)
  return cursor as Extract<Cursor, { k: K }>
}
