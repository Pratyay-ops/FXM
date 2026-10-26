/**
 * The tiny local test plugin: a source and resolver for an invented catalog on
 * `catalog.fxm-plugin.test`, a host under the `.test` top-level domain, which RFC 2606 keeps for
 * tests, so it never reaches a real service. FXM's tests install it, run it in the evaluator and
 * answer its requests with {@link fakeCatalogFetch}. It is also the example in the package
 * README of what a plugin looks like.
 *
 * @module
 */

import { sha256Hex, utf8 } from '../checksum'
import type { PluginManifest } from '../manifest'
import { createPluginFile } from '../package'

/** The test catalog's API host. */
export const TEST_CATALOG_HOST = 'catalog.fxm-plugin.test'

/** The test catalog's media host: covers and audio. */
export const TEST_MEDIA_HOST = 'media.fxm-plugin.test'

/** The test plugin's code. */
export const TEST_PLUGIN_CODE = `// FXM's test plugin: an invented catalog on catalog.fxm-plugin.test, for FXM's own tests.
const API = 'https://catalog.fxm-plugin.test'
const MEDIA = 'https://media.fxm-plugin.test'

async function get(ctx, path) {
  const response = await ctx.fetch(API + path, { headers: { accept: 'application/json' } })
  if (response.status === 404) fxm.fail('NotFound', 'Not in the test catalog')
  if (!response.ok) throw new Error('The test catalog answered ' + response.status)
  return response.json()
}

function track(item) {
  return {
    id: item.id,
    title: item.title,
    artists: [{ id: item.artistId, name: item.artist }],
    album: { id: item.albumId, name: item.album },
    durationMs: item.seconds * 1000,
    artwork: [{ url: MEDIA + '/covers/' + item.albumId + '.jpg', width: 300, height: 300 }],
    isrc: item.isrc,
  }
}

function album(item) {
  return {
    id: item.id,
    name: item.title,
    artists: [{ id: item.artistId, name: item.artist }],
    artwork: [MEDIA + '/covers/' + item.id + '.jpg'],
    type: 'album',
    releaseDate: item.year,
    tracks: item.tracks ? item.tracks.map(track) : undefined,
  }
}

fxm.register({
  async search(query, options, ctx) {
    const cursor = options.cursor ? '&cursor=' + encodeURIComponent(options.cursor) : ''
    const data = await get(ctx, '/search?q=' + encodeURIComponent(query) + cursor)
    return {
      tracks: { items: data.tracks.map(track), nextCursor: data.next },
      albums: data.albums.map(album),
      artists: data.artists.map((item) => ({ id: item.id, name: item.name })),
    }
  },
  async suggest(query, ctx) {
    return (await get(ctx, '/suggest?q=' + encodeURIComponent(query))).suggestions
  },
  async track(id, ctx) {
    return track(await get(ctx, '/tracks/' + encodeURIComponent(id)))
  },
  async album(id, ctx) {
    return album(await get(ctx, '/albums/' + encodeURIComponent(id)))
  },
  async artist(id, ctx) {
    const data = await get(ctx, '/artists/' + encodeURIComponent(id))
    return { id: data.id, name: data.name, topTracks: data.tracks.map(track) }
  },
  async playlist(id, options, ctx) {
    const cursor = options.cursor ? '?cursor=' + encodeURIComponent(options.cursor) : ''
    const data = await get(ctx, '/playlists/' + encodeURIComponent(id) + cursor)
    return { id: data.id, name: data.title, tracks: { items: data.tracks.map(track), nextCursor: data.next } }
  },
  async radio(seed, ctx) {
    const data = await get(ctx, '/radio?title=' + encodeURIComponent(seed.title || seed.name))
    return data.tracks.map(track)
  },
  async match(wanted, ctx) {
    const data = await get(ctx, '/search?q=' + encodeURIComponent(wanted.title))
    return data.tracks.map((item) => ({
      id: item.id,
      title: item.title,
      artists: [item.artist],
      durationMs: item.seconds * 1000,
      confidence: item.title === wanted.title ? 0.9 : 0.3,
    }))
  },
  async resolve(candidate, ctx) {
    const [mp3, flac] = await Promise.all([
      get(ctx, '/streams/' + encodeURIComponent(candidate.id) + '?format=mp3'),
      get(ctx, '/streams/' + encodeURIComponent(candidate.id) + '?format=flac'),
    ])
    return [mp3, flac].map((stream) => ({
      url: stream.url,
      codec: stream.codec,
      container: stream.container,
      bitrateKbps: stream.kbps,
    }))
  },
})
`

/** The test plugin's manifest, with the checksum of `code` (by default its own code). */
export function testPluginManifest(
  overrides: Partial<Record<keyof PluginManifest, unknown>> = {},
  code: string = TEST_PLUGIN_CODE,
): Record<string, unknown> {
  return {
    fxmPlugin: 1,
    id: 'test-catalog',
    name: 'Test Catalog',
    version: '1.0.0',
    description: 'An invented catalog for FXM’s own tests.',
    author: 'FXM tests',
    license: 'Apache-2.0',
    minFxmVersion: '0.0.0',
    hosts: [TEST_CATALOG_HOST, TEST_MEDIA_HOST],
    entry: 'plugin.js',
    sha256: sha256Hex(utf8(code)),
    provides: [
      'search',
      'suggest',
      'track',
      'album',
      'artist',
      'playlist',
      'radio',
      'match',
      'resolve',
    ],
    requestsPerHour: 120,
    ...overrides,
  }
}

