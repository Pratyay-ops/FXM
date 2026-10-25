/**
 * Source-qualified entity IDs of the form `<source>:<kind>:<nativeId>`, for example
 * `ytm:track:dQw4w9WgXcQ` or `spotify:album:4aawyAB9vmqN3uQ7FjRGTy`, and canonical ISRCs.
 *
 * ## Sources
 *
 * A source is either built in (the {@link SOURCE_IDS}) or added by a runtime plugin, whose
 * source ID is `plugin.<name>` (see {@link PluginSourceId}). The prefix keeps the two apart, so
 * a plugin can never take the ID of a built-in source, present or future.
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
 * - `local`: an ID that the local-files feature chooses, stable across rescans of the same file
 * - `plugin.<name>`: whatever the plugin chooses. FXM treats it as opaque: it never parses,
 *   normalizes or merges it with another source's IDs, so the plugin itself must spell each
 *   entity's ID one way only
 *
 * YouTube Music and plain YouTube share one ID space. An item gets `ytm` when it came from
 * YouTube Music, whatever its kind (a song, an official video, or an upload found there), and
 * `yt` only when it came from plain YouTube. The same video can therefore have a `ytm` and a `yt`
 * ID: {@link entityKey} gives both one key, for storage and de-duplication.
 *
 * @module
 */

/**
 * Every source built into FXM. The order carries no meaning. Runtime plugins add sources of
 * their own (see {@link PluginSourceId}).
 */
export const SOURCE_IDS = ['ytm', 'yt', 'spotify', 'archive', 'jamendo', 'local'] as const

/**
 * A source built into FXM:
 *
 * - `ytm`: YouTube Music songs, albums, artists and playlists
 * - `yt`: plain YouTube videos, channels and playlists
 * - `spotify`: Spotify metadata and recommendations (no audio of its own in FXM)
 * - `archive`: Internet Archive
 * - `jamendo`: Jamendo
 * - `local`: files on the user's device
 */
export type BuiltInSourceId = (typeof SOURCE_IDS)[number]

/**
 * The source ID of a runtime plugin: `plugin.` and the plugin's name, e.g. `plugin.radio-garden`.
 * The name follows the rule for a DNS label: 1 to 63 lower-case ASCII letters, digits and
 * hyphens, neither starting nor ending with a hyphen. So it has one spelling only and never
 * contains the `:` that separates the parts of an {@link EntityId}. The type accepts any
 * `plugin.` string; {@link isPluginSourceId} checks the name. To tell a plugin source from a
 * built-in one, use {@link isBuiltInSourceId}.
 *
 * A plugin's native IDs are opaque to FXM (see the module documentation).
 */
export type PluginSourceId = `plugin.${string}`

/** A source FXM reads from: a {@link BuiltInSourceId} or a {@link PluginSourceId}. */
export type SourceId = BuiltInSourceId | PluginSourceId

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

/** `plugin.` and a name like a DNS label: see {@link PluginSourceId}. */
const PLUGIN_SOURCE_ID = /^plugin\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u

/**
 * Whether `value` is a {@link SourceId}: one of the built-in {@link SOURCE_IDS}, or a plugin
 * source with a well-formed name (see {@link isPluginSourceId}).
 */
export function isSourceId(value: unknown): value is SourceId {
  return isBuiltInSourceId(value) || isPluginSourceId(value)
}

/**
 * Whether `value` is one of the built-in {@link SOURCE_IDS}, spelled exactly. Use it to branch
 * on a source: for a {@link SourceId}, `false` means a plugin source, which is exactly what
 * TypeScript narrows it to.
 */
export function isBuiltInSourceId(value: unknown): value is BuiltInSourceId {
  return typeof value === 'string' && (SOURCE_IDS as readonly string[]).includes(value)
}

/**
 * Whether `value` is a well-formed {@link PluginSourceId}: `plugin.` and a name of 1 to 63
 * lower-case ASCII letters, digits and hyphens that neither starts nor ends with a hyphen, such
 * as `plugin.radio-garden`. Use it to check a name from untrusted input, such as a plugin's
 * manifest.
 *
 * Do not branch on a source with it: the `PluginSourceId` type accepts any `plugin.` string, so
 * `false` does not prove a built-in source, although TypeScript then narrows a `SourceId` to
 * `BuiltInSourceId`. A malformed plugin source, such as `plugin.Radio` from untyped plugin code,
 * would land there. {@link isBuiltInSourceId} is exact in both branches.
 */
export function isPluginSourceId(value: unknown): value is PluginSourceId {
  return typeof value === 'string' && PLUGIN_SOURCE_ID.test(value)
}

/** Whether `value` is one of the {@link ENTITY_KINDS}. */
export function isEntityKind(value: unknown): value is EntityKind {
  return typeof value === 'string' && (ENTITY_KINDS as readonly string[]).includes(value)
}

/**
 * Builds an {@link EntityId} from its parts. The native ID is kept verbatim, so it may contain
 * `:` (e.g. a local file path); {@link parseId} splits only on the first two colons. Pass it in
 * its source's canonical form (see the module documentation): a Spotify ID, for example, is the
 * bare base62 ID and never a `spotify:track:…` URI. A plugin source's native ID is passed as the
 * plugin gives it.
 *
 * @throws RangeError when the source is neither built in nor a well-formed plugin source, the
 * kind is unknown or the native ID is empty. Those are programming errors, and refusing them
 * guarantees that every formatted ID parses back.
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
 * string, the source is not a {@link SourceId} (built in, or a plugin source with a well-formed
 * name), the kind is unknown, or the native ID is empty.
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
 * have the key `youtube:track:dQw4w9WgXcQ`; any other ID is its own key. That includes a plugin
 * source's IDs, which are opaque, so they never share a key with another source's, even when the
 * native IDs look alike. The key is only for comparing and storing: it is not an `EntityId` and
 * need not parse as one.
 */
export function entityKey(id: EntityId): string {
  const source = id.slice(0, id.indexOf(':'))
  return source === 'ytm' || source === 'yt' ? `youtube${id.slice(source.length)}` : id
}

/** Whether two IDs name the same entity, i.e. have the same {@link entityKey}. */
export function sameEntity(a: EntityId, b: EntityId): boolean {
  return entityKey(a) === entityKey(b)
}

/** An ISRC: country (2 letters), registrant (3 characters), year (2 digits), number (5 digits). */
const ISRC = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/u

/**
 * The canonical form of an International Standard Recording Code: 12 upper-case characters
 * without separators, e.g. `GBARL9300135` for `gb-arl-93-00135`. `Track.isrc` always holds this
 * form, so ISRCs from Spotify, MusicBrainz, YouTube Music and file tags compare equal.
 *
 * Accepts lower case, hyphens, dashes, dots, spaces, full-width characters and an `ISRC:` label.
 * Returns `null`, and never throws, when the value is not a string or not a valid ISRC.
 */
export function normalizeIsrc(text: unknown): string | null {
  if (typeof text !== 'string') return null
  const compact = text
    .normalize('NFKC')
    .toUpperCase()
    .replace(/^\s*ISRC(?:\s*:\s*|\s+)/u, '')
    .replace(/[\s.\-\u{2010}-\u{2015}\u{2212}]/gu, '')
  return ISRC.test(compact) ? compact : null
}
