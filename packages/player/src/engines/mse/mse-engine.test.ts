import { describe, expect, it } from 'vitest'
import { type EngineError, isEngineError } from './engine-contract'
import { MseEngine } from './mse-engine'
import {
  FakeAudio,
  type FakeMediaSource,
  fakeFeed,
  fakeMediaSourceHost,
  SESSION,
  sabrStream,
} from './testing'

const NOW = Date.UTC(2026, 9, 26, 12)

/** Lets queued promise callbacks and microtasks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup(options: { supported?: string[] } = {}) {
  const audio = new FakeAudio()
  const media = fakeMediaSourceHost(options.supported)
  const feed = fakeFeed()
  const fetch = (() => Promise.reject(new Error('no network in tests'))) as typeof globalThis.fetch
  const engine = new MseEngine({
    fetch,
    createAudio: () => audio as unknown as HTMLAudioElement,
    mediaSource: media.host,
    startFeed: feed.start,
    now: () => NOW,
  })
  const events: Array<[string, unknown]> = []
  for (const type of [
    'timeupdate',
    'durationchange',
    'play',
    'pause',
    'ended',
    'error',
    'stalled',
    'waiting',
    'canplay',
  ] as const) {
    engine.on(type, (payload) => events.push([type, payload]))
  }
  const errors = () =>
    events.filter(([type]) => type === 'error').map(([, error]) => error as EngineError)
  /** The media source of the n-th load, opened as an element attaching it would. */
  const opened = async (index = 0): Promise<FakeMediaSource> => {
    const source = media.created[index] as FakeMediaSource
    source.open()
    await settle()
    return source
  }
  return { audio, media, feed, fetch, engine, events, errors, opened }
}

