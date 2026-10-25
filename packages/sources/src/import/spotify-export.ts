/**
 * Spotify's "Download your data" export: the JSON files of its "Account data" (playlists, the
 * library and a year of listening history) and of its "Extended streaming history" (every play
 * of the account's lifetime). It needs no Spotify provider and no network: the rows go to the
 * matching engine (through the MusicBrainz exact path first, since the export has no lengths or
 * ISRCs), and the plays become listening signals (stage 3.1). The formats, and where they were
 * checked, are in `CLEAN-ROOM.md`.
 *
 * Only the fields FXM uses are read. The export also holds personal data FXM has no use for (the
 * user name, IP addresses, devices, search queries, payments, inferences): those files are never
 * parsed, and those fields are never copied.
 *
 * @module
 */

import { type Album, type Artist, type EntityId, normalizeText, type Track } from '@fxm/core'
import { spotifyEntityIdFromUri } from '../spotify'
import { ImportInputError } from './errors'
import { cleanArtists, cleanText, dedupeCollection, parseTime } from './rows'
import {
  type ImportCollection,
  type ImportPlay,
  type ImportRow,
  type ImportSkips,
  MIN_PLAY_MS,
  noSkips,
  type ParsedImport,
} from './types'

/** One file of the export, already read as text. */
export interface ExportFile {
  /** Its name or path, e.g. `Spotify Account Data/Playlist1.json`. */
  name: string
  /** Its contents. */
  text: string
}

/**
 * What a file of the export holds:
 *
 * - `playlists`: `Playlist1.json`, `Playlist2.json`, …
 * - `library`: `YourLibrary.json` (liked songs, saved albums, followed artists)
 * - `history`: the account data's year of plays, `StreamingHistory_music_0.json` (or the
 *   older `StreamingHistory0.json`)
 * - `extended-history`: the lifetime of plays, `Streaming_History_Audio_2019-2021_0.json` (or
 *   the older `endsong_0.json`)
 * - `other`: anything else, never parsed
 */
export type ExportFileKind = 'playlists' | 'library' | 'history' | 'extended-history' | 'other'

/** The largest export file an import reads, in characters. */
export const MAX_EXPORT_FILE_LENGTH = 128 * 1024 * 1024

/** What a file of the export holds, by its name (see {@link ExportFileKind}). */
export function exportFileKind(name: string): ExportFileKind {
  const base = name.replace(/^.*[\\/]/u, '').replace(/ \(\d+\)(?=\.json$)/iu, '')
  if (/^Playlist\d*\.json$/iu.test(base)) return 'playlists'
  if (/^YourLibrary\.json$/iu.test(base)) return 'library'
  if (/^StreamingHistory(?:_music)?_?\d+\.json$/iu.test(base)) return 'history'
  if (/^(?:Streaming_History_Audio_[\w-]*|endsong_\d+)\.json$/iu.test(base)) {
    return 'extended-history'
  }
  return 'other'
}

/** Whether the export file `name` is one an import reads. */
export function isWantedExportFile(name: string): boolean {
  return exportFileKind(name) !== 'other'
}

/** A JSON object. */
type Fields = Readonly<Record<string, unknown>>

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The export's track for a Spotify track URI, shared by every row and play that names it. */
class TrackBook {
  readonly #tracks = new Map<string, Track>()

  track(id: EntityId<'track'>, title: string, artists: readonly string[], album?: string): Track {
    const known = this.#tracks.get(id)
    if (known) return known
    const track: Track = {
      id,
      source: 'spotify',
      title,
      artists: artists.map((name) => ({ name })),
      artwork: [],
      kind: 'song',
      externalIds: { spotify: id.slice('spotify:track:'.length) },
    }
    if (album !== undefined) track.album = { name: album }
    this.#tracks.set(id, track)
    return track
  }
}

/** The key that finds a track by artist and title, for plays that name no URI. */
function nameKey(artist: string | undefined, title: string): string {
  return `${normalizeText(artist ?? '')}|${normalizeText(title)}`
}

/** A row from a playlist item or a liked song, or what to count instead. */
function trackRow(
  fields: { title: unknown; artist: unknown; album: unknown; uri: unknown; addedAt?: unknown },
  skipped: ImportSkips,
): ImportRow | undefined {
  const title = cleanText(fields.title)
  if (title === undefined) {
    skipped.unreadable++
    return undefined
  }
  const row: ImportRow = { title, artists: cleanArtists([fields.artist]) }
  const album = cleanText(fields.album)
  if (album !== undefined) row.album = album
  const trackId = spotifyEntityIdFromUri('track', fields.uri)
  if (trackId) row.trackId = trackId
  const addedAt = parseTime(fields.addedAt)
  if (addedAt !== undefined) row.addedAt = addedAt
  return row
}

