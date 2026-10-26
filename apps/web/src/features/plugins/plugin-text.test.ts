import { PLUGIN_OPERATIONS } from '@fxm/plugins'
import { describe, expect, it } from 'vitest'
import { operationsSentences, splitOperations, USED_OPERATIONS } from './plugin-text'

describe('what a plugin adds', () => {
  it('counts only what this version of FXM uses', () => {
    expect([...USED_OPERATIONS]).toEqual(['search', 'album', 'artist', 'playlist', 'resolve'])
    expect(splitOperations([...PLUGIN_OPERATIONS])).toEqual({
      used: ['search', 'album', 'artist', 'playlist', 'resolve'],
      unused: ['suggest', 'track', 'radio', 'match'],
    })
  })

  it('says what it adds, and names what it offers beyond that as unused', () => {
    expect(operationsSentences(['search', 'radio', 'match', 'resolve'])).toEqual([
      'It adds search and audio for its songs.',
      'It also offers radio and audio for songs from other sources, which this version of FXM doesn’t use.',
    ])
    expect(operationsSentences(['search', 'album'], '')).toEqual(['Adds search and albums.'])
    expect(operationsSentences(['radio'], '')).toEqual([
      'Offers radio, which this version of FXM doesn’t use.',
    ])
    expect(operationsSentences([])).toEqual([])
  })
})
