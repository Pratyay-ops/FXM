/**
 * Test helpers for the Spotify provider: FXM's own recorded fixtures, a FAKE TOTP secret, a fake
 * clock, and a fake Spotify behind an injected `fetch` that records every request and refuses
 * any URL it does not know, so no test can reach the network.
 *
 * The JSON fixtures are real answers recorded anonymously from Spotify on 2026-10-25 and then
 * trimmed and sanitized: lists cut to a few items; share IDs, request and decision IDs, traces,
 * colours, rights lines and the biography text removed or replaced; the owners of user-made
 * playlists and their descriptions replaced with placeholders. Catalog facts (IDs, titles,
 * artists, durations, dates) are kept. No token, cookie or secret was ever recorded.
 *
 * @module
 */

import type { NetworkCapabilities, ProviderContext } from '@fxm/core'
import artistOverview from './artist-overview.json'
import artistRelated from './artist-related.json'
import error401 from './error-401.json'
import error403Client from './error-403-client.json'
import errorGraphql from './error-graphql.json'
import errorNotFound from './error-not-found.json'
import getAlbum from './get-album.json'
import getTrack from './get-track.json'
import home from './home.json'
import homeSection from './home-section.json'
import metadataTrack from './metadata-track.json'
import playlistRadio from './playlist-radio.json'
import searchAlbums from './search-albums.json'
import searchArtists from './search-artists.json'
import searchDesktop from './search-desktop.json'
import searchPlaylists from './search-playlists.json'
import searchTracks from './search-tracks.json'
import seedToPlaylistArtist from './seed-to-playlist-artist.json'
import seedToPlaylistTrack from './seed-to-playlist-track.json'

/** The recorded answers, by what they answer. */
export const fixtures = {
  /** `searchDesktop` for "radiohead creep", limit 5, cut to 2 items per type. */
  searchDesktop,
  /** `searchTracks` for "radiohead creep", limit 3, cut to 2 items. */
  searchTracks,
  /** `searchAlbums` for "radiohead", limit 3, cut to 2 items. */
  searchAlbums,
  /** `searchArtists` for "radiohead", limit 3, cut to 2 items. */
  searchArtists,
  /** `searchPlaylists` for "radiohead", limit 3, cut to 2 items. */
  searchPlaylists,
  /** `getTrack` for Creep (70LcF31zb1H0PyJoS1Sx1r). */
  getTrack,
  /** `getAlbum` for Pablo Honey: the first 3 of its 12 tracks. */
  getAlbum,
  /** `queryArtistOverview` for Radiohead, cut down. */
  artistOverview,
  /** `queryArtistRelated` for Radiohead: 3 of its 40 related artists. */
  artistRelated,
  /** `fetchPlaylist` for "Creep Radio" (offset 0, limit 50): 3 of its 50 tracks. */
  playlistRadio,
  /** spclient `seed_to_playlist` for the track Creep. */
  seedToPlaylistTrack,
  /** spclient `seed_to_playlist` for the artist Radiohead. */
  seedToPlaylistArtist,
  /** spclient `metadata/4/track` for Creep: ISRC, label, date, popularity. */
  metadataTrack,
  /** The anonymous `home` feed (market IN): 4 sections of 2 items. */
  home,
  /** `homeSection` for "Popular artists": 3 items, more to follow. */
  homeSection,
  /** `getTrack` for an ID that does not exist. */
  errorNotFound,
  /** A GraphQL validation error (a required variable left out), sent with HTTP 400. */
  errorGraphql,
  /** pathfinder's 401 body for a bad token. */
  error401,
  /** pathfinder's 403 body for a non-browser User-Agent (curl). */
  error403Client,
}

/** The track Creep, as FXM IDs it. */
export const CREEP_ID: string = 'spotify:track:70LcF31zb1H0PyJoS1Sx1r'
/** The album Pablo Honey. */
export const PABLO_HONEY_ID: string = 'spotify:album:3gBVdu4a1MMJVMy6vwPEb8'
/** The artist Radiohead. */
export const RADIOHEAD_ID: string = 'spotify:artist:4Z8W4fKeB5YxbusRsdQVPb'

