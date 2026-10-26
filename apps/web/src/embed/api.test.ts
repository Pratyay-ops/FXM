import { createQueue, formatId, setQueue } from '@fxm/core'
import type { PlayerState } from '@fxm/player'
import { describe, expect, it, vi } from 'vitest'
import {
  connectEmbedApi,
  EMBED_COMMANDS,
  type EmbedApiController,
  type EmbedApiWindow,
  MAX_SEEK_MS,
  RATE_LIMIT,
  readMessage,
  toApiState,
} from './api'
import type { EmbedState } from './controller'
import { SONG_A, SONG_B } from './testing/harness'

const PAGE = 'https://blog.example'
const TARGET = { kind: 'album', id: formatId('ytm', 'album', 'MPREb_x') } as const

describe('readMessage', () => {
  it('reads a hello and every command with its parameters', () => {
    expect(readMessage({ type: 'fxm-embed:hello', protocol: 1 })).toEqual({ kind: 'hello' })
    for (const command of ['pause', 'toggle', 'next', 'previous', 'getState'] as const) {
      expect(readMessage({ type: 'fxm-embed:command', command })).toEqual({
        kind: 'command',
        command: { command },
      })
    }
    expect(readMessage({ type: 'fxm-embed:command', protocol: 1, command: 'play' })).toEqual({
      kind: 'command',
      command: { command: 'play' },
    })
    expect(
      readMessage({ type: 'fxm-embed:command', command: 'play', index: 2, id: 'track-3' }),
    ).toEqual({ kind: 'command', command: { command: 'play', index: 2 }, id: 'track-3' })
    expect(readMessage({ type: 'fxm-embed:command', command: 'seek', positionMs: 1500 })).toEqual({
      kind: 'command',
      command: { command: 'seek', positionMs: 1500 },
    })
    expect(readMessage({ type: 'fxm-embed:command', command: 'setVolume', volume: 0.5 })).toEqual({
      kind: 'command',
      command: { command: 'setVolume', volume: 0.5 },
    })
    expect(
      readMessage({ type: 'fxm-embed:command', command: 'setMuted', muted: false, id: 4 }),
    ).toEqual({ kind: 'command', command: { command: 'setMuted', muted: false }, id: 4 })
    expect(EMBED_COMMANDS).toHaveLength(9)
  })

  it.each([
    ['a string', 'fxm-embed:hello'],
    ['an array', ['fxm-embed:hello']],
    ['null', null],
    ['an object of a class', new Date()],
    ['no type', { command: 'play' }],
    ['another library', { type: 'yt-player:play' }],
    ['its own ready, echoed back', { type: 'fxm-embed:ready', protocol: 1 }],
    ['its own state, echoed back', { type: 'fxm-embed:state', state: {} }],
    ['its own error, echoed back', { type: 'fxm-embed:error', code: 'bad-request' }],
  ])('ignores %s', (_name, data) => {
    expect(readMessage(data)).toEqual({ kind: 'ignore' })
  })

  it.each([
    ['an unknown type', { type: 'fxm-embed:eject' }, { code: 'unsupported' }],
    [
      'a hello of another protocol',
      { type: 'fxm-embed:hello', protocol: 2 },
      { code: 'unsupported' },
    ],
    ['a hello without a protocol', { type: 'fxm-embed:hello' }, { code: 'unsupported' }],
    [
      'a hello with extra fields',
      { type: 'fxm-embed:hello', protocol: 1, x: 1 },
      { code: 'bad-request' },
    ],
    [
      'an unknown command',
      { type: 'fxm-embed:command', command: 'eject' },
      { code: 'unsupported' },
    ],
    [
      'an inherited name',
      { type: 'fxm-embed:command', command: 'toString' },
      { code: 'unsupported' },
    ],
    [
      'a command of another protocol',
      { type: 'fxm-embed:command', protocol: 2, command: 'play', id: 'a' },
      { code: 'unsupported', id: 'a' },
    ],
    [
      'a malformed id',
      { type: 'fxm-embed:command', command: 'play', id: 'has space' },
      { code: 'bad-request' },
    ],
    [
      'a negative id',
      { type: 'fxm-embed:command', command: 'play', id: -1 },
      { code: 'bad-request' },
    ],
    [
      'a long id',
      { type: 'fxm-embed:command', command: 'play', id: 'x'.repeat(65) },
      { code: 'bad-request' },
    ],
    [
      'an extra field',
      { type: 'fxm-embed:command', command: 'pause', force: true },
      { code: 'bad-request', command: 'pause' },
    ],
    [
      'a field of another command',
      { type: 'fxm-embed:command', command: 'pause', volume: 1 },
      { code: 'bad-request', command: 'pause' },
    ],
    [
      'a fractional index',
      { type: 'fxm-embed:command', command: 'play', index: 1.5 },
      { code: 'bad-request', command: 'play' },
    ],
    [
      'a negative index',
      { type: 'fxm-embed:command', command: 'play', index: -1 },
      { code: 'bad-request', command: 'play' },
    ],
    [
      'an index as text',
      { type: 'fxm-embed:command', command: 'play', index: '1' },
      { code: 'bad-request', command: 'play' },
    ],
    [
      'a seek without a position',
      { type: 'fxm-embed:command', command: 'seek' },
      { code: 'bad-request', command: 'seek' },
    ],
    [
      'a seek to NaN',
      { type: 'fxm-embed:command', command: 'seek', positionMs: Number.NaN },
      { code: 'bad-request', command: 'seek' },
    ],
    [
      'a seek before the start',
      { type: 'fxm-embed:command', command: 'seek', positionMs: -1 },
      { code: 'bad-request', command: 'seek' },
    ],
    [
      'a seek past a day',
      { type: 'fxm-embed:command', command: 'seek', positionMs: MAX_SEEK_MS + 1 },
      { code: 'bad-request', command: 'seek' },
    ],
    [
      'a volume above 1',
      { type: 'fxm-embed:command', command: 'setVolume', volume: 1.01 },
      { code: 'bad-request', command: 'setVolume' },
    ],
    [
      'an infinite volume',
      { type: 'fxm-embed:command', command: 'setVolume', volume: Number.POSITIVE_INFINITY },
      { code: 'bad-request', command: 'setVolume' },
    ],
    [
      'a mute as a number',
      { type: 'fxm-embed:command', command: 'setMuted', muted: 1 },
      { code: 'bad-request', command: 'setMuted' },
    ],
  ])('refuses %s', (_name, data, refusal) => {
    expect(readMessage(data)).toEqual({ kind: 'reject', ...refusal })
  })
})

