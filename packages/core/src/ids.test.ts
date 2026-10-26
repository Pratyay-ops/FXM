import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  type BuiltInSourceId,
  ENTITY_KINDS,
  type EntityId,
  type EntityIdParts,
  type EntityKind,
  entityKey,
  formatId,
  isBuiltInSourceId,
  isEntityId,
  isEntityKind,
  isPluginSourceId,
  isSourceId,
  normalizeIsrc,
  type PluginSourceId,
  parseId,
  SOURCE_IDS,
  type SourceId,
  sameEntity,
} from './ids'

/** Plugin source IDs at the edges of the name rule. */
const PLUGIN_SOURCES = [
  'plugin.example',
  'plugin.radio-garden',
  'plugin.a',
  'plugin.0',
  'plugin.my-source2',
  'plugin.a--b',
  `plugin.${'a'.repeat(63)}`,
] as const satisfies readonly PluginSourceId[]

/** Malformed plugin source IDs, and why. */
const MALFORMED_PLUGIN_SOURCES = [
  ['plugin', 'no name and no dot'],
  ['plugin.', 'an empty name'],
  ['plugin.Radio', 'an upper-case letter'],
  ['Plugin.radio', 'an upper-case prefix'],
  ['plugin.-radio', 'a leading hyphen'],
  ['plugin.radio-', 'a trailing hyphen'],
  ['plugin.radio.garden', 'a dot in the name'],
  ['plugin.radio_garden', 'an underscore'],
  ['plugin.radio garden', 'a space'],
  [' plugin.radio', 'leading whitespace'],
  ['plugin.radio\n', 'a trailing newline'],
  ['plugin.rädio', 'a non-ASCII letter'],
  ['plugin..radio', 'two dots'],
  ['plugins.radio', 'another prefix'],
  ['xplugin.radio', 'text before the prefix'],
  [`plugin.${'a'.repeat(64)}`, 'a name over 63 characters'],
] as const

describe('formatId and parseId', () => {
  const combinations = [...SOURCE_IDS, ...PLUGIN_SOURCES].flatMap((source) =>
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
    ['non-Latin text', 'plugin.example', 'album', 'केसरिया'],
    ['colons in a plugin ID', 'plugin.radio-garden', 'track', 'station:42:live'],
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
    ['jiosaavn:track:abc', 'a removed source'],
    ['plugin.radio:song:abc', 'a plugin source with an unknown kind'],
    ['plugin.radio:track:', 'a plugin source with an empty native ID'],
  ])('returns null for %j (%s)', (input) => {
    expect(parseId(input)).toBeNull()
  })

  it.each(MALFORMED_PLUGIN_SOURCES)('returns null for the plugin source %j (%s)', (source) => {
    expect(parseId(`${source}:track:abc`)).toBeNull()
  })

  it.each([undefined, null, 42, {}, ['ytm', 'track', 'abc']])(
    'returns null instead of throwing for the non-string %j',
    (input) => {
      expect(parseId(input as unknown as string)).toBeNull()
    },
  )

  it.each([
    ['an unknown source', 'youtube', 'track', 'abc'],
    ['a removed source', 'jiosaavn', 'track', 'abc'],
    ['a plugin source without a name', 'plugin.', 'track', 'abc'],
    ['a plugin source with a colon in its name', 'plugin.a:b', 'track', 'abc'],
    ['an unknown kind', 'ytm', 'song', 'abc'],
    ['an unknown kind from a plugin source', 'plugin.radio', 'song', 'abc'],
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
    expect(isEntityId('plugin.radio-garden:playlist:x:y')).toBe(true)
  })

  it('checks the kind when one is given', () => {
    expect(isEntityId('ytm:album:abc', 'album')).toBe(true)
    expect(isEntityId('ytm:album:abc', 'track')).toBe(false)
  })

  it.each([
    'ytm:track:',
    'nope',
    '',
    42,
    null,
    undefined,
    { id: 'ytm:track:abc' },
    'jiosaavn:track:abc',
    'plugin.Radio:track:abc',
  ])('rejects %j', (value) => {
    expect(isEntityId(value)).toBe(false)
  })

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

  it.each(['youtube', 'saavn', 'jiosaavn', 'YTM', '', 'constructor', 7, null])(
    'rejects %j',
    (value) => {
      expect(isSourceId(value)).toBe(false)
      expect(isEntityKind(value)).toBe(false)
    },
  )

  it('lists every built-in source and kind', () => {
    expect([...SOURCE_IDS].sort()).toEqual(
      ['archive', 'jamendo', 'local', 'spotify', 'yt', 'ytm'].sort(),
    )
    expect(ENTITY_KINDS).toEqual(['track', 'album', 'artist', 'playlist'])
  })

  it('no longer knows JioSaavn, at compile time or at run time', () => {
    // @ts-expect-error JioSaavn was removed from the plan
    const removed: SourceId = 'jiosaavn'
    expect(isSourceId(removed)).toBe(false)
    expect(() => formatId(removed, 'track', 'abc')).toThrow(RangeError)
  })
})

