/**
 * Telling recommendations apart: when two listings are one song, which artist a name is, and
 * which seed a candidate came from. The keys are for comparing only, never for display.
 *
 * - A **track** is known by its `entityKey`, so a video's `ytm` and `yt` IDs are one track.
 * - A **song** is also known by its main artist and title proper ({@link songIdentity}), so the
 *   same song from YouTube Music, Spotify and a Last.fm station is one candidate, and a song the
 *   user played on one source counts as played on every other. Versions fold together: "Creep"
 *   and "Creep - Acoustic" are one song here, which suits recommendations, and only them.
 * - An **artist** is known by {@link artistKeyOf}: stage 3.1's `artistAffinityKey` of the name
 *   without YouTube's channel suffixes ("Radiohead - Topic", "RadioheadVEVO"), so a candidate's
 *   artist finds the user's affinity for that artist.
 *
 * @module
 */

import { type EntityId, entityKey, isEntityId } from '../ids'
import { type ArtistRef, isTrackSeed, type Track } from '../model'
import type { RadioSeed } from '../providers'
import { artistAffinityKey } from '../signals/keys'
import { normalizeText, splitTitle, stripPresentationNoise } from '../text'
import type { RecSeed } from './types'

/** The prefix of {@link songIdentity} keys, which no `entityKey` starts with. */
const SONG_PREFIX = 'song:'

/** Folds every run of whitespace into one space and trims. */
function foldSpaces(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** A name without the channel suffixes YouTube adds: " - Topic" and "VEVO". */
function withoutChannelSuffix(name: string): string {
  const folded = foldSpaces(name)
  const cleaned = folded
    .replace(/\s+-\s+topic$/iu, '')
    .replace(/(?<=\S)\s*vevo$/iu, '')
    .trim()
  return cleaned === '' ? folded : cleaned
}

/**
 * The key of an artist: `artistAffinityKey` (stage 3.1) of the name without YouTube's channel
 * suffixes, so it finds the user's affinity for the artist. `undefined` for anything that is not
 * a name, and for placeholders such as "Various Artists".
 */
export function artistKeyOf(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined
  return artistAffinityKey(withoutChannelSuffix(name))
}

/** The {@link artistKeyOf} keys of `names`, each once, in order. */
export function artistKeysOf(names: readonly unknown[]): string[] {
  const keys: string[] = []
  for (const name of names) {
    const key = artistKeyOf(name)
    if (key !== undefined && !keys.includes(key)) keys.push(key)
  }
  return keys
}

/** `text` with punctuation and symbols as spaces: "AC/DC" and "AC DC" compare equal. */
function looseText(text: string): string {
  return normalizeText(text)
    .replace(/&/gu, ' and ')
    .replace(/['.]/gu, '')
    .replace(/[\p{P}\p{S}\s]+/gu, ' ')
    .trim()
}

/**
 * The key two listings of one song share, whatever their source: `song:` with the main artist
 * and the title proper, both normalized and with punctuation folded. Presentation noise ("(Official
 * Video)"), a leading "Artist - " that names a credited artist, qualifiers (versions) and featured
 * artists are left out. `undefined` when the title or every artist is missing.
 */
export function songIdentity(title: unknown, artists: readonly unknown[]): string | undefined {
  if (typeof title !== 'string' || !Array.isArray(artists)) return undefined
  const credited = artistKeysOf(artists)
  const main = credited[0]
  if (main === undefined) return undefined
  let clean = stripPresentationNoise(foldSpaces(title))
  const prefixed = /^(.+?)\s+[-–—]\s+(.+)$/u.exec(clean)
  if (prefixed !== null) {
    const named = artistKeyOf(prefixed[1])
    if (named !== undefined && credited.includes(named)) clean = prefixed[2] ?? clean
  }
  const core = looseText(splitTitle(clean).core)
  const artist = looseText(main)
  if (core === '' || artist === '') return undefined
  return `${SONG_PREFIX}${artist}|${core}`
}

/** Whether a key is a {@link songIdentity} rather than an `entityKey`. */
export function isSongIdentity(key: string): boolean {
  return key.startsWith(SONG_PREFIX)
}

/**
 * Every key a track is known by: its `entityKey` and, when it has a title and an artist, its
 * {@link songIdentity}. Empty for a track without a valid ID.
 */
export function trackKeys(track: Pick<Track, 'id' | 'title' | 'artists'>): string[] {
  if (!isEntityId(track?.id, 'track')) return []
  const keys = [entityKey(track.id)]
  const artists = Array.isArray(track.artists) ? track.artists.map((artist) => artist?.name) : []
  const song = songIdentity(track.title, artists)
  if (song !== undefined) keys.push(song)
  return keys
}

/** How candidates record a radio seed: the shape of `@fxm/sources/recommend`'s `seedRef`. */
export function recSeedOf(seed: RadioSeed): RecSeed {
  if (!isTrackSeed(seed)) {
    return seed.id === undefined
      ? { type: 'artist', name: seed.name }
      : { type: 'artist', id: seed.id, name: seed.name }
  }
  return {
    type: 'track',
    id: seed.id,
    name: seed.title,
    artists: seed.artists.map((artist) => artist.name),
  }
}

/**
 * The key of a seed: one track (by `entityKey`, else by its song identity) or one artist (by
 * name). Candidates collected for a seed carry it in their `seed`, so this tells which planned
 * seed a candidate answers. `undefined` for a seed without a usable name or ID. For a radio seed
 * (a track or an artist reference), pass `recSeedOf(seed)`.
 */
export function seedKey(seed: RecSeed): string | undefined {
  if (seed?.type === 'track') {
    if (isEntityId(seed.id, 'track')) return `track:${entityKey(seed.id)}`
    const song = songIdentity(seed.name, seed.artists ?? [])
    return song === undefined ? undefined : `track:${song}`
  }
  if (seed?.type !== 'artist') return undefined
  const artist = artistKeyOf(seed.name)
  return artist === undefined ? undefined : `artist:${artist}`
}

/** The keys a seed's own song is known by, so a radio never recommends its seed. */
export function seedSongKeys(seed: RecSeed): string[] {
  if (seed.type !== 'track') return []
  const keys: string[] = []
  if (isEntityId(seed.id, 'track')) keys.push(entityKey(seed.id))
  const song = songIdentity(seed.name, seed.artists ?? [])
  if (song !== undefined) keys.push(song)
  return keys
}

/** The key of a seed's main artist: the artist itself, or a track's first credited artist. */
export function seedArtistKey(seed: RecSeed): string | undefined {
  if (seed.type === 'artist') return artistKeyOf(seed.name)
  return artistKeysOf(seed.artists ?? [])[0]
}

/** An artist reference for a name and, when it is an artist ID, an ID. */
export function artistRef(name: string, id?: EntityId): ArtistRef {
  return isEntityId(id, 'artist') ? { id, name } : { name }
}
