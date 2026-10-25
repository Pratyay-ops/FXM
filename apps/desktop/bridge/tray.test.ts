import { currentQueueItem } from '@fxm/core'
import { Player } from '@fxm/player'
import { FakeEngine, FakeResolver, testTrack, testTracks } from '@fxm/player/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopShell, MediaAction, NowPlaying } from './shell'
import { connectTray, isPlaybackActive, nowPlayingOf } from './tray'

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
  const player = new Player({ engine, resolver: new FakeResolver() })
  return { engine, player, ...fakeShell() }
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
    expect(nowPlayingOf(player.getState())).toEqual({ playing: false })
    const track = testTrack('Creep', { artists: [{ name: 'Radiohead' }, { name: 'Guest' }] })
    await player.setQueue([track])
    expect(nowPlayingOf(player.getState())).toEqual({
      playing: true,
      title: 'Creep',
      artist: 'Radiohead, Guest',
    })
    player.pause()
    expect(nowPlayingOf(player.getState()).playing).toBe(false)
  })

  it('leaves out an empty artist line', async () => {
    const { player } = setup()
    await player.setQueue([testTrack('Untitled', { artists: [] })])
    expect(nowPlayingOf(player.getState())).toEqual({ playing: true, title: 'Untitled' })
  })

  it('counts loading as playing, so the close button never stops music between tracks', () => {
    expect(isPlaybackActive({ status: 'loading' })).toBe(true)
    expect(isPlaybackActive({ status: 'playing' })).toBe(true)
    for (const status of ['idle', 'paused', 'ended', 'error'] as const) {
      expect(isPlaybackActive({ status }), status).toBe(false)
    }
  })
})

describe('connectTray', () => {
  it('shows the state at once and then only what changes', async () => {
    const { player, engine, shell, shown } = setup()
    connectTray(player, shell)
    expect(shown).toEqual([{ playing: false }])
    await player.setQueue(testTracks('a', 'b'))
    expect(shown.at(-1)).toEqual({ playing: true, title: 'a', artist: 'a artist' })
    const sent = shown.length
    for (let position = 1000; position <= 5000; position += 1000) engine.progress(position)
    expect(shown).toHaveLength(sent)
    player.pause()
    expect(shown.slice(sent)).toEqual([{ playing: false, title: 'a', artist: 'a artist' }])
  })

  it('follows the queue from track to track', async () => {
    const { player, engine, shell, shown } = setup()
    connectTray(player, shell)
    await player.setQueue(testTracks('a', 'b'))
    engine.end()
    await settle()
    expect(current(player)).toBe('b')
    expect(shown.at(-1)).toEqual({ playing: true, title: 'b', artist: 'b artist' })
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
    expect(shown.at(-1)).toEqual({ playing: false })
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
})