/** The playlists of one `Playlist*.json` file. */
function readPlaylists(data: unknown, skipped: ImportSkips): ImportCollection[] {
  const playlists = isFields(data) && Array.isArray(data.playlists) ? data.playlists : []
  const collections: ImportCollection[] = []
  for (const playlist of playlists) {
    if (!isFields(playlist)) {
      skipped.unreadable++
      continue
    }
    const rows: ImportRow[] = []
    for (const item of Array.isArray(playlist.items) ? playlist.items : []) {
      if (!isFields(item)) {
        skipped.unreadable++
        continue
      }
      if (isFields(item.track)) {
        const row = trackRow(
          {
            title: item.track.trackName,
            artist: item.track.artistName,
            album: item.track.albumName,
            uri: item.track.trackUri,
            addedAt: item.addedDate,
          },
          skipped,
        )
        if (row) rows.push(row)
      } else if (isFields(item.localTrack)) skipped.localFiles++
      else if (isFields(item.episode) || isFields(item.audiobook)) skipped.episodes++
      else skipped.unreadable++
    }
    const name = cleanText(playlist.name, 100) ?? 'Spotify playlist'
    const description = cleanText(playlist.description, 300)
    collections.push(description === undefined ? { name, rows } : { name, description, rows })
  }
  return collections
}

/** The liked songs, saved albums and followed artists of `YourLibrary.json`. */
function readLibrary(
  data: unknown,
  skipped: ImportSkips,
): { liked: ImportRow[]; follows: (Album | Artist)[] } {
  const liked: ImportRow[] = []
  const follows: (Album | Artist)[] = []
  if (!isFields(data)) return { liked, follows }
  for (const item of Array.isArray(data.tracks) ? data.tracks : []) {
    if (!isFields(item)) {
      skipped.unreadable++
      continue
    }
    const row = trackRow(
      { title: item.track, artist: item.artist, album: item.album, uri: item.uri },
      skipped,
    )
    if (row) liked.push(row)
  }
  for (const item of Array.isArray(data.albums) ? data.albums : []) {
    const id = isFields(item) ? spotifyEntityIdFromUri('album', item.uri) : null
    const name = isFields(item) ? cleanText(item.album) : undefined
    if (!id || name === undefined || !isFields(item)) continue
    follows.push({
      id,
      source: 'spotify',
      name,
      artists: cleanArtists([item.artist]).map((artist) => ({ name: artist })),
      artwork: [],
    })
  }
  for (const item of Array.isArray(data.artists) ? data.artists : []) {
    const id = isFields(item) ? spotifyEntityIdFromUri('artist', item.uri) : null
    const name = isFields(item) ? cleanText(item.name) : undefined
    if (!id || name === undefined) continue
    follows.push({ id, source: 'spotify', name, artwork: [] })
  }
  for (const key of ['shows', 'episodes']) {
    const items = data[key]
    if (Array.isArray(items)) skipped.episodes += items.length
  }
  return { liked, follows }
}

/**
 * `endTime` of the account data's history: when the play ended, in UTC, to the minute
 * (`2023-01-31 18:05`). Epoch milliseconds, or `undefined`.
 */
export function parseEndTime(text: unknown): number | undefined {
  if (typeof text !== 'string') return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/u.exec(text.trim())
  if (!match) return undefined
  const [, year, month, day, hour, minute, second] = match
  const time = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? 0),
  )
  return Number.isFinite(time) ? time : undefined
}

/** A play's length in milliseconds, or `undefined` when it is not a number of 0 or more. */
function playedMsOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined
}

/** The plays of the account data's history, identified through the export's own track names. */
function readHistory(
  data: unknown,
  byName: ReadonlyMap<string, EntityId<'track'>>,
  book: TrackBook,
  skipped: ImportSkips,
  plays: ImportPlay[],
): void {
  for (const entry of Array.isArray(data) ? data : []) {
    if (!isFields(entry)) {
      skipped.unreadable++
      continue
    }
    if ('podcastName' in entry || 'episodeName' in entry) {
      skipped.episodes++
      continue
    }
    const title = cleanText(entry.trackName)
    const artist = cleanText(entry.artistName)
    const endedAt = parseEndTime(entry.endTime)
    const playedMs = playedMsOf(entry.msPlayed)
    if (title === undefined || endedAt === undefined || playedMs === undefined) {
      skipped.unreadable++
      continue
    }
    if (playedMs < MIN_PLAY_MS) {
      skipped.shortPlays++
      continue
    }
    const id = byName.get(nameKey(artist, title))
    if (id === undefined) {
      skipped.unknownPlays++
      continue
    }
    plays.push({
      track: book.track(id, title, artist === undefined ? [] : [artist]),
      playedAt: Math.max(0, endedAt - playedMs),
      playedMs,
      completed: false,
      skipped: false,
    })
  }
}

