import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  ENTITY_KINDS,
  type EntityId,
  type EntityIdParts,
  type EntityKind,
  entityKey,
  formatId,
  isEntityId,
  isEntityKind,
  isSourceId,
  parseId,
  SOURCE_IDS,
  type SourceId,
  sameEntity,
} from './ids'

describe('formatId and parseId', () => {
  const combinations = SOURCE_IDS.flatMap((source) =>
    ENTITY_KINDS.map((kind) => [source, kind] as const),
  )

  it.each(combinations)('round-trips %s:%s', (source, kind) => {
    const id = formatId(source, kind, 'abc123')
    expect(id).toBe(`${source}:${kind}:abc123`)
    expect(parseId(id)).toEqual({ source, kind, nativeId: 'abc123' })
  })

  it.each([
    ['a YouTube video ID with - and _', 'ytm', 'track', 'dQw4w9WgXcQ-_'],
    ['colons in a local path', 'local', 'playlist', '/Volumes/Music/Live: 1977/Set: 2.m3u'],
    ['a local path', 'local', 'track', 'C:\\Music\\Song: Live.flac'],
    ['an Internet Archive file', 'archive', 'track', 'gd1977-05-08/d1t01.flac'],
    ['a trailing colon', 'yt', 'playlist', 'PL123:'],
    ['spaces', 'local', 'album', '/Users/me/My Music/Album'],
    ['non-Latin text', 'jiosaavn', 'album', 'केसरिया'],
  ] as const)('keeps a native ID with %s verbatim', (_label, source, kind, nativeId) => {
    const id = formatId(source, kind, nativeId)
    expect(id).toBe(`${source}:${kind}:${nativeId}`)
    expect(parseId(id)).toEqual({ source, kind, nativeId })
  })

  it('splits only on the first two colons', () => {
    expect(parseId('local:track:a:b:c')).toEqual({
      source: 'local',
      kind: 'track',
      nativeId: 'a:b:c',
    })
  })

  it.each([
    ['', 'empty'],
    ['ytm', 'no colon'],
    ['ytm:track', 'one colon'],
    ['ytm:track:', 'an empty native ID'],
    [':track:abc', 'an empty source'],
    ['ytm::abc', 'an empty kind'],
    ['youtube:track:abc', 'an unknown source'],
    ['YTM:track:abc', 'a source in the wrong case'],
    [' ytm:track:abc', 'leading whitespace'],
    ['ytm:song:abc', 'an unknown kind'],
    ['ytm:Track:abc', 'a kind in the wrong case'],
    ['ytm:track abc', 'a space instead of a colon'],
    ['toString:track:abc', 'an inherited property name as source'],
  ])('returns null for %j (%s)', (input) => {
    expect(parseId(input)).toBeNull()
  })

  it.each([undefined, null, 42, {}, ['ytm', 'track', 'abc']])(
    'returns null instead of throwing for the non-string %j',
    (input) => {
      expect(parseId(input as unknown as string)).toBeNull()
    },
  )

  it.each([
    ['an unknown source', 'youtube', 'track', 'abc'],
    ['an unknown kind', 'ytm', 'song', 'abc'],
    ['an empty native ID', 'ytm', 'track', ''],
    ['a non-string native ID', 'ytm', 'track', 42],
  ])('refuses to format %s', (_label, source, kind, nativeId) => {
    expect(() =>
      formatId(source as SourceId, kind as EntityKind, nativeId as unknown as string),
    ).toThrow(RangeError)
  })
})

describe('isEntityId', () => {
  it('accepts well-formed IDs', () => {
    expect(isEntityId('ytm:track:abc')).toBe(true)
    expect(isEntityId('spotify:artist:0OdUWJ0sBjDrqHygGUXeCF')).toBe(true)
  })

  it('checks the kind when one is given', () => {
    expect(isEntityId('ytm:album:abc', 'album')).toBe(true)
    expect(isEntityId('ytm:album:abc', 'track')).toBe(false)
  })

  it.each(['ytm:track:', 'nope', '', 42, null, undefined, { id: 'ytm:track:abc' }])(
    'rejects %j',
    (value) => {
      expect(isEntityId(value)).toBe(false)
    },
  )

  it('narrows unknown values to branded IDs', () => {
    const value: unknown = 'ytm:track:abc'
    if (isEntityId(value, 'track')) expectTypeOf(value).toEqualTypeOf<EntityId<'track'>>()
    if (isEntityId(value)) expectTypeOf(value).toEqualTypeOf<EntityId>()
  })
})