describe('the MediaSource engine', () => {
  it('can play SABR sessions whose audio MediaSource takes, and nothing else', () => {
    const { engine } = setup({ supported: ['audio/webm; codecs="opus"'] })
    expect(engine.canPlay(sabrStream())).toBe('probably')
    expect(engine.canPlay(sabrStream({ protocol: 'progressive' }))).toBe('no')
    expect(engine.canPlay(sabrStream({ fullLength: 'capped' }))).toBe('no')
    expect(engine.canPlay(sabrStream({ expiresAt: NOW - 1 }))).toBe('no')
    expect(engine.canPlay(sabrStream({ playback: { format: 'other' } }))).toBe('no')
    const aac = {
      ...SESSION,
      audio: { ...SESSION.audio, mimeType: 'audio/mp4; codecs="mp4a.40.2"' },
    }
    expect(engine.canPlay(sabrStream({ playback: aac }))).toBe('no')
    // Only googlevideo, which is where the session's requests may go.
    for (const url of [
      'https://evil.example/videoplayback?sabr=1',
      'http://rr1---sn-fxm.googlevideo.com/videoplayback?sabr=1',
      'https://rr1---sn-fxm.googlevideo.com:8443/videoplayback?sabr=1',
    ]) {
      expect(engine.canPlay(sabrStream({ url }))).toBe('no')
    }
  })

  it('starts the session on sourceopen and appends its audio in order, then ends the stream', async () => {
    const { audio, engine, feed, fetch, opened } = setup()
    await engine.load({ stream: sabrStream() })
    expect(audio.src).toBe('blob:https://fxm.test/0')
    const source = await opened()
    expect(source.mimeType).toBe('audio/webm; codecs="opus"')
    expect(source.duration).toBe(239)
    expect(feed.starts).toEqual([{ playback: SESSION, url: sabrStream().url, fetch }])
    feed.push(3, 5, 8)
    feed.close()
    await settle()
    await settle()
    const buffer = source.sourceBuffers[0]
    expect(buffer?.appended.map((chunk) => chunk.byteLength)).toEqual([3, 5, 8])
    expect(source.readyState).toBe('ended')
  })

  it('starts at the requested position once data is in, reporting no position before', async () => {
    const { audio, engine, feed, events, opened } = setup()
    await engine.load({ stream: sabrStream() }, 42_000)
    await opened()
    audio.fire('timeupdate')
    expect(events.filter(([type]) => type === 'timeupdate')).toEqual([])
    feed.push(4)
    await settle()
    await settle()
    expect(audio.currentTime).toBe(42)
    audio.fire('timeupdate')
    expect(events.filter(([type]) => type === 'timeupdate')).toEqual([['timeupdate', 42_000]])
  })

  it("maps the element's events to the engine's", async () => {
    const { audio, engine, events } = setup()
    await engine.load({ stream: sabrStream() })
    audio.duration = 239
    audio.fire('durationchange')
    await engine.play()
    audio.fire('waiting')
    audio.readyState = 1
    audio.fire('stalled')
    audio.readyState = 4
    audio.fire('stalled')
    audio.fire('canplay')
    audio.pause()
    audio.ended = true
    audio.fire('pause')
    audio.fire('ended')
    expect(events.map(([type]) => type)).toEqual([
      'durationchange',
      'play',
      'waiting',
      'stalled',
      'canplay',
      'pause',
      'ended',
    ])
    expect(events[0]).toEqual(['durationchange', 239_000])
  })

  it('reports a play() the browser refuses as autoplay-blocked', async () => {
    const { audio, engine, errors } = setup()
    await engine.load({ stream: sabrStream() })
    audio.refusePlay = new DOMException('gesture needed', 'NotAllowedError')
    await engine.play()
    expect(errors().map((error) => error.type)).toEqual(['autoplay-blocked'])
    expect(isEngineError(errors()[0], 'autoplay-blocked')).toBe(true)
  })

  it('reports a failed session as network, a refused attestation as unsupported', async () => {
    const network = setup()
    await network.engine.load({ stream: sabrStream() })
    await network.opened()
    network.feed.fail(new Error('Server returned 403'))
    await settle()
    expect(network.errors().map((error) => error.type)).toEqual(['network'])

    const attestation = setup()
    await attestation.engine.load({ stream: sabrStream() })
    await attestation.opened()
    attestation.feed.fail(new Error('Cannot proceed with stream: attestation required'))
    await settle()
    expect(attestation.errors().map((error) => error.type)).toEqual(['unsupported'])
  })

  it('refuses streams it cannot play with an error, without a media source', async () => {
    const { engine, media, errors } = setup()
    await engine.load({ stream: sabrStream({ protocol: 'progressive' }) })
    await engine.load({ stream: sabrStream({ expiresAt: NOW - 1 }) })
    await settle()
    expect(errors().map((error) => error.type)).toEqual(['unsupported', 'expired'])
    expect(media.created).toHaveLength(0)
  })

  it('makes room behind the playhead when the source buffer is full', async () => {
    const { audio, engine, feed, opened } = setup()
    await engine.load({ stream: sabrStream() })
    const source = await opened()
    const buffer = source.sourceBuffers[0]
    if (buffer === undefined) throw new Error('no source buffer')
    buffer.quotaSeconds = 100
    feed.push(60, 30)
    await settle()
    await settle()
    audio.currentTime = 50
    feed.push(30)
    await settle()
    await settle()
    await settle()
    expect(buffer.removed).toEqual([[0, 40]])
    expect(buffer.appended.map((chunk) => chunk.byteLength)).toEqual([60, 30, 30])
  })

  it('seeks within what is buffered, and starts over for audio it removed', async () => {
    const { audio, engine, feed, media, opened } = setup()
    await engine.load({ stream: sabrStream() })
    const source = await opened()
    feed.push(60)
    await settle()
    await settle()
    engine.seek(30_000)
    expect(audio.currentTime).toBe(30)
    const buffer = source.sourceBuffers[0]
    if (buffer === undefined) throw new Error('no source buffer')
    buffer.buffered.ranges = [[20, 60]]
    engine.seek(5_000)
    await settle()
    expect(media.created).toHaveLength(2)
    expect(feed.aborted).toBe(1)
    expect(media.revoked).toEqual(['blob:https://fxm.test/0'])
  })

  it('reports a buffer that refuses data once: through the element, as a decode error', async () => {
    const { audio, engine, feed, errors, opened } = setup()
    await engine.load({ stream: sabrStream() })
    const source = await opened()
    const buffer = source.sourceBuffers[0]
    if (buffer === undefined) throw new Error('no source buffer')
    buffer.refuseAppends = true
    feed.push(4)
    await settle()
    await settle()
    // MSE's append error ends the stream with a decode error, which the element reports.
    audio.error = { code: 3, message: 'append failed' }
    audio.fire('error')
    expect(errors().map((error) => error.type)).toEqual(['decode'])
  })

  it('reports a codec the source buffer refuses as unsupported', async () => {
    const { engine, media, errors } = setup()
    await engine.load({ stream: sabrStream() })
    const source = media.created[0] as FakeMediaSource
    source.refuseTypes = true
    source.open()
    await settle()
    expect(errors().map((error) => error.type)).toEqual(['unsupported'])
  })

  it('refuses a session that is not on googlevideo, without a media source', async () => {
    const { engine, media, errors } = setup()
    await engine.load({ stream: sabrStream({ url: 'https://evil.example/videoplayback?sabr=1' }) })
    await settle()
    expect(errors().map((error) => error.type)).toEqual(['unsupported'])
    expect(media.created).toHaveLength(0)
  })

  it('reports the element failing to decode', async () => {
    const { audio, engine, errors } = setup()
    await engine.load({ stream: sabrStream() })
    audio.error = { code: 3, message: 'bad data' }
    audio.fire('error')
    expect(errors().map((error) => error.type)).toEqual(['decode'])
  })

  it('stops the session and its listeners when destroyed', async () => {
    const { audio, engine, feed, media, events, opened } = setup()
    await engine.load({ stream: sabrStream() })
    await opened()
    engine.destroy()
    expect(feed.aborted).toBe(1)
    expect(media.revoked).toEqual(['blob:https://fxm.test/0'])
    expect(audio.src).toBe('')
    audio.fire('playing')
    expect(events).toEqual([])
  })
})
