/**
 * What an embed shows and how its address spells it. The share dialog builds these addresses
 * and the embed parses them, so both live here:
 *
 * ```
 * https://fxmusic.pages.dev/embed/<kind>/<source>:<native ID>?layout=compact&theme=light&mode=all
 * ```
 *
 * - `<kind>` is `track`, `album` or `playlist`.
 * - `<source>:<native ID>` names the entity the way the app's own pages do
 *   (`/album/ytm:MPREb_…`), with the native ID percent-encoded, so an Internet Archive track
 *   (`<identifier>/<file>`) stays one path segment.
 * - Every query parameter is optional and has a default: `layout` (`card`), `theme` (`auto`)
 *   and `mode` (`music`). `origin` names the page allowed to control the player through the
 *   postMessage API (see `api.ts`).
 *
 * Everything here treats its input as untrusted: any site can write an embed address.
 *
 * @module
 */

import {
  type CatalogMode,
  type EntityId,
  type EntityKind,
  formatId,
  isCatalogMode,
  parseId,
} from '@fxm/core'

/** The path every embed is served under. */
export const EMBED_BASE_PATH = '/embed/'

/** FXM's public origin, where shared embeds are served from (ARCHITECTURE.md D24). */
export const FXM_PUBLIC_ORIGIN = 'https://fxmusic.pages.dev'

/** What an embed can show. Artists have no embed. */
export const EMBED_KINDS = ['track', 'album', 'playlist'] as const

/** What an embed can show: a track, an album or a playlist. */
export type EmbedKind = (typeof EMBED_KINDS)[number]

/**
 * The sources an embed can load: YouTube Music and plain YouTube, which play through FXM
 * Connect or the Lite tier, and the free sources, which play everywhere. Local files live on
 * one device, plugins aren't loaded in embeds, and Spotify needs FXM Connect plus the matching
 * engine, which the embed doesn't run yet.
 */
export const EMBED_SOURCES = ['ytm', 'yt', 'archive', 'jamendo'] as const

/** A source an embed can load. */
export type EmbedSource = (typeof EMBED_SOURCES)[number]

/**
 * The entity an embed shows: what it is (`kind`) and its ID, of that kind and from one of the
 * {@link EMBED_SOURCES}.
 */
export type EmbedTarget =
  | { readonly kind: 'track'; readonly id: EntityId<'track'> }
  | { readonly kind: 'album'; readonly id: EntityId<'album'> }
  | { readonly kind: 'playlist'; readonly id: EntityId<'playlist'> }

/** The target for a kind, a source and a non-empty native ID. */
function targetFor(kind: EmbedKind, source: EmbedSource, nativeId: string): EmbedTarget {
  switch (kind) {
    case 'track':
      return { kind, id: formatId(source, kind, nativeId) }
    case 'album':
      return { kind, id: formatId(source, kind, nativeId) }
    case 'playlist':
      return { kind, id: formatId(source, kind, nativeId) }
  }
}

/** The two layouts. */
export const EMBED_LAYOUTS = ['compact', 'card'] as const

/**
 * How an embed is laid out: `compact`, one row with the artwork, the title and a play button;
 * `card`, a larger card with a seek bar and, for albums and playlists, the track list.
 */
export type EmbedLayout = (typeof EMBED_LAYOUTS)[number]

/** The color themes. */
export const EMBED_THEMES = ['auto', 'dark', 'light'] as const

/** The embed's colors: following the visitor's system setting, or always dark or light. */
export type EmbedTheme = (typeof EMBED_THEMES)[number]

/** How an embed looks and what it plays, from its query parameters. */
export interface EmbedOptions {
  /** The layout. */
  readonly layout: EmbedLayout
  /** The color theme. */
  readonly theme: EmbedTheme
  /** The catalog mode the embed plays in: songs only, or videos too. */
  readonly mode: CatalogMode
}

/** The options an address without query parameters gets. */
export const DEFAULT_EMBED_OPTIONS: EmbedOptions = Object.freeze({
  layout: 'card',
  theme: 'auto',
  mode: 'music',
})