/**
 * A FAKE TOTP secret in the community JSON's map shape: version 7, the character codes of
 * "FXM fake secret". It has nothing to do with Spotify's real secret, which FXM never commits.
 */
export const FAKE_SECRET = {
  version: 7,
  secret: [70, 88, 77, 32, 102, 97, 107, 101, 32, 115, 101, 99, 114, 101, 116],
}

/** {@link FAKE_SECRET} as the JSON a secret source serves. */
export const FAKE_SECRET_JSON = { [String(FAKE_SECRET.version)]: FAKE_SECRET.secret }

/** Where the tests' secret source lives. */
export const SECRET_URL = 'https://secrets.example.test/secret.json'

/** A clock the tests move by hand. */
export interface FakeClock {
  /** The current time, as epoch milliseconds. */
  now: () => number
  /** Moves the clock forward. */
  advance: (ms: number) => void
}

/** A fake clock starting at 2026-10-25T12:00:00Z. */
export function fakeClock(start = Date.UTC(2026, 9, 25, 12)): FakeClock {
  let time = start
  return {
    now: () => time,
    advance: (ms) => {
      time += ms
    },
  }
}

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

/** Capabilities with the given Spotify access, and full YouTube. */
export function capabilities(spotify: NetworkCapabilities['spotify']): NetworkCapabilities {
  return { youtube: 'full', mediaBytes: true, spotify, fileSystem: false }
}

/** A provider context around `fetch`: the web app with FXM Connect, Music mode. */
export function contextFor(
  fetchImpl: typeof fetch,
  overrides: Partial<ProviderContext> = {},
): ProviderContext {
  return {
    fetch: fetchImpl,
    platform: 'web',
    capabilities: capabilities('anonymous'),
    mode: 'music',
    ...overrides,
  }
}

/** What the fake Spotify was asked. */
export type CallKind = 'secret' | 'server-time' | 'token' | 'graphql' | 'spclient'

/** One request the fake Spotify received. */
export interface Call {
  /** Which service it went to. */
  kind: CallKind
  /** The URL. */
  url: URL
  /** The method. */
  method: string
  /** The request headers. */
  headers: Headers
  /** For GraphQL: the operation name. */
  operationName?: string
  /** For GraphQL: the variables. */
  variables?: Record<string, unknown>
  /** For GraphQL: the persisted-query hash. */
  sha256Hash?: string
  /** The bearer token sent, if any. */
  token?: string
  /** The request options. */
  init: RequestInit | undefined
}

type Handler<A extends unknown[]> = (...args: A) => Response | Promise<Response>

/** How the fake Spotify answers; each default serves the fixtures. */
export interface FakeSpotifyOptions {
  /** The clock tokens expire by. Default: a new fake clock. */
  clock?: FakeClock
  /** The secret source. Default: {@link FAKE_SECRET_JSON}. */
  secret?: Handler<[Call]>
  /** `/api/server-time`. Default: the clock's time. */
  serverTime?: Handler<[Call]>
  /** `/api/token`. Default: a new anonymous token per request, valid for an hour. */
  token?: Handler<[URLSearchParams, Call]>
  /** GraphQL, by operation name. Default: the fixture for the operation. */
  graphql?: Partial<Record<string, Handler<[Record<string, unknown>, Call]>>>
  /** spclient, by path. Default: the radio and metadata fixtures. */
  spclient?: Handler<[string, Call]>
}

const GRAPHQL_FIXTURES: Record<string, unknown> = {
  searchDesktop,
  searchTracks,
  searchAlbums,
  searchArtists,
  searchPlaylists,
  getTrack,
  getAlbum,
  queryArtistOverview: artistOverview,
  queryArtistRelated: artistRelated,
  fetchPlaylist: playlistRadio,
  home,
  homeSection,
}

