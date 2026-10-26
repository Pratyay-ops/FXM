import {
  type AudioEffectsSettings,
  DEFAULT_AUDIO_EFFECTS,
  dbToGain,
  equalizerHeadroomDb,
  equalizerPreset,
  equalizerResponseDb,
  type StreamLoudness,
  type StreamOption,
} from '@fxm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectAudioEngine, type DirectAudioEngineOptions } from './direct-audio-engine'
import type { AudioEffectsStatus, EngineEffects, PlaybackSource } from './engine'
import { testStream } from './testing'
import { FakeAudioContext } from './testing/fake-audio-context'

const RATE = 48_000
const ROCK = equalizerPreset('rock').gainsDb

function effects(patch: Partial<AudioEffectsSettings> = {}): EngineEffects {
  const settings = { ...DEFAULT_AUDIO_EFFECTS, ...patch }
  return { equalizer: settings.equalizer, loudness: settings.loudness }
}

const EQ_ON = effects({ equalizer: { enabled: true, gainsDb: ROCK, preset: 'rock' } })
const EQ_OFF = effects()

/** YouTube's "3.89 dB above -14 LUFS". */
const LOUD: StreamLoudness = { trackLufs: -10.11, source: 'youtube' }
/** A quiet local file whose ReplayGain allows +6 dB at most. */
const QUIET: StreamLoudness = { trackLufs: -24, trackPeak: 0.5, source: 'replaygain' }

function setup(options: Partial<DirectAudioEngineOptions> = {}) {
  const elements: HTMLAudioElement[] = []
  const context = new FakeAudioContext({ sampleRate: RATE })
  let contexts = 0
  const engine = new DirectAudioEngine({
    createAudio: () => {
      const element = document.createElement('audio')
      elements.push(element)
      return element
    },
    createAudioContext: () => {
      contexts += 1
      return context
    },
    // Streams whose URL says "opaque" stand for googlevideo without FXM Connect.
    isReadable: (stream) => !stream.url.includes('opaque'),
    clock: () => Date.now(),
    ...options,
  })
  const events: string[] = []
  const statuses: AudioEffectsStatus[] = []
  for (const type of ['play', 'pause', 'ended', 'error', 'waiting'] as const) {
    engine.on(type, () => events.push(type))
  }
  engine.on('effects', (status) => statuses.push(status))
  const [plainA, plainB, routedA, routedB] = elements as [
    HTMLAudioElement,
    HTMLAudioElement,
    HTMLAudioElement,
    HTMLAudioElement,
  ]
  return {
    engine,
    context,
    elements,
    plainA,
    plainB,
    routedA,
    routedB,
    events,
    statuses,
    contexts: () => contexts,
  }
}

function source(name: string, overrides: Partial<StreamOption> = {}): PlaybackSource {
  return { stream: testStream(name, overrides) }
}

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

/** Fails `element` with a `MediaError` of `code`. */
function failWith(element: HTMLAudioElement, code: number): void {
  set(element, 'error', { code, message: '' } as MediaError)
  fire(element, 'error')
}

/** Half a second of a sine at `frequency` Hz. */
function sine(frequency: number): Float64Array {
  return Float64Array.from(
    { length: RATE / 2 },
    (_, index) => 0.25 * Math.sin((2 * Math.PI * frequency * index) / RATE),
  )
}