/**
 * The iframe height each layout is designed for, in CSS pixels. A card for a track has no track
 * list, so it is shorter than one for an album or a playlist.
 */
export const EMBED_HEIGHTS: Readonly<Record<EmbedLayout, Readonly<Record<EmbedKind, number>>>> =
  Object.freeze({
    compact: Object.freeze({ track: 80, album: 80, playlist: 80 }),
    card: Object.freeze({ track: 232, album: 380, playlist: 380 }),
  })

/** The longest native ID an address may carry, after decoding. */
const MAX_NATIVE_ID_LENGTH = 512

/** Whether `value` is one of `values`, spelled exactly. */
function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

/** Whether `value` is an {@link EmbedKind}. */
export function isEmbedKind(value: unknown): value is EmbedKind {
  return isOneOf(EMBED_KINDS, value)
}

/** Whether `value` is an {@link EmbedSource}. */
export function isEmbedSource(value: unknown): value is EmbedSource {
  return isOneOf(EMBED_SOURCES, value)
}

/** Whether `value` is an {@link EmbedLayout}. */
export function isEmbedLayout(value: unknown): value is EmbedLayout {
  return isOneOf(EMBED_LAYOUTS, value)
}

/** Whether `value` is an {@link EmbedTheme}. */
export function isEmbedTheme(value: unknown): value is EmbedTheme {
  return isOneOf(EMBED_THEMES, value)
}

/**
 * The embed target for an entity ID, or `undefined` when no embed can show it: an artist, or a
 * source the embed can't load (see {@link EMBED_SOURCES}).
 */
export function embedTargetOf(id: EntityId): EmbedTarget | undefined {
  const { kind, source, nativeId } = parseId(id)
  if (!isEmbedKind(kind) || !isEmbedSource(source)) return undefined
  return targetFor(kind, source, nativeId)
}

/** Whether an embed can show the entity `id`. */
export function isEmbeddable(id: EntityId): boolean {
  return embedTargetOf(id) !== undefined
}

/**
 * The path of an embed, under {@link EMBED_BASE_PATH}: `/embed/track/ytm:dQw4w9WgXcQ`, or
 * `/embed/track/archive:item%2Fsong.flac` for a native ID with a slash.
 */
export function embedPath(target: EmbedTarget): string {
  const { source, nativeId } = parseId(target.id)
  return `${EMBED_BASE_PATH}${target.kind}/${source}:${encodeURIComponent(nativeId)}`
}

/**
 * The full address of an embed on `origin`, with only the options that differ from
 * {@link DEFAULT_EMBED_OPTIONS} in its query, so shared links stay short.
 */
export function embedUrl(
  origin: string,
  target: EmbedTarget,
  options: Partial<EmbedOptions> = {},
): string {
  const url = new URL(embedPath(target), origin)
  const { layout, theme, mode } = { ...DEFAULT_EMBED_OPTIONS, ...options }
  if (layout !== DEFAULT_EMBED_OPTIONS.layout) url.searchParams.set('layout', layout)
  if (theme !== DEFAULT_EMBED_OPTIONS.theme) url.searchParams.set('theme', theme)
  if (mode !== DEFAULT_EMBED_OPTIONS.mode) url.searchParams.set('mode', mode)
  return url.href
}

/** Why an address names no embed. */
export type EmbedAddressError = 'not-an-embed' | 'unknown-kind' | 'unsupported-source' | 'bad-id'

/** What an embed address says, or why it says nothing usable. */
export type EmbedAddress =
  | {
      readonly ok: true
      readonly target: EmbedTarget
      readonly options: EmbedOptions
      /**
       * The serialized origin of the page allowed to control the player, from the `origin`
       * parameter. Absent when the address doesn't name one or names something else.
       */
      readonly controller?: string
    }
  | { readonly ok: false; readonly error: EmbedAddressError }

/**
 * Whether `value` is a serialized web origin such as `https://example.com` or
 * `http://localhost:8080`: exactly what `URL.origin` gives, with no path, user or trailing
 * slash. Opaque origins (`null`) don't count.
 */
