import { FxmError, formatId, type Lyrics, type Track } from '@fxm/core'
import { testStream, testTrack } from '@fxm/player/testing'
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

  it('waits for the match of the next song before looking it up', async () => {
    const { player, engine } = setupTestPlayback()
    const provider = setupTestLyrics(() => CREEP)
    await player.setQueue([testTrack('First'), spotifyTrack('Matched later')])
    await renderLyrics()
    await panel().findByRole('button', { name: 'Second line' })

    act(() => engine.progress(160_000))
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))

    expect(provider.lookups.map((track) => track.title)).toEqual(['First'])
  })

  it('looks a matched song up once, when its match is known, and shows it without a reload', async () => {
    const { player, resolver } = setupTestPlayback()
    const provider = setupTestLyrics(() => CREEP)
    const track = spotifyTrack('Creep', { durationMs: 213_573 })
    let release = () => {}
    const found = new Promise<void>((resolve) => {
      release = resolve
    })
    resolver.handler = async () => {
      await found
      return {
        stream: testStream('match'),
        candidate: testCandidate('match', { durationMs: 214_000 }),
      }
    }
    const playing = player.setQueue([track])
    await renderLyrics()

    // While the player looks for the song's audio, the lyrics wait for it.
    expect(panel().getByText('Loading lyrics…')).toBeInTheDocument()
    expect(provider.lookups).toHaveLength(0)

    await act(async () => {
      release()
      await playing
    })

    expect(await panel().findByRole('button', { name: 'Second line' })).toBeInTheDocument()
    expect(player.getState().queue.items[0]?.candidate?.ref).toBe('match')
    expect(provider.lookups).toHaveLength(1)
    expect(provider.lookups[0]?.durationMs).toBe(213_573)
  })

  it('keeps the lyrics on screen while a song that started paused looks up its match', async () => {
    const { player, resolver } = setupTestPlayback()
    const provider = setupTestLyrics(() => CREEP)
    const track = spotifyTrack('Creep', { durationMs: 200_000 })
    resolver.handler = () => ({
      stream: testStream('match'),
      candidate: testCandidate('match', { durationMs: 230_000 }),
    })
    await player.setQueue([track], { autoplay: false })
    const { user } = await renderLyrics()
    await panel().findByRole('button', { name: 'Second line' })
    // A clearly longer recording plays: its lyrics are looked up again.
    let answer = () => {}
    provider.handler = () =>
      new Promise((resolve) => {
        answer = () => resolve(syncedLyrics([[0, 'Longer cut']]))
      })

    await user.click(screen.getAllByRole('button', { name: 'Play' })[0] as HTMLElement)

    await expect
      .poll(() => provider.lookups.map((lookup) => lookup.durationMs))
      .toEqual([200_000, 230_000])
    // The lyrics found so far stay until the new ones arrive.
    expect(panel().getByRole('button', { name: 'Second line' })).toBeInTheDocument()
    expect(panel().queryByText('Loading lyrics…')).not.toBeInTheDocument()
    act(() => answer())
    expect(await panel().findByRole('button', { name: 'Longer cut' })).toBeInTheDocument()
  })
})

describe('the lyrics from the keyboard', () => {
  it('are one Tab stop, on the line being sung, and the arrow keys move between lines', async () => {
    await queuePaused(testTrack('Creep'), 6000)
    setupTestLyrics(() => CREEP)
    const { user } = await renderLyrics()
    const second = await panel().findByRole('button', { name: 'Second line' })

    const lines = within(screen.getByRole('tabpanel')).getAllByRole('button')
    expect(lines.filter((line) => line.tabIndex === 0)).toEqual([second])

    second.focus()
    await user.keyboard('{ArrowDown}')
    expect(panel().getByRole('button', { name: 'Instrumental' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(panel().getByRole('button', { name: 'Last line' })).toHaveFocus()
    expect(panel().getByRole('button', { name: 'Last line' })).toHaveAttribute('tabindex', '0')
    expect(second).toHaveAttribute('tabindex', '-1')
    await user.keyboard('{Home}')
    expect(panel().getByRole('button', { name: 'First line' })).toHaveFocus()
  })

  it('stop following the song while the keyboard is on a line', async () => {
    const { player } = await queuePaused(testTrack('Creep'), 6000)
    setupTestLyrics(() => CREEP)
    const { user } = await renderLyrics()
    const second = await panel().findByRole('button', { name: 'Second line' })

    second.focus()
    await user.keyboard('{ArrowUp}')

    expect(panel().getByRole('button', { name: 'Current line' })).toBeInTheDocument()
    act(() => player.seek(16_000))
    // The sung line moves on, the focus doesn't.
    expect(panel().getByRole('button', { name: 'Last line' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(panel().getByRole('button', { name: 'First line' })).toHaveFocus()

    await user.click(panel().getByRole('button', { name: 'Current line' }))

    expect(panel().queryByRole('button', { name: 'Current line' })).not.toBeInTheDocument()
    expect(panel().getByRole('button', { name: 'Last line' })).toHaveFocus()
  })
})

describe('the track lyrics are looked up for', () => {
  it('is the track itself when it plays its own audio', () => {
    const track = testTrack('Creep')
    expect(lyricsTrackFor({ uid: 0, track })).toBe(track)
    expect(lyricsTrackFor({ uid: 0, track, candidate: testCandidate('Creep') })).toBe(track)
  })

  it('takes the duration of a match of another length, and keeps the track’s own names', () => {
    const track = spotifyTrack('Creep', { durationMs: 238_000 })
    const lookup = lyricsTrackFor({
      uid: 0,
      track,
      candidate: testCandidate('m', { durationMs: 243_500 }),
    })
    expect(lookup).toEqual({ ...track, durationMs: 243_500 })
  })

  it('is the track itself when its match is about as long, which finds the same lyrics', () => {
    const track = spotifyTrack('Creep', { durationMs: 238_000 })
    const match = (durationMs: number) => testCandidate('m', { durationMs })
    expect(lyricsTrackFor({ uid: 0, track, candidate: match(239_500) })).toBe(track)
    expect(lyricsTrackFor({ uid: 0, track, candidate: match(236_000) })).toBe(track)
    const { durationMs: _none, ...unknown } = match(0)
    expect(lyricsTrackFor({ uid: 0, track, candidate: unknown })).toBe(track)
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