describe('isSourceId and isEntityKind', () => {
  it.each(SOURCE_IDS)('knows the source %s', (source) => {
    expect(isSourceId(source)).toBe(true)
  })

  it.each(ENTITY_KINDS)('knows the kind %s', (kind) => {
    expect(isEntityKind(kind)).toBe(true)
  })

  it.each(['youtube', 'saavn', 'YTM', '', 'constructor', 7, null])('rejects %j', (value) => {
    expect(isSourceId(value)).toBe(false)
    expect(isEntityKind(value)).toBe(false)
  })

  it('lists every source and kind of the brief', () => {
    expect([...SOURCE_IDS].sort()).toEqual(
      ['archive', 'jamendo', 'jiosaavn', 'local', 'spotify', 'yt', 'ytm'].sort(),
    )
    expect(ENTITY_KINDS).toEqual(['track', 'album', 'artist', 'playlist'])
  })
})

describe('EntityId types', () => {
  it('is branded and narrows by kind', () => {
    const track = formatId('ytm', 'track', 'abc')
    expectTypeOf(track).toEqualTypeOf<EntityId<'track'>>()
    expectTypeOf(track).toExtend<EntityId>()
    expectTypeOf(track).toExtend<string>()
    expectTypeOf<EntityId<'album'>>().not.toExtend<EntityId<'track'>>()
    expectTypeOf<string>().not.toExtend<EntityId>()
    // @ts-expect-error a plain string is not an EntityId
    const plain: EntityId = 'ytm:track:abc'
    expect(plain).toBe(track)
  })

  it('parses a branded ID without a null check and keeps its kind', () => {
    const album = formatId('spotify', 'album', '4aawyAB9vmqN3uQ7FjRGTy')
    const parts = parseId(album)
    expectTypeOf(parts).toEqualTypeOf<EntityIdParts<'album'>>()
    expect(parts.nativeId).toBe('4aawyAB9vmqN3uQ7FjRGTy')
    expectTypeOf(parseId(album as EntityId)).toEqualTypeOf<EntityIdParts>()
  })

  it('may return null for any other value', () => {
    const text: string = 'ytm:track:abc'
    expectTypeOf(parseId(text)).toEqualTypeOf<EntityIdParts | null>()
    expectTypeOf(parseId(undefined)).toEqualTypeOf<EntityIdParts | null>()
    const maybe = formatId('ytm', 'track', 'abc') as EntityId<'track'> | undefined
    expectTypeOf(parseId(maybe)).toEqualTypeOf<EntityIdParts | null>()
  })
})

describe('entityKey and sameEntity', () => {
  it.each([
    ['ytm', 'track', 'dQw4w9WgXcQ', 'youtube:track:dQw4w9WgXcQ'],
    ['yt', 'track', 'dQw4w9WgXcQ', 'youtube:track:dQw4w9WgXcQ'],
    ['yt', 'artist', 'UCuAXFkgsw1L7xaCfnd5JJOw', 'youtube:artist:UCuAXFkgsw1L7xaCfnd5JJOw'],
    ['ytm', 'playlist', 'PL1:x', 'youtube:playlist:PL1:x'],
    ['spotify', 'track', '4uLU6hMCjMI75M1A2tKUQC', 'spotify:track:4uLU6hMCjMI75M1A2tKUQC'],
    ['archive', 'track', 'gd1977/d1t01.flac', 'archive:track:gd1977/d1t01.flac'],
    ['local', 'album', 'ytm:album:x', 'local:album:ytm:album:x'],
  ] as const)('keys %s:%s:%s as %s', (source, kind, nativeId, key) => {
    expect(entityKey(formatId(source, kind, nativeId))).toBe(key)
  })

  it('treats one YouTube item from YouTube Music and from plain YouTube as one entity', () => {
    expect(sameEntity(formatId('ytm', 'track', 'abc'), formatId('yt', 'track', 'abc'))).toBe(true)
    expect(sameEntity(formatId('yt', 'artist', 'UC1'), formatId('ytm', 'artist', 'UC1'))).toBe(true)
    expect(sameEntity(formatId('jamendo', 'track', '7'), formatId('jamendo', 'track', '7'))).toBe(
      true,
    )
  })

  it.each([
    ['another kind', 'ytm', 'album', 'abc'],
    ['another source', 'spotify', 'track', 'abc'],
    ['another native ID', 'yt', 'track', 'abd'],
    ['a native ID in another case', 'ytm', 'track', 'ABC'],
  ] as const)('keeps an ID with %s apart', (_label, source, kind, nativeId) => {
    expect(sameEntity(formatId('ytm', 'track', 'abc'), formatId(source, kind, nativeId))).toBe(
      false,
    )
  })

  it('returns keys that are not entity IDs', () => {
    const key = entityKey(formatId('ytm', 'track', 'abc'))
    expect(isEntityId(key)).toBe(false)
    expect(parseId(key)).toBeNull()
  })
})