function levelDb(samples: ArrayLike<number>): number {
  let sum = 0
  const from = Math.floor(samples.length / 2)
  for (let index = from; index < samples.length; index++) sum += (samples[index] ?? 0) ** 2
  return 10 * Math.log10(sum / (samples.length - from))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('DirectAudioEngine: routing through Web Audio', () => {
  it('has a second pair of crossorigin elements where Web Audio exists', () => {
    const { elements, routedA, routedB, plainA, contexts } = setup()
    expect(elements).toHaveLength(4)
    expect(routedA.crossOrigin).toBe('anonymous')
    expect(routedB.crossOrigin).toBe('anonymous')
    expect(plainA.hasAttribute('crossorigin')).toBe(false)
    // The context waits until an effect needs it.
    expect(contexts()).toBe(0)
  })

  it('has none without Web Audio', () => {
    const { elements, engine } = setup({ createAudioContext: null })
    expect(elements).toHaveLength(2)
    engine.setEffects(EQ_ON)
    expect(elements).toHaveLength(2)
  })

  it('plays every stream on a plain element while no effect needs Web Audio', async () => {
    const { engine, plainA, routedA, contexts, statuses } = setup()
    engine.setEffects(EQ_OFF)
    await engine.load(source('a'))
    expect(plainA.getAttribute('src')).toBe('https://media.test/a')
    expect(routedA.hasAttribute('src')).toBe(false)
    expect(contexts()).toBe(0)
    expect(statuses.at(-1)).toEqual({ equalizer: 'off', loudness: 'no-data', loudnessGainDb: 0 })
  })

  it('plays a readable stream through the equalizer', async () => {
    const { engine, context, plainA, routedA, statuses } = setup()
    engine.setEffects(EQ_ON)
    await engine.load(source('a'))
    expect(routedA.getAttribute('src')).toBe('https://media.test/a')
    expect(plainA.hasAttribute('src')).toBe(false)
    expect(context.sources.has(routedA)).toBe(true)
    expect(statuses.at(-1)?.equalizer).toBe('on')
    // What reaches the speakers: the equalizer's curve plus its headroom.
    const input = sine(8000)
    const output = context.render(new Map([[routedA, input]]))
    const [curve = 0] = equalizerResponseDb(ROCK, [8000], RATE)
    expect(levelDb(output) - levelDb(input)).toBeCloseTo(curve + equalizerHeadroomDb(ROCK, RATE), 1)
    expect(routedA.volume).toBe(1)
  })

  it('says the equalizer is unavailable for a stream it cannot read', async () => {
    const { engine, plainA, routedA, statuses } = setup()
    engine.setEffects(EQ_ON)
    await engine.load(source('opaque-a'))
    expect(plainA.getAttribute('src')).toBe('https://media.test/opaque-a')
    expect(routedA.hasAttribute('src')).toBe(false)
    expect(statuses.at(-1)).toEqual({
      equalizer: 'unavailable',
      loudness: 'no-data',
      loudnessGainDb: 0,
    })
  })

  it('plays again without effects at once when a routed stream fails before it plays', async () => {
    const { engine, plainA, routedA, events, statuses } = setup()
    engine.setEffects(EQ_ON)
    await engine.load(source('a'), 30_000)
    // The element never gets as far as playing.
    vi.spyOn(routedA, 'play').mockResolvedValue()
    await engine.play()
    // The CORS read failed (say, after a googlevideo redirect): no error reaches the player.
    failWith(routedA, 4)
    expect(events).not.toContain('error')
    expect(plainA.getAttribute('src')).toBe('https://media.test/a')
    expect(plainA.paused).toBe(false)
    expect(statuses.at(-1)?.equalizer).toBe('unavailable')
    // The same URL plays without effects from now on.
    await engine.load(source('a'))
    expect(routedA.hasAttribute('src')).toBe(false)
  })

  it('reports a routed stream that fails after it played', async () => {
    const { engine, routedA, events } = setup()
    engine.setEffects(EQ_ON)
    await engine.load(source('a'))
    await engine.play()
    fire(routedA, 'playing')
    failWith(routedA, 2)
    expect(events).toContain('error')
  })

  it('moves the playing stream onto the equalizer when it is switched on', async () => {
    const { engine, plainA, routedA, statuses } = setup()
    engine.setEffects(EQ_OFF)
    await engine.load(source('a'))
    await engine.play()
    set(plainA, 'readyState', 4)
    plainA.currentTime = 42
    engine.setEffects(EQ_ON)
    expect(routedA.getAttribute('src')).toBe('https://media.test/a')
    expect(plainA.hasAttribute('src')).toBe(false)
    expect(routedA.paused).toBe(false)
    expect(statuses.at(-1)?.equalizer).toBe('on')
    // The position is applied once the element knows its duration.
    set(routedA, 'readyState', 1)
    fire(routedA, 'loadedmetadata')
    expect(routedA.currentTime).toBe(42)
  })

  it('stays on the routed element, flat, when the equalizer is switched off', async () => {
    const { engine, context, routedA, statuses } = setup()
    engine.setEffects(EQ_ON)
    await engine.load(source('a'))
    engine.setEffects(EQ_OFF)
    expect(routedA.getAttribute('src')).toBe('https://media.test/a')
    expect(statuses.at(-1)?.equalizer).toBe('off')
    const input = sine(8000)
    expect(levelDb(context.render(new Map([[routedA, input]]))) - levelDb(input)).toBeCloseTo(0, 6)
  })

  it('waits for the context to run, then moves the stream onto it', async () => {
    const { engine, context, plainA, routedA, statuses } = setup()
    context.state = 'suspended'
    context.resumeWorks = false
    engine.setEffects(EQ_ON)
    await engine.load(source('a'))
    expect(plainA.getAttribute('src')).toBe('https://media.test/a')
    expect(statuses.at(-1)?.equalizer).toBe('unavailable')
    context.setState('running')
    expect(routedA.getAttribute('src')).toBe('https://media.test/a')
    expect(statuses.at(-1)?.equalizer).toBe('on')
  })

  it('creates the context in a user gesture, not when the settings arrive at startup', async () => {
    const { engine, contexts, context } = setup()
    engine.setEffects(EQ_ON)
    expect(contexts()).toBe(0)
    engine.unlock()
    expect(contexts()).toBe(1)
    expect(context.resumes).toBe(0)
    // Switched on again while something plays (the switch's click): the context runs on.
    await engine.load(source('a'))
    engine.setEffects(EQ_OFF)
    engine.setEffects(EQ_ON)
    expect(contexts()).toBe(1)
  })

  it('lets the context run from a user gesture', () => {
    const { engine, context } = setup()
    context.state = 'suspended'
    context.resumeWorks = false
    engine.setEffects(EQ_ON)
    const resumes = context.resumes
    engine.unlock()
    expect(context.resumes).toBe(resumes + 1)
  })

  it('moves the stream off Web Audio when the browser stops the context', async () => {
    const { engine, context, plainA, routedA } = setup()
    engine.setEffects(EQ_ON)
    await engine.load(source('a'))
    await engine.play()
    context.setState('suspended')
    expect(plainA.getAttribute('src')).toBe('https://media.test/a')
    expect(plainA.paused).toBe(false)
    expect(routedA.hasAttribute('src')).toBe(false)
  })

  it('applies the volume on the graph for routed elements', async () => {
    const { engine, context, routedA } = setup()
    engine.setEffects(EQ_ON)
    await engine.load(source('a'))
    engine.setVolume(0.5)
    const input = sine(1000)
    const at = () => levelDb(context.render(new Map([[routedA, input]]))) - levelDb(input)
    const before = at()
    engine.setMuted(true)
    expect(at()).toBe(Number.NEGATIVE_INFINITY)
    engine.setMuted(false)
    expect(at()).toBeCloseTo(before, 6)
    expect(routedA.volume).toBe(1)
    expect(routedA.muted).toBe(false)
  })

  it('closes the context with the engine', async () => {
    const { engine, context } = setup()
    engine.setEffects(EQ_ON)
    await engine.load(source('a'))
    engine.destroy()
    expect(context.closed).toBe(true)
  })
})

describe('DirectAudioEngine: loudness', () => {
  it('turns a loud track down through the element volume', async () => {
    const { engine, plainA, statuses } = setup()
    engine.setEffects(EQ_OFF)
    engine.setVolume(0.8)
    await engine.load(source('opaque-a', { loudness: LOUD }))
    expect(plainA.volume).toBeCloseTo(0.8 * dbToGain(-3.89), 6)
    expect(statuses.at(-1)).toEqual({ equalizer: 'off', loudness: 'on', loudnessGainDb: -3.89 })
    engine.setEffects(effects({ loudness: { enabled: false, targetLufs: -14, mode: 'track' } }))
    expect(plainA.volume).toBeCloseTo(0.8, 6)
    expect(statuses.at(-1)).toEqual({ equalizer: 'off', loudness: 'off', loudnessGainDb: 0 })
  })

  it('turns a quiet readable track up through Web Audio', async () => {
    const { engine, context, routedA, statuses } = setup()
    engine.setEffects(EQ_OFF)
    await engine.load(source('a', { loudness: QUIET }))
    expect(routedA.getAttribute('src')).toBe('https://media.test/a')
    expect(statuses.at(-1)).toEqual({ equalizer: 'off', loudness: 'on', loudnessGainDb: 6.02 })
    const input = sine(1000)
    const output = context.render(new Map([[routedA, input]]))
    expect(levelDb(output) - levelDb(input)).toBeCloseTo(6.02, 2)
  })

  it('leaves a quiet track it cannot read as it is', async () => {
    const { engine, plainA, statuses } = setup()
    engine.setEffects(EQ_OFF)
    await engine.load(source('opaque-a', { loudness: QUIET }))
    expect(plainA.getAttribute('src')).toBe('https://media.test/opaque-a')
    expect(plainA.volume).toBe(1)
    expect(statuses.at(-1)).toEqual({ equalizer: 'off', loudness: 'on', loudnessGainDb: 0 })
  })

  it('says loudness is unavailable where pages cannot set the volume (iOS)', async () => {
    const { engine, statuses } = setup({
      createAudio: () => {
        const element = document.createElement('audio')
        Object.defineProperty(element, 'volume', { get: () => 1, set: () => {} })
        return element
      },
    })
    engine.setEffects(EQ_OFF)
    await engine.load(source('opaque-a', { loudness: LOUD }))
    expect(statuses.at(-1)).toEqual({
      equalizer: 'off',
      loudness: 'unavailable',
      loudnessGainDb: 0,
    })
  })

  it('turns nothing up through Web Audio where pages cannot set the volume (iOS)', async () => {
    const elements: HTMLAudioElement[] = []
    const { engine, statuses } = setup({
      createAudio: () => {
        const element = document.createElement('audio')
        Object.defineProperty(element, 'volume', { get: () => 1, set: () => {} })
        elements.push(element)
        return element
      },
    })
    engine.setEffects(EQ_OFF)
    await engine.load(source('a', { loudness: QUIET }))
    expect(elements[0]?.getAttribute('src')).toBe('https://media.test/a')
    expect(elements[2]?.hasAttribute('src')).toBe(false)
    expect(statuses.at(-1)).toEqual({ equalizer: 'off', loudness: 'on', loudnessGainDb: 0 })
  })

  it('gives a preloaded track its own level', async () => {
    const { engine, plainA, plainB } = setup()
    engine.setEffects(EQ_OFF)
    engine.unlock()
    await engine.load(source('opaque-a'))
    engine.preload(source('opaque-b', { loudness: LOUD }))
    expect(plainA.volume).toBe(1)
    expect(plainB.volume).toBeCloseTo(dbToGain(-3.89), 6)
  })
})

describe('DirectAudioEngine: playback speed', () => {
  it('sets the speed on every element, keeping the pitch, for later sources too', async () => {
    const { engine, elements } = setup()
    engine.setPlaybackRate(1.5)
    for (const element of elements) {
      expect(element.playbackRate).toBe(1.5)
      expect(element.defaultPlaybackRate).toBe(1.5)
      expect(element.preservesPitch).toBe(true)
    }
    await engine.load(source('a'))
    expect(elements[0]?.playbackRate).toBe(1.5)
    engine.setPlaybackRate(Number.NaN)
    engine.setPlaybackRate(0)
    expect(elements[0]?.playbackRate).toBe(1.5)
  })
})

describe('DirectAudioEngine: crossfade', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  /** Plays `a` and preloads `b`, ready to play. */
  async function playingWithNext(stream: Partial<StreamOption> = {}) {
    const context = setup()
    context.engine.setEffects(EQ_OFF)
    context.engine.unlock()
    await context.engine.load(source('opaque-a'))
    await context.engine.play()
    context.engine.preload(source('opaque-b', stream))
    set(context.plainB, 'readyState', 4)
    context.events.length = 0
    return context
  }

  it('starts the preloaded track and fades between the two with equal power', async () => {
    const { engine, plainA, plainB, events } = await playingWithNext()
    expect(engine.crossfade(source('opaque-b'), 2000)).toBe(true)
    expect(plainB.paused).toBe(false)
    expect(plainB.volume).toBe(0)
    expect(plainA.paused).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(plainA.volume).toBeCloseTo(Math.SQRT1_2, 1)
    expect(plainB.volume).toBeCloseTo(Math.SQRT1_2, 1)
    // The old track's events no longer count; the new one's do.
    fire(plainA, 'pause')
    expect(events).toEqual(['play'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(plainA.hasAttribute('src')).toBe(false)
    expect(plainB.volume).toBe(1)
  })

  it('ends the fade when the old track reaches its end', async () => {
    const { engine, plainA, plainB } = await playingWithNext()
    engine.crossfade(source('opaque-b'), 5000)
    set(plainA, 'ended', true)
    fire(plainA, 'ended')
    expect(plainA.hasAttribute('src')).toBe(false)
    expect(plainB.volume).toBe(1)
  })

  it('ends the fade at once on a pause, a seek or a load', async () => {
    for (const act of [
      (engine: DirectAudioEngine) => engine.pause(),
      (engine: DirectAudioEngine) => engine.seek(5000),
      (engine: DirectAudioEngine) => void engine.load(source('opaque-c')),
    ]) {
      const { engine, plainA } = await playingWithNext()
      engine.crossfade(source('opaque-b'), 5000)
      act(engine)
      // The old track stops at once (a new one plays on the other element).
      expect(plainA.hasAttribute('src')).toBe(false)
    }
  })

  it('refuses when the track is not prepared, not ready or nothing plays', async () => {
    const other = await playingWithNext()
    expect(other.engine.crossfade(source('opaque-x'), 2000)).toBe(false)
    const notReady = await playingWithNext()
    set(notReady.plainB, 'readyState', 2)
    expect(notReady.engine.crossfade(source('opaque-b'), 2000)).toBe(false)
    const paused = await playingWithNext()
    paused.engine.pause()
    expect(paused.engine.crossfade(source('opaque-b'), 2000)).toBe(false)
    const failed = await playingWithNext()
    failWith(failed.plainB, 2)
    expect(failed.engine.crossfade(source('opaque-b'), 2000)).toBe(false)
    expect(failed.plainA.paused).toBe(false)
  })

  it('preloads the track after next once the fade is over', async () => {
    const { engine, plainA } = await playingWithNext()
    engine.crossfade(source('opaque-b'), 2000)
    engine.preload(source('opaque-c'))
    expect(plainA.getAttribute('src')).toBe('https://media.test/opaque-a')
    await vi.advanceTimersByTimeAsync(2000)
    expect(plainA.getAttribute('src')).toBe('https://media.test/opaque-c')
  })

  it('keeps each track at its own loudness through the fade', async () => {
    const { engine, plainB } = await playingWithNext({ loudness: LOUD })
    engine.crossfade(source('opaque-b', { loudness: LOUD }), 2000)
    await vi.advanceTimersByTimeAsync(2000)
    expect(plainB.volume).toBeCloseTo(dbToGain(-3.89), 6)
  })

  it('fades routed elements on the graph', async () => {
    const { engine, context, routedA, routedB } = setup()
    engine.setEffects(EQ_ON)
    engine.unlock()
    await engine.load(source('a'))
    await engine.play()
    engine.preload(source('b'))
    expect(routedB.getAttribute('src')).toBe('https://media.test/b')
    set(routedB, 'readyState', 4)
    expect(engine.crossfade(source('b'), 2000)).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    const input = sine(1000)
    const outgoing = levelDb(context.render(new Map([[routedA, input]])))
    const incoming = levelDb(context.render(new Map([[routedB, input]])))
    expect(outgoing).toBeCloseTo(incoming, 0)
  })
})

describe('DirectAudioEngine: output fades', () => {
  it('fades the whole output and back, keeping the volume', async () => {
    vi.useFakeTimers()
    const { engine, plainA } = setup()
    engine.setVolume(0.6)
    await engine.load(source('opaque-a'))
    engine.fadeOutput(0, 1000)
    await vi.advanceTimersByTimeAsync(500)
    expect(plainA.volume).toBeCloseTo(0.3, 1)
    await vi.advanceTimersByTimeAsync(500)
    expect(plainA.volume).toBe(0)
    engine.fadeOutput(1, 0)
    expect(plainA.volume).toBeCloseTo(0.6, 6)
  })
})
