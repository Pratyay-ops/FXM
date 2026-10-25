/**
 * Live smoke test against Spotify, anonymous, with the bundled config and the default secret
 * source. It runs only with `FXM_LIVE=1`:
 *
 * ```sh
 * FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/spotify/live.test.ts
 * ```
 *
 * It sends fewer than 30 requests to Spotify (about 13: the server time, one token, then one or
 * two per check), as a native transport would, with the browser User-Agent. It prints nothing:
 * no token, TOTP or secret ever reaches the output.
 */

import type { EntityId } from '@fxm/core'
import { afterAll, describe, expect, it } from 'vitest'
import { contextFor } from './fixtures/testing'
import { createSpotifyProvider } from './provider'

/** Node's environment, read without Node's types (this package type-checks as a web worker). */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const live = env?.FXM_LIVE === '1'

const CREEP = 'spotify:track:70LcF31zb1H0PyJoS1Sx1r' as EntityId<'track'>
const PABLO_HONEY = 'spotify:album:3gBVdu4a1MMJVMy6vwPEb8' as EntityId<'album'>
const RADIOHEAD = 'spotify:artist:4Z8W4fKeB5YxbusRsdQVPb' as EntityId<'artist'>

describe.skipIf(!live)('Spotify, live', { timeout: 60_000 }, () => {
  /** Host and path of every request, never the query (it holds the TOTP). */
  const requests: string[] = []
  const counting: typeof fetch = (input, init) => {
    const url = new URL(String(input))
    requests.push(`${url.host}${url.pathname}`)
    return globalThis.fetch(input, init)
  }
  // Node's fetch is a native transport: like the desktop app, it sends the browser User-Agent.
  const ctx = contextFor(counting, { platform: 'desktop' })
  const spotify = createSpotifyProvider()
  const toSpotify = () => requests.filter((r) => /(^|\.)spotify\.com\//u.test(r))

  afterAll(() => {
    expect(toSpotify().length).toBeLessThan(30)
  })

  it('mints one anonymous token and searches', async () => {
    const results = await spotify.search('radiohead creep', { types: ['track', 'artist'] }, ctx)
    const creep = results.tracks?.items.find((t) => t.id === CREEP)
    expect(creep).toMatchObject({ title: 'Creep', kind: 'song', artists: [{ name: 'Radiohead' }] })
    expect(results.artists?.items.some((a) => a.id === RADIOHEAD)).toBe(true)
    expect(requests.filter((r) => r === 'open.spotify.com/api/token')).toHaveLength(1)
  })

  it('loads an artist', async () => {
    const artist = await spotify.getArtist(RADIOHEAD, ctx)
    expect(artist.name).toBe('Radiohead')
    expect(artist.topTracks?.length).toBeGreaterThanOrEqual(5)
    expect(artist.albums?.length).toBeGreaterThan(0)
    expect(artist.related?.length).toBeGreaterThan(0)
  })

  it('loads an album, which was never tested anonymously before', async () => {
    const album = await spotify.getAlbum(PABLO_HONEY, ctx)
    expect(album).toMatchObject({ name: 'Pablo Honey', type: 'album', trackCount: 12 })
    expect(album.tracks?.map((t) => t.title)).toContain('Creep')
  })

  it('lists related artists', async () => {
    const related = await spotify.getRelatedArtists(RADIOHEAD, ctx)
    expect(related.length).toBeGreaterThanOrEqual(20)
    expect(related.every((a) => a.id.startsWith('spotify:artist:'))).toBe(true)
  })

  it('plays track radio', async () => {
    const seed = await spotify.getTrack(CREEP, ctx)
    const tracks = await spotify.radio(seed, ctx)
    expect(tracks.length).toBeGreaterThanOrEqual(20)
    expect(tracks.some((t) => t.id === CREEP)).toBe(false)
    expect(tracks.every((t) => t.kind === 'song')).toBe(true)
  })

  it('plays artist radio', async () => {
    const tracks = await spotify.radio({ id: RADIOHEAD, name: 'Radiohead' }, ctx)
    expect(tracks.length).toBeGreaterThanOrEqual(20)
  })

  it('looks up the ISRC, label and release date', async () => {
    const details = await spotify.getTrackDetails(CREEP, ctx)
    expect(details).toMatchObject({ isrc: 'GBAYE9200070', releaseDate: '1993-02-22' })
    expect(details.label).toBeTruthy()
    expect(spotify.health()).toEqual({ brokenOperations: [] })
  })
})
