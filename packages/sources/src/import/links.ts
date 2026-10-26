/**
 * The links and references an import understands: Spotify playlist, album and track links and
 * URIs (read with the Spotify provider's own parser), and YouTube and YouTube Music playlist and
 * video links, as the sites show them in the address bar and their share dialogs. See
 * `CLEAN-ROOM.md` for the forms and where they were checked.
 *
 * @module
 */

import { type EntityId, formatId } from '@fxm/core'
import { spotifyEntityIdFromLink } from '../spotify'

/** A link to something an import can read. */
export type ImportLink =
  | { source: 'spotify'; id: EntityId<'playlist'> | EntityId<'album'> | EntityId<'track'> }
  | { source: 'youtube'; id: EntityId<'playlist'> }

/** YouTube's hosts, and which FXM source each one's items belong to. */
const YOUTUBE_HOSTS: Readonly<Record<string, 'ytm' | 'yt'>> = {
  'music.youtube.com': 'ytm',
  'www.youtube.com': 'yt',
  'youtube.com': 'yt',
  'm.youtube.com': 'yt',
  'youtu.be': 'yt',
  'www.youtube-nocookie.com': 'yt',
}

/** A YouTube videoId: 11 characters of the URL-safe base64 alphabet. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u

/** A YouTube playlist ID: letters, digits, `_` and `-`. */
const PLAYLIST_ID = /^[A-Za-z0-9_-]{2,64}$/u

/**
 * Lists that are not playlists anyone can read: liked videos (`LL`), Watch later (`WL`), liked
 * music (`LM`), and mixes (`RD…`), which YouTube builds per session. YouTube Music's own curated
 * playlists start with `RDCLAK`, and they are ordinary playlists.
 */
function isReadablePlaylistId(id: string): boolean {
  if (id === 'LL' || id === 'WL' || id === 'LM') return false
  return !id.startsWith('RD') || id.startsWith('RDCLAK')
}

/** `text` as a URL, also without its scheme ("youtu.be/…"). `null` when it is none. */
function toUrl(text: string): URL | null {
  const trimmed = text.trim()
  if (trimmed === '' || /\s/u.test(trimmed)) return null
  for (const candidate of [trimmed, `https://${trimmed}`]) {
    try {
      const url = new URL(candidate)
      if (url.protocol === 'https:' || url.protocol === 'http:') return url
    } catch {
      // Not a URL in this form; try the next.
    }
  }
  return null
}

/** The YouTube source of a URL's host, or `null` when it is not YouTube. */
function youtubeSourceOf(url: URL): 'ytm' | 'yt' | null {
  const host = url.hostname.toLowerCase()
  return Object.hasOwn(YOUTUBE_HOSTS, host) ? (YOUTUBE_HOSTS[host] ?? null) : null
}

/**
 * The FXM ID of a YouTube or YouTube Music playlist link, e.g.
 * `https://music.youtube.com/playlist?list=OLAK5uy_…` → `ytm:playlist:OLAK5uy_…`, or a video
 * link that plays inside a playlist (`watch?v=…&list=…`). Links from music.youtube.com get the
 * `ytm` source, the others `yt`. `null` for anything else, and for lists nobody else can read
 * (liked videos, Watch later, mixes).
 */
export function youtubePlaylistId(text: string): EntityId<'playlist'> | null {
  const url = toUrl(text)
  const source = url && youtubeSourceOf(url)
  if (!url || !source) return null
  let id = url.searchParams.get('list') ?? ''
  if (id === '' && url.pathname.startsWith('/browse/VL')) id = url.pathname.slice('/browse/'.length)
  if (id.startsWith('VL')) id = id.slice(2)
  return PLAYLIST_ID.test(id) && isReadablePlaylistId(id) ? formatId(source, 'playlist', id) : null
}

/**
 * The FXM ID of a YouTube or YouTube Music video link: `watch?v=…`, `youtu.be/…`, `/shorts/…`,
 * `/embed/…` or `/live/…`. Links from music.youtube.com get the `ytm` source, the others `yt`.
 * `null` for anything else.
 */
export function youtubeTrackId(text: string): EntityId<'track'> | null {
  const url = toUrl(text)
  const source = url && youtubeSourceOf(url)
  if (!url || !source) return null
  const segments = url.pathname.split('/').filter(Boolean)
  let id: string | undefined
  if (url.hostname.toLowerCase() === 'youtu.be') id = segments[0]
  else if (segments[0] === 'watch') id = url.searchParams.get('v') ?? undefined
  else if (['shorts', 'embed', 'live', 'v'].includes(segments[0] ?? '')) id = segments[1]
  return id !== undefined && VIDEO_ID.test(id) ? formatId(source, 'track', id) : null
}

/** A Spotify link pasted without its scheme ("open.spotify.com/…"), with it. */
function withSpotifyScheme(text: string): string {
  const trimmed = text.trim()
  return /^(?:open|play)\.spotify\.com\//iu.test(trimmed) ? `https://${trimmed}` : trimmed
}

/**
 * A track a reference names in a catalog FXM knows: a Spotify track link or URI
 * (`spotify:track:…`), or a YouTube or YouTube Music video link. `null` for anything else, such
 * as a file path.
 */
export function catalogTrackId(text: string): EntityId<'track'> | null {
  return spotifyEntityIdFromLink(withSpotifyScheme(text), 'track') ?? youtubeTrackId(text)
}

/**
 * What a pasted link imports: a Spotify playlist, album or track (link or URI), or a YouTube or
 * YouTube Music playlist. `null` for anything else, such as a Spotify artist, a YouTube video
 * without a playlist, or a list nobody else can read.
 */
export function parseImportLink(text: string): ImportLink | null {
  const spotify = spotifyEntityIdFromLink(withSpotifyScheme(text))
  if (spotify !== null) {
    if (spotify.startsWith('spotify:playlist:')) {
      return { source: 'spotify', id: spotify as EntityId<'playlist'> }
    }
    if (spotify.startsWith('spotify:album:')) {
      return { source: 'spotify', id: spotify as EntityId<'album'> }
    }
    if (spotify.startsWith('spotify:track:')) {
      return { source: 'spotify', id: spotify as EntityId<'track'> }
    }
    return null
  }
  const playlist = youtubePlaylistId(text)
  return playlist === null ? null : { source: 'youtube', id: playlist }
}
