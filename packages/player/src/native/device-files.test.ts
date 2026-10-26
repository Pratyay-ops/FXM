import { describe, expect, it } from 'vitest'
import * as player from '../index'
import { testStream, testTrack } from '../testing/fixtures'
import { deviceFileUri, pageOrigin, webViewFileUrl } from './device-files'
import { nativeEntry, nativeSource, nativeSupport, restoreStream } from './entries'

const ORIGIN = 'https://localhost'
const DOWNLOAD = 'file:///data/user/0/io.github.pratyayops.fxm/files/downloads/2f1c0d3e-9a4b'
const SONG = 'content://media/external_primary/audio/media/42'

describe('device files in the WebView', () => {
  it('are served at Capacitor’s URLs of the page’s origin, and read back from them', () => {
    expect(webViewFileUrl(DOWNLOAD, ORIGIN)).toBe(
      'https://localhost/_capacitor_file_/data/user/0/io.github.pratyayops.fxm/files/downloads/2f1c0d3e-9a4b',
    )
    expect(webViewFileUrl(SONG, ORIGIN)).toBe(
      'https://localhost/_capacitor_content_/media/external_primary/audio/media/42',
    )
    for (const uri of [DOWNLOAD, SONG]) {
      expect(deviceFileUri(webViewFileUrl(uri, ORIGIN) ?? '', ORIGIN)).toBe(uri)
      // A device file's own URI names itself.
      expect(deviceFileUri(uri, ORIGIN)).toBe(uri)
      expect(deviceFileUri(uri, null)).toBe(uri)
    }
  })

  it('are only what Capacitor serves for the page’s own origin', () => {
    expect(deviceFileUri('https://media.test/a', ORIGIN)).toBeUndefined()
    expect(deviceFileUri('https://localhost/assets/index.js', ORIGIN)).toBeUndefined()
    expect(deviceFileUri('https://elsewhere.test/_capacitor_file_/data/a', ORIGIN)).toBeUndefined()
    expect(deviceFileUri('https://localhost/_capacitor_file_/data/a', null)).toBeUndefined()
    expect(deviceFileUri('https://localhost/_capacitor_file_', ORIGIN)).toBeUndefined()
    expect(deviceFileUri('https://localhost/_capacitor_file_/a?x=1', ORIGIN)).toBeUndefined()
    expect(deviceFileUri('https://localhost/_capacitor_content_/media', ORIGIN)).toBeUndefined()
    expect(deviceFileUri('blob:https://localhost/1234', ORIGIN)).toBeUndefined()
    expect(deviceFileUri('file://host/a', ORIGIN)).toBeUndefined()
    expect(webViewFileUrl('https://media.test/a', ORIGIN)).toBeUndefined()
    expect(webViewFileUrl(DOWNLOAD, null)).toBeUndefined()
  })

  it('know the page’s origin', () => {
    expect(pageOrigin({ location: { origin: ORIGIN } })).toBe(ORIGIN)
    expect(pageOrigin({ location: { origin: 'null' } })).toBeUndefined()
    expect(pageOrigin({})).toBeUndefined()
    expect(player).toHaveProperty('webViewFileUrl')
    expect(player).toHaveProperty('deviceFileUri')
  })

  it('play on Media3 as file sources, without headers, expiry or network', () => {
    const stream = testStream('a', {
      url: webViewFileUrl(SONG, ORIGIN) ?? '',
      codec: 'flac',
      container: 'flac',
      tier: 'lossless',
      fullLength: 'verified',
      requestHeaders: { Referer: 'https://x.test/' },
    })
    expect(nativeSupport(stream, ORIGIN)).toBe('probably')
    expect(nativeSupport({ ...stream, codec: 'alac', container: 'm4a' }, ORIGIN)).toBe('maybe')
    expect(nativeSupport({ ...stream, fullLength: 'capped' }, ORIGIN)).toBe('no')
    expect(nativeSource(stream, 3, ORIGIN)).toEqual({ kind: 'file', url: SONG })
    // On another page the URL is nothing of the device's: a WebView URL Media3 can't fetch.
    expect(nativeSource(stream, 3, 'https://other.test').kind).toBeUndefined()
  })

  it('come back from a session as the stream that was sent', () => {
    const stream = testStream('a', {
      url: webViewFileUrl(DOWNLOAD, ORIGIN) ?? '',
      fullLength: 'verified',
    })
    const entry = nativeEntry('n1-1', { uid: 4, track: testTrack('a') }, stream, 2, ORIGIN)
    expect(entry.source).toEqual({ kind: 'file', url: DOWNLOAD })
    expect(restoreStream(entry, ORIGIN)).toEqual(stream)
    // Without the page's origin, the file's own URI, which plays on Media3 all the same.
    expect(restoreStream(entry, null)).toEqual({ ...stream, url: DOWNLOAD })
  })
})
