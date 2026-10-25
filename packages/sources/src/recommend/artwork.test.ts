import { type Artwork, formatId, type Track } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { type CoverArtClient, createCoverArtClient } from '../coverart/api'
import pabloHoney from '../coverart/fixtures/release-pablo-honey.json'
import { createItunesClient, type ItunesClient } from '../itunes/api'
import ramAlbums from '../itunes/fixtures/search-album-daft-punk-ram.json'
import getLucky from '../itunes/fixtures/search-song-daft-punk-get-lucky.json'
import creepSongs from '../itunes/fixtures/search-song-radiohead-creep.json'
import { createListenBrainzClient, type ListenBrainzClient } from '../listenbrainz/api'
import acrLookup from '../listenbrainz/fixtures/acr-lookup-radiohead-creep.json'
import type { PacedCallOptions } from '../shared/gate'
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

/** A track without an album, as a station item or a video gives it. */
function single(title: string, artist: string): Track {
  return ytmTrack('aaaaaaaaaaa', title, artist)
}

/** An `acr-lookup` row for a recording on a release, in the labs API's shape. */
function acrRow(artist: string, recording: string, release: string, releaseMbid: string) {
  return [
    {
      artist_credit_name: artist,
      recording_name: recording,
      release_name: release,
      release_mbid: releaseMbid,
      recording_mbid: '11111111-2222-4333-8444-555555555555',
      artist_mbids: ['20244d07-534f-4eff-b4d4-930878889970'],
    },
  ]
}

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
      if (url.searchParams.get('entity') === 'album') return jsonResponse(ramAlbums)
      const term = url.searchParams.get('term') ?? ''
      return jsonResponse(term.startsWith('Radiohead') ? creepSongs : getLucky)
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

/** The widths of some artwork. */
function widths(artwork: readonly Artwork[] | undefined): Array<number | undefined> {
  return (artwork ?? []).map((art) => art.width)
}

