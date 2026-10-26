import { describe, expect, it } from 'vitest'
import { createPlaybackProbe, mimeTypeOf, type ProbeResult } from './playback-probe'
import { FakeMediaElement, ManualClock } from './testing'

function setup() {
  const element = new FakeMediaElement()
  const clock = new ManualClock()
  const released: string[] = []
  const probe = createPlaybackProbe({
    createElement: () => element,
    clock,
    primerUrl: () => ({ url: 'blob:primer', release: () => released.push('blob:primer') }),
  })
  return { element, clock, probe, released }
}

/** Lets the promise callbacks inside the probe run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createPlaybackProbe', () => {
  it('passes once the stream has played long enough after `playing`', async () => {
    const { element, clock, probe } = setup()
    let result: ProbeResult | undefined
    void probe.play('https://media.example/ok', { playMs: 3000 }).then((value) => {
      result = value
    })
    expect(element.src).toBe('https://media.example/ok')
    clock.advance(400)
    element.fire('playing')
    element.progress(1.5)
    await settle()
    expect(result).toBeUndefined()
    clock.advance(1600)
    element.progress(1.6)
    await settle()
    expect(result).toEqual({ ok: true, startedAfterMs: 400, playedMs: 3100 })
    // Released: no source left downloading.
    expect(element.src).toBe('')
  })

  it('fails at once on a media error before playing, naming the error', async () => {
    const { element, clock, probe } = setup()
    const pending = probe.play('https://media.example/capped')
    clock.advance(120)
    element.failWith(4)
    expect(await pending).toEqual({
      ok: false,
      reason: 'media-error',
      afterMs: 120,
      playedMs: 0,
      detail: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
    })
  })

  it('counts a stall before the first `playing` as a failure', async () => {
    const { element, probe } = setup()
    const pending = probe.play('https://media.example/slow')
    element.fire('stalled')
    expect(await pending).toMatchObject({ ok: false, reason: 'stalled' })
  })

  it('ignores a stall once playing, and fails if progress stops for good', async () => {
    const { element, clock, probe } = setup()
    const pending = probe.play('https://media.example/stops', { playMs: 3000 })
    element.fire('playing')
    element.progress(1)
    element.fire('stalled')
    clock.advance(13_000)
    expect(await pending).toEqual({ ok: false, reason: 'stalled', afterMs: 13_000, playedMs: 1000 })
  })

  it('times out when nothing plays', async () => {
    const { clock, probe } = setup()
    const pending = probe.play('https://media.example/silent', { startTimeoutMs: 5000 })
    clock.advance(5000)
    expect(await pending).toMatchObject({ ok: false, reason: 'timeout', afterMs: 5000 })
  })

  it('reports autoplay rules that refuse playback', async () => {
    const { element, probe } = setup()
    element.playAnswer = 'not-allowed'
    expect(await probe.play('https://media.example/ok')).toMatchObject({
      ok: false,
      reason: 'blocked',
    })
  })

  it('counts a short file that played to its end as played', async () => {
    const { element, probe } = setup()
    const pending = probe.play('https://media.example/short', { playMs: 3000 })
    element.fire('playing')
    element.progress(2)
    element.fire('ended')
    expect(await pending).toMatchObject({ ok: true, playedMs: 2000 })
  })

  it('stops when cancelled, before or during playback', async () => {
    const { element, probe } = setup()
    const before = new AbortController()
    before.abort()
    expect(await probe.play('https://media.example/a', { signal: before.signal })).toMatchObject({
      reason: 'aborted',
    })
    const during = new AbortController()
    const pending = probe.play('https://media.example/b', { signal: during.signal })
    element.fire('playing')
    during.abort()
    expect(await pending).toMatchObject({ ok: false, reason: 'aborted' })
  })

  it('ends one probe when the next starts, and when disposed', async () => {
    const { probe } = setup()
    const first = probe.play('https://media.example/a')
    const second = probe.play('https://media.example/b')
    expect(await first).toMatchObject({ reason: 'aborted' })
    probe.dispose()
    expect(await second).toMatchObject({ reason: 'aborted' })
  })

  it('primes the element with a silent sound from the click, and releases it', () => {
    const { element, probe, released } = setup()
    probe.prime()
    expect(element.played).toEqual(['blob:primer'])
    expect(element.volume).toBe(0)
    probe.dispose()
    expect(released).toEqual(['blob:primer'])
  })

  it('asks the element whether it decodes an option', () => {
    const { element, probe } = setup()
    element.supported = ['audio/webm']
    expect(probe.canPlay({ codec: 'opus', container: 'webm', media: 'audio' })).toBe(true)
    expect(probe.canPlay({ codec: 'aac', container: 'm4a', media: 'audio' })).toBe(false)
  })
})

describe('mimeTypeOf', () => {
  it("names each codec's type, and itag 18 as an H.264 and AAC video", () => {
    expect(mimeTypeOf({ codec: 'opus', container: 'webm', media: 'audio' })).toBe(
      'audio/webm; codecs="opus"',
    )
    expect(mimeTypeOf({ codec: 'aac', container: 'm4a', media: 'audio' })).toBe(
      'audio/mp4; codecs="mp4a.40.2"',
    )
    expect(mimeTypeOf({ codec: 'aac', container: 'mp4', media: 'muxed-video' })).toBe(
      'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
    )
    expect(mimeTypeOf({ codec: 'flac', container: 'flac', media: 'audio' })).toBe('audio/flac')
    expect(mimeTypeOf({ codec: 'mp3', container: 'mp3', media: 'audio' })).toBe('audio/mpeg')
    expect(mimeTypeOf({ codec: 'pcm', container: 'wav', media: 'audio' })).toBe('audio/wav')
    expect(mimeTypeOf({ codec: 'vorbis', container: 'ogg', media: 'audio' })).toBe(
      'audio/ogg; codecs="vorbis"',
    )
  })
})
