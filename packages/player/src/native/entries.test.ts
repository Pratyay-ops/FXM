import { describe, expect, it } from 'vitest'
import * as player from '../index'
import { createFakeFxmPlayer } from '../testing/fake-fxm-player'
import { testStream, testTrack } from '../testing/fixtures'
import * as testing from '../testing/index'
import {
  lockScreenArtwork,
  nativeEntry,
  nativeMetadata,
  nativeSource,
  nativeSupport,
  restoreStream,
  streamFileKey,
} from './entries'
import { FXM_PLAYER_MAX_ENTRY_DATA, findFxmPlayerPlugin, fxmPlayerErrorCode } from './plugin'

/** A googlevideo-style URL: `itag` and `lmt` name the file, `sig` varies between resolutions. */
function googlevideo(params: string): string {
  return `https://rr1---sn-fxmtest.googlevideo.com/videoplayback?${params}`
}

describe('native entries', () => {
  it('carry what the notification and the lock screen show', () => {
    const track = testTrack('Creep', {
      artists: [{ name: 'Radiohead' }, { name: '' }],
      album: { name: 'Pablo Honey' },
      durationMs: 238_640,
      artwork: [
        { url: 'https://i.ytimg.com/a/60.jpg', width: 60, height: 60 },
        { url: 'https://i.ytimg.com/a/544.jpg', width: 544, height: 544 },
        { url: 'https://i.ytimg.com/a/1200.jpg', width: 1200, height: 1200 },
      ],
    })
    expect(nativeMetadata(track)).toEqual({
      title: 'Creep',
      artists: ['Radiohead'],
      album: 'Pablo Honey',
      artworkUrl: 'https://i.ytimg.com/a/544.jpg',
      durationMs: 238_640,
    })
    expect(nativeMetadata(testTrack(' ', { durationMs: 0 }))).toEqual({
      title: 'Untitled',
      artists: ['  artist'],
    })
    // The plugin refuses numbers past JavaScript's safe range.
    expect(nativeMetadata(testTrack('a', { durationMs: Infinity }))).not.toHaveProperty(
      'durationMs',
    )
  })

  it('pick HTTPS artwork, the last one when no size is given', () => {
    expect(lockScreenArtwork([])).toBeUndefined()
    expect(lockScreenArtwork([{ url: 'http://x.test/a.jpg', width: 100 }])).toBeUndefined()
    expect(
      lockScreenArtwork([{ url: 'https://x.test/small.jpg' }, { url: 'https://x.test/large.jpg' }]),
    ).toBe('https://x.test/large.jpg')
    expect(lockScreenArtwork([{ url: 'https://x.test/huge.jpg', width: 4000, height: 4000 }])).toBe(
      'https://x.test/huge.jpg',
    )
  })

  it('carry the stream’s URL, headers, expiry, IP binding and network', () => {
    const stream = testStream('a', {
      ipBound: true,
      expiresAt: 1_792_979_495_000.7,
      requestHeaders: { Referer: 'https://www.youtube.com/' },
    })
    expect(nativeSource(stream, 3)).toEqual({
      url: stream.url,
      ipBound: true,
      headers: { Referer: 'https://www.youtube.com/' },
      expiresAt: 1_792_979_495_000,
      network: 3,
    })
    expect(nativeSource(testStream('b', { requestHeaders: {} }))).toEqual({
      url: testStream('b').url,
      ipBound: false,
    })
    const entry = nativeEntry('n1-1', { uid: 4, track: testTrack('a') }, stream)
    expect(entry).toMatchObject({ id: 'n1-1', uid: 4, metadata: { title: 'a' } })
  })

  it('name the file a googlevideo URL serves, so a fresh URL for it keeps the buffer', () => {
    const first = googlevideo('itag=251&lmt=1700000000000000&clen=4000000&dur=212.3&sig=1')
    const fresh = googlevideo('itag=251&lmt=1700000000000000&clen=4000000&dur=212.3&sig=2')
    expect(streamFileKey(first)).toBe('googlevideo:251:1700000000000000:4000000:212.3')
    expect(streamFileKey(fresh)).toBe(streamFileKey(first))
    // Another format, or another encoding of the file, is another file.
    expect(streamFileKey(first.replace('itag=251', 'itag=140'))).not.toBe(streamFileKey(first))
    expect(streamFileKey(first.replace('lmt=17', 'lmt=18'))).not.toBe(streamFileKey(first))
    // itag 18 has no clen.
    expect(streamFileKey(googlevideo('itag=18&lmt=1&dur=2.0&sig=1'))).toBe('googlevideo:18:1::2.0')
    // Without the fields that name the file, or not googlevideo however it is spelled: no key.
    expect(streamFileKey(googlevideo('itag=251&sig=1'))).toBeUndefined()
    expect(
      streamFileKey(first.replace('googlevideo.com', 'googlevideo.com.example.test')),
    ).toBeUndefined()
    expect(streamFileKey('https://media.test/a')).toBeUndefined()
    expect(streamFileKey('not a url')).toBeUndefined()
    expect(nativeSource(testStream('a', { url: first })).fileKey).toBe(streamFileKey(first))
  })

  it('keep their stream, which a recreated page reads back', () => {
    const stream = testStream('a', {
      ipBound: true,
      expiresAt: 1_792_979_495_000,
      requestHeaders: { Referer: 'https://www.youtube.com/' },
      sampleRateHz: 48_000,
    })
    const entry = nativeEntry('n1-1', { uid: 4, track: testTrack('a') }, stream)
    expect(entry.data).not.toContain(stream.url)
    expect(restoreStream(entry)).toEqual(stream)
  })

  it('give back only streams the native player can play, for their own URL', () => {
    const entry = nativeEntry('n1-1', { uid: 4, track: testTrack('a') }, testStream('a'))
    const withData = (data: unknown) => ({ ...entry, data: JSON.stringify(data) })
    const { url: _url, ...stored } = testStream('a')
    const { data: _data, ...withoutData } = entry
    expect(restoreStream(withoutData)).toBeUndefined()
    expect(restoreStream({ ...entry, data: 'not json' })).toBeUndefined()
    expect(restoreStream(withData([1]))).toBeUndefined()
    expect(restoreStream(withData({ ...stored, protocol: 'hls' }))).toBeUndefined()
    expect(restoreStream(withData({ ...stored, fullLength: 'capped' }))).toBeUndefined()
    expect(restoreStream(withData({ ...stored, codec: 'speex' }))).toBeUndefined()
    expect(restoreStream(withData({ ...stored, ipBound: 'yes' }))).toBeUndefined()
    // Unknown fields are dropped, malformed optional ones too; the URL is always the entry's.
    const restored = restoreStream(
      withData({ ...stored, url: 'https://elsewhere.test/', bitrateKbps: 'fast', secret: 1 }),
    )
    expect(restored).toEqual({ ...testStream('a'), bitrateKbps: undefined })
    expect(restored).not.toHaveProperty('secret')
    // A stream too large to carry is left out rather than refused by the plugin.
    const huge = testStream('a', {
      requestHeaders: { 'X-Big': 'x'.repeat(FXM_PLAYER_MAX_ENTRY_DATA) },
    })
    expect(nativeEntry('n1-2', { uid: 4, track: testTrack('a') }, huge)).not.toHaveProperty('data')
  })

  it('are not made from streams the plugin would refuse', () => {
    expect(nativeSupport(testStream('a'))).toBe('probably')
    expect(nativeSupport(testStream('a', { url: 'https://' }))).toBe('no')
    expect(nativeSupport(testStream('a', { url: 'blob:https://localhost/1234' }))).toBe('no')
    expect(nativeSupport(testStream('a', { requestHeaders: { 'bad name': 'x' } }))).toBe('no')
    expect(nativeSupport(testStream('a', { requestHeaders: { Referer: 'a\r\nb' } }))).toBe('no')
    expect(nativeSupport(testStream('a', { requestHeaders: { Referer: 'ü' } }))).toBe('no')
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`x-${i}`, 'v']))
    expect(nativeSupport(testStream('a', { requestHeaders: many }))).toBe('no')
    expect(nativeSupport(testStream('a', { requestHeaders: { Referer: 'a\tb' } }))).toBe('probably')
  })
})

