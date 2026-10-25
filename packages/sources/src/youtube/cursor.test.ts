import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor, RADIO_MEMORY, seenField, seenIds } from './cursor'

describe('cursors', () => {
  it('round-trip, queries in any script included', () => {
    const search = { k: 'search', t: 'track', q: 'アイドル YOASOBI', c: 'token', o: 4 } as const
    expect(decodeCursor(encodeCursor(search), 'search')).toEqual(search)
    const playlist = { k: 'playlist', p: 'PLNfe5eb0vdozpNx650kvCDhFjteIpW-L2' } as const
    expect(decodeCursor(encodeCursor(playlist), 'playlist')).toEqual(playlist)
    const radio = { k: 'radio', s: 'track:zFYEYRcjK2g', c: 'token', seen: 'zFYEYRcjK2g' } as const
    expect(decodeCursor(encodeCursor(radio), 'radio')).toEqual(radio)
    const firstPage = { k: 'radio', s: 'artist:UCr_iyUANcn9OX_yy9piYoLw', seen: '' } as const
    expect(decodeCursor(encodeCursor(firstPage), 'radio')).toEqual(firstPage)
    expect(encodeCursor(search)).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('are refused as NotFound when malformed, tampered with or of another list', () => {
    const encoded = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, '')
    for (const [text, kind] of [
      ['', 'search'],
      ['not base64!', 'search'],
      [btoa('{not json'), 'search'],
      [encoded({ k: 'search', t: 'song', q: 'x' }), 'search'],
      [encoded({ k: 'search', t: 'track', q: 'x', o: 0.5 }), 'search'],
      [encoded({ k: 'search', t: 'track', q: 'x'.repeat(501) }), 'search'],
      [encoded({ k: 'playlist', p: 'bad id!' }), 'playlist'],
      [encoded({ k: 'radio', s: 'track:zFYEYRcjK2g', c: 'c', seen: 'short' }), 'radio'],
      [encoded({ k: 'radio', s: 'video:x', c: 'c', seen: '' }), 'radio'],
      [encoded({ k: 'radio', s: 'track:zFYEYRcjK2g', c: '', seen: '' }), 'radio'],
      [encoded({ k: 'radio', s: 'track:zFYEYRcjK2g', c: 7, seen: '' }), 'radio'],
      [encoded({ k: 'playlist', p: 'PL1' }), 'search'],
      [encoded({ k: 'other' }), 'search'],
      ['a'.repeat(9000), 'search'],
    ] as const) {
      expect(() => decodeCursor(text, kind)).toThrow(expect.objectContaining({ code: 'NotFound' }))
    }
  })

  it('remember only the newest videoIds of a radio', () => {
    const ids = Array.from(
      { length: RADIO_MEMORY + 5 },
      (_, n) => `id${String(n).padStart(9, '0')}`,
    )
    const seen = seenField(ids)
    expect(seen).toHaveLength(RADIO_MEMORY * 11)
    const cursor = { k: 'radio', s: 'track:zFYEYRcjK2g', c: 'c', seen } as const
    expect(seenIds(cursor)[0]).toBe(ids[5])
    expect(seenIds(cursor).at(-1)).toBe(ids.at(-1))
  })
})