/** The fixture answer to a spclient path. */
export function spclientFixture(path: string): Response {
  if (path.startsWith('/inspiredby-mix/v2/seed_to_playlist/spotify:track:')) {
    return json(seedToPlaylistTrack)
  }
  if (path.startsWith('/inspiredby-mix/v2/seed_to_playlist/spotify:artist:')) {
    return json(seedToPlaylistArtist)
  }
  if (path.startsWith('/metadata/4/track/')) return json(metadataTrack)
  return json({ error: { status: 404, message: 'not found' } }, { status: 404 })
}

/**
 * A fake Spotify behind an injected `fetch`. Like a real `fetch`, it rejects with the signal's
 * reason when the request is cancelled. Unknown URLs throw, so a test can never reach the network.
 */
export function fakeSpotify(options: FakeSpotifyOptions = {}): {
  fetch: typeof fetch
  calls: Call[]
  clock: FakeClock
  callsOf: (kind: CallKind, operationName?: string) => Call[]
} {
  const clock = options.clock ?? fakeClock()
  const calls: Call[] = []
  let issued = 0
  const route = async (call: Call): Promise<Response> => {
    const { url } = call
    if (call.kind === 'secret') {
      return options.secret ? options.secret(call) : json(FAKE_SECRET_JSON)
    }
    if (call.kind === 'server-time') {
      return options.serverTime
        ? options.serverTime(call)
        : json({ serverTime: Math.floor(clock.now() / 1000) })
    }
    if (call.kind === 'token') {
      if (options.token) return options.token(url.searchParams, call)
      issued += 1
      return json({
        clientId: 'fixture-client-id',
        accessToken: `fixture-token-${issued}`,
        accessTokenExpirationTimestampMs: clock.now() + 3_600_000,
        isAnonymous: true,
        _notes: 'Usage of this endpoint is not permitted under the Spotify Developer Terms',
      })
    }
    if (call.kind === 'graphql') {
      const name = call.operationName ?? ''
      const handler = options.graphql?.[name]
      if (handler) return handler(call.variables ?? {}, call)
      const fixture = GRAPHQL_FIXTURES[name]
      if (fixture === undefined) throw new Error(`The fake Spotify has no answer for ${name}`)
      return json(fixture)
    }
    const path = url.pathname + url.search
    return options.spclient ? options.spclient(path, call) : spclientFixture(path)
  }
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    const kind = kindOf(url)
    const authorization = headers.get('authorization')
    const call: Call = {
      kind,
      url,
      method: init?.method ?? 'GET',
      headers,
      init,
      ...(authorization ? { token: authorization.replace(/^Bearer /u, '') } : {}),
    }
    if (kind === 'graphql' && typeof init?.body === 'string') {
      const body = JSON.parse(init.body) as {
        operationName?: string
        variables?: Record<string, unknown>
        extensions?: { persistedQuery?: { sha256Hash?: string } }
      }
      if (body.operationName !== undefined) call.operationName = body.operationName
      if (body.variables !== undefined) call.variables = body.variables
      const hash = body.extensions?.persistedQuery?.sha256Hash
      if (hash !== undefined) call.sha256Hash = hash
    }
    calls.push(call)
    const signal = init?.signal
    if (signal?.aborted) throw signal.reason
    return route(call)
  }
  return {
    fetch: fetchImpl,
    calls,
    clock,
    callsOf: (kind, operationName) =>
      calls.filter(
        (c) =>
          c.kind === kind && (operationName === undefined || c.operationName === operationName),
      ),
  }
}

function kindOf(url: URL): CallKind {
  if (url.href === SECRET_URL) return 'secret'
  if (url.host === 'open.spotify.com' && url.pathname === '/api/server-time') return 'server-time'
  if (url.host === 'open.spotify.com' && url.pathname === '/api/token') return 'token'
  if (url.host === 'api-partner.spotify.com' && url.pathname === '/pathfinder/v2/query') {
    return 'graphql'
  }
  if (url.host === 'spclient.wg.spotify.com') return 'spclient'
  throw new Error(`The fake Spotify refuses an unexpected request to ${url.origin}${url.pathname}`)
}

/** A fetch that never answers on its own and rejects when its signal aborts. */
export const hangingFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