describe('createArtworkFiller', () => {
  it('fills a gap with the release’s cover from the Cover Art Archive', async () => {
    const { filler, ctx, calls } = setup()
    const filled = await filler.fill(CREEP, ctx)
    expect(widths(filled.artwork)).toEqual([250, 500, 1200])
    expect(filled.artwork[0]?.url).toBe(
      `https://coverartarchive.org/release/${PABLO_HONEY}/4203359815-250.jpg`,
    )
    expect(requested(calls)).toEqual([
      'labs.api.listenbrainz.org/acr-lookup/json',
      `coverartarchive.org/release/${PABLO_HONEY}`,
    ])
    const found = await filler.artworkFor(CREEP, ctx)
    expect(found).toMatchObject({
      source: 'coverartarchive',
      pageUrl: `https://musicbrainz.org/release/${PABLO_HONEY}`,
    })
  })

  it('leaves a track that has artwork alone', async () => {
    const { filler, ctx, calls } = setup()
    const track = { ...CREEP, artwork: [{ url: 'https://i.ytimg.com/vi/x/hqdefault.jpg' }] }
    expect(await filler.fill(track, ctx)).toBe(track)
    expect(calls).toHaveLength(0)
  })

  it('falls back to iTunes, the album first, with its store page', async () => {
    const { filler, ctx, calls } = setup()
    const found = await filler.artworkFor(GET_LUCKY, ctx)
    expect(widths(found?.artwork)).toEqual([100, 300, 600])
    expect(found?.artwork[2]?.url).toBe(
      ramAlbums.results[0]?.artworkUrl100.replace('100x100bb.jpg', '600x600bb.jpg'),
    )
    expect(found).toMatchObject({
      source: 'itunes',
      pageUrl: 'https://music.apple.com/us/album/random-access-memories/617154241?uo=4',
    })
    expect(requested(calls)).toEqual([
      'labs.api.listenbrainz.org/acr-lookup/json',
      'itunes.apple.com/search',
    ])
  })

  it('searches iTunes for the song when the track names no album', async () => {
    const { filler, ctx, calls } = setup()
    const found = await filler.artworkFor(single('Get Lucky', 'Daft Punk'), ctx)
    expect(found?.artwork).toHaveLength(3)
    expect(found?.pageUrl).toBe(getLucky.results[0]?.trackViewUrl)
    expect(calls.at(-1)?.url.searchParams.get('entity')).toBe('song')
  })

  it('tries the release adapter before ListenBrainz, and trusts it', async () => {
    const releaseMbid = async () => PABLO_HONEY
    const { filler, ctx, calls } = setup(undefined, { releaseMbid })
    const found = await filler.artworkFor({ ...GET_LUCKY, album: { name: 'Pablo Honey' } }, ctx)
    expect(found?.artwork).toHaveLength(3)
    expect(requested(calls)).toEqual([`coverartarchive.org/release/${PABLO_HONEY}`])
  })

  it('never uses a release that is not the album the track names', async () => {
    const { filler, ctx, calls } = setup()
    // ListenBrainz names Pablo Honey; the track says otherwise, and iTunes has no match for it.
    const elsewhere = { ...CREEP, album: { name: 'Random Access Memories' } }
    expect(await filler.artworkFor(elsewhere, ctx)).toBeNull()
    expect(requested(calls)).not.toContain(`coverartarchive.org/release/${PABLO_HONEY}`)
  })

  it('gives a version its own cover, or none, never the studio album’s', async () => {
    const versions = setup((url) => {
      // As if ListenBrainz had found the studio recording for a versioned name.
      if (url.searchParams.get('recording_name') === "Love Story (Taylor's Version)") {
        return jsonResponse(acrRow('Taylor Swift', 'Love Story', 'Fearless', PABLO_HONEY))
      }
      return undefined
    })
    const acoustic = await versions.filler.artworkFor(
      single('Creep (Acoustic)', 'Radiohead'),
      versions.ctx,
    )
    expect(acoustic).toMatchObject({ source: 'itunes' })
    expect(acoustic?.artwork[0]?.url).toBe(creepSongs.results[0]?.artworkUrl100)
    expect(
      await versions.filler.artworkFor(single('Creep (Live)', 'Radiohead'), versions.ctx),
    ).toBeNull()
    const rerecorded = single("Love Story (Taylor's Version)", 'Taylor Swift')
    expect(await versions.filler.artworkFor(rerecorded, versions.ctx)).toBeNull()
    // The versions were looked up by their whole titles, and no archive cover was asked for.
    const names = versions.calls
      .filter((call) => call.url.pathname === '/acr-lookup/json')
      .map((call) => call.url.searchParams.get('recording_name'))
    expect(names).toEqual(['Creep (Acoustic)', 'Creep (Live)', "Love Story (Taylor's Version)"])
    expect(requested(versions.calls).some((path) => path.startsWith('coverartarchive'))).toBe(false)
  })

  it('keeps the covers of two versions apart in its cache', async () => {
    const itunesOnly = (order: Track[]) => {
      const { fetch, calls } = network()
      const filler = createArtworkFiller({ itunes: createItunesClient() })
      return { filler, ctx: testContext({ fetch, tier: 'free' }), calls, order }
    }
    const studio = single('Creep', 'Radiohead')
    const acoustic = single('Creep (Acoustic)', 'Radiohead')
    for (const order of [
      [acoustic, studio],
      [studio, acoustic],
    ]) {
      const { filler, ctx } = itunesOnly(order)
      const results = new Map<Track, unknown>()
      for (const track of order) results.set(track, await filler.artworkFor(track, ctx))
      expect(results.get(studio)).toBeNull()
      expect(results.get(acoustic)).toMatchObject({ source: 'itunes' })
      // Asked again, each keeps its own answer.
      expect(await filler.artworkFor(studio, ctx)).toBeNull()
      expect(await filler.artworkFor(acoustic, ctx)).toMatchObject({ source: 'itunes' })
    }
  })

  it('passes its priority to every request', async () => {
    const seen: Array<string | undefined> = []
    const record = (options: PacedCallOptions | undefined) => seen.push(options?.priority)
    const listenbrainz: ListenBrainzClient = {
      async lookupRecording(_artist, _recording, _ctx, options) {
        record(options)
        return {
          recordingMbid: '70595637-9310-45f2-a266-58f8de4874a7',
          recordingName: 'Creep',
          artistCredit: 'Radiohead',
          artistMbids: [],
          releaseMbid: PABLO_HONEY,
        }
      },
      similarArtists: async () => [],
    }
    const coverArt: CoverArtClient = {
      async releaseArtwork(_mbid, _ctx, options) {
        record(options)
        return []
      },
    }
    const itunes: ItunesClient = {
      async searchSongs(_term, _ctx, options) {
        record(options)
        return []
      },
      async searchAlbums(_term, _ctx, options) {
        record(options)
        return []
      },
    }
    const filler = createArtworkFiller({ listenbrainz, coverArt, itunes })
    expect(await filler.artworkFor(CREEP, testContext(), { priority: 'bulk' })).toBeNull()
    expect(seen).toEqual(['bulk', 'bulk', 'bulk', 'bulk'])
  })

  it('remembers a miss, but not a failure', async () => {
    const failing = setup((url) =>
      url.hostname === 'itunes.apple.com' ? textResponse('oops', { status: 500 }) : undefined,
    )
    const nobody = ytmTrack('nobody00001', 'Unknown Song', 'Nobody')
    expect(await failing.filler.artworkFor(nobody, failing.ctx)).toBeNull()
    expect(await failing.filler.artworkFor(nobody, failing.ctx)).toBeNull()
    expect(requested(failing.calls).filter((path) => path.startsWith('itunes'))).toHaveLength(2)
    const missing = setup((url) =>
      url.hostname === 'itunes.apple.com'
        ? jsonResponse({ resultCount: 0, results: [] })
        : undefined,
    )
    expect(await missing.filler.artworkFor(nobody, missing.ctx)).toBeNull()
    expect(await missing.filler.artworkFor(nobody, missing.ctx)).toBeNull()
    expect(missing.calls).toHaveLength(2)
  })

  it('skips a release adapter that gives something that is not an MBID', async () => {
    const { filler, ctx, calls } = setup(undefined, { releaseMbid: async () => 'not an mbid' })
    const found = await filler.artworkFor(GET_LUCKY, ctx)
    expect(found).toMatchObject({ source: 'itunes' })
    expect(requested(calls).some((path) => path.startsWith('coverartarchive'))).toBe(false)
  })

  it('asks nothing for a track without a title or an artist', async () => {
    const { filler, ctx, calls } = setup()
    expect(await filler.artworkFor({ ...CREEP, artists: [] }, ctx)).toBeNull()
    expect(await filler.artworkFor({ ...CREEP, title: '  ' }, ctx)).toBeNull()
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
