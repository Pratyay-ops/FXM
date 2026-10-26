/**
 * The Spotify account's browser-test network: one local HTTPS server that stands in for every
 * host the test touches. Chromium's `--host-resolver-rules` sends the real host names here (and
 * every other host nowhere), so FXM Connect's rules, which match real host names and FXM's real
 * origin, apply exactly as they do online, and nothing reaches the internet.
 *
 * - **FXM's site** (`fxmusic.pages.dev`): `dist/pages/` as `make dist` composes it, served by
 *   the deploy package's own stand-in for Cloudflare Pages (its `_headers` rules, redirects and
 *   404 pages), so the app runs under its production policy, and the Spotify secret goes
 *   through the sandboxed `/sandbox/userhost.html`, as it does online.
 * - **The secret source** (`raw.githubusercontent.com`): a FAKE TOTP secret, with
 *   `Access-Control-Allow-Origin: *`, as GitHub serves the community's.
 * - **Spotify** (`open.spotify.com`, `api-partner.spotify.com`): answers as measured and as the
 *   web player's own readers expect (packages/sources/src/spotify/README.md, the clean-room
 *   log). The token and server-time endpoints send no CORS headers (FXM Connect adds them);
 *   the token endpoint hands out an account token only to a request that carries the session
 *   cookie, which only FXM Connect's bridge can send. Pathfinder answers the logged-in
 *   operations only with that token. Everything it serves is made up: no real account, track
 *   or token.
 *
 * The port is strict (`FXM_SPOTIFY_E2E_PORT`, default 6600): a busy port fails the run.
 *
 * @module
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPagesServer } from '../../../../scripts/build-dist/src/pages-server.ts'

export const PORT = Number(process.env.FXM_SPOTIFY_E2E_PORT ?? 6600)
export const FXM_HOST = 'fxmusic.pages.dev'
export const FXM = `https://${FXM_HOST}`
export const SPOTIFY_HOST = 'open.spotify.com'
export const PATHFINDER_HOST = 'api-partner.spotify.com'
export const SPCLIENT_HOST = 'spclient.wg.spotify.com'
export const SECRET_HOSTS = ['raw.githubusercontent.com', 'gist.githubusercontent.com']
export const HOSTS = [FXM_HOST, SPOTIFY_HOST, PATHFINDER_HOST, SPCLIENT_HOST, ...SECRET_HOSTS]

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
/** What `make dist` composed. */
export const PAGES_DIR = process.env.FXM_PAGES_DIR ?? join(REPO, 'dist', 'pages')

/** The session cookie of the made-up Spotify login. Never a real one. */
export const SESSION = { name: 'sp_dc', value: 'e2e-made-up-session' }
/** The made-up account token's prefix: any request or storage holding it leaked a token. */
export const ACCOUNT_TOKEN_PREFIX = 'e2e-account-token-'
export const ANONYMOUS_TOKEN = 'e2e-anonymous-token'

/** A FAKE TOTP secret (version 7, "FXM fake secret"): it has nothing to do with Spotify's. */
const FAKE_SECRET = { '7': [70, 88, 77, 32, 102, 97, 107, 101, 32, 115, 101, 99, 114, 101, 116] }

/** One request the network answered. */
export interface Logged {
  /** When the request arrived, as epoch milliseconds. */
  at: number
  host: string
  method: string
  path: string
  cookie?: string
  origin?: string
  authorization?: string
  operation?: string
  status: number
}

/**
 * A made-up Spotify base62 ID: `0`, a letter and 20 digits. The leading `0` keeps it within the
 * 128 bits a real one has, which the provider checks.
 */
export function nativeId(prefix: string, n: number): string {
  return `0${prefix}${String(n).padStart(20, '0')}`
}

/** A made-up playlist of the account. */
export interface MockPlaylist {
  id: string
  name: string
  description?: string
  tracks: number[]
  /** Changes whenever the test changes the playlist. */
  revision: number
}

