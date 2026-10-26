import { currentQueueItem, FxmError } from '@fxm/core'
import { Player } from '@fxm/player'
import { FakeEngine, FakeResolver, testTrack, testTracks } from '@fxm/player/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesktopShell, type DesktopShell, type MediaAction, type NowPlaying } from './shell'
import {
  connectTray,
  isPlaybackActive,
  nowPlayingOf,
  playbackStateOf,
  TRAY_RETRY_MS,
  trayRetryDelay,
} from './tray'

/** A shell that records what the tray shows and lets a test click the tray's items. */
function fakeShell() {
  const shown: NowPlaying[] = []
  let click: ((action: MediaAction) => void) | undefined
  const stopped = vi.fn()
  const shell: DesktopShell = {
    environment: async () => ({ os: 'macos', tray: true }),
    setNowPlaying: vi.fn(async (now: NowPlaying) => {
      shown.push(now)
    }),
    onMediaAction(listener) {
      click = listener
      return () => {
        click = undefined
        stopped()
      }
    },
    onNetworkChange: () => () => {},
  }
  return { shell, shown, stopped, click: (action: MediaAction) => click?.(action) }
}

function setup() {
  const engine = new FakeEngine()
  const resolver = new FakeResolver()
  const player = new Player({ engine, resolver })
  return { engine, resolver, player, ...fakeShell() }
}

const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms)
const current = (player: Player) => currentQueueItem(player.getState().queue)?.track.title

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('nowPlayingOf', () => {
  it('names the current track and its artists, and says whether it plays', async () => {
    const { player } = setup()
    expect(nowPlayingOf(player.getState())).toEqual({ state: 'paused' })
    const track = testTrack('Creep', { artists: [{ name: 'Radiohead' }, { name: 'Guest' }] })
    await player.setQueue([track])
    expect(nowPlayingOf(player.getState())).toEqual({
      state: 'playing',
      title: 'Creep',
      artist: 'Radiohead, Guest',
    })
    player.pause()
    expect(nowPlayingOf(player.getState()).state).toBe('paused')
  })

  it('leaves out an empty artist line', async () => {
    const { player } = setup()
    await player.setQueue([testTrack('Untitled', { artists: [] })])
    expect(nowPlayingOf(player.getState())).toEqual({ state: 'playing', title: 'Untitled' })
  })

  it('says when playback stopped on a failure the user must look at', async () => {
    const { player, resolver } = setup()
    resolver.handler = () => {
      throw new FxmError('BotCheck', 'prove you are human')
    }
    await player.setQueue(testTracks('a'))
    await settle()
    expect(player.getState().status).toBe('error')
    expect(nowPlayingOf(player.getState())).toEqual({
      state: 'error',
      title: 'a',
      artist: 'a artist',
    })
  })

  it('counts loading as playing, so the tray and the Web Lock follow music between tracks', () => {
    expect(isPlaybackActive({ status: 'loading' })).toBe(true)
    expect(isPlaybackActive({ status: 'playing' })).toBe(true)
    for (const status of ['idle', 'paused', 'ended', 'error'] as const) {
      expect(isPlaybackActive({ status }), status).toBe(false)
    }
    expect(playbackStateOf({ status: 'loading' })).toBe('playing')
    expect(playbackStateOf({ status: 'error' })).toBe('error')
    for (const status of ['idle', 'paused', 'ended'] as const) {
      expect(playbackStateOf({ status }), status).toBe('paused')
    }
  })
})

