import { afterEach, describe, expect, it } from 'vitest'
import {
  type ConvertFileSrc,
  isReadableMediaUrl,
  isStreamUrl,
  MEDIA_SCHEME,
  readableMediaUrl,
  readableStreamUrl,
  tauriConvertFileSrc,
} from './media'

/** A stream URL as stage 1.4 resolves one; its query carries the user's IP address. */
const STREAM =
  'https://rr3---sn-ab5l6nrz.googlevideo.com/videoplayback?expire=1&ip=203.0.113.7&itag=251&mime=audio%2Fwebm'

/** Tauri's convertFileSrc, as its script spells URLs on macOS and Linux. */
const unix: ConvertFileSrc = (path, scheme) => `${scheme}://localhost/${encodeURIComponent(path)}`

/** The same on Windows, where wry serves custom schemes from `http://<scheme>.localhost`. */
const windows: ConvertFileSrc = (path, scheme) =>
  `http://${scheme}.localhost/${encodeURIComponent(path)}`

describe('isStreamUrl', () => {
  it('takes googlevideo stream URLs, as the shell does', () => {
    expect(isStreamUrl(STREAM)).toBe(true)
    expect(isStreamUrl('https://rr1---sn-4g5e6nsk.googlevideo.com/videoplayback?itag=18')).toBe(
      true,
    )
  })

  it('refuses every other URL, as the shell does', () => {
    for (const url of [
      'http://rr3---sn-ab5l6nrz.googlevideo.com/videoplayback?itag=251',
      'https://rr3---sn-ab5l6nrz.googlevideo.com:8443/videoplayback',
      'https://user:pass@rr3---sn-ab5l6nrz.googlevideo.com/videoplayback',
      'https://rr3---sn-ab5l6nrz.googlevideo.com/initplayback?itag=251',
      'https://rr3---sn-ab5l6nrz.googlevideo.com/videoplayback/x',
      'https://googlevideo.com/videoplayback',
      'https://evilgooglevideo.com/videoplayback',
      'https://rr3.googlevideo.com.evil.test/videoplayback',
      'https://archive.org/download/x/x.mp3',
      'blob:tauri://localhost/1234',
      'not a url',
    ]) {
      expect(isStreamUrl(url), url).toBe(false)
    }
  })
})

describe('readableMediaUrl', () => {
  it('puts the whole stream URL, encoded, in the path of the shell’s scheme', () => {
    const url = readableMediaUrl(STREAM, unix)
    expect(url).toBe(`fxm-media://localhost/${encodeURIComponent(STREAM)}`)
    // Nothing of the stream URL is left in a query or a fragment of its own.
    const parsed = new URL(url ?? '')
    expect(parsed.search).toBe('')
    expect(parsed.hash).toBe('')
    expect(decodeURIComponent(parsed.pathname.slice(1))).toBe(STREAM)
  })

  it('takes the form Tauri gives the scheme on Windows', () => {
    expect(readableMediaUrl(STREAM, windows)).toBe(
      `http://fxm-media.localhost/${encodeURIComponent(STREAM)}`,
    )
  })

  it('has no readable form for other URLs', () => {
    expect(readableMediaUrl('https://archive.org/download/x/x.mp3', unix)).toBeUndefined()
  })
})

describe('tauriConvertFileSrc', () => {
  const global = globalThis as { __TAURI_INTERNALS__?: unknown }
  afterEach(() => {
    delete global.__TAURI_INTERNALS__
  })

  it('is Tauri’s own, from the script Tauri puts in the app’s pages', () => {
    const internals = {
      os: 'windows',
      convertFileSrc(this: { os: string }, path: string, scheme: string) {
        return this.os === 'windows' ? windows(path, scheme) : unix(path, scheme)
      },
    }
    global.__TAURI_INTERNALS__ = internals
    expect(readableMediaUrl(STREAM)).toBe(readableMediaUrl(STREAM, windows))
    expect(tauriConvertFileSrc()?.('x', MEDIA_SCHEME)).toBe('http://fxm-media.localhost/x')
  })

  it('is missing outside the desktop app, where nothing is readable this way', () => {
    expect(tauriConvertFileSrc()).toBeUndefined()
    expect(readableMediaUrl(STREAM)).toBeUndefined()
    expect(readableStreamUrl({ url: STREAM, protocol: 'progressive' })).toBeUndefined()
  })
})

describe('readableStreamUrl', () => {
  it('serves progressive googlevideo streams only', () => {
    expect(readableStreamUrl({ url: STREAM, protocol: 'progressive' }, unix)).toBe(
      readableMediaUrl(STREAM, unix),
    )
    // A SABR session (stage 1.11) is posted to, not loaded by an element.
    expect(readableStreamUrl({ url: STREAM, protocol: 'sabr' }, unix)).toBeUndefined()
    expect(
      readableStreamUrl(
        { url: 'https://archive.org/download/x/x.mp3', protocol: 'progressive' },
        unix,
      ),
    ).toBeUndefined()
  })
})

describe('isReadableMediaUrl', () => {
  it('knows the scheme in both forms', () => {
    expect(isReadableMediaUrl(readableMediaUrl(STREAM, unix) ?? '')).toBe(true)
    expect(isReadableMediaUrl(readableMediaUrl(STREAM, windows) ?? '')).toBe(true)
    expect(isReadableMediaUrl(`https://${MEDIA_SCHEME}.localhost/x`)).toBe(true)
  })

  it('knows nothing else', () => {
    for (const url of [
      STREAM,
      'tauri://localhost/index.html',
      'fxm-media://evil.test/x',
      'http://fxm-media.localhost:8080/x',
      'http://fxm-media.localhost.evil.test/x',
      'not a url',
    ]) {
      expect(isReadableMediaUrl(url), url).toBe(false)
    }
  })
})