describe('plugin sources', () => {
  it.each(PLUGIN_SOURCES)('accepts the plugin source %s', (source) => {
    expect(isPluginSourceId(source)).toBe(true)
    expect(isSourceId(source)).toBe(true)
  })

  it.each(MALFORMED_PLUGIN_SOURCES)('rejects %j (%s)', (source) => {
    expect(isPluginSourceId(source)).toBe(false)
    expect(isSourceId(source)).toBe(false)
  })

  it.each([...SOURCE_IDS, 'toString', 42, null, undefined, { source: 'plugin.radio' }])(
    'does not take %j for a plugin source',
    (value) => {
      expect(isPluginSourceId(value)).toBe(false)
    },
  )

  it('keeps the built-in sources and the plugin sources apart in the types', () => {
    expectTypeOf<SourceId>().toEqualTypeOf<BuiltInSourceId | `plugin.${string}`>()
    expectTypeOf<PluginSourceId>().toEqualTypeOf<`plugin.${string}`>()
    const source = 'plugin.radio' as SourceId
    if (isBuiltInSourceId(source)) expectTypeOf(source).toEqualTypeOf<BuiltInSourceId>()
    else expectTypeOf(source).toEqualTypeOf<PluginSourceId>()
    const stored: unknown = 'plugin.radio'
    if (isSourceId(stored)) expectTypeOf(stored).toEqualTypeOf<SourceId>()
    if (isPluginSourceId(stored)) expectTypeOf(stored).toEqualTypeOf<PluginSourceId>()
    expectTypeOf(formatId('plugin.radio', 'track', 'x')).toEqualTypeOf<EntityId<'track'>>()
    // @ts-expect-error a plugin source needs the plugin. prefix
    expect(() => formatId('radio', 'track', 'x')).toThrow(RangeError)
  })

  it('takes a malformed plugin source that the type allows for neither kind', () => {
    // The type accepts any plugin. string, as untyped plugin code may hand over.
    const malformed: SourceId = 'plugin.Bad'
    expect(isBuiltInSourceId(malformed)).toBe(false)
    expect(isPluginSourceId(malformed)).toBe(false)
    expect(isSourceId(malformed)).toBe(false)
    expect(() => formatId(malformed, 'track', 'x')).toThrow(RangeError)
  })
})

describe('isBuiltInSourceId', () => {
  it.each(SOURCE_IDS)('knows the built-in source %s', (source) => {
    expect(isBuiltInSourceId(source)).toBe(true)
  })

  it.each([
    ...PLUGIN_SOURCES,
    ...MALFORMED_PLUGIN_SOURCES.map(([source]) => source),
    'jiosaavn',
    'youtube',
    'YTM',
    'ytm ',
    '',
    'toString',
    'constructor',
    42,
    null,
    undefined,
    { source: 'ytm' },
  ])('rejects %j', (value) => {
    expect(isBuiltInSourceId(value)).toBe(false)
  })

  it('splits every source into exactly one of the two kinds', () => {
    for (const source of [...SOURCE_IDS, ...PLUGIN_SOURCES]) {
      expect(isSourceId(source)).toBe(true)
      expect(isBuiltInSourceId(source)).not.toBe(isPluginSourceId(source))
    }
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
    ['plugin.example', 'track', 'dQw4w9WgXcQ', 'plugin.example:track:dQw4w9WgXcQ'],
    ['plugin.youtube', 'track', 'dQw4w9WgXcQ', 'plugin.youtube:track:dQw4w9WgXcQ'],
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
    ['a plugin source and the same native ID', 'plugin.example', 'track', 'abc'],
  ] as const)('keeps an ID with %s apart', (_label, source, kind, nativeId) => {
    expect(sameEntity(formatId('ytm', 'track', 'abc'), formatId(source, kind, nativeId))).toBe(
      false,
    )
  })

  it('keys a plugin ID by itself, apart from every other source', () => {
    const plugin = formatId('plugin.example', 'track', 'abc')
    expect(sameEntity(plugin, formatId('plugin.example', 'track', 'abc'))).toBe(true)
    expect(sameEntity(plugin, formatId('plugin.other', 'track', 'abc'))).toBe(false)
    expect(sameEntity(plugin, formatId('yt', 'track', 'abc'))).toBe(false)
  })

  it('returns keys that are not entity IDs', () => {
    const key = entityKey(formatId('ytm', 'track', 'abc'))
    expect(isEntityId(key)).toBe(false)
    expect(parseId(key)).toBeNull()
  })
})

describe('normalizeIsrc', () => {
  it.each([
    ['GBARL9300135', 'GBARL9300135'],
    ['gbarl9300135', 'GBARL9300135'],
    ['GB-ARL-93-00135', 'GBARL9300135'],
    ['GB ARL 93 00135', 'GBARL9300135'],
    [' gb\u{2013}arl\u{2013}93\u{2013}00135 ', 'GBARL9300135'],
    ['US.UM7.15.00001', 'USUM71500001'],
    ['ＧＢＡＲＬ９３００１３５', 'GBARL9300135'],
    ['ISRC: GB-ARL-93-00135', 'GBARL9300135'],
    ['isrc GBARL9300135', 'GBARL9300135'],
    ['QZES82012345', 'QZES82012345'],
    // An Icelandic ISRC whose registrant code starts with RC, not an "ISRC" label.
    ['ISRCA2400001', 'ISRCA2400001'],
  ])('normalizes %j to %s', (input, expected) => {
    expect(normalizeIsrc(input)).toBe(expected)
    expect(normalizeIsrc(expected)).toBe(expected)
  })

  it.each([
    '',
    'ISRC:',
    'GBARL930013',
    'GBARL93001355',
    '1BARL9300135',
    'GBARL93A0135',
    'GB_ARL_93_00135',
    'GBARL9300135 (2009)',
    'not an isrc',
  ])('rejects %j', (input) => {
    expect(normalizeIsrc(input)).toBeNull()
  })

  it.each([null, undefined, 42, {}, ['GBARL9300135']])(
    'returns null for the non-string %j',
    (value) => {
      expect(normalizeIsrc(value)).toBeNull()
    },
  )
})