describe('connectTray', () => {
  it('shows the state at once and then only what changes', async () => {
    const { player, engine, shell, shown } = setup()
    connectTray(player, shell)
    expect(shown).toEqual([{ state: 'paused' }])
    await player.setQueue(testTracks('a', 'b'))
    expect(shown.at(-1)).toEqual({ state: 'playing', title: 'a', artist: 'a artist' })
    const sent = shown.length
    for (let position = 1000; position <= 5000; position += 1000) engine.progress(position)
    expect(shown).toHaveLength(sent)
    player.pause()
    expect(shown.slice(sent)).toEqual([{ state: 'paused', title: 'a', artist: 'a artist' }])
  })

  it('follows the queue from track to track', async () => {
    const { player, engine, shell, shown } = setup()
    connectTray(player, shell)
    await player.setQueue(testTracks('a', 'b'))
    engine.end()
    await settle()
    expect(current(player)).toBe('b')
    expect(shown.at(-1)).toEqual({ state: 'playing', title: 'b', artist: 'b artist' })
  })

  it('plays, pauses and skips when the tray says so', async () => {
    const { player, shell, click } = setup()
    connectTray(player, shell)
    await player.setQueue(testTracks('a', 'b', 'c'))
    click('toggle')
    expect(player.getState().status).toBe('paused')
    click('toggle')
    await settle()
    expect(player.getState().status).toBe('playing')
    click('next')
    await settle()
    expect(current(player)).toBe('b')
    click('previous')
    await settle()
    expect(current(player)).toBe('a')
  })

  it('disconnects: no more actions, and the tray shows that nothing plays', async () => {
    const { player, shell, shown, stopped, click } = setup()
    const disconnect = connectTray(player, shell)
    await player.setQueue(testTracks('a', 'b'))
    disconnect()
    expect(stopped).toHaveBeenCalledOnce()
    expect(shown.at(-1)).toEqual({ state: 'paused' })
    click('next')
    await settle()
    expect(current(player)).toBe('a')
    const sent = shown.length
    player.pause()
    expect(shown).toHaveLength(sent)
  })

  it('reports a tray that could not be updated without disturbing the player', async () => {
    const { player, shell } = setup()
    vi.mocked(shell.setNowPlaying).mockRejectedValue(new Error('menu gone'))
    const onError = vi.fn()
    connectTray(player, shell, { onError })
    await player.setQueue(testTracks('a'))
    await settle()
    expect(onError).toHaveBeenCalledWith(new Error('menu gone'))
    expect(player.getState().status).toBe('playing')
  })

  it('sends a failed update again a second later, even when nothing changes since', async () => {
    const { player, shell, shown } = setup()
    const onError = vi.fn()
    connectTray(player, shell, { onError })
    await player.setQueue(testTracks('a'))
    await settle()
    vi.mocked(shell.setNowPlaying).mockRejectedValueOnce(new Error('busy'))
    player.pause()
    await settle()
    expect(onError).toHaveBeenCalledWith(new Error('busy'))
    // The shell still believes the track plays, and a paused player commits nothing more.
    expect(shown.at(-1)).toEqual({ state: 'playing', title: 'a', artist: 'a artist' })
    await settle(TRAY_RETRY_MS.first - 1)
    expect(shown.at(-1)?.state).toBe('playing')
    await settle(1)
    expect(shown.at(-1)).toEqual({ state: 'paused', title: 'a', artist: 'a artist' })
    expect(onError).toHaveBeenCalledOnce()
  })

  it('asks a tray that keeps failing less and less often, and reports it once', async () => {
    const { player, engine, shell } = setup()
    const setNowPlaying = vi.mocked(shell.setNowPlaying)
    const onError = vi.fn()
    const disconnect = connectTray(player, shell, { onError })
    await player.setQueue(testTracks('a'))
    await settle()
    setNowPlaying.mockRejectedValue(new Error('no permission'))
    const before = setNowPlaying.mock.calls.length
    const calls = () => setNowPlaying.mock.calls.length - before
    player.pause()
    await settle()
    expect(calls()).toBe(1)
    // While the retry is due, changes and the many progress commits wait for it.
    await player.play()
    for (let position = 250; position <= 1000; position += 250) engine.progress(position)
    expect(calls()).toBe(1)
    await settle(TRAY_RETRY_MS.first)
    expect(calls()).toBe(2)
    expect(setNowPlaying).toHaveBeenLastCalledWith({
      state: 'playing',
      title: 'a',
      artist: 'a artist',
    })
    await settle(2000)
    expect(calls()).toBe(3)
    await settle(4000)
    expect(calls()).toBe(4)
    expect(onError).toHaveBeenCalledOnce()
    expect([1, 2, 3, 7, 8].map(trayRetryDelay)).toEqual([1000, 2000, 4000, 60_000, 60_000])
    // Disconnecting sends one last update at once, and nothing after it.
    disconnect()
    expect(calls()).toBe(5)
    expect(setNowPlaying).toHaveBeenLastCalledWith({ state: 'paused' })
    await settle(10 * 60_000)
    expect(calls()).toBe(5)
  })

  it('reports a new run of failures once an update got through', async () => {
    const { player, shell } = setup()
    const setNowPlaying = vi.mocked(shell.setNowPlaying)
    const onError = vi.fn()
    connectTray(player, shell, { onError })
    await player.setQueue(testTracks('a'))
    await settle()
    setNowPlaying.mockRejectedValueOnce(new Error('first'))
    player.pause()
    await settle(TRAY_RETRY_MS.first)
    setNowPlaying.mockRejectedValueOnce(new Error('second'))
    await player.play()
    await settle()
    expect(onError.mock.calls).toEqual([[new Error('first')], [new Error('second')]])
  })

  it('ignores the failure of an update that a newer one replaced', async () => {
    const { player, shell, shown } = setup()
    vi.mocked(shell.setNowPlaying).mockRejectedValueOnce(new Error('stale'))
    const onError = vi.fn()
    connectTray(player, shell, { onError })
    await player.setQueue(testTracks('a'))
    await settle(10_000)
    expect(onError).not.toHaveBeenCalled()
    expect(shown.at(-1)).toEqual({ state: 'playing', title: 'a', artist: 'a artist' })
    expect(shown).not.toContainEqual({ state: 'paused' })
  })

  it('sends a title with a lone surrogate to Rust as U+FFFD', async () => {
    const { player } = setup()
    const wellFormedText = (text: string) =>
      !/[\uD800-\uDFFF]/.test(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))
    // Like Rust's JSON parser, which refuses a lone surrogate escape such as \ud83c.
    const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      const sent = JSON.parse(JSON.stringify(args)) as { now: Record<string, unknown> }
      for (const value of Object.values(sent.now)) {
        if (typeof value === 'string' && !wellFormedText(value)) {
          throw new Error('lone leading surrogate in hex escape')
        }
      }
      return undefined as never
    })
    const shell = createDesktopShell({
      bindings: { invoke, listen: async () => () => {} },
    })
    const onError = vi.fn()
    connectTray(player, shell, { onError })
    // A title cut in the middle of an emoji: '🎵' is two code units.
    const cut = 'Song 🎵'.slice(0, -1)
    await player.setQueue([testTrack(cut, { artists: [{ name: '\udc35 Band' }] })])
    await settle()
    expect(onError).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenLastCalledWith('set_now_playing', {
      now: { state: 'playing', title: 'Song �', artist: '� Band' },
    })
  })
})