describe('the FxmPlayer plugin', () => {
  it('is found only in the Android app, with all its methods', () => {
    const plugin = createFakeFxmPlayer()
    const android = { Capacitor: { isNativePlatform: () => true, Plugins: { FxmPlayer: plugin } } }
    expect(findFxmPlayerPlugin(android)).toBe(plugin)
    expect(findFxmPlayerPlugin({})).toBeUndefined()
    expect(
      findFxmPlayerPlugin({
        Capacitor: { isNativePlatform: () => false, Plugins: { FxmPlayer: plugin } },
      }),
    ).toBeUndefined()
    const { release: _release, ...partial } = plugin
    expect(
      findFxmPlayerPlugin({
        Capacitor: { isNativePlatform: () => true, Plugins: { FxmPlayer: partial } },
      }),
    ).toBeUndefined()
    const engine = player.NativeEngine.ifAvailable(android)
    expect(engine).toBeInstanceOf(player.NativeEngine)
    engine?.destroy()
  })

  it('rejects with codes the engine can tell apart', () => {
    expect(fxmPlayerErrorCode(Object.assign(new Error('x'), { code: 'UNAVAILABLE' }))).toBe(
      'UNAVAILABLE',
    )
    expect(fxmPlayerErrorCode(Object.assign(new Error('x'), { code: 'NOPE' }))).toBeUndefined()
    expect(fxmPlayerErrorCode(null)).toBeUndefined()
    expect(fxmPlayerErrorCode('BAD_REQUEST')).toBeUndefined()
  })

  it('and its engine are exported, with the fake under @fxm/player/testing', () => {
    for (const name of [
      'NativeEngine',
      'NATIVE_ENGINE_DEFAULTS',
      'findFxmPlayerPlugin',
      'fxmPlayerErrorCode',
      'FXM_PLAYER_PLUGIN',
      'FXM_PLAYER_ERROR_CODES',
    ]) {
      expect(player).toHaveProperty(name)
    }
    // The entry builders are the engine's own.
    for (const name of ['nativeEntry', 'nativeSource', 'nativeSupport', 'lockScreenArtwork']) {
      expect(player).not.toHaveProperty(name)
    }
    expect(testing).toHaveProperty('createFakeFxmPlayer')
  })
})
