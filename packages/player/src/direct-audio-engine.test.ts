import type { StreamOption } from '@fxm/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DirectAudioEngine, type DirectAudioEngineOptions } from './direct-audio-engine'
import {
  type EngineError,
  type EngineEventType,
  isEngineError,
  type PlaybackSource,
} from './engine'
import { testStream } from './testing'

const EVENT_TYPES: readonly EngineEventType[] = [
  'timeupdate',
  'durationchange',
  'play',
  'pause',
  'ended',
  'error',
  'stalled',
  'waiting',
  'canplay',
]

function setup(options: Omit<DirectAudioEngineOptions, 'createAudio'> = {}) {
  const elements: HTMLAudioElement[] = []
  const engine = new DirectAudioEngine({
    createAudio: () => {
      const element = document.createElement('audio')
      elements.push(element)
      return element
    },
    ...options,
  })
  const events: string[] = []
  const errors: EngineError[] = []
  for (const type of EVENT_TYPES) {
    engine.on(type, (payload) => {
      if (type === 'error') errors.push(payload as EngineError)
      events.push(typeof payload === 'number' ? `${type} ${payload}` : type)
    })
  }
  const [first, second] = elements as [HTMLAudioElement, HTMLAudioElement]
  return { engine, first, second, events, errors }
}

function source(name: string, overrides: Partial<StreamOption> = {}): PlaybackSource {
  return { stream: testStream(name, overrides) }
}

/** Overrides a read-only media element property, as a real browser would change it. */
function set<K extends keyof HTMLAudioElement>(
  element: HTMLAudioElement,
  key: K,
  value: HTMLAudioElement[K],
): void {
  Object.defineProperty(element, key, { value, configurable: true })
}

function fire(element: HTMLAudioElement, type: string): void {
  element.dispatchEvent(new Event(type))
}

