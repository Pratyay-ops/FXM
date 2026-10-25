import { describe, expect, it } from 'vitest'
import * as player from './index'
import * as testing from './testing'

describe('the @fxm/player entry point', () => {
  it.each([
    ['facade', ['Player', 'PLAYER_DEFAULTS']],
    ['engines', ['DirectAudioEngine', 'EngineError', 'isEngineError', 'ENGINE_ERROR_TYPES']],
    ['media session', ['connectMediaSession', 'MEDIA_SESSION_ACTIONS', 'mediaMetadataInit']],
    ['media session helpers', ['mediaImages', 'MEDIA_SESSION_SEEK_OFFSET_MS']],
    ['formats', ['mimeTypeOf', 'formatTime']],
  ])('exports the %s', (_group, names) => {
    for (const name of names) expect(player).toHaveProperty(name)
  })

  it('keeps formatTime', () => {
    expect(player.formatTime(65)).toBe('1:05')
  })

  it('offers fakes for tests under @fxm/player/testing', () => {
    for (const name of ['FakeEngine', 'FakeResolver', 'testTrack', 'testTracks', 'testStream']) {
      expect(testing).toHaveProperty(name)
    }
  })
})
