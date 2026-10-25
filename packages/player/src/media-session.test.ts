import { currentQueueItem } from '@fxm/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  connectMediaSession,
  MEDIA_SESSION_ACTIONS,
  type MediaSessionOptions,
  mediaImages,
  mediaMetadataInit,
} from './media-session'
import { Player } from './player'
import type { ResolvedStream } from './resolver'
import { FakeEngine, FakeResolver, testStream, testTrack, testTracks } from './testing'

/** Records what the player does to the Media Session. */
class FakeSession {
  metadata: unknown = null
  playbackState: MediaSessionPlaybackState = 'none'
  readonly handlers = new Map<string, MediaSessionActionHandler | null>()
  readonly positions: (MediaPositionState | undefined)[] = []
  readonly unsupported = new Set<string>()
  rejectPositions = false

  setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void {
    if (this.unsupported.has(action)) throw new TypeError(`"${action}" is not supported`)
    this.handlers.set(action, handler)
  }

  setPositionState(state?: MediaPositionState): void {
    if (this.rejectPositions) throw new TypeError('Invalid position')
    this.positions.push(state)
  }

  /** Runs an action as the system would. */
  act(action: MediaSessionAction, details: Partial<MediaSessionActionDetails> = {}): void {
    this.handlers.get(action)?.({ action, ...details })
  }
}

function setup(options: MediaSessionOptions = {}, session = new FakeSession()) {
  const engine = new FakeEngine()
  const resolver = new FakeResolver()
  const player = new Player({ engine, resolver })
  let now = 0
  const metadata = vi.fn((init: MediaMetadataInit) => init as unknown as MediaMetadata)
  const disconnect = connectMediaSession(player, {
    session: session as unknown as MediaSession,
    createMetadata: metadata,
    now: () => now,
    ...options,
  })
  const tick = (ms: number) => {
    now += ms
  }
  return { engine, resolver, player, session, metadata, disconnect, tick }
}

