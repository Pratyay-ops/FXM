import { formatId, type Track } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { createCoverArtClient } from '../coverart/api'
import pabloHoney from '../coverart/fixtures/release-pablo-honey.json'
import { createItunesClient } from '../itunes/api'
import ramAlbums from '../itunes/fixtures/search-album-daft-punk-ram.json'
import getLucky from '../itunes/fixtures/search-song-daft-punk-get-lucky.json'
import { createListenBrainzClient } from '../listenbrainz/api'
import acrLookup from '../listenbrainz/fixtures/acr-lookup-radiohead-creep.json'
import { type ArtworkFillerOptions, createArtworkFiller } from './artwork'
import { fakeFetch, jsonResponse, testContext, textResponse, ytmTrack } from './testing'

const PABLO_HONEY = '07aab296-9a40-42a9-8d1f-6b06aa032e8a'

/** Creep from a Last.fm station: no artwork of its own. */
const CREEP: Track = ytmTrack('XFkzRNyygfk', 'Creep', 'Radiohead', 'song', {
  album: { name: 'Pablo Honey' },
})
const GET_LUCKY: Track = ytmTrack('getLucky001', 'Get Lucky', 'Daft Punk', 'song', {
  album: { name: 'Random Access Memories' },
})

/** A fake network for every artwork source, answering from the recorded fixtures. */
function network(overrides: (url: URL) => Response | undefined = () => undefined) {
  return fakeFetch((url) => {
    const override = overrides(url)
    if (override !== undefined) return override
    if (url.pathname === '/acr-lookup/json') {
      return url.searchParams.get('recording_name') === 'Creep'
        ? jsonResponse(acrLookup)
        : jsonResponse([])
    }
    if (url.pathname === `/release/${PABLO_HONEY}`) return jsonResponse(pabloHoney)
    if (url.hostname === 'itunes.apple.com') {
      return jsonResponse(url.searchParams.get('entity') === 'album' ? ramAlbums : getLucky)
    }
    return textResponse('Not found', { status: 404 })
  })
}

/** A filler over the real clients and a fake network. */
function setup(
  overrides?: (url: URL) => Response | undefined,
  options: Partial<ArtworkFillerOptions> = {},
) {
  const { fetch, calls } = network(overrides)
  const filler = createArtworkFiller({
    coverArt: createCoverArtClient(),
    listenbrainz: createListenBrainzClient({ minIntervalMs: 0 }),
    itunes: createItunesClient(),
    ...options,
  })
  return { filler, ctx: testContext({ fetch, tier: 'free' }), calls }
}

/** The hosts and paths requested, in order. */
function requested(calls: readonly { url: URL }[]): string[] {
  return calls.map((call) => `${call.url.hostname}${call.url.pathname}`)
}

describe('createArtworkFiller', () => {
  it('fills a gap with the release’s cover from the Cover Art Archive', async () => {
    const { filler, ctx, calls } = setup()
    const filled = await filler.fill(CREEP, ctx)
    expect(filled.artwork.map((art) => art.width)).toEqual([250, 500, 1200])
    expect(filled.artwork[0]?.url).toBe(
      `https://coverartarchive.org/release/${PABLO_HONEY}/4203359815-250.jpg`,
    )
    expect(requested(calls)).toEqual([
      'labs.api.listenbrainz.org/acr-lookup/json',
      `coverartarchive.org/release/${PABLO_HONEY}`,
    ])
  })

  it('leaves a track that has artwork alone', async () => {
    const { filler, ctx, calls } = setup()
    const track = { ...CREEP, artwork: [{ url: 'https://i.ytimg.com/vi/x/hqdefault.jpg' }] }
    expect(await filler.fill(track, ctx)).toBe(track)
    expect(calls).toHaveLength(0)
  })

  it('falls back to iTunes, the album first', async () => {
    const { filler, ctx, calls } = setup()
    const artwork = await filler.artworkFor(GET_LUCKY, ctx)
    expect(artwork.map((art) => art.width)).toEqual([100, 300, 600])
    expect(artwork[2]?.url).toBe(
      ramAlbums.results[0]?.artworkUrl100.replace('100x100bb.jpg', '600x600bb.jpg'),
    )
    expect(requested(calls)).toEqual([
      'labs.api.listenbrainz.org/acr-lookup/json',
      'itunes.apple.com/search',
    ])
  })

  it('searches iTunes for the song when the track names no album', async () => {
    const { filler, ctx, calls } = setup()
    const { album: _album, ...single } = GET_LUCKY
    const artwork = await filler.artworkFor(single, ctx)
    expect(artwork).toHaveLength(3)
    expect(calls.at(-1)?.url.searchParams.get('entity')).toBe('song')
  })

  it('tries the release adapter before ListenBrainz', async () => {
    const releaseMbid = async () => PABLO_HONEY
    const { filler, ctx, calls } = setup(undefined, { releaseMbid })
    const artwork = await filler.artworkFor({ ...GET_LUCKY, album: { name: 'Pablo Honey' } }, ctx)
    expect(artwork).toHaveLength(3)
    expect(requested(calls)).toEqual([`coverartarchive.org/release/${PABLO_HONEY}`])
  })

  it('prefers iTunes when the archive’s release is not the track’s album', async () => {
    const { filler, ctx } = setup()
    const compilation = { ...CREEP, album: { name: 'Random Access Memories' }, title: 'Creep' }
    // ListenBrainz names Pablo Honey; the track says otherwise, and iTunes has no match for it
    // either, so the archive's cover is the last resort.
    const artwork = await filler.artworkFor(compilation, ctx)
    expect(artwork.map((art) => art.width)).toEqual([250, 500, 1200])
  })

  it('remembers a miss, but not a failure', async () => {
    const failing = setup((url) =>
      url.hostname === 'itunes.apple.com' ? textResponse('oops', { status: 500 }) : undefined,
    )
    const nobody = ytmTrack('nobody00001', 'Unknown Song', 'Nobody')
    expect(await failing.filler.artworkFor(nobody, failing.ctx)).toEqual([])
    expect(await failing.filler.artworkFor(nobody, failing.ctx)).toEqual([])
    expect(requested(failing.calls).filter((path) => path.startsWith('itunes'))).toHaveLength(2)
    const missing = setup((url) =>
      url.hostname === 'itunes.apple.com'
        ? jsonResponse({ resultCount: 0, results: [] })
        : undefined,
    )
    expect(await missing.filler.artworkFor(nobody, missing.ctx)).toEqual([])
    expect(await missing.filler.artworkFor(nobody, missing.ctx)).toEqual([])
    expect(missing.calls).toHaveLength(2)
  })

  it('asks nothing for a track without a title or an artist', async () => {
    const { filler, ctx, calls } = setup()
    expect(await filler.artworkFor({ ...CREEP, artists: [] }, ctx)).toEqual([])
    expect(await filler.artworkFor({ ...CREEP, title: '  ' }, ctx)).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('works with no sources at all', async () => {
    const filler = createArtworkFiller()
    expect(await filler.fill(CREEP, testContext())).toBe(CREEP)
  })

  it('rejects with the reason when the call is cancelled', async () => {
    const controller = new AbortController()
    const reason = new Error('stop')
    const { filler, ctx } = setup(() => {
      controller.abort(reason)
      return textResponse('late', { status: 500 })
    })
    const track = { ...CREEP, id: formatId('ytm', 'track', 'other000001') }
    await expect(filler.artworkFor(track, { ...ctx, signal: controller.signal })).rejects.toBe(
      reason,
    )
  })
})
