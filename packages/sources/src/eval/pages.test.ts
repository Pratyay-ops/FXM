import { FxmError, formatId, matchingEval, type ProviderContext, type Track } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { fetchPage, type PageProviders } from './pages'

const ctx: ProviderContext = {
  fetch: () => Promise.reject(new Error('no network in tests')),
  platform: 'desktop',
  capabilities: { youtube: 'full', spotify: 'anonymous', mediaBytes: true, fileSystem: false },
  mode: 'music',
}

function song(id: string, title: string, kind: Track['kind'] = 'song'): Track {
  return {
    id: formatId('ytm', 'track', id),
    source: 'ytm',
    title,
    artists: [{ name: 'Artist' }],
    durationMs: 200_000,
    artwork: [],
    kind,
  }
}

function providers(calls: string[]): PageProviders {
  return {
    music: {
      async search(query, options) {
        calls.push(`search ${options.types.join()} ${query}`)
        return options.types.includes('video')
          ? { videos: { items: [song('vid', 'Video', 'music-video')] } }
          : { tracks: { items: [song('a', 'Song A'), song('b', 'Song B')] } }
      },
      async topResult(query) {
        calls.push(`top ${query}`)
        return query === 'album'
          ? {
              type: 'album',
              album: {
                id: formatId('ytm', 'album', 'x'),
                source: 'ytm',
                name: 'LP',
                artists: [],
                artwork: [],
              },
            }
          : { type: 'track', track: song('card', 'Card') }
      },
      async getDescription(id) {
        calls.push(`description ${id}`)
        return 'Provided to YouTube by Label\n\nSong A · Artist\n\nLP\n\n℗ 2020 Label Records\n\nReleased on: 2020-05-01'
      },
    },
    video: {
      async search(query) {
        calls.push(`youtube ${query}`)
        return {
          videos: {
            items: [
              { ...song('up', 'Upload', 'video'), id: formatId('yt', 'track', 'up'), source: 'yt' },
            ],
          },
        }
      },
    },
  }
}

describe('fetchPage', () => {
  it('files a songs search, an ISRC search and their items', async () => {
    const calls: string[] = []
    const recording = matchingEval.emptyRecording()
    await fetchPage('songs/Artist Song', providers(calls), ctx, recording)
    await fetchPage('isrc-songs/2/USAAA0000001', providers(calls), ctx, recording)
    expect(calls).toEqual(['search track Artist Song', 'search track USAAA0000001'])
    expect(recording.pages['songs/Artist Song']).toEqual({ items: ['a', 'b'] })
    expect(recording.pages['isrc-songs/2/USAAA0000001']).toEqual({ items: ['a', 'b'] })
    expect(Object.keys(recording.items)).toEqual(['a', 'b'])
  })

  it('files the top-result card, or none when it is not a track', async () => {
    const recording = matchingEval.emptyRecording()
    await fetchPage('isrc-top-card/USAAA0000001', providers([]), ctx, recording)
    await fetchPage('isrc-top-card/album', providers([]), ctx, recording)
    expect(recording.pages['isrc-top-card/USAAA0000001']).toEqual({ item: 'card' })
    expect(recording.pages['isrc-top-card/album']).toEqual({ item: null })
  })

  it("files a description's release facts and its generated lines", async () => {
    const calls: string[] = []
    const recording = matchingEval.emptyRecording()
    const page = await fetchPage('description/a', providers(calls), ctx, recording)
    expect(calls).toEqual(['description ytm:track:a'])
    expect(page).toEqual({
      facts: { providedBy: 'Label', label: 'Label Records', releaseYear: 2020 },
      excerpt:
        'Provided to YouTube by Label\nSong A · Artist\nLP\n℗ 2020 Label Records\nReleased on: 2020-05-01',
    })
  })

  it('files the video searches of Music + Video mode', async () => {
    const recording = matchingEval.emptyRecording()
    await fetchPage('videos/Artist - Song', providers([]), ctx, recording)
    await fetchPage('youtube/Artist - Song', providers([]), ctx, recording)
    expect(recording.pages['videos/Artist - Song']).toEqual({ items: ['vid'] })
    expect(recording.items.up).toMatchObject({ kind: 'video', source: 'yt' })
  })

  it('files nothing when the provider fails, and refuses a key that names no page', async () => {
    const recording = matchingEval.emptyRecording()
    const failing: PageProviders = {
      music: {
        ...providers([]).music,
        search: async () => {
          throw new FxmError('BotCheck', 'not a bot?')
        },
      },
    }
    await expect(fetchPage('songs/x', failing, ctx, recording)).rejects.toMatchObject({
      code: 'BotCheck',
    })
    expect(recording.pages).toEqual({})
    await expect(fetchPage('nope', providers([]), ctx, recording)).rejects.toThrow(RangeError)
    await expect(
      fetchPage('youtube/x', { music: providers([]).music }, ctx, recording),
    ).rejects.toThrow(RangeError)
  })
})
