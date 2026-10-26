import { type EntityId, formatId, MATCHING_CONFIG, type MatchRequest } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { matchRow, matchSourceOf, needsLoad, planRow, trackOfCandidate } from './match'
import { AUTO_AVAILABLE, fakeYouTube, song, testContext } from './testing'
import type { StoredRow } from './types'

const SPOTIFY = formatId('spotify', 'track', '0000000000000000000001')
const id = (text: string) => text as EntityId<'track'>

function pagesFrom(catalog: Parameters<typeof fakeYouTube>[0]) {
  const youtube = fakeYouTube(catalog)
  return {
    youtube,
    fetchPage: (request: MatchRequest) => youtube.fetchMatchPage(request, testContext()),
  }
}

describe('planRow', () => {
  it('matches Spotify tracks and rows without a catalog track', () => {
    expect(planRow({ title: 'A', artists: [], trackId: SPOTIFY }, 'music')).toBe('match')
    expect(planRow({ title: 'A', artists: [] }, 'all')).toBe('match')
  })

  it('needs nothing for a song, and follows the mode for videos', () => {
    const base: StoredRow = { title: 'A', artists: ['B'], trackId: id('ytm:track:abcdefghijk') }
    expect(planRow({ ...base, kind: 'song' }, 'music')).toBe('ready')
    expect(planRow({ ...base, kind: 'music-video' }, 'music')).toBe('video-song')
    expect(
      planRow({ ...base, kind: 'music-video', songId: id('ytm:track:bbbbbbbbbbb') }, 'music'),
    ).toBe('ready')
    expect(planRow({ ...base, kind: 'music-video' }, 'all')).toBe('ready')
    expect(planRow({ ...base, kind: 'video' }, 'music')).toBe('match')
    expect(planRow({ ...base, kind: 'video' }, 'all')).toBe('ready')
    expect(planRow({ ...base, kind: 'episode' }, 'all')).toBe('unplayable')
  })

  it('loads a row that only links its track', () => {
    const linked: StoredRow = { title: '', artists: [], trackId: SPOTIFY }
    expect(needsLoad(linked)).toBe(true)
    expect(planRow(linked, 'music')).toBe('load')
    const video: StoredRow = { title: 'T', artists: [], trackId: id('yt:track:abcdefghijk') }
    expect(planRow(video, 'music')).toBe('load')
  })
})

describe('matchSourceOf', () => {
  it('takes the row’s own ISRC as the catalog’s, else the lookup’s with its origin', () => {
    const row: StoredRow = {
      title: 'Creep',
      artists: ['Radiohead'],
      album: 'Pablo Honey',
      isrc: 'GBAYE9200070',
    }
    expect(matchSourceOf(row, { source: 'musicbrainz', isrc: 'USXXX0000001' })).toMatchObject({
      isrc: 'GBAYE9200070',
      isrcOrigin: 'catalog',
    })
    const bare: StoredRow = { title: 'Creep', artists: ['Radiohead'] }
    expect(
      matchSourceOf(bare, {
        source: 'musicbrainz',
        isrc: 'GBAYE9200070',
        isrcOrigin: 'musicbrainz-exact',
        durationMs: 238_000,
      }),
    ).toEqual({
      title: 'Creep',
      artists: [{ name: 'Radiohead' }],
      durationMs: 238_000,
      isrc: 'GBAYE9200070',
      isrcOrigin: 'musicbrainz-exact',
    })
  })
})

