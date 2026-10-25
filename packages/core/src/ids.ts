/**
 * Source-qualified entity IDs of the form `<source>:<kind>:<nativeId>`, for example
 * `ytm:track:dQw4w9WgXcQ` or `spotify:album:4aawyAB9vmqN3uQ7FjRGTy`.
 *
 * ## Canonical native IDs
 *
 * Likes, follows, history, playlists and the caches are keyed by these IDs, and several providers
 * create them independently, so each source spells its native IDs one way only:
 *
 * - `ytm` and `yt`: YouTube's own IDs, bare: the videoId for tracks, the browseId (`MPREb_…`)
 *   for albums, the channelId (`UC…`) for artists, and the playlistId without the `VL` browse
 *   prefix for playlists
 * - `spotify`: the 22-character base62 ID, never a `spotify:track:…` URI or an
 *   open.spotify.com URL
 * - `archive`: the item identifier for albums, and `<identifier>/<file path>` for tracks
 * - `jamendo`: Jamendo's numeric ID, in decimal
 * - `jiosaavn`: JioSaavn's own ID
 * - `local`: an ID that the local-files feature chooses, stable across rescans of the same file
 *
 * YouTube Music and plain YouTube share one ID space. An item gets `ytm` when it came from
 * YouTube Music, whatever its kind (a song, an official video, or an upload found there), and
 * `yt` only when it came from plain YouTube. The same video can therefore have a `ytm` and a `yt`
 * ID: {@link entityKey} gives both one key, for storage and de-duplication.
 *
 * @module
 */

/** Every source FXM can read from. The order carries no meaning. */
export const SOURCE_IDS = [
  'ytm',
  'yt',
  'spotify',
  'archive',
  'jamendo',
  'local',
  'jiosaavn',
] as const

/**
 * A source FXM reads from:
 *
 * - `ytm`: YouTube Music songs, albums, artists and playlists
 * - `yt`: plain YouTube videos, channels and playlists
 * - `spotify`: Spotify metadata and recommendations (no audio of its own in FXM)
 * - `archive`: Internet Archive
 * - `jamendo`: Jamendo
 * - `local`: files on the user's device
 * - `jiosaavn`: JioSaavn
 */
export type SourceId = (typeof SOURCE_IDS)[number]

/** Every kind of entity an {@link EntityId} can name. */
export const ENTITY_KINDS = ['track', 'album', 'artist', 'playlist'] as const

/** The kind of entity an ID names. */
export type EntityKind = (typeof ENTITY_KINDS)[number]

declare const entityIdBrand: unique symbol

/**
 * A source-qualified ID, `<source>:<kind>:<nativeId>`, such as `ytm:track:dQw4w9WgXcQ`. The
 * native ID is in its source's canonical form (see the module documentation).
 *
 * It is a branded string: plain strings are not accepted where an `EntityId` is expected, so
 * every ID in the app went through {@link formatId} or was checked by {@link isEntityId}.
 * `K` narrows the kind, e.g. `EntityId<'album'>`; the default accepts any kind.
 */
export type EntityId<K extends EntityKind = EntityKind> = `${SourceId}:${K}:${string}` & {
  readonly [entityIdBrand]: K
}

/** The three parts of an {@link EntityId}, as returned by {@link parseId}. */
export interface EntityIdParts<K extends EntityKind = EntityKind> {
  /** The source the entity comes from. */
  source: SourceId
  /** What the ID names. */
  kind: K
  /** The source's own ID. Never empty, and may itself contain `:`. */
  nativeId: string
}

/** Whether `value` is one of the {@link SOURCE_IDS}. */
export function isSourceId(value: unknown): value is SourceId {
  return typeof value === 'string' && (SOURCE_IDS as readonly string[]).includes(value)
}

/** Whether `value` is one of the {@link ENTITY_KINDS}. */
export function isEntityKind(value: unknown): value is EntityKind {
  return typeof value === 'string' && (ENTITY_KINDS as readonly string[]).includes(value)
}

/**
 * Builds an {@link EntityId} from its parts. The native ID is kept verbatim, so it may contain
 * `:` (e.g. a local file path); {@link parseId} splits only on the first two colons. Pass it in
 * its source's canonical form (see the module documentation): a Spotify ID, for example, is the
 * bare base62 ID and never a `spotify:track:…` URI.
 *
 * @throws RangeError when the source or kind is unknown or the native ID is empty. Those are
 * programming errors, and refusing them guarantees that every formatted ID parses back.
 */
export function formatId<K extends EntityKind>(
  source: SourceId,
  kind: K,
  nativeId: string,
): EntityId<K> {
  if (!isSourceId(source)) throw new RangeError(`Unknown source: ${String(source)}`)
  if (!isEntityKind(kind)) throw new RangeError(`Unknown entity kind: ${String(kind)}`)
  if (typeof nativeId !== 'string' || nativeId === '') {
    throw new RangeError('The native ID must be a non-empty string')
  }
  return `${source}:${kind}:${nativeId}` as EntityId<K>
}

/**
 * Splits an {@link EntityId} into its parts, keeping its kind. A branded ID is valid by
 * construction, so the result is never `null`. Only the first two `:` separate parts, so the
 * native ID may contain more colons.
 */
export function parseId<K extends EntityKind>(id: EntityId<K>): EntityIdParts<K>
/**
 * Splits a value that may be an ID into its parts. Only the first two `:` separate parts, so the
 * native ID may contain more colons. Returns `null`, and never throws, when the value is not a
 * string, the source or kind is unknown, or the native ID is empty.
 */
export function parseId(id: unknown): EntityIdParts | null
export function parseId(id: unknown): EntityIdParts | null {
  if (typeof id !== 'string') return null
  const first = id.indexOf(':')
  const second = first < 0 ? -1 : id.indexOf(':', first + 1)
  if (second < 0) return null
  const source = id.slice(0, first)
  const kind = id.slice(first + 1, second)
  const nativeId = id.slice(second + 1)
  if (!isSourceId(source) || !isEntityKind(kind) || nativeId === '') return null
  return { source, kind, nativeId }
}

/**
 * Whether `value` is a well-formed {@link EntityId}, optionally of one `kind`. Use it to
 * accept IDs from untrusted places such as URLs, storage or imported backups.
 */
export function isEntityId<K extends EntityKind = EntityKind>(
  value: unknown,
  kind?: K,
): value is EntityId<K> {
  if (typeof value !== 'string') return false
  const parts = parseId(value)
  return parts !== null && (kind === undefined || parts.kind === kind)
}

/**
 * The key to store and de-duplicate an entity under: equal for IDs that name the same entity.
 * `ytm` and `yt` share one ID space, so `ytm:track:dQw4w9WgXcQ` and `yt:track:dQw4w9WgXcQ` both
 * have the key `youtube:track:dQw4w9WgXcQ`; any other ID is its own key. The key is only for
 * comparing and storing: it is not an `EntityId` and need not parse as one.
 */
export function entityKey(id: EntityId): string {
  const source = id.slice(0, id.indexOf(':'))
  return source === 'ytm' || source === 'yt' ? `youtube${id.slice(source.length)}` : id
}

/** Whether two IDs name the same entity, i.e. have the same {@link entityKey}. */
export function sameEntity(a: EntityId, b: EntityId): boolean {
  return entityKey(a) === entityKey(b)
}