export function isSerializedOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value
  } catch {
    return false
  }
}

/**
 * Reads an embed address: the path (`/embed/<kind>/<source>:<native ID>`) and the query.
 *
 * Unknown or malformed query values fall back to their defaults, so a typo in an option never
 * breaks a player. A path that names no entity an embed can show is an error. Only the first
 * `:` of the last segment separates the source, so native IDs may contain colons.
 */
export function parseEmbedAddress(pathname: string, search = ''): EmbedAddress {
  if (!pathname.startsWith(EMBED_BASE_PATH)) return { ok: false, error: 'not-an-embed' }
  const segments = pathname.slice(EMBED_BASE_PATH.length).split('/')
  // A trailing slash is harmless: `/embed/track/ytm:abc/`.
  if (segments.length === 3 && segments[2] === '') segments.pop()
  if (segments.length !== 2) return { ok: false, error: 'not-an-embed' }
  const [kind, segment = ''] = segments
  if (!isEmbedKind(kind)) return { ok: false, error: 'unknown-kind' }

  let decoded: string
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    return { ok: false, error: 'bad-id' }
  }
  const separator = decoded.indexOf(':')
  if (separator <= 0) return { ok: false, error: 'bad-id' }
  const source = decoded.slice(0, separator)
  const nativeId = decoded.slice(separator + 1)
  if (!isEmbedSource(source)) return { ok: false, error: 'unsupported-source' }
  if (nativeId === '' || nativeId.length > MAX_NATIVE_ID_LENGTH || hasControlCharacter(nativeId)) {
    return { ok: false, error: 'bad-id' }
  }
  const target = targetFor(kind, source, nativeId)

  const query = new URLSearchParams(search)
  const layout = query.get('layout')
  const theme = query.get('theme')
  const mode = query.get('mode')
  const controller = query.get('origin')
  return {
    ok: true,
    target,
    options: {
      layout: isEmbedLayout(layout) ? layout : DEFAULT_EMBED_OPTIONS.layout,
      theme: isEmbedTheme(theme) ? theme : DEFAULT_EMBED_OPTIONS.theme,
      mode: isCatalogMode(mode) ? mode : DEFAULT_EMBED_OPTIONS.mode,
    },
    ...(isSerializedOrigin(controller) ? { controller } : {}),
  }
}

/** Whether `text` holds a C0 or C1 control character, which no native ID contains. */
function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return true
  }
  return false
}

/** The kinds of entity an app page exists for, as the app's routes spell them. */
const APP_PAGE_KINDS: ReadonlySet<EntityKind> = new Set(['album', 'playlist'])

/** The longest search a track's link asks the app for: titles come from the source. */
const MAX_SEARCH_LENGTH = 200

/** What the embed knows about a track, to find it in the app. */
export interface AppLinkHint {
  /** The track's title, once loaded. */
  readonly title?: string
  /** Its first artist, when known. */
  readonly artist?: string
}

/**
 * Where "Open in FXM" goes for a target, on `origin`: the album or playlist page of the web app
 * (`/app/album/ytm:MPREb_…`, the form the app's pages use). A track has no page of its own, so
 * it goes to the app's search for its title and artist (`/app/search?q=…`), or to the app's
 * home while its title isn't known.
 */
export function appUrlFor(origin: string, target: EmbedTarget, hint: AppLinkHint = {}): string {
  if (!APP_PAGE_KINDS.has(target.kind)) {
    const title = hint.title?.trim()
    if (!title) return new URL('/app/', origin).href
    const url = new URL('/app/search', origin)
    const query = [title, hint.artist?.trim()].filter(Boolean).join(' ')
    url.searchParams.set('q', query.slice(0, MAX_SEARCH_LENGTH))
    return url.href
  }
  const { source, nativeId } = parseId(target.id)
  return new URL(`/app/${target.kind}/${source}:${encodeURIComponent(nativeId)}`, origin).href
}

/** Where the install hint points: the "Get FXM" section of the landing page on `origin`. */
export function installUrlFor(origin: string): string {
  return new URL('/#get', origin).href
}