/** The test plugin as a plugin file. */
export function testPluginFile(
  overrides: Partial<Record<keyof PluginManifest, unknown>> = {},
  code: string = TEST_PLUGIN_CODE,
): string {
  return createPluginFile(testPluginManifest(overrides, code), code)
}

/** One invented track of the test catalog. */
interface CatalogTrack {
  readonly id: string
  readonly title: string
  readonly artist: string
  readonly artistId: string
  readonly album: string
  readonly albumId: string
  readonly seconds: number
  readonly isrc: string
}

/** The test catalog: invented songs by an invented band. */
export const TEST_CATALOG: readonly CatalogTrack[] = [
  {
    id: 't1',
    title: 'Lantern Weather',
    artist: 'The Paper Moths',
    artistId: 'a1',
    album: 'Night Ferries',
    albumId: 'al1',
    seconds: 201,
    isrc: 'ZZTST2600001',
  },
  {
    id: 't2',
    title: 'Harbour Lights Out',
    artist: 'The Paper Moths',
    artistId: 'a1',
    album: 'Night Ferries',
    albumId: 'al1',
    seconds: 187,
    isrc: 'ZZTST2600002',
  },
  {
    id: 't3',
    title: 'Copper Tide',
    artist: 'The Paper Moths',
    artistId: 'a1',
    album: 'Night Ferries',
    albumId: 'al1',
    seconds: 244,
    isrc: 'ZZTST2600003',
  },
]

/** A request the fake catalog answered. */
export interface CatalogRequest {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
}

/** The fake catalog's `fetch`, with the requests it answered. */
export interface FakeCatalogFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  /** Every request, in order. */
  readonly requests: readonly CatalogRequest[]
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * A `fetch` that answers the test plugin's requests to the test catalog from
 * {@link TEST_CATALOG}, offline, and records them. Any other URL gets a 404. Use it as the
 * platform's `fetch` of a provider context.
 */
export function fakeCatalogFetch(): FakeCatalogFetch {
  const requests: CatalogRequest[] = []
  const catalogFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : 'url' in input ? input.url : input.href)
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value
    })
    requests.push({ url: url.href, method: init?.method ?? 'GET', headers })
    init?.signal?.throwIfAborted()
    if (url.host !== TEST_CATALOG_HOST) return json({ error: 'not found' }, 404)
    const path = url.pathname
    const byId = (id: string) => TEST_CATALOG.find((item) => item.id === id)
    if (path === '/search') {
      const query = (url.searchParams.get('q') ?? '').toLowerCase()
      const found = TEST_CATALOG.filter(
        (item) =>
          item.title.toLowerCase().includes(query) || item.artist.toLowerCase().includes(query),
      )
      const cursor = url.searchParams.get('cursor')
      const tracks = cursor === null ? found.slice(0, 2) : found.slice(2)
      return json({
        tracks,
        next: cursor === null && found.length > 2 ? 'page-2' : undefined,
        albums:
          found.length > 0
            ? [
                {
                  id: 'al1',
                  title: 'Night Ferries',
                  artist: 'The Paper Moths',
                  artistId: 'a1',
                  year: '2026',
                },
              ]
            : [],
        artists: found.length > 0 ? [{ id: 'a1', name: 'The Paper Moths' }] : [],
      })
    }
    if (path === '/suggest') {
      return json({ suggestions: ['lantern weather', 'lantern weather live'] })
    }
    const track = /^\/tracks\/(.+)$/u.exec(path)
    if (track !== null) {
      const item = byId(decodeURIComponent(track[1] ?? ''))
      return item === undefined ? json({ error: 'not found' }, 404) : json(item)
    }
    if (path === '/albums/al1') {
      return json({
        id: 'al1',
        title: 'Night Ferries',
        artist: 'The Paper Moths',
        artistId: 'a1',
        year: '2026',
        tracks: TEST_CATALOG,
      })
    }
    if (path === '/artists/a1') {
      return json({ id: 'a1', name: 'The Paper Moths', tracks: TEST_CATALOG.slice(0, 2) })
    }
    if (path === '/playlists/p1') {
      const cursor = url.searchParams.get('cursor')
      return json({
        id: 'p1',
        title: 'Ferry Songs',
        tracks: cursor === null ? TEST_CATALOG.slice(0, 2) : TEST_CATALOG.slice(2),
        next: cursor === null ? 'more' : undefined,
      })
    }
    if (path === '/radio') return json({ tracks: TEST_CATALOG.slice(1) })
    const stream = /^\/streams\/(.+)$/u.exec(path)
    if (stream !== null) {
      const id = decodeURIComponent(stream[1] ?? '')
      if (byId(id) === undefined) return json({ error: 'not found' }, 404)
      const flac = url.searchParams.get('format') === 'flac'
      return json({
        url: `https://${TEST_MEDIA_HOST}/audio/${id}.${flac ? 'flac' : 'mp3'}`,
        codec: flac ? 'flac' : 'mp3',
        container: flac ? 'flac' : 'mp3',
        kbps: flac ? 900 : 320,
      })
    }
    return json({ error: 'not found' }, 404)
  }
  return Object.assign(catalogFetch, {
    get requests() {
      return requests
    },
  }) as FakeCatalogFetch
}