describe('toApiState', () => {
  it('says only what the player shows', () => {
    expect(toApiState({ phase: 'loading', tier: 'full' })).toEqual({
      status: 'preparing',
      buffering: false,
      index: -1,
      trackCount: 0,
      positionMs: 0,
      durationMs: null,
      volume: 1,
      muted: false,
      track: null,
    })
    expect(
      toApiState({ phase: 'unavailable', problem: 'needs-youtube', tier: 'free' }).status,
    ).toBe('unavailable')
    const ready = readyState({ status: 'playing', positionMs: 1234.6, durationMs: 200_000.4 })
    expect(toApiState(ready)).toEqual({
      status: 'idle',
      buffering: false,
      index: 0,
      trackCount: 2,
      positionMs: 1235,
      durationMs: 200_000,
      volume: 1,
      muted: false,
      track: { id: SONG_A.id, title: SONG_A.title, artists: ['The Testers'] },
    })
    expect(toApiState({ ...ready, started: true }).status).toBe('playing')
    // The tier never leaks.
    expect(JSON.stringify(toApiState({ ...ready, tier: 'full' }))).not.toMatch(/full|lite|free/)
  })
})

/** A ready embed with SONG_A and SONG_B queued. */
function readyState(player: Partial<PlayerState> = {}, started = false): EmbedState {
  const queue = setQueue(createQueue(), [SONG_A, SONG_B])
  return {
    phase: 'ready',
    tier: 'lite',
    ...(started ? { started } : {}),
    player: {
      queue,
      status: 'paused',
      buffering: false,
      positionMs: 0,
      durationMs: 200_000,
      volume: 1,
      muted: false,
      stream: undefined,
      error: undefined,
      playbackRate: 1,
      effects: { equalizer: 'off', loudness: 'off', loudnessGainDb: 0 },
      sleepTimer: undefined,
      ...player,
    },
  }
}

