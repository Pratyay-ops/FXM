/**
 * Test helpers for scrobbling: the fixtures, a fake service behind an injected `fetch`, tracks
 * and plays.
 *
 * Files without `synthetic` in their name are real answers recorded on 2026-10-26 with made-up
 * credentials, which is all FXM has: every error a service sent for them. The `.synthetic`
 * files are not recordings: they follow the samples in the services' documentation (Last.fm's
 * XML samples in the JSON form its API answers with), because recording them needs a real
 * account. See CLEAN-ROOM.md.
 *
 * @module
 */

import { formatId, type Track } from '@fxm/core'
import type { Scrobble, ScrobbleContext, ScrobblePlay } from '../types'
import lastfmInvalidApiKey from './lastfm-error-invalid-api-key.json'
import lastfmNowPlaying from './lastfm-now-playing.synthetic.json'
import lastfmScrobbleOne from './lastfm-scrobble-one.synthetic.json'
import lastfmScrobbleTwoOneIgnored from './lastfm-scrobble-two-one-ignored.synthetic.json'
import lastfmSession from './lastfm-session.synthetic.json'
import lastfmToken from './lastfm-token.synthetic.json'
import listenbrainzInvalidToken from './listenbrainz-submit-invalid-token.json'
import listenbrainzValidateInvalid from './listenbrainz-validate-invalid.json'
import listenbrainzValidateNoToken from './listenbrainz-validate-no-token.json'
import listenbrainzValidateValid from './listenbrainz-validate-valid.synthetic.json'

/** The fixtures. */
export const fixtures = {
  /** Last.fm's answer to a made-up API key: HTTP 403, error 10 (recorded). */
  lastfmInvalidApiKey,
  /** `auth.getToken`, from the documented sample. */
  lastfmToken,
  /** `auth.getSession`, from the documented sample. */
  lastfmSession,
  /** `track.updateNowPlaying`, from the documented sample. */
  lastfmNowPlaying,
  /** `track.scrobble` with one scrobble, from the documented sample. */
  lastfmScrobbleOne,
  /** `track.scrobble` with two scrobbles, one of them ignored (code 1), after the samples. */
  lastfmScrobbleTwoOneIgnored,
  /** `validate-token` for a made-up token: HTTP 200, `valid: false` (recorded). */
  listenbrainzValidateInvalid,
  /** `validate-token` without a token: HTTP 400 (recorded). */
  listenbrainzValidateNoToken,
  /** `validate-token` for a valid token, from the documented sample. */
  listenbrainzValidateValid,
  /** `submit-listens` with a made-up token: HTTP 401 (recorded). */
  listenbrainzInvalidToken,
}

/** A made-up Last.fm API key and shared secret: 32 hexadecimal digits each. */
export const LASTFM_TEST_CREDENTIALS = Object.freeze({
  apiKey: '0123456789abcdef0123456789abcdef',
  secret: 'fedcba9876543210fedcba9876543210',
})

/** A made-up Last.fm session key. */
export const LASTFM_TEST_SESSION_KEY = 'd580d57f32848f5dcf574d1ce18d78b2'

/** A made-up ListenBrainz user token. */
export const LISTENBRAINZ_TEST_TOKEN = '00000000-0000-4000-8000-000000000000'

/** A JSON response. */
export function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

/** A response that isn't JSON, e.g. a proxy's error page. */
export function html(status: number, headers: Record<string, string> = {}): Response {
  return new Response('<html><body>Bad Gateway</body></html>', {
    status,
    headers: { 'content-type': 'text/html', ...headers },
  })
}

/** One request the fake service received. */
export interface Call {
  /** The URL. */
  url: URL
  /** The method. */
  method: string
  /** The request headers. */
  headers: Headers
  /** The body as text. */
  body: string
  /** The request options as given. */
  init: RequestInit | undefined
  /** When it arrived, by `Date.now()`. */
  at: number
}

/**
 * A fake service that answers each request with `route(call)` and records it. Like a real
 * `fetch`, it rejects with the signal's reason when the request is cancelled.
 */
export function fakeService(route: (call: Call) => Response | Promise<Response>): {
  fetch: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fakeFetch: typeof fetch = async (input, init) => {
    init?.signal?.throwIfAborted()
    const url = new URL(input instanceof Request ? input.url : String(input))
    const body = init?.body
    const text =
      body === undefined || body === null
        ? ''
        : body instanceof URLSearchParams
          ? body.toString()
          : String(body)
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: text,
      init,
      at: Date.now(),
    }
    calls.push(call)
    return route(call)
  }
  return { fetch: fakeFetch, calls }
}

/** The form parameters of a Last.fm call. */
export function formOf(call: Call): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(call.body))
}

/** A `fetch` that never answers, and rejects like a real one when its signal aborts. */
export const hangingFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal
    if (signal?.aborted) reject(signal.reason)
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })

/** A scrobble context around `fetch`. */
export function contextFor(fetch: typeof globalThis.fetch, signal?: AbortSignal): ScrobbleContext {
  return { fetch, ...(signal === undefined ? {} : { signal }) }
}

/** Radiohead's "Creep" from YouTube Music, with `overrides`. */
export function creep(overrides: Partial<Track> = {}): Track {
  return {
    id: formatId('ytm', 'track', 'XFkzRNyygfk'),
    source: 'ytm',
    title: 'Creep',
    artists: [{ name: 'Radiohead' }],
    album: { name: 'Pablo Honey' },
    durationMs: 239_000,
    artwork: [],
    kind: 'song',
    trackNumber: 2,
    isrc: 'GBAYE9200070',
    ...overrides,
  }
}

/** 2026-10-26 09:00 UTC, when the test plays start. */
export const T0 = Date.UTC(2026, 9, 26, 9)

/** A play of `track` from {@link T0} that heard `playedMs`. */
export function playOf(
  track: Track,
  playedMs: number,
  overrides: Partial<ScrobblePlay> = {},
): ScrobblePlay {
  return { track, at: T0, playedMs, ...overrides }
}

/** The scrobble of {@link creep} heard for 3 minutes from `startedAt`. */
export function creepScrobble(startedAt = T0): Scrobble {
  return {
    track: {
      artists: ['Radiohead'],
      title: 'Creep',
      album: 'Pablo Honey',
      durationMs: 239_000,
      trackNumber: 2,
      isrc: 'GBAYE9200070',
    },
    startedAt,
    playedMs: 180_000,
  }
}
