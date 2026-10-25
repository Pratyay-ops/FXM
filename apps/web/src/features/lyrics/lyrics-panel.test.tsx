import { FxmError, formatId, type Lyrics, type Track } from '@fxm/core'
import { testTrack } from '@fxm/player/testing'
import { act, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '../../test/render'
import {
  setupTestLyrics,
  setupTestPlayback,
  spotifyTrack,
  syncedLyrics,
  testCandidate,
} from '../now-playing/testing'
import { lyricsTrackFor } from './lyrics-source'

const CREEP = syncedLyrics([
  [0, 'First line'],
  [5000, 'Second line'],
  [10_000, ''],
  [15_000, 'Last line'],
])

/** Renders the lyrics tab of Now playing and waits for it. */
async function renderLyrics() {
  const rendered = renderApp('/now-playing')
  await screen.findByRole('heading', { level: 1, name: 'Now playing' })
  return rendered
}

/** Queues `track`, paused at `positionMs`. */
async function queuePaused(track: Track, positionMs = 0) {
  const playback = setupTestPlayback()
  await playback.player.setQueue([track], { autoplay: false })
  playback.player.seek(positionMs)
  return playback
}

const panel = () => within(screen.getByRole('tabpanel'))

describe('synced lyrics', () => {
  it('highlight the line being sung and follow the song', async () => {
    const { player } = await queuePaused(testTrack('Creep'), 6000)
    setupTestLyrics(() => CREEP)
    await renderLyrics()

    const second = await panel().findByRole('button', { name: 'Second line' })
    expect(second).toHaveAttribute('aria-current', 'true')
    expect(panel().getByRole('button', { name: 'First line' })).not.toHaveAttribute('aria-current')

    act(() => player.seek(16_000))

    expect(panel().getByRole('button', { name: 'Last line' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(second).not.toHaveAttribute('aria-current')
    expect(panel().getByText('Instrumental')).toBeInTheDocument()
  })

  it('play the song from the line that is tapped', async () => {
    const { player } = await queuePaused(testTrack('Creep'))
    setupTestLyrics(() => CREEP)
    const { user } = await renderLyrics()

    const last = await panel().findByRole('button', { name: 'Last line' })
    expect(last).toHaveAccessibleDescription('Plays the song from this line.')
    await user.click(last)

    expect(player.getState().positionMs).toBe(15_000)
    expect(last).toHaveAttribute('aria-current', 'true')
  })

  it('highlight the words sung so far in enhanced LRC', async () => {
    await queuePaused(testTrack('Creep'), 1200)
    const lyrics: Lyrics = {
      synced: true,
      source: 'lrclib',
      lines: [
        {
          timeMs: 0,
          text: 'When you were here',
          words: [
            { timeMs: 0, text: 'When ' },
            { timeMs: 500, text: 'you ' },
            { timeMs: 1000, text: 'were ' },
            { timeMs: 1500, text: 'here' },
          ],
        },
      ],
    }
    setupTestLyrics(() => lyrics)
    await renderLyrics()

    const line = await panel().findByRole('button', { name: 'When you were here' })
    const words = within(line).getAllByText(/\w+/)
    expect(words.map((word) => word.classList.contains('text-text'))).toEqual([
      true,
      true,
      true,
      false,
    ])
  })

  it('credit where the lyrics came from', async () => {
    await queuePaused(testTrack('Creep'))
    setupTestLyrics(() => CREEP)
    await renderLyrics()

    expect(await panel().findByRole('link', { name: 'LRCLIB' })).toHaveAttribute(
      'href',
      'https://lrclib.net',
    )
  })
})

describe('the lyrics tab', () => {
  it('shows plain lyrics as text, saying they are not synced', async () => {
    await queuePaused(testTrack('Creep'))
    setupTestLyrics(() => ({
      synced: false,
      source: 'lrclib',
      lines: [{ text: 'Verse one' }, { text: '' }, { text: 'Verse two' }],
    }))
    await renderLyrics()

    expect(await panel().findByText('These lyrics aren’t synced to the song.')).toBeInTheDocument()
    expect(panel().getByText('Verse two')).toBeInTheDocument()
    expect(panel().queryByRole('button', { name: 'Verse one' })).not.toBeInTheDocument()
  })

  it('says when there are no lyrics', async () => {
    await queuePaused(testTrack('Creep'))
    setupTestLyrics(() => null)
    await renderLyrics()

    expect(await panel().findByRole('heading', { name: 'No lyrics for this song' })).toBeVisible()
  })

  it('says why lyrics failed to load, and tries again', async () => {
    await queuePaused(testTrack('Creep'))
    const provider = setupTestLyrics(() => {
      throw new FxmError('RateLimited', 'Slow down', { retryAfterMs: 30_000 })
    })
    const { user } = await renderLyrics()

    expect(await panel().findByText(/asked FXM to slow down/)).toBeInTheDocument()
    // Rate limits aren't retried on their own.
    expect(provider.lookups).toHaveLength(1)

    provider.handler = () => CREEP
    await user.click(panel().getByRole('button', { name: 'Try again' }))

    expect(await panel().findByRole('button', { name: 'Second line' })).toBeInTheDocument()
  })

  it('suggests checking the connection when LRCLIB can’t be reached', async () => {
    await queuePaused(testTrack('Creep'))
    setupTestLyrics(() => {
      throw new FxmError('Network', 'Offline')
    })
    await renderLyrics()

    expect(await panel().findByText(/Check your connection/, {}, { timeout: 8000 })).toBeVisible()
  })

  it('says lyrics show while a song plays when the queue is empty', async () => {
    setupTestPlayback()
    const provider = setupTestLyrics()
    await renderLyrics()

    expect(panel().getByRole('heading', { name: 'Nothing playing' })).toBeInTheDocument()
    expect(provider.lookups).toHaveLength(0)
  })

  it('looks the lyrics of the next song up before it starts', async () => {
    const { player, engine } = setupTestPlayback()
    const provider = setupTestLyrics(() => CREEP)
    const [first, next] = [testTrack('First'), testTrack('Next')]
    await player.setQueue([first, next])
    await renderLyrics()
    await panel().findByRole('button', { name: 'Second line' })

    act(() => engine.progress(160_000))

    await vi.waitFor(() => expect(provider.lookups.map((track) => track.title)).toContain('Next'))
  })
})

describe('the track lyrics are looked up for', () => {
  it('is the track itself when it plays its own audio', () => {
    const track = testTrack('Creep')
    expect(lyricsTrackFor({ uid: 0, track })).toBe(track)
    expect(lyricsTrackFor({ uid: 0, track, candidate: testCandidate('Creep') })).toBe(track)
  })

  it('takes the duration of a match, and keeps the track’s own names', () => {
    const track = spotifyTrack('Creep', { durationMs: 238_000 })
    const lookup = lyricsTrackFor({
      uid: 0,
      track,
      candidate: testCandidate('m', { durationMs: 239_500 }),
    })
    expect(lookup).toEqual({ ...track, durationMs: 239_500 })
  })

  it('is the song of an official video that plays its song', () => {
    const video = testTrack('Creep (Official Video)', {
      kind: 'music-video',
      durationMs: 260_000,
      songId: formatId('ytm', 'track', 'song'),
    })
    const lookup = lyricsTrackFor({
      uid: 0,
      track: video,
      candidate: testCandidate('song', {
        title: 'Creep',
        artists: ['Radiohead'],
        durationMs: 238_000,
      }),
    })
    expect(lookup).toMatchObject({
      title: 'Creep',
      artists: [{ name: 'Radiohead' }],
      durationMs: 238_000,
    })
  })

  it('drops the video’s duration when its song has none', () => {
    const video = testTrack('Clip', { kind: 'music-video', durationMs: 260_000 })
    const { durationMs: _none, ...song } = testCandidate('song')
    expect(lyricsTrackFor({ uid: 0, track: video, candidate: song }).durationMs).toBeUndefined()
  })
})

describe('lyrics from LRCLIB', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('are fetched from the page without cookies, and shown', async () => {
    await queuePaused(testTrack('Creep', { artists: [{ name: 'Radiohead' }] }), 6000)
    const requests: { url: string; init: RequestInit | undefined }[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init })
      return Response.json({
        id: 1,
        trackName: 'Creep',
        artistName: 'Radiohead',
        albumName: 'Pablo Honey',
        duration: 180,
        instrumental: false,
        plainLyrics: 'First line\nSecond line',
        syncedLyrics: '[00:00.00]First line\n[00:05.00]Second line',
      })
    })
    await renderLyrics()

    expect(await panel().findByRole('button', { name: 'Second line' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    const url = new URL(requests[0]?.url ?? '')
    expect(url.origin + url.pathname).toBe('https://lrclib.net/api/get')
    expect(url.searchParams.get('track_name')).toBe('Creep')
    expect(url.searchParams.get('artist_name')).toBe('Radiohead')
    expect(requests[0]?.init?.credentials).toBe('omit')
  })
})
