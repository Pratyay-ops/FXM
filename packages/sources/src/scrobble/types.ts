/**
 * The vocabulary of scrobbling: the services, what a scrobble says about a track and a listen,
 * and the play it comes from.
 *
 * @module
 */

import type { PlaySignal, ProviderContext, Track } from '@fxm/core'

/** Every {@link ScrobbleServiceId}, in the order the app lists them. */
export const SCROBBLE_SERVICES = ['listenbrainz', 'lastfm'] as const

/** A service FXM scrobbles to: ListenBrainz or Last.fm. */
export type ScrobbleServiceId = (typeof SCROBBLE_SERVICES)[number]

/** The service's name as people read it. */
export const SCROBBLE_SERVICE_NAMES: Readonly<Record<ScrobbleServiceId, string>> = Object.freeze({
  listenbrainz: 'ListenBrainz',
  lastfm: 'Last.fm',
})

/**
 * What the scrobble clients take from a {@link ProviderContext}: only the injected `fetch` and
 * an optional cancel signal, so a full `ProviderContext` works as it is.
 */
export type ScrobbleContext = Pick<ProviderContext, 'fetch' | 'signal'>

/** A track as scrobbles describe it: plain names, cleaned from a core `Track`. */
export interface ScrobbleTrack {
  /** The credited artists, main artist first; never empty. */
  artists: string[]
  /** The title. */
  title: string
  /** The album it was played from, when known. */
  album?: string
  /** Its length in milliseconds, when known. */
  durationMs?: number
  /** Its position on its disc, when known. */
  trackNumber?: number
  /** Its ISRC (canonical: 12 characters), when known. */
  isrc?: string
  /** Spotify's ID of the recording, when known. */
  spotifyId?: string
}

/** One listen to send: the track, when it started and how long it was heard. */
export interface Scrobble {
  /** The track. */
  track: ScrobbleTrack
  /** When it started playing, as epoch milliseconds. */
  startedAt: number
  /** How long it was heard, in milliseconds, when known. */
  playedMs?: number
  /**
   * `false` when someone else chose the track, as FXM's radio does. Left out otherwise: Last.fm
   * then assumes the user chose it, and asks clients to leave it out when in doubt.
   */
  chosenByUser?: boolean
}

/**
 * A play that ended, as the listening signals record it (stage 3.1): a `PlaySignal`'s start,
 * time heard, length and context, with the whole track, whose album and ISRC a scrobble sends
 * too.
 */
export interface ScrobblePlay
  extends Pick<PlaySignal, 'at' | 'playedMs' | 'durationMs' | 'context'> {
  /** The track that played. */
  track: Track
}
