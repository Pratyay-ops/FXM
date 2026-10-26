// @vitest-environment happy-dom
import { choosePlaybackStream, type StreamOption } from '@fxm/core'
import { Player } from '@fxm/player'
import { FakeResolver, ladderStreams, testStream, testTracks } from '@fxm/player/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DesktopAudioEngine,
  desktopPlaySupport,
  lacksOpus,
  MACOS_OPUS_VERSION,
  parseVersion,
} from './engine'
import type { DesktopEnvironment } from './shell'

const OPUS = 'audio/webm; codecs="opus"'
const AAC = 'audio/mp4; codecs="mp4a.40.2"'
const MP3 = 'audio/mpeg'

const mac = (osVersion?: string): DesktopEnvironment => ({
  os: 'macos',
  tray: true,
  ...(osVersion === undefined ? {} : { osVersion }),
})
const WINDOWS: DesktopEnvironment = { os: 'windows', webviewVersion: '142.0.3595.53', tray: true }

/** What YouTube's ladder offers for a song: Opus 251 and AAC 140, or the muxed itag 18. */
const top = (fullLength: StreamOption['fullLength']) =>
  ladderStreams('song', { rung: 'top', fullLength, serial: 1 })
const fallback = (fullLength: StreamOption['fullLength']) =>
  ladderStreams('song', { rung: 'fallback', fullLength, serial: 2 })
const [opus, aac] = top('verified') as [StreamOption, StreamOption]
/** An Internet Archive MP3: not IP-bound, never capped, never probed. */
const archiveMp3 = testStream('bell.mp3', { codec: 'mp3', container: 'mp3', tier: 'normal' })

/** A desktop engine whose webview answers `canPlayType` from `answers`. */
function engineWith(
  answers: Record<string, CanPlayTypeResult>,
  environment: () => DesktopEnvironment | undefined = () => undefined,
) {
  const createAudio = () => {
    const audio = document.createElement('audio')
    audio.canPlayType = (type: string) => answers[type] ?? ''
    return audio
  }
  return new DesktopAudioEngine({ createAudio, environment })
}

/** A webview that is sure of Opus, AAC and MP3: WebView2, or WebKit from macOS 15.4. */
const EVERYTHING = { [OPUS]: 'probably', [AAC]: 'probably', [MP3]: 'probably' } as const

const choose = (engine: DesktopAudioEngine, options: StreamOption[]) =>
  choosePlaybackStream(options, { support: (stream) => engine.canPlay(stream), ceiling: 'high' })

describe('desktopPlaySupport: <audio src> only for URLs that passed the probe', () => {
  it('refuses an IP-bound URL unless its end-of-file probe passed', () => {
    for (const fullLength of ['unverified', 'capped'] as const) {
      for (const stream of [...top(fullLength), ...fallback(fullLength)]) {
        expect(desktopPlaySupport(stream, 'probably', WINDOWS), fullLength).toBe('no')
      }
    }
    expect(desktopPlaySupport(aac, 'probably', WINDOWS)).toBe('probably')
    expect(desktopPlaySupport(fallback('verified')[0] as StreamOption, 'maybe', WINDOWS)).toBe(
      'maybe',
    )
  })

  it('plays free sources, which no one caps, without a probe', () => {
    expect(desktopPlaySupport(archiveMp3, 'probably', WINDOWS)).toBe('probably')
    expect(desktopPlaySupport(archiveMp3, 'maybe', undefined)).toBe('maybe')
  })

  it('never turns the webview’s no into a yes', () => {
    expect(desktopPlaySupport(aac, 'no', WINDOWS)).toBe('no')
    expect(desktopPlaySupport(archiveMp3, 'no', WINDOWS)).toBe('no')
  })
})

describe('desktopPlaySupport: the codec per canPlayType, AAC on macOS before 15.4', () => {
  it('rates Opus maybe at best on macOS before 15.4, whatever WebKit answers', () => {
    for (const version of ['11.7.10', '13.6', '14.7.1', '15.0', '15.3.2']) {
      expect(desktopPlaySupport(opus, 'probably', mac(version)), version).toBe('maybe')
      expect(desktopPlaySupport(aac, 'probably', mac(version)), version).toBe('probably')
    }
  })

  it('leaves Opus to the webview from macOS 15.4, and on Windows and Linux', () => {
    for (const environment of [mac('15.4'), mac('15.5.0'), mac('26.1'), WINDOWS]) {
      expect(desktopPlaySupport(opus, 'probably', environment), environment.osVersion).toBe(
        'probably',
      )
    }
    expect(desktopPlaySupport(opus, 'probably', { os: 'linux', tray: false })).toBe('probably')
  })

  it('trusts the webview while it doesn’t know which macOS it runs on', () => {
    expect(desktopPlaySupport(opus, 'probably', undefined)).toBe('probably')
    expect(desktopPlaySupport(opus, 'probably', mac())).toBe('probably')
    expect(desktopPlaySupport(opus, 'probably', mac('fifteen'))).toBe('probably')
  })
})