/** A fake player window inside a fake parent, and a fake controller. */
function setup(
  options: { controllerOrigin?: string; state?: EmbedState; topLevel?: boolean } = {},
) {
  const posted: { message: Record<string, unknown>; origin: string }[] = []
  const listeners = new Set<(event: MessageEvent) => void>()
  const parent = { postMessage: vi.fn((message, origin) => posted.push({ message, origin })) }
  const sibling = { postMessage: vi.fn() }
  const window: EmbedApiWindow = {
    parent,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  }
  if (options.topLevel) Object.assign(window, { parent: window })
  let state: EmbedState = options.state ?? readyState()
  let visible = true
  const changes = new Set<() => void>()
  const controller = {
    target: TARGET,
    getState: () => state,
    subscribe: (listener: () => void) => {
      changes.add(listener)
      return () => changes.delete(listener)
    },
    play: vi.fn(),
    pause: vi.fn(),
    toggle: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    seek: vi.fn(),
    setVolume: vi.fn(),
    setMuted: vi.fn(),
  } satisfies EmbedApiController
  let now = 1_000_000
  const stop = connectEmbedApi({
    window,
    controller,
    visibility: { visible: () => visible },
    now: () => now,
    ...(options.controllerOrigin === undefined
      ? {}
      : { controllerOrigin: options.controllerOrigin }),
  })
  return {
    controller,
    parent,
    posted,
    listeners,
    stop,
    /** A message from `source` (the parent by default) at `origin`. */
    send(data: unknown, origin = PAGE, source: unknown = parent) {
      for (const listener of [...listeners]) {
        listener({ data, origin, source } as unknown as MessageEvent)
      }
    },
    sibling,
    setState(next: EmbedState) {
      state = next
      for (const listener of [...changes]) listener()
    },
    advance(ms: number) {
      now += ms
    },
    /** Shows or hides the player, as its visibility gate would see it. */
    setVisible(next: boolean) {
      visible = next
    },
    types: () => posted.map(({ message }) => message.type),
  }
}

const hello = { type: 'fxm-embed:hello', protocol: 1 }
const command = (fields: Record<string, unknown>) => ({ type: 'fxm-embed:command', ...fields })