/** The made-up account, which the tests change between syncs. */
export interface MockAccount {
  username: string
  displayName: string
  /** Liked songs by number, newest first. */
  liked: number[]
  playlists: MockPlaylist[]
}

export function defaultAccount(): MockAccount {
  return {
    username: 'e2e-user',
    displayName: 'E2E Listener',
    liked: [1, 2, 3],
    playlists: [
      {
        id: nativeId('p', 1),
        name: 'Road trip',
        description: 'Loud',
        tracks: [11, 12, 13],
        revision: 1,
      },
      { id: nativeId('p', 2), name: 'Late night (private)', tracks: [21, 22], revision: 1 },
    ],
  }
}

function trackData(n: number) {
  return {
    __typename: 'Track',
    uri: `spotify:track:${nativeId('t', n)}`,
    name: `E2E song ${n}`,
    duration: { totalMilliseconds: 200_000 + n * 1000 },
    artists: {
      items: [{ uri: `spotify:artist:${nativeId('a', n)}`, profile: { name: `E2E artist ${n}` } }],
    },
    albumOfTrack: {
      uri: `spotify:album:${nativeId('b', n)}`,
      name: `E2E album ${n}`,
      coverArt: { sources: [] },
    },
    contentRating: { label: 'NONE' },
    playability: { playable: true },
  }
}

function playlistData(playlist: MockPlaylist, account: MockAccount) {
  return {
    __typename: 'Playlist',
    uri: `spotify:playlist:${playlist.id}`,
    name: playlist.name,
    description: playlist.description ?? '',
    revisionId: `AAAA${playlist.id}-${playlist.revision}`,
    images: { items: [] },
    ownerV2: {
      data: {
        __typename: 'User',
        uri: `spotify:user:${account.username}`,
        name: account.displayName,
        username: account.username,
      },
    },
    attributes: [],
    currentUserCapabilities: { canView: true, canEditItems: true },
  }
}

type Reply = { status: number; headers?: Record<string, string>; body?: string }

function json(value: unknown, headers: Record<string, string> = {}): Reply {
  return {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(value),
  }
}

/** The network: its log, the account it serves, and how to stop it. */
export interface Network {
  readonly log: Logged[]
  readonly account: MockAccount
  /** Account tokens handed out so far. */
  readonly accountTokens: string[]
  /** Requests to a host (and a path prefix), since the last `clearLog`. */
  requests(host: string, pathPrefix?: string): Logged[]
  clearLog(): void
  close(): Promise<void>
}

function selfSignedCertificate(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fxm-spotify-e2e-'))
  try {
    const key = join(dir, 'key.pem')
    const cert = join(dir, 'cert.pem')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-subj',
        '/CN=fxm-spotify-e2e',
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'ignore' },
    )
    return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/** Starts the network on {@link PORT}. */