/** Waits for deferred work: promise callbacks and microtasks. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('DirectAudioEngine: setup', () => {
  it('prepares two audio elements without crossOrigin, preloading automatically', () => {
    const { first, second } = setup()
    for (const element of [first, second]) {
      expect(element.hasAttribute('crossorigin')).toBe(false)
      expect(element.crossOrigin).toBeNull()
      expect(element.getAttribute('preload')).toBe('auto')
    }
  })

  it('removes a crossorigin attribute the element came with', () => {
    const elements: HTMLAudioElement[] = []
    new DirectAudioEngine({
      createAudio: () => {
        const element = document.createElement('audio')
        element.setAttribute('crossorigin', 'anonymous')
        elements.push(element)
        return element
      },
    })
    expect(elements.map((element) => element.hasAttribute('crossorigin'))).toEqual([false, false])
  })

  it('creates its elements with document.createElement by default', () => {
    const create = vi.spyOn(document, 'createElement')
    const engine = new DirectAudioEngine()
    expect(create.mock.calls).toEqual([['audio'], ['audio']])
    engine.destroy()
  })
})

describe('DirectAudioEngine: playback', () => {
  it('plays a stream through src, without fetching it', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { engine, first, second, events } = setup()
    await engine.load(source('a'))
    expect(first.getAttribute('src')).toBe('https://media.test/a')
    expect(second.hasAttribute('src')).toBe(false)
    await engine.play()
    expect(first.paused).toBe(false)
    expect(events).toContain('play')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports a pause, but not the one before the end', async () => {
    const { engine, first, events } = setup()
    await engine.load(source('a'))
    await engine.play()
    engine.pause()
    expect(first.paused).toBe(true)
    expect(events.filter((event) => event === 'pause')).toHaveLength(1)
    await engine.play()
    set(first, 'ended', true)
    fire(first, 'pause')
    fire(first, 'ended')
    expect(events.slice(-2)).toEqual(['play', 'ended'])
  })

  it('drops events that belong to a replaced source', async () => {
    const { engine, first, events } = setup()
    await engine.load(source('a'))
    await engine.play()
    await engine.load(source('b'))
    events.length = 0
    fire(first, 'pause')
    fire(first, 'ended')
    fire(first, 'playing')
    fire(first, 'error')
    expect(events).toEqual([])
  })

  it('reports the position and the duration in milliseconds', async () => {
    const { engine, first, events } = setup()
    await engine.load(source('a'))
    events.length = 0
    first.currentTime = 12.5
    fire(first, 'timeupdate')
    set(first, 'duration', 215.25)
    fire(first, 'durationchange')
    set(first, 'duration', Number.POSITIVE_INFINITY)
    fire(first, 'durationchange')
    set(first, 'duration', 0)
    fire(first, 'durationchange')
    expect(events).toEqual(['timeupdate 12500', 'durationchange 215250'])
  })

  it('forwards waiting and canplay, and stalled only while starved of data', async () => {
    const { engine, first, events } = setup()
    await engine.load(source('a'))
    events.length = 0
    for (const type of ['waiting', 'stalled', 'canplay']) fire(first, type)
    set(first, 'readyState', 3)
    fire(first, 'stalled')
    set(first, 'readyState', 4)
    fire(first, 'stalled')
    set(first, 'readyState', 2)
    fire(first, 'stalled')
    expect(events).toEqual(['waiting', 'stalled', 'canplay', 'stalled'])
  })

  it('starts at a position once the duration is known, reporting no position before', async () => {
    const { engine, first, events } = setup()
    await engine.load(source('a'), 42_000)
    events.length = 0
    expect(first.currentTime).toBe(0)
    fire(first, 'timeupdate')
    expect(events).toEqual([])
    set(first, 'readyState', 1)
    fire(first, 'loadedmetadata')
    expect(first.currentTime).toBe(42)
    fire(first, 'timeupdate')
    expect(events).toEqual(['timeupdate 42000'])
    first.currentTime = 50
    fire(first, 'loadedmetadata')
    expect(first.currentTime).toBe(50)
  })

  it('reports no position on a retry until the start position applies', async () => {
    const { engine, first, events } = setup()
    await engine.load(source('a'))
    await engine.play()
    first.currentTime = 10.945
    await engine.load(source('a2'), 10_945)
    events.length = 0
    first.currentTime = 0
    fire(first, 'timeupdate')
    fire(first, 'timeupdate')
    expect(events).toEqual([])
  })

  it('seeks at once when the duration is known, else when it becomes known', async () => {
    const { engine, first } = setup()
    await engine.load(source('a'))
    engine.seek(10_000)
    expect(first.currentTime).toBe(0)
    set(first, 'readyState', 4)
    fire(first, 'loadedmetadata')
    expect(first.currentTime).toBe(10)
    engine.seek(-3000)
    expect(first.currentTime).toBe(0)
    engine.seek(Number.NaN)
    expect(first.currentTime).toBe(0)
    engine.seek(90_500)
    expect(first.currentTime).toBe(90.5)
  })

  it('reloads when the same URL is loaded again', async () => {
    const { engine, first } = setup()
    await engine.load(source('a'))
    const setSrc = vi.spyOn(first, 'src', 'set')
    await engine.load(source('a'))
    expect(setSrc).toHaveBeenCalledWith('https://media.test/a')
  })

  it('does not start an element that has no source', async () => {
    const { engine, first } = setup()
    const play = vi.spyOn(first, 'play')
    await engine.play()
    expect(play).not.toHaveBeenCalled()
  })

  it('applies the volume and mute to both elements', () => {
    const { engine, first, second } = setup()
    engine.setVolume(0.3)
    engine.setMuted(true)
    expect([first.volume, second.volume, first.muted, second.muted]).toEqual([0.3, 0.3, true, true])
    engine.setVolume(7)
    expect(first.volume).toBe(1)
    engine.setVolume(-1)
    expect(second.volume).toBe(0)
    engine.setVolume(Number.NaN)
    expect(first.volume).toBe(0)
  })
})

describe('DirectAudioEngine: failures', () => {
  it.each([
    [1, 'network'],
    [2, 'network'],
    [3, 'decode'],
    [4, 'unsupported'],
  ] as const)('maps MediaError code %i to %s', async (code, type) => {
    const { engine, first, errors } = setup()
    await engine.load(source('a'))
    const mediaError = { code, message: '' } as MediaError
    set(first, 'error', mediaError)
    fire(first, 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.type).toBe(type)
    expect(errors[0]?.cause).toBe(mediaError)
    expect(errors[0]?.message).not.toBe('')
  })

  it("keeps the browser's message", async () => {
    const { engine, first, errors } = setup()
    await engine.load(source('a'))
    set(first, 'error', { code: 2, message: 'net::ERR_FAILED' } as MediaError)
    fire(first, 'error')
    expect(errors[0]?.message).toBe('net::ERR_FAILED')
  })

  it('reports a failure after the URL expired as expired, except decode errors', async () => {
    let now = 1000
    const { engine, first, errors } = setup({ now: () => now })
    await engine.load(source('a', { expiresAt: 5000 }))
    now = 6000
    for (const code of [4, 2, 3]) {
      set(first, 'error', { code, message: '' } as MediaError)
      fire(first, 'error')
    }
    expect(errors.map((error) => error.type)).toEqual(['expired', 'expired', 'decode'])
  })

  it('ignores an error event without an error', async () => {
    const { engine, first, errors } = setup()
    await engine.load(source('a'))
    fire(first, 'error')
    expect(errors).toEqual([])
  })

  it('reports a play() refused by the autoplay policy', async () => {
    const { engine, first, errors } = setup()
    await engine.load(source('a'))
    const refusal = new DOMException('play() needs a user gesture', 'NotAllowedError')
    vi.spyOn(first, 'play').mockRejectedValue(refusal)
    await engine.play()
    await flush()
    expect(errors).toHaveLength(1)
    expect(isEngineError(errors[0], 'autoplay-blocked')).toBe(true)
    expect(errors[0]?.cause).toBe(refusal)
  })

  it.each(['AbortError', 'NotSupportedError'])(
    'leaves a play() %s to other events',
    async (name) => {
      const { engine, first, errors } = setup()
      await engine.load(source('a'))
      vi.spyOn(first, 'play').mockRejectedValue(new DOMException('no', name))
      await engine.play()
      await flush()
      expect(errors).toEqual([])
    },
  )

  it('ignores a refused play() after a newer load or a non-DOM rejection', async () => {
    const { engine, first, errors } = setup()
    await engine.load(source('a'))
    const play = vi.spyOn(first, 'play')
    play.mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'))
    const playing = engine.play()
    void engine.load(source('b'))
    await playing
    await flush()
    play.mockRejectedValueOnce('weird')
    await engine.play()
    await flush()
    expect(errors).toEqual([])
  })

  it.each([
    ['an HLS stream', { protocol: 'hls' }],
    ['a DASH stream', { protocol: 'dash' }],
    ['a SABR stream', { protocol: 'sabr' }],
    ['a stream that needs request headers', { requestHeaders: { Referer: 'https://x.test' } }],
    ['a capped stream', { fullLength: 'capped' }],
  ] as const)('refuses %s without loading it', async (_name, overrides) => {
    const { engine, first, errors } = setup()
    await engine.load(source('a', overrides))
    expect(first.hasAttribute('src')).toBe(false)
    const play = vi.spyOn(first, 'play')
    await engine.play()
    expect(play).not.toHaveBeenCalled()
    await flush()
    expect(errors.map((error) => error.type)).toEqual(['unsupported'])
    expect(errors[0]?.message).not.toBe('')
  })

  it('plays a stream with an empty set of request headers', async () => {
    const { engine, first, errors } = setup()
    await engine.load(source('a', { requestHeaders: {} }))
    await flush()
    expect(first.getAttribute('src')).toBe('https://media.test/a')
    expect(errors).toEqual([])
  })

  it('refuses a stream that has already expired', async () => {
    const { engine, first, errors } = setup({ now: () => 10_000 })
    await engine.load(source('a', { expiresAt: 10_000 }))
    await flush()
    expect(first.hasAttribute('src')).toBe(false)
    expect(errors.map((error) => error.type)).toEqual(['expired'])
  })

  it('drops the refusal of a load that was replaced at once', async () => {
    const { engine, errors } = setup()
    void engine.load(source('a', { protocol: 'sabr' }))
    await engine.load(source('b'))
    await flush()
    expect(errors).toEqual([])
  })
})

describe('DirectAudioEngine: user gestures', () => {
  it('plays and pauses both empty elements at once, without reporting it', () => {
    const { engine, first, second, events } = setup()
    const plays = [vi.spyOn(first, 'play'), vi.spyOn(second, 'play')]
    engine.unlock()
    expect(plays.map((play) => play.mock.calls.length)).toEqual([1, 1])
    expect([first.paused, second.paused]).toEqual([true, true])
    expect(events).toEqual([])
    engine.unlock()
    expect(plays.map((play) => play.mock.calls.length)).toEqual([1, 1])
  })

  it('leaves an element that holds a source alone', async () => {
    const { engine, first, second } = setup()
    await engine.load(source('a'))
    const plays = [vi.spyOn(first, 'play'), vi.spyOn(second, 'play')]
    engine.unlock()
    expect(plays.map((play) => play.mock.calls.length)).toEqual([0, 1])
  })

  it('preloads only into an unlocked element', async () => {
    const { engine, second } = setup()
    await engine.load(source('a'))
    engine.preload(source('b'))
    expect(second.hasAttribute('src')).toBe(false)
    engine.unlock()
    engine.preload(source('b'))
    expect(second.getAttribute('src')).toBe('https://media.test/b')
  })

  it('keeps an element the browser refuses to start locked', async () => {
    const { engine, second } = setup()
    vi.spyOn(second, 'play').mockRejectedValue(new DOMException('no', 'NotAllowedError'))
    engine.unlock()
    await flush()
    engine.preload(source('b'))
    expect(second.hasAttribute('src')).toBe(false)
  })

  it('counts an element unlocked when the pause interrupts its start', async () => {
    const { engine, second } = setup()
    vi.spyOn(second, 'play').mockRejectedValue(new DOMException('interrupted', 'AbortError'))
    engine.unlock()
    await flush()
    engine.preload(source('b'))
    expect(second.getAttribute('src')).toBe('https://media.test/b')
  })

  it('keeps an element locked when play() throws at once', () => {
    const { engine, second } = setup()
    vi.spyOn(second, 'play').mockImplementation(() => {
      throw new TypeError('old browser')
    })
    engine.unlock()
    engine.preload(source('b'))
    expect(second.hasAttribute('src')).toBe(false)
  })

  it('starts a new source on the unlocked element when the playing one is locked', async () => {
    const { engine, first, second } = setup()
    await engine.load(source('a'))
    engine.unlock()
    await engine.load(source('b'))
    expect(first.hasAttribute('src')).toBe(false)
    expect(second.getAttribute('src')).toBe('https://media.test/b')
    const play = vi.spyOn(second, 'play')
    await engine.play()
    expect(play).toHaveBeenCalledOnce()
  })

  it('counts an element that played as unlocked', async () => {
    const { engine, first } = setup()
    await engine.load(source('a'))
    await engine.play()
    await flush()
    engine.unlock()
    engine.preload(source('b'))
    await engine.load(source('b'))
    engine.preload(source('c'))
    expect(first.getAttribute('src')).toBe('https://media.test/c')
  })
})

describe('DirectAudioEngine: preloading', () => {
  it('preloads the next stream in the second element and swaps to it', async () => {
    const { engine, first, second, events } = setup()
    engine.unlock()
    await engine.load(source('a'))
    await engine.play()
    engine.preload(source('b'))
    expect(second.getAttribute('src')).toBe('https://media.test/b')
    fire(second, 'timeupdate')
    fire(second, 'playing')
    set(second, 'duration', 200)
    set(second, 'readyState', 4)
    events.length = 0
    await engine.load(source('b'), 1500)
    expect(first.hasAttribute('src')).toBe(false)
    expect(first.paused).toBe(true)
    expect(second.getAttribute('src')).toBe('https://media.test/b')
    expect(second.currentTime).toBe(1.5)
    expect(events).toEqual(['durationchange 200000'])
    await engine.play()
    expect(second.paused).toBe(false)
    fire(first, 'timeupdate')
    second.currentTime = 3
    fire(second, 'timeupdate')
    expect(events).toEqual(['durationchange 200000', 'play', 'timeupdate 3000'])
  })

  it('swaps without reporting a duration the preloaded element does not know yet', async () => {
    const { engine, second, events } = setup()
    engine.unlock()
    await engine.load(source('a'))
    engine.preload(source('b'))
    events.length = 0
    await engine.load(source('b'))
    expect(second.getAttribute('src')).toBe('https://media.test/b')
    expect(events).toEqual([])
  })

  it('keeps a preload that is asked for twice', () => {
    const { engine, second } = setup()
    engine.unlock()
    engine.preload(source('b'))
    const setSrc = vi.spyOn(second, 'src', 'set')
    engine.preload(source('b'))
    expect(setSrc).not.toHaveBeenCalled()
  })

  it('drops the preloaded stream on request and for streams it refuses', () => {
    const { engine, second } = setup()
    engine.unlock()
    engine.preload(source('b'))
    engine.preload(null)
    expect(second.hasAttribute('src')).toBe(false)
    engine.preload(source('b'))
    engine.preload(source('c', { protocol: 'sabr' }))
    expect(second.hasAttribute('src')).toBe(false)
  })

  it('loads normally when the preload failed', async () => {
    const { engine, first, second } = setup()
    engine.unlock()
    engine.preload(source('b'))
    set(second, 'error', { code: 2, message: '' } as MediaError)
    fire(second, 'error')
    await engine.load(source('b'))
    expect(first.getAttribute('src')).toBe('https://media.test/b')
    engine.preload(source('b'))
    expect(second.getAttribute('src')).toBe('https://media.test/b')
  })

  it('does not report events of the preloading element', async () => {
    const { engine, second, events } = setup()
    engine.unlock()
    await engine.load(source('a'))
    engine.preload(source('b'))
    events.length = 0
    for (const type of ['playing', 'pause', 'timeupdate', 'waiting', 'canplay', 'error']) {
      fire(second, type)
    }
    expect(events).toEqual([])
  })
})

describe('DirectAudioEngine: support and teardown', () => {
  it('says how sure the browser is that it can play a stream', () => {
    const { engine, first } = setup()
    const canPlayType = vi.spyOn(first, 'canPlayType').mockReturnValue('probably')
    expect(engine.canPlay(testStream('a'))).toBe('probably')
    expect(canPlayType).toHaveBeenCalledWith('audio/webm; codecs="opus"')
    canPlayType.mockReturnValue('maybe')
    expect(engine.canPlay(testStream('a', { codec: 'aac', container: 'm4a' }))).toBe('maybe')
    canPlayType.mockReturnValue('')
    expect(engine.canPlay(testStream('a'))).toBe('no')
    expect(engine.canPlay(testStream('a', { codec: 'mp3', container: 'webm' }))).toBe('maybe')
  })

  it.each([
    ['not progressive', { protocol: 'hls' }],
    ['needing request headers', { requestHeaders: { Referer: 'https://x.test' } }],
    ['capped', { fullLength: 'capped' }],
  ] as const)('cannot play a stream %s', (_name, overrides) => {
    const { engine, first } = setup()
    vi.spyOn(first, 'canPlayType').mockReturnValue('probably')
    expect(engine.canPlay(testStream('a', overrides))).toBe('no')
  })

  it('asks for the audio track of a muxed video', () => {
    const { engine, first } = setup()
    const canPlayType = vi.spyOn(first, 'canPlayType').mockReturnValue('probably')
    const itag18 = testStream('a', { codec: 'aac', container: 'mp4', media: 'muxed-video' })
    expect(engine.canPlay(itag18)).toBe('probably')
    expect(canPlayType).toHaveBeenCalledWith('audio/mp4; codecs="mp4a.40.2"')
  })

  it('releases both elements and stops reporting when destroyed', async () => {
    const { engine, first, second, events } = setup()
    engine.unlock()
    await engine.load(source('a'))
    await engine.play()
    engine.preload(source('b'))
    engine.destroy()
    engine.destroy()
    expect(first.hasAttribute('src')).toBe(false)
    expect(second.hasAttribute('src')).toBe(false)
    expect(first.paused).toBe(true)
    events.length = 0
    fire(first, 'timeupdate')
    await engine.load(source('c'))
    await engine.play()
    engine.pause()
    engine.seek(1000)
    engine.setVolume(0.5)
    engine.setMuted(true)
    engine.preload(source('d'))
    const play = vi.spyOn(second, 'play')
    engine.unlock()
    expect(play).not.toHaveBeenCalled()
    expect(first.hasAttribute('src')).toBe(false)
    expect(first.volume).toBe(1)
    expect(first.muted).toBe(false)
    expect(events).toEqual([])
  })
})
