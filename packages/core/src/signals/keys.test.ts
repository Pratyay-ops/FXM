import { describe, expect, it } from 'vitest'
import { formatId } from '../ids'
import { artistAffinityKey, artistKey, tagAffinityKey, trackAffinityKey } from './keys'

describe('artistKey', () => {
  it.each([
    ['Radiohead', 'radiohead'],
    ['  The   Beatles ', 'the beatles'],
    ['Beyoncé', 'beyonce'],
    ['BEYONCE', 'beyonce'],
    ['Mø', 'mo'],
    ['宇多田ヒカル', '宇多田ヒカル'],
    ['AC/DC', 'ac dc'],
    ['Guns N’ Roses', 'guns n roses'],
    ['Panic! at the Disco', 'panic at the disco'],
  ])('keys %j as %j', (name, key) => {
    expect(artistKey(name)).toBe(key)
  })

  it.each([
    'Radiohead',
    'Radiohead - Topic',
    'Radiohead – Topic',
    'RadioheadVEVO',
    'Radiohead VEVO',
    'Radiohead Official',
    'Radiohead (Official)',
    'Radiohead [UK]',
    'RADIOHEAD',
  ])('gives %j the key of the artist behind the channel', (name) => {
    expect(artistKey(name)).toBe('radiohead')
  })

  it('reads & as and', () => {
    expect(artistKey('Simon & Garfunkel')).toBe(artistKey('Simon and Garfunkel'))
    expect(artistKey('Simon & Garfunkel')).toBe('simon and garfunkel')
  })

  it('keeps what it can of a name that is all decoration or punctuation', () => {
    expect(artistKey('VEVO')).toBe('vevo')
    expect(artistKey('(Official)')).toBe('official')
    expect(artistKey('!!!')).toBe('!!!')
    expect(artistKey('')).toBe('')
    expect(artistKey(7 as unknown as string)).toBe('')
  })

  it.each([
    'Radiohead - Topic',
    'X VEVO VEVO!',
    'XVEVO Official',
    'Sunn O)))',
    'Simon & Garfunkel',
    '!!!',
    'Official髭男dism',
    'Ｆｕｌｌ　Ｗｉｄｔｈ',
  ])('gives its own key back for %j', (name) => {
    const key = artistKey(name)
    expect(artistKey(key)).toBe(key)
  })
})

describe('artistAffinityKey', () => {
  it('is the artist key', () => {
    expect(artistAffinityKey('Radiohead - Topic')).toBe('radiohead')
    expect(artistAffinityKey('Beyoncé')).toBe('beyonce')
  })

  it.each([
    '',
    '   ',
    'Various Artists',
    'VARIOUS ARTISTS',
    'Various',
    'V/A',
    'Unknown Artist',
    'unknown',
    '[unknown]',
    '<Unknown>',
    'x'.repeat(201),
  ])('gives no key for %j', (name) => {
    expect(artistAffinityKey(name)).toBeUndefined()
  })

  it('gives no key for a value that is not a string', () => {
    expect(artistAffinityKey(42 as unknown as string)).toBeUndefined()
    expect(artistAffinityKey(undefined as unknown as string)).toBeUndefined()
  })
})

describe('tagAffinityKey', () => {
  it.each(['Hip-Hop', 'hip hop', 'HIP_HOP', 'hip/hop', ' hip -  hop '])(
    'keys %j as "hip hop"',
    (tag) => {
      expect(tagAffinityKey(tag)).toBe('hip hop')
    },
  )

  it('keeps other punctuation and other scripts', () => {
    expect(tagAffinityKey('R&B')).toBe('r&b')
    expect(tagAffinityKey('Électro')).toBe('electro')
    expect(tagAffinityKey('ボカロ')).toBe('ボカロ')
  })

  it('gives its own key back', () => {
    expect(tagAffinityKey('hip hop')).toBe('hip hop')
  })

  it.each(['', ' - ', 'x'.repeat(65)])('gives no key for %j', (tag) => {
    expect(tagAffinityKey(tag)).toBeUndefined()
  })

  it('gives no key for a value that is not a string', () => {
    expect(tagAffinityKey(null as unknown as string)).toBeUndefined()
  })
})

describe('trackAffinityKey', () => {
  it('gives both YouTube spellings of a video one key, and gives the key back', () => {
    const key = trackAffinityKey(formatId('ytm', 'track', 'dQw4w9WgXcQ'))
    expect(key).toBe('youtube:track:dQw4w9WgXcQ')
    expect(trackAffinityKey(formatId('yt', 'track', 'dQw4w9WgXcQ'))).toBe(key)
    expect(trackAffinityKey(key as string)).toBe(key)
  })

  it('keys any other track by its ID', () => {
    const id = formatId('spotify', 'track', '4uLU6hMCjMI75M1A2tKUQC')
    expect(trackAffinityKey(id)).toBe(id)
  })

  it('gives no key for an empty value or one that is not a string', () => {
    expect(trackAffinityKey('')).toBeUndefined()
    expect(trackAffinityKey(null as unknown as string)).toBeUndefined()
  })
})