/** The plays of the extended streaming history, which name each track's URI. */
function readExtendedHistory(
  data: unknown,
  book: TrackBook,
  skipped: ImportSkips,
  plays: ImportPlay[],
): void {
  for (const entry of Array.isArray(data) ? data : []) {
    if (!isFields(entry)) {
      skipped.unreadable++
      continue
    }
    const id = spotifyEntityIdFromUri('track', entry.spotify_track_uri)
    if (!id) {
      if (entry.spotify_episode_uri || entry.episode_name || entry.audiobook_uri) {
        skipped.episodes++
      } else skipped.unreadable++
      continue
    }
    const title = cleanText(entry.master_metadata_track_name)
    const endedAt = parseTime(entry.ts)
    const playedMs = playedMsOf(entry.ms_played)
    if (title === undefined || endedAt === undefined || playedMs === undefined) {
      skipped.unreadable++
      continue
    }
    const wasSkipped = entry.skipped === true || entry.reason_end === 'fwdbtn'
    if (playedMs < MIN_PLAY_MS && !wasSkipped) {
      skipped.shortPlays++
      continue
    }
    const artist = cleanText(entry.master_metadata_album_artist_name)
    const album = cleanText(entry.master_metadata_album_album_name)
    plays.push({
      track: book.track(id, title, artist === undefined ? [] : [artist], album),
      playedAt: Math.max(0, endedAt - playedMs),
      playedMs,
      completed: entry.reason_end === 'trackdone',
      skipped: wasSkipped,
    })
  }
}

/** The JSON of a file, or `undefined` (counted) when it cannot be read. */
function readJson(file: ExportFile, skipped: ImportSkips): unknown {
  if (file.text.length > MAX_EXPORT_FILE_LENGTH) {
    throw new ImportInputError('too-large', `${file.name} is too large to import`)
  }
  try {
    return JSON.parse(file.text.charCodeAt(0) === 0xfeff ? file.text.slice(1) : file.text)
  } catch {
    skipped.unreadable++
    return undefined
  }
}

/** The name the liked songs' playlist gets. */
export const LIKED_SONGS_NAME = 'Liked Songs from Spotify'

/**
 * Reads the files of a Spotify data export into an import: one playlist per Spotify playlist,
 * one for the liked songs ({@link LIKED_SONGS_NAME}), the saved albums and followed artists,
 * and the listening history. When the extended streaming history is among the files, the
 * account data's shorter history is left out, since the extended one holds the same plays to the
 * second; plays of the shorter history are identified by artist and title through the export's
 * own playlists and liked songs, because it names no URIs.
 *
 * @throws ImportInputError `not-spotify-export` when no file is part of a data export, `no-tracks`
 * when the files hold nothing to import, `too-large` for a file over
 * {@link MAX_EXPORT_FILE_LENGTH}.
 */
export function parseSpotifyExport(files: readonly ExportFile[]): ParsedImport {
  const byKind = new Map<ExportFileKind, ExportFile[]>()
  for (const file of files) {
    const kind = exportFileKind(file.name)
    if (kind === 'other') continue
    byKind.set(kind, [...(byKind.get(kind) ?? []), file])
  }
  if (byKind.size === 0) {
    throw new ImportInputError('not-spotify-export', 'None of the files is from a data export')
  }
  const skipped = noSkips()
  const book = new TrackBook()
  const sorted = (kind: ExportFileKind) =>
    [...(byKind.get(kind) ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name, 'en', { numeric: true }),
    )
  const collections: ImportCollection[] = []
  for (const file of sorted('playlists')) {
    collections.push(...readPlaylists(readJson(file, skipped), skipped))
  }
  const follows: (Album | Artist)[] = []
  for (const file of sorted('library')) {
    const library = readLibrary(readJson(file, skipped), skipped)
    if (library.liked.length > 0) collections.push({ name: LIKED_SONGS_NAME, rows: library.liked })
    follows.push(...library.follows)
  }
  // A play of a track the playlists or liked songs name shares that row's metadata, so the
  // library keeps one description of it (with its album) whichever it saves last.
  for (const row of collections.flatMap((collection) => collection.rows)) {
    if (row.trackId !== undefined) book.track(row.trackId, row.title, row.artists, row.album)
  }
  const plays: ImportPlay[] = []
  if (byKind.has('extended-history')) {
    for (const file of sorted('extended-history')) {
      readExtendedHistory(readJson(file, skipped), book, skipped, plays)
    }
  } else if (byKind.has('history')) {
    const byName = new Map<string, EntityId<'track'>>()
    for (const row of collections.flatMap((collection) => collection.rows)) {
      if (row.trackId !== undefined) byName.set(nameKey(row.artists[0], row.title), row.trackId)
    }
    for (const file of sorted('history')) {
      readHistory(readJson(file, skipped), byName, book, skipped, plays)
    }
  }
  plays.sort((a, b) => a.playedAt - b.playedAt)
  const deduped = collections
    .map((collection) => dedupeCollection(collection, skipped))
    .filter((collection) => collection.rows.length > 0)
  if (deduped.length === 0 && plays.length === 0 && follows.length === 0) {
    throw new ImportInputError('no-tracks', 'The data export holds nothing to import')
  }
  return {
    kind: 'spotify-export',
    label: 'Spotify data export',
    collections: deduped,
    plays,
    follows: uniqueFollows(follows),
    skipped,
  }
}

/** Each saved album and followed artist once. */
function uniqueFollows(follows: readonly (Album | Artist)[]): (Album | Artist)[] {
  const seen = new Set<string>()
  return follows.filter((follow) => {
    if (seen.has(follow.id)) return false
    seen.add(follow.id)
    return true
  })
}