describe('lacksOpus and parseVersion', () => {
  it('compares major and minor with 15.4', () => {
    expect(MACOS_OPUS_VERSION).toEqual([15, 4])
    expect(lacksOpus(mac('15.3.9'))).toBe(true)
    expect(lacksOpus(mac('15.4.0'))).toBe(false)
    expect(lacksOpus(mac('15'))).toBe(true)
    expect(lacksOpus(WINDOWS)).toBe(false)
  })

  it('reads dotted numbers only', () => {
    expect(parseVersion('15.5.0')).toEqual([15, 5, 0])
    expect(parseVersion('26')).toEqual([26])
    for (const bad of ['', '15.', '.4', '15.4b', 'v15', undefined]) {
      expect(parseVersion(bad), String(bad)).toBeUndefined()
    }
  })
})

describe('DesktopAudioEngine', () => {
  it('plays AAC 140 on macOS 14, even where WebKit claims Opus', () => {
    const engine = engineWith(EVERYTHING, () => mac('14.7'))
    expect(engine.canPlay(opus)).toBe('maybe')
    expect(choose(engine, top('verified'))?.codec).toBe('aac')
  })

  it('plays Opus 251 from macOS 15.4, as on Windows and Linux', () => {
    expect(
      choose(
        engineWith(EVERYTHING, () => mac('15.5.0')),
        top('verified'),
      )?.codec,
    ).toBe('opus')
    expect(
      choose(
        engineWith(EVERYTHING, () => WINDOWS),
        top('verified'),
      )?.codec,
    ).toBe('opus')
  })

  it('plays AAC where the webview has no Opus at all', () => {
    const engine = engineWith({ [AAC]: 'probably', [OPUS]: '' })
    expect(engine.canPlay(opus)).toBe('no')
    expect(choose(engine, top('verified'))?.codec).toBe('aac')
  })

  it('still plays Opus on an old Mac when a resolution has nothing else', () => {
    const engine = engineWith(EVERYTHING, () => mac('13.6'))
    expect(choose(engine, [opus])?.codec).toBe('opus')
  })

  it('reads the environment whenever it rates a stream: the shell answers late', () => {
    let environment: DesktopEnvironment | undefined
    const engine = engineWith(EVERYTHING, () => environment)
    expect(engine.canPlay(opus)).toBe('probably')
    environment = mac('14.0')
    expect(engine.canPlay(opus)).toBe('maybe')
  })

  it('chooses the probed fallback over a top rung whose probe did not answer', () => {
    const engine = engineWith(EVERYTHING, () => WINDOWS)
    expect(choose(engine, top('unverified'))).toBeUndefined()
    expect(choose(engine, [...top('unverified'), ...fallback('verified')])?.media).toBe(
      'muxed-video',
    )
  })

  it('plays an Internet Archive MP3 that was never probed', () => {
    const engine = engineWith(EVERYTHING, () => WINDOWS)
    expect(engine.canPlay(archiveMp3)).toBe('probably')
  })
})

describe('the player with the desktop engine', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('never hands an unprobed IP-bound URL to <audio>, and asks the resolver again', async () => {
    const engine = engineWith(EVERYTHING, () => WINDOWS)
    const load = vi.spyOn(engine, 'load')
    const resolver = new FakeResolver((_item, request) => ({
      stream: request.attempt === 0 ? (top('unverified')[1] as StreamOption) : aac,
    }))
    const player = new Player({ engine, resolver })
    await player.setQueue(testTracks('a'))
    await vi.advanceTimersByTimeAsync(0)
    expect(resolver.log.slice(0, 2)).toEqual(['a:play#0', 'a:retry#1'])
    expect(load).toHaveBeenCalledTimes(1)
    expect(load.mock.calls[0]?.[0].stream.url).toBe(aac.url)
    player.destroy()
  })
})
