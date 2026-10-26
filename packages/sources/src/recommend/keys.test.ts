import { describe, expect, it } from 'vitest'
import { artistKey, songKey } from './keys'

describe('songKey and artistKey', () => {
  it('give listings of the same song or artist one key', () => {
    expect(songKey('Radiohead', 'Creep')).toBe('radiohead|creep')
    expect(songKey('RadioheadVEVO', 'Radiohead - Creep (Official Music Video)')).toBe(
      'radiohead|creep',
    )
    expect(songKey('Blur', 'Song 2 - 2012 Remaster')).toBe(songKey('Blur', 'Song 2'))
    expect(artistKey('Björk')).toBe('bjork')
    expect(artistKey('Radiohead - Topic')).toBe(artistKey('radiohead'))
  })

  it('keep names of symbols only apart', () => {
    expect(artistKey('!!!')).toBe('!!!')
    expect(artistKey('✝✝✝')).not.toBe(artistKey('!!!'))
    expect(songKey('!!!', 'Me and Giuliani Down by the School Yard')).not.toBe(
      songKey('✝✝✝', 'Me and Giuliani Down by the School Yard'),
    )
    expect(artistKey('  ')).toBe('')
  })
})