/** Lets the player's pending promise chains finish. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const current = (player: Player) => currentQueueItem(player.getState().queue)?.track.title
const position = (state: MediaPositionState | undefined) => state?.position

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('mediaMetadataInit', () => {
  it('shows the title, every artist, the album and every artwork size', () => {
    const track = testTrack('Song', {
      artists: [{ name: 'One' }, { name: 'Two' }],
      album: { name: 'Album' },
      artwork: [
        { url: 'https://i.test/s.jpg', width: 60, height: 60 },
        { url: 'https://i.test/l.jpg', width: 544, height: 544 },
        { url: 'https://i.test/u.jpg' },
      ],
    })
    expect(mediaMetadataInit(track)).toEqual({
      title: 'Song',
      artist: 'One, Two',
      album: 'Album',
      artwork: [
        { src: 'https://i.test/s.jpg', sizes: '60x60' },
        { src: 'https://i.test/l.jpg', sizes: '544x544' },
        { src: 'https://i.test/u.jpg' },
      ],
    })
  })

  it('leaves the album empty when the track has none', () => {
    expect(mediaMetadataInit(testTrack('Song')).album).toBe('')
  })

  it('leaves out sizes that are unknown or zero', () => {
    expect(
      mediaImages([
        { url: 'a', width: 0, height: 0 },
        { url: 'b', width: 100 },
      ]),
    ).toEqual([{ src: 'a' }, { src: 'b' }])
  })
})

describe('connectMediaSession', () => {
  it('does nothing where the browser has no Media Session', async () => {
    const player = new Player({ engine: new FakeEngine(), resolver: new FakeResolver() })
    const disconnect = connectMediaSession(player)
    await player.setQueue(testTracks('a'))
    expect(() => disconnect()).not.toThrow()
  })

  it("uses the browser's session and MediaMetadata by default", async () => {
    const session = new FakeSession()
    Object.defineProperty(navigator, 'mediaSession', { value: session, configurable: true })
    vi.stubGlobal(
      'MediaMetadata',
      class {
        constructor(readonly init: MediaMetadataInit) {}
      },
    )
    try {
      const player = new Player({ engine: new FakeEngine(), resolver: new FakeResolver() })
      const disconnect = connectMediaSession(player)
      await player.setQueue(testTracks('a'))
      expect(session.metadata).toMatchObject({ init: { title: 'a' } })
      expect(session.handlers.size).toBe(MEDIA_SESSION_ACTIONS.length)
      disconnect()
    } finally {
      Reflect.deleteProperty(navigator, 'mediaSession')
    }
  })

  it('leaves the metadata empty without MediaMetadata', async () => {
    const session = new FakeSession()
    const player = new Player({ engine: new FakeEngine(), resolver: new FakeResolver() })
    connectMediaSession(player, { session: session as unknown as MediaSession })
    await player.setQueue(testTracks('a'))
    expect(session.metadata).toBeNull()
    expect(session.playbackState).toBe('playing')
  })

  it('registers every action', () => {
    const { session } = setup()
    expect([...session.handlers.keys()]).toEqual([...MEDIA_SESSION_ACTIONS])
    expect(MEDIA_SESSION_ACTIONS).toEqual([
      'play',
      'pause',
      'previoustrack',
      'nexttrack',
      'seekto',
      'seekbackward',
      'seekforward',
      'stop',
    ])
  })

  it('skips actions the browser does not support', () => {
    const session = new FakeSession()
    session.unsupported.add('seekto')
    session.unsupported.add('stop')
    setup({}, session)
    expect([...session.handlers.keys()]).toEqual([
      'play',
      'pause',
      'previoustrack',
      'nexttrack',
      'seekbackward',
      'seekforward',
    ])
  })

  it('sends the actions to the player', async () => {
    const { player, session } = setup()
    await player.setQueue(testTracks('a', 'b', 'c'))
    session.act('pause')
    expect(player.getState().status).toBe('paused')
    session.act('play')
    await flush()
    expect(player.getState().status).toBe('playing')
    session.act('nexttrack')
    await flush()
    expect(current(player)).toBe('b')
    session.act('previoustrack')
    await flush()
    expect(current(player)).toBe('a')
    session.act('seekto', { seekTime: 42.5 })
    expect(player.getState().positionMs).toBe(42_500)
    session.act('seekto', {})
    session.act('seekbackward')
    expect(player.getState().positionMs).toBe(32_500)
    session.act('seekforward', { seekOffset: 5 })
    expect(player.getState().positionMs).toBe(37_500)
    session.act('seekforward', { seekOffset: 0 })
    expect(player.getState().positionMs).toBe(47_500)
    session.act('stop')
    expect(player.getState()).toMatchObject({ status: 'paused', positionMs: 0 })
  })

  it('uses the configured seek step', async () => {
    const { player, session } = setup({ seekOffsetMs: 15_000 })
    await player.setQueue(testTracks('a'))
    session.act('seekforward')
    expect(player.getState().positionMs).toBe(15_000)
  })

  it('shows the current track and follows track changes', async () => {
    const { player, session, metadata } = setup()
    expect(session.metadata).toBeNull()
    await player.setQueue([
      testTrack('a', { album: { name: 'Album' }, artwork: [{ url: 'https://i.test/a.jpg' }] }),
      testTrack('b'),
    ])
    expect(session.metadata).toEqual({
      title: 'a',
      artist: 'a artist',
      album: 'Album',
      artwork: [{ src: 'https://i.test/a.jpg' }],
    })
    player.seek(1000)
    player.pause()
    expect(metadata).toHaveBeenCalledOnce()
    await player.next()
    expect(session.metadata).toMatchObject({ title: 'b' })
    player.remove(1)
    player.remove(0)
    expect(session.metadata).toBeNull()
    expect(session.playbackState).toBe('none')
  })

  it('drops the artwork when the browser rejects it, and the metadata if it must', async () => {
    const strict = (init: MediaMetadataInit) => {
      if ((init.artwork ?? []).length > 0) throw new TypeError('Invalid image URL')
      if (init.title === 'bad') throw new TypeError('Invalid metadata')
      return init as unknown as MediaMetadata
    }
    const { player, session } = setup({ createMetadata: strict })
    await player.setQueue([
      testTrack('a', { artwork: [{ url: 'not a url' }] }),
      testTrack('bad', { artwork: [{ url: 'not a url' }] }),
    ])
    expect(session.metadata).toMatchObject({ title: 'a', artwork: [] })
    await player.next()
    expect(session.metadata).toBeNull()
    expect(session.playbackState).toBe('playing')
  })

  it('updates the position for a new item of the same track', async () => {
    const { player, session } = setup()
    const track = testTrack('a')
    await player.setQueue([track, track])
    session.positions.length = 0
    await player.next()
    expect(session.positions.at(-1)).toEqual({ duration: 180, playbackRate: 1, position: 0 })
  })

  it('mirrors the playback state', async () => {
    const { player, engine, resolver, session } = setup()
    expect(session.playbackState).toBe('none')
    let release: (value: ResolvedStream) => void = () => {}
    resolver.handler = () =>
      new Promise((resolve) => {
        release = resolve
      })
    const starting = player.setQueue(testTracks('a'))
    expect(player.getState().status).toBe('loading')
    expect(session.playbackState).toBe('playing')
    release({ stream: testStream('a') })
    await starting
    expect(player.getState().status).toBe('playing')
    player.pause()
    expect(session.playbackState).toBe('paused')
    engine.end()
    expect(player.getState().status).toBe('ended')
    expect(session.playbackState).toBe('paused')
  })

  it('sends the position at once on changes and spaces it out during playback', async () => {
    const { player, engine, session, tick } = setup()
    expect(session.positions).toEqual([undefined])
    await player.setQueue(testTracks('a', 'b'))
    expect(session.positions.at(-1)).toEqual({ duration: 180, playbackRate: 1, position: 0 })
    const sent = session.positions.length
    engine.progress(500)
    tick(999)
    engine.progress(1500)
    expect(session.positions).toHaveLength(sent)
    tick(1)
    engine.progress(1600)
    expect(session.positions).toHaveLength(sent + 1)
    expect(position(session.positions.at(-1))).toBe(1.6)
    player.seek(60_000)
    expect(position(session.positions.at(-1))).toBe(60)
    player.pause()
    expect(session.positions).toHaveLength(sent + 3)
    engine.emit('durationchange', 200_000)
    expect(session.positions.at(-1)).toEqual({ duration: 200, playbackRate: 1, position: 60 })
  })

  it('keeps the position within the duration', async () => {
    const { player, engine, session } = setup()
    await player.setQueue(testTracks('a'))
    engine.emit('durationchange', 100_000)
    player.seek(100_000)
    engine.progress(150_000)
    player.pause()
    expect(position(session.positions.at(-1))).toBe(100)
  })

  it('clears the position while the duration is unknown', async () => {
    const { player, session } = setup()
    const { durationMs: _unknown, ...track } = testTrack('a')
    await player.setQueue([track])
    expect(session.positions.at(-1)).toBeUndefined()
    expect(session.positions.length).toBeGreaterThan(1)
  })

  it('survives a browser that rejects the position or cannot take one', async () => {
    const rejecting = new FakeSession()
    rejecting.rejectPositions = true
    const { player } = setup({}, rejecting)
    await expect(player.setQueue(testTracks('a'))).resolves.toBeUndefined()
    const bare = { metadata: null, playbackState: 'none', setActionHandler: () => {} }
    const other = new Player({ engine: new FakeEngine(), resolver: new FakeResolver() })
    const disconnect = connectMediaSession(other, { session: bare as unknown as MediaSession })
    await other.setQueue(testTracks('a'))
    expect(bare.playbackState).toBe('playing')
    expect(() => disconnect()).not.toThrow()
  })

  it('disconnects and clears the session', async () => {
    const { player, session, disconnect } = setup()
    await player.setQueue(testTracks('a', 'b'))
    disconnect()
    expect([...session.handlers.values()].every((handler) => handler === null)).toBe(true)
    expect(session.metadata).toBeNull()
    expect(session.playbackState).toBe('none')
    expect(session.positions.at(-1)).toBeUndefined()
    const sent = session.positions.length
    await player.next()
    player.seek(5000)
    expect(session.metadata).toBeNull()
    expect(session.positions).toHaveLength(sent)
  })

  it('disconnects quietly when clearing the position fails', async () => {
    const { session, disconnect } = setup()
    session.rejectPositions = true
    expect(() => disconnect()).not.toThrow()
  })
})