describe('connectEmbedApi', () => {
  it('pairs with the parent on its hello and answers its origin only', () => {
    const api = setup()
    api.send(command({ command: 'play' }))
    expect(api.controller.play).not.toHaveBeenCalled()
    expect(api.posted).toEqual([])

    api.send(hello)

    expect(api.posted).toEqual([
      {
        origin: PAGE,
        message: {
          type: 'fxm-embed:ready',
          protocol: 1,
          embed: { kind: 'album', id: TARGET.id, title: null, trackCount: 2 },
          state: expect.objectContaining({ status: 'idle', trackCount: 2 }),
        },
      },
    ])
    api.send(command({ command: 'play', index: 1 }))
    expect(api.controller.play).toHaveBeenCalledWith(1)
  })

  it('ignores every window but its parent, and every origin but the paired one', () => {
    const api = setup()
    api.send(hello, 'https://evil.example', api.sibling)
    api.send(hello, 'null')
    expect(api.posted).toEqual([])

    api.send(hello)
    api.send(command({ command: 'pause' }), 'https://evil.example')
    api.send(command({ command: 'pause' }), PAGE, api.sibling)
    api.send(hello, 'https://evil.example')
    expect(api.controller.pause).not.toHaveBeenCalled()
    expect(api.types()).toEqual(['fxm-embed:ready'])
  })

  it('does nothing at top level, where there is no embedding page', () => {
    const api = setup({ topLevel: true })
    expect(api.listeners.size).toBe(0)
  })

  it('pairs only with the origin its address names, and announces itself to it', () => {
    const api = setup({ controllerOrigin: PAGE, state: { phase: 'loading' } })
    expect(api.posted).toEqual([])
    api.setState(readyState())
    expect(api.posted).toEqual([expect.objectContaining({ origin: PAGE })])
    expect(api.types()).toEqual(['fxm-embed:ready'])

    // Commands need no hello then; other origins still can't pair.
    api.send(command({ command: 'pause' }))
    expect(api.controller.pause).toHaveBeenCalled()
    api.send(hello, 'https://other.example')
    expect(api.posted).toHaveLength(1)
  })

  it('waits for the content before it says it is ready', () => {
    const api = setup({ state: { phase: 'loading' } })
    api.send(hello)
    expect(api.posted).toEqual([])
    api.setState({ phase: 'unavailable', problem: 'not-found' })
    expect(api.posted).toEqual([
      {
        origin: PAGE,
        message: expect.objectContaining({
          type: 'fxm-embed:ready',
          state: expect.objectContaining({ status: 'unavailable' }),
        }),
      },
    ])
  })

  it('answers bad messages from its parent with the reason', () => {
    const api = setup()
    // Before pairing, a bad hello still learns why.
    api.send({ type: 'fxm-embed:hello', protocol: 9 })
    api.send(hello)
    api.send(command({ command: 'seek', positionMs: -1, id: 'q1' }))
    api.send(command({ command: 'play', index: 5, id: 'q2' }))
    api.send(command({ command: 'getState' }))
    expect(api.posted.map(({ message, origin }) => ({ origin, ...message }))).toEqual([
      { origin: PAGE, type: 'fxm-embed:error', protocol: 1, code: 'unsupported' },
      expect.objectContaining({ type: 'fxm-embed:ready' }),
      {
        origin: PAGE,
        type: 'fxm-embed:error',
        protocol: 1,
        code: 'bad-request',
        id: 'q1',
        command: 'seek',
      },
      {
        origin: PAGE,
        type: 'fxm-embed:error',
        protocol: 1,
        code: 'bad-request',
        id: 'q2',
        command: 'play',
      },
      expect.objectContaining({ type: 'fxm-embed:state' }),
    ])
  })

  it('runs commands only once the content is ready, but always pauses and sets the volume', () => {
    const api = setup({ state: { phase: 'loading' } })
    api.send(hello)
    api.send(command({ command: 'play', id: 'early' }))
    api.send(command({ command: 'seek', positionMs: 10 }))
    api.send(command({ command: 'pause' }))
    api.send(command({ command: 'setVolume', volume: 0.25 }))
    api.send(command({ command: 'setMuted', muted: true }))
    expect(api.controller.play).not.toHaveBeenCalled()
    expect(api.controller.seek).not.toHaveBeenCalled()
    expect(api.controller.pause).toHaveBeenCalled()
    expect(api.controller.setVolume).toHaveBeenCalledWith(0.25)
    expect(api.controller.setMuted).toHaveBeenCalledWith(true)
    expect(api.posted.map(({ message }) => message.code)).toEqual(['not-ready', 'not-ready'])

    api.setState(readyState())
    api.send(command({ command: 'seek', positionMs: 10 }))
    api.send(command({ command: 'toggle' }))
    api.send(command({ command: 'next' }))
    api.send(command({ command: 'previous' }))
    expect(api.controller.seek).toHaveBeenCalledWith(10)
    expect(api.controller.toggle).toHaveBeenCalled()
    expect(api.controller.next).toHaveBeenCalled()
    expect(api.controller.previous).toHaveBeenCalled()
  })

  it('limits commands that start a track to 10 a minute', () => {
    const api = setup({ state: readyState({ status: 'paused' }, true) })
    api.send(hello)
    for (let count = 0; count < RATE_LIMIT.max; count++) api.send(command({ command: 'next' }))
    api.send(command({ command: 'previous', id: 'too-many' }))
    api.send(command({ command: 'play', index: 0 }))
    expect(api.controller.next).toHaveBeenCalledTimes(RATE_LIMIT.max)
    expect(api.controller.previous).not.toHaveBeenCalled()
    expect(api.posted.filter(({ message }) => message.code === 'rate-limited')).toHaveLength(2)

    // Resuming a paused track starts nothing new, so it isn't limited.
    api.send(command({ command: 'play' }))
    api.send(command({ command: 'toggle' }))
    expect(api.controller.play).toHaveBeenCalledTimes(1)
    expect(api.controller.toggle).toHaveBeenCalledTimes(1)

    api.advance(RATE_LIMIT.windowMs)
    api.send(command({ command: 'previous' }))
    expect(api.controller.previous).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['before the first play', readyState()],
    ['after the queue ended', readyState({ status: 'ended' }, true)],
    ['after playback failed', readyState({ status: 'error' }, true)],
  ])('limits play %s, which resolves the track', (_name, state) => {
    const api = setup({ state })
    api.send(hello)
    for (let count = 0; count <= RATE_LIMIT.max; count++) api.send(command({ command: 'toggle' }))
    api.send(command({ command: 'play' }))
    expect(api.controller.toggle).toHaveBeenCalledTimes(RATE_LIMIT.max)
    expect(api.controller.play).not.toHaveBeenCalled()
  })

  it('starts or skips playback only while the player is visible', () => {
    const api = setup({ state: readyState({ status: 'paused' }, true) })
    api.send(hello)
    api.setVisible(false)
    api.send(command({ command: 'play', id: 'p' }))
    api.send(command({ command: 'play', index: 1, id: 'p1' }))
    api.send(command({ command: 'toggle', id: 't' }))
    api.send(command({ command: 'next', id: 'n' }))
    api.send(command({ command: 'previous', id: 'b' }))
    expect(api.controller.play).not.toHaveBeenCalled()
    expect(api.controller.toggle).not.toHaveBeenCalled()
    expect(api.controller.next).not.toHaveBeenCalled()
    expect(api.controller.previous).not.toHaveBeenCalled()
    expect(
      api.posted
        .filter(({ message }) => message.type === 'fxm-embed:error')
        .map(({ message }) => [message.id, message.code, message.command]),
    ).toEqual([
      ['p', 'not-visible', 'play'],
      ['p1', 'not-visible', 'play'],
      ['t', 'not-visible', 'toggle'],
      ['n', 'not-visible', 'next'],
      ['b', 'not-visible', 'previous'],
    ])

    // Pausing, seeking and the volume work hidden too, and so does toggle when it pauses.
    api.send(command({ command: 'pause' }))
    api.send(command({ command: 'seek', positionMs: 1000 }))
    api.send(command({ command: 'setVolume', volume: 0.5 }))
    expect(api.controller.pause).toHaveBeenCalled()
    expect(api.controller.seek).toHaveBeenCalledWith(1000)
    expect(api.controller.setVolume).toHaveBeenCalledWith(0.5)
    api.setState(readyState({ status: 'playing' }, true))
    api.send(command({ command: 'toggle' }))
    expect(api.controller.toggle).toHaveBeenCalledTimes(1)

    // Refusals cost no slot of the rate limit: once shown, all ten are there.
    api.setVisible(true)
    for (let count = 0; count < RATE_LIMIT.max; count++) api.send(command({ command: 'next' }))
    expect(api.controller.next).toHaveBeenCalledTimes(RATE_LIMIT.max)
  })

  it('reports changes, and the position at most once a second while playing', () => {
    const api = setup({ state: readyState({ status: 'playing' }, true) })
    api.send(hello)
    api.posted.length = 0

    api.setState(readyState({ status: 'playing', positionMs: 400 }, true))
    expect(api.posted).toEqual([])
    api.advance(1000)
    api.setState(readyState({ status: 'playing', positionMs: 1200 }, true))
    expect(api.types()).toEqual(['fxm-embed:state'])
    // A jump goes at once.
    api.setState(readyState({ status: 'playing', positionMs: 90_000 }, true))
    expect(api.posted).toHaveLength(2)
    // So does anything but the position.
    api.setState(readyState({ status: 'paused', positionMs: 90_000 }, true))
    api.setState(readyState({ status: 'paused', positionMs: 90_000, muted: true }, true))
    expect(api.posted).toHaveLength(4)
    // While paused, a seek goes at once too.
    api.setState(readyState({ status: 'paused', positionMs: 91_000, muted: true }, true))
    expect(api.posted).toHaveLength(5)
    // Nothing new, nothing said.
    api.setState(readyState({ status: 'paused', positionMs: 91_000, muted: true }, true))
    expect(api.posted).toHaveLength(5)
  })

  it('stops listening when stopped', () => {
    const api = setup()
    api.stop()
    api.send(hello)
    expect(api.posted).toEqual([])
    expect(api.listeners.size).toBe(0)
  })

  it('survives a page that has gone away', () => {
    const api = setup()
    api.send(hello)
    api.parent.postMessage.mockImplementation(() => {
      throw new Error('The page has gone away')
    })
    expect(() => api.setState(readyState({ status: 'paused', muted: true }))).not.toThrow()
    expect(() => api.send(command({ command: 'getState' }))).not.toThrow()
  })
})