export async function startNetwork(account: MockAccount = defaultAccount()): Promise<Network> {
  if (!existsSync(join(PAGES_DIR, '_headers'))) {
    throw new Error(`${PAGES_DIR} has no _headers file: run make dist first`)
  }
  const pages = createPagesServer(PAGES_DIR).listeners('request')[0] as RequestListener
  const log: Logged[] = []
  const accountTokens: string[] = []
  let issued = 0

  function cors(request: IncomingMessage): Record<string, string> {
    // Pathfinder echoes any Origin (measured 2026-10-25); FXM Connect's rules set it anyway.
    const origin = request.headers.origin
    return origin === undefined
      ? {}
      : {
          'access-control-allow-origin': origin,
          'access-control-allow-headers': 'authorization, content-type, accept',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
        }
  }

  function token(request: IncomingMessage, url: URL): Reply {
    const params = url.searchParams
    for (const name of ['reason', 'productType', 'totp', 'totpServer', 'totpVer']) {
      if (!params.get(name)) return { status: 400, body: '{"error":"missing parameters"}' }
    }
    const cookie = request.headers.cookie ?? ''
    const loggedIn = cookie.split(/;\s*/).includes(`${SESSION.name}=${SESSION.value}`)
    const expires = Date.now() + 3_600_000
    if (params.get('reason') === 'transport' && loggedIn) {
      issued += 1
      const accessToken = `${ACCOUNT_TOKEN_PREFIX}${issued}`
      accountTokens.push(accessToken)
      return json({
        accessToken,
        accessTokenExpirationTimestampMs: expires,
        isAnonymous: false,
        clientId: 'e2e',
      })
    }
    return json({
      accessToken: ANONYMOUS_TOKEN,
      accessTokenExpirationTimestampMs: expires,
      isAnonymous: true,
      clientId: 'e2e',
    })
  }

  function pathfinder(
    operation: string,
    variables: Record<string, unknown>,
    authorization: string | undefined,
  ): Reply {
    const bearer = authorization?.replace(/^Bearer /u, '')
    const loggedIn = bearer !== undefined && accountTokens.includes(bearer)
    const personal = ['profileAttributes', 'fetchLibraryTracks', 'libraryV3']
    if (bearer !== ANONYMOUS_TOKEN && !loggedIn) {
      return {
        status: 401,
        headers: { 'content-type': 'application/json' },
        body: '{"error":{"status":401,"message":"Invalid token"}}',
      }
    }
    if (personal.includes(operation) && !loggedIn) {
      return json({ errors: [{ message: 'Unauthorized' }], data: { me: null } })
    }
    const offset = typeof variables.offset === 'number' ? variables.offset : 0
    const limit = typeof variables.limit === 'number' ? variables.limit : 50
    switch (operation) {
      case 'profileAttributes':
        return json({
          data: {
            me: {
              profile: {
                uri: `spotify:user:${account.username}`,
                username: account.username,
                name: account.displayName,
                avatar: null,
              },
            },
          },
        })
      case 'fetchLibraryTracks': {
        const items = account.liked.slice(offset, offset + limit).map((n, index) => ({
          addedAt: {
            isoString: new Date(
              Date.UTC(2026, 9, 20) - (offset + index) * 86_400_000,
            ).toISOString(),
          },
          track: { _uri: `spotify:track:${nativeId('t', n)}`, data: trackData(n) },
        }))
        return json({
          data: {
            me: {
              library: {
                tracks: {
                  __typename: 'UserLibraryTrackPage',
                  items,
                  pagingInfo: { offset, limit },
                  totalCount: account.liked.length,
                },
              },
            },
          },
        })
      }
      case 'libraryV3': {
        const items = account.playlists.slice(offset, offset + limit).map((playlist) => ({
          item: {
            __typename: 'PlaylistResponseWrapper',
            _uri: `spotify:playlist:${playlist.id}`,
            data: playlistData(playlist, account),
          },
          pinned: false,
          addedAt: { isoString: '2026-10-01T00:00:00Z' },
          playedAt: null,
          depth: 0,
          pinnable: true,
        }))
        return json({
          data: {
            me: {
              libraryV3: {
                __typename: 'LibraryPage',
                items,
                totalCount: account.playlists.length,
                selectedSortOrder: { id: 'Recents' },
                breadcrumbs: [],
              },
            },
          },
        })
      }
      case 'fetchPlaylist': {
        const id = String(variables.uri ?? '').replace('spotify:playlist:', '')
        const playlist = account.playlists.find((p) => p.id === id)
        if (!playlist || (!loggedIn && playlist.name.includes('private'))) {
          return json({ data: { playlistV2: { __typename: 'NotFound', message: 'Not found' } } })
        }
        return json({
          data: {
            playlistV2: {
              ...playlistData(playlist, account),
              content: {
                __typename: 'PlaylistItemsPage',
                totalCount: playlist.tracks.length,
                pagingInfo: { offset, limit },
                items: playlist.tracks.slice(offset, offset + limit).map((n) => ({
                  uid: `uid-${n}`,
                  addedAt: { isoString: '2026-10-02T00:00:00Z' },
                  addedBy: null,
                  itemV2: { __typename: 'TrackResponseWrapper', data: trackData(n) },
                })),
              },
            },
          },
        })
      }
      case 'home': {
        const section = loggedIn
          ? {
              uri: 'spotify:section:e2emadeforyou',
              title: `Made for ${account.displayName}`,
              tracks: [31, 32],
            }
          : { uri: 'spotify:section:e2etrending', title: 'Trending songs', tracks: [41] }
        return json({
          data: {
            home: {
              sectionContainer: {
                sections: {
                  items: [
                    {
                      uri: section.uri,
                      data: {
                        __typename: 'HomeGenericSectionData',
                        title: { transformedLabel: section.title },
                        subtitle: { transformedLabel: '' },
                      },
                      sectionItems: {
                        items: section.tracks.map((n) => ({
                          uri: `spotify:track:${nativeId('t', n)}`,
                          content: { __typename: 'TrackResponseWrapper', data: trackData(n) },
                        })),
                      },
                    },
                  ],
                },
              },
            },
          },
        })
      }
      default:
        return {
          status: 412,
          headers: { 'content-type': 'application/json' },
          body: '{"errors":[{"message":"Invalid query hash"}]}',
        }
    }
  }

  async function answer(
    request: IncomingMessage,
    host: string,
    url: URL,
  ): Promise<Reply & { operation?: string }> {
    if (SECRET_HOSTS.includes(host)) {
      return json(FAKE_SECRET, { 'access-control-allow-origin': '*' })
    }
    if (host === SPOTIFY_HOST) {
      // No CORS headers for any origin, as measured: FXM Connect's rules add them.
      if (request.method === 'OPTIONS') return { status: 200 }
      if (url.pathname === '/api/server-time')
        return json({ serverTime: Math.floor(Date.now() / 1000) })
      if (url.pathname === '/api/token') return token(request, url)
      // A plain resource, to tell whether the browser sends the session cookie to Spotify from
      // FXM's page at all (third-party cookies allowed or blocked).
      if (url.pathname === '/e2e-cookie-probe.gif') {
        return { status: 200, headers: { 'content-type': 'image/gif' }, body: 'GIF89a' }
      }
      return { status: 404 }
    }
    if (host === PATHFINDER_HOST && url.pathname === '/pathfinder/v2/query') {
      if (request.method === 'OPTIONS') return { status: 200, headers: cors(request) }
      const body = JSON.parse((await readBody(request)) || '{}') as {
        operationName?: string
        variables?: Record<string, unknown>
      }
      const operation = body.operationName ?? ''
      const reply = pathfinder(operation, body.variables ?? {}, request.headers.authorization)
      return { ...reply, headers: { ...reply.headers, ...cors(request) }, operation }
    }
    return { status: 404 }
  }

  const server: Server = createServer(
    selfSignedCertificate(),
    (request, response: ServerResponse) => {
      const host = (request.headers.host ?? '').replace(/:\d+$/u, '')
      const url = new URL(request.url ?? '/', `https://${host}`)
      if (host === FXM_HOST) {
        log.push({
          at: Date.now(),
          host,
          method: request.method ?? 'GET',
          path: url.pathname,
          status: 200,
        })
        pages(request, response)
        return
      }
      void answer(request, host, url).then(
        (reply) => {
          const entry: Logged = {
            at: Date.now(),
            host,
            method: request.method ?? 'GET',
            path: url.pathname + url.search,
            status: reply.status,
          }
          if (request.headers.cookie) entry.cookie = request.headers.cookie
          if (request.headers.origin) entry.origin = request.headers.origin
          if (request.headers.authorization) entry.authorization = request.headers.authorization
          if (reply.operation) entry.operation = reply.operation
          log.push(entry)
          response.writeHead(reply.status, reply.headers ?? {})
          response.end(reply.body ?? '')
        },
        (error: unknown) => {
          response.writeHead(500)
          response.end(String(error))
        },
      )
    },
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORT, '127.0.0.1', () => resolve())
  })
  return {
    log,
    account,
    accountTokens,
    requests: (host, pathPrefix = '') =>
      log.filter((entry) => entry.host === host && entry.path.startsWith(pathPrefix)),
    clearLog: () => {
      log.length = 0
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