describe('matchRow', () => {
  const creep = song('creep000001', 'Creep', 'Radiohead', {
    album: 'Pablo Honey',
    seconds: 239,
    isrc: 'GBAYE9200070',
    artwork: 'https://lh3.googleusercontent.com/creep',
  })
  const live = song('creeplive01', 'Creep (Live)', 'Radiohead', { album: 'Live', seconds: 280 })

  it('verifies a match through its ISRC and keeps the page’s album and artwork', async () => {
    const { youtube, fetchPage } = pagesFrom({ catalog: [creep, live] })
    const seen = new Map([[creep.id, creep]])
    const result = await matchRow({
      row: {
        title: 'Creep',
        artists: ['Radiohead'],
        album: 'Pablo Honey',
        durationMs: 238_640,
        isrc: 'GBAYE9200070',
        trackId: SPOTIFY,
      },
      mode: 'music',
      autoMatch: true,
      matchingConfig: AUTO_AVAILABLE,
      fetchPage,
      seen,
    })
    expect(result).toMatchObject({
      outcome: 'matched',
      verdict: 'auto',
      isrc: 'GBAYE9200070',
      isrcOrigin: 'catalog',
      best: { ref: 'creep000001', signals: { isrcVerified: true } },
      extras: {
        creep000001: {
          album: { name: 'Pablo Honey' },
          artwork: { url: 'https://lh3.googleusercontent.com/creep' },
        },
      },
    })
    expect(result).not.toHaveProperty('noDuration')
    expect(youtube.requests[0]).toBe('isrc-songs GBAYE9200070')
  })

  it('holds a sure match at Suggest while the Auto setting is off, keeping the verdict', async () => {
    const { fetchPage } = pagesFrom({ catalog: [creep] })
    const result = await matchRow({
      row: { title: 'Creep', artists: ['Radiohead'], durationMs: 238_640, isrc: 'GBAYE9200070' },
      mode: 'music',
      autoMatch: false,
      fetchPage,
    })
    expect(result).toMatchObject({ outcome: 'review', verdict: 'auto' })
    expect(result.blockers).toContain('setting-off')
  })

  it('counts the Auto setting only where the matching config makes the band available', async () => {
    const { fetchPage } = pagesFrom({ catalog: [creep] })
    const row = {
      title: 'Creep',
      artists: ['Radiohead'],
      durationMs: 238_640,
      isrc: 'GBAYE9200070',
    }
    // The config FXM ships with keeps the band off (stage 1.12), whatever the stored setting.
    const shipped = await matchRow({ row, mode: 'music', autoMatch: true, fetchPage })
    expect(MATCHING_CONFIG.auto).toBe(false)
    expect(shipped).toMatchObject({ outcome: 'review', verdict: 'auto' })
    expect(shipped.blockers).toContain('setting-off')
  })

  it("applies the matching config's measured fallback to text matches", async () => {
    const { fetchPage } = pagesFrom({ catalog: [creep] })
    const row = { title: 'Creep', artists: ['Radiohead'], durationMs: 238_640 }
    const plain = await matchRow({
      row,
      mode: 'music',
      autoMatch: true,
      matchingConfig: AUTO_AVAILABLE,
      fetchPage,
    })
    const guarded = await matchRow({
      row,
      mode: 'music',
      autoMatch: true,
      matchingConfig: { ...AUTO_AVAILABLE, requireReleaseAgreement: true },
      fetchPage,
    })
    expect(plain.outcome).toBe('matched')
    // Without an ISRC, the album or year must agree before a match plays unasked.
    expect(guarded).toMatchObject({ outcome: 'review', verdict: 'suggest' })
    expect(guarded.blockers).toContain('release-agreement-required')
  })

  it('caps a row without a length at Suggest (no-duration mode)', async () => {
    const { fetchPage } = pagesFrom({ catalog: [creep, live] })
    const result = await matchRow({
      row: { title: 'Creep', artists: ['Radiohead'], album: 'Pablo Honey', trackId: SPOTIFY },
      mode: 'music',
      autoMatch: true,
      fetchPage,
    })
    expect(result).toMatchObject({ outcome: 'review', verdict: 'suggest', noDuration: true })
    expect(result.best?.ref).toBe('creep000001')
    expect(result.blockers).toContain('no-duration')
  })

  it('finds nothing for a song the catalog lacks', async () => {
    const { fetchPage } = pagesFrom({ catalog: [creep] })
    const result = await matchRow({
      row: { title: 'Unheard Of', artists: ['Nobody Known'], durationMs: 200_000 },
      mode: 'music',
      autoMatch: true,
      fetchPage,
    })
    expect(result).toMatchObject({ outcome: 'not-found', verdict: 'none' })
    expect(result.best).toBeUndefined()
  })

  it('marks a result incomplete when a page could not be fetched', async () => {
    const result = await matchRow({
      row: { title: 'Creep', artists: ['Radiohead'], durationMs: 238_640 },
      mode: 'music',
      autoMatch: true,
      fetchPage: async () => null,
    })
    expect(result).toMatchObject({ outcome: 'not-found', incomplete: true })
  })

  it('maps an official video to its song in Music mode', async () => {
    const video = song('creepvideo1', 'Radiohead - Creep (Official Video)', 'Radiohead', {
      kind: 'music-video',
      seconds: 243,
    })
    const { youtube, fetchPage } = pagesFrom({ catalog: [creep] })
    const result = await matchRow({
      row: {
        title: video.title,
        artists: ['Radiohead'],
        durationMs: 243_000,
        trackId: video.id,
        kind: 'music-video',
      },
      mode: 'music',
      autoMatch: true,
      matchingConfig: AUTO_AVAILABLE,
      fetchPage,
    })
    expect(youtube.requests).toEqual(['text-songs Radiohead Creep'])
    expect(result).toMatchObject({ outcome: 'matched', best: { ref: 'creep000001' } })
  })

  it('needs no search for a row that plays as it is, or never plays', async () => {
    const fetchPage = async () => {
      throw new Error('no search expected')
    }
    await expect(
      matchRow({
        row: { title: 'Creep', artists: [], trackId: creep.id, kind: 'song' },
        mode: 'music',
        autoMatch: true,
        fetchPage,
      }),
    ).resolves.toEqual({ outcome: 'ready', playlistTrackId: creep.id })
    await expect(
      matchRow({
        row: { title: 'Ep', artists: [], trackId: id('yt:track:episode0001'), kind: 'episode' },
        mode: 'all',
        autoMatch: true,
        fetchPage,
      }),
    ).resolves.toMatchObject({ outcome: 'not-found' })
    await expect(
      matchRow({
        row: { title: '', artists: [], trackId: SPOTIFY },
        mode: 'music',
        autoMatch: true,
        fetchPage,
      }),
    ).rejects.toThrow(RangeError)
  })
})

describe('trackOfCandidate', () => {
  it('makes a library track from a candidate and its extras', () => {
    expect(
      trackOfCandidate(
        {
          source: 'ytm',
          ref: 'creep000001',
          kind: 'song',
          title: 'Creep',
          artists: ['Radiohead'],
          durationMs: 239_000,
          confidence: 1,
          evidence: [],
        },
        { album: { name: 'Pablo Honey' }, artwork: { url: 'https://x/y', width: 120 } },
      ),
    ).toEqual({
      id: 'ytm:track:creep000001',
      source: 'ytm',
      title: 'Creep',
      artists: [{ name: 'Radiohead' }],
      artwork: [{ url: 'https://x/y', width: 120 }],
      kind: 'song',
      durationMs: 239_000,
      album: { name: 'Pablo Honey' },
    })
  })
})
