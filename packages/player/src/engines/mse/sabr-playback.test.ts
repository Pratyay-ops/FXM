import { describe, expect, it } from 'vitest'
import { parseSabrPlayback, SABR_PLAYBACK_FORMAT } from './sabr-playback'
import { SESSION } from './testing'

describe('the SABR session in a stream option', () => {
  it('reads the session @fxm/sources describes', () => {
    expect(parseSabrPlayback(JSON.parse(JSON.stringify(SESSION)))).toEqual(SESSION)
  })

  it('refuses anything else', () => {
    const broken: unknown[] = [
      undefined,
      'session',
      { ...SESSION, format: 'youtube-sabr/2' },
      { ...SESSION, videoId: 'short' },
      { ...SESSION, ustreamerConfig: 'not base64!' },
      { ...SESSION, poToken: '' },
      { ...SESSION, client: { nameId: 0, version: '1' } },
      { ...SESSION, durationMs: 0 },
      { ...SESSION, audio: { ...SESSION.audio, mimeType: 'video/webm' } },
      { ...SESSION, audio: { ...SESSION.audio, lastModified: 'yesterday' } },
      { ...SESSION, video: { ...SESSION.video, mimeType: 'audio/webm' } },
    ]
    for (const value of broken)
      expect(parseSabrPlayback(value), JSON.stringify(value)).toBeUndefined()
    expect(SABR_PLAYBACK_FORMAT).toBe('youtube-sabr/1')
  })

  it('keeps only known optional fields', () => {
    const parsed = parseSabrPlayback({
      ...SESSION,
      audio: { ...SESSION.audio, xtags: 'CgcKAnh0EgEx', surprise: { nested: true } },
    })
    expect(parsed?.audio).toEqual({ ...SESSION.audio, xtags: 'CgcKAnh0EgEx' })
  })
})
