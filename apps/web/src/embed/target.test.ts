import { type EntityId, formatId } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import {
  appUrlFor,
  DEFAULT_EMBED_OPTIONS,
  EMBED_HEIGHTS,
  type EmbedTarget,
  embedPath,
  embedTargetOf,
  embedUrl,
  FXM_PUBLIC_ORIGIN,
  installUrlFor,
  isEmbeddable,
  isSerializedOrigin,
  parseEmbedAddress,
} from './target'

const SONG: EmbedTarget = { kind: 'track', id: formatId('ytm', 'track', 'dQw4w9WgXcQ') }
const ARCHIVE: EmbedTarget = { kind: 'track', id: formatId('archive', 'track', 'item/a b.flac') }
const ALBUM: EmbedTarget = { kind: 'album', id: formatId('ytm', 'album', 'MPREb_abc') }

describe('embed addresses', () => {
  it('spell the entity as the app pages do, with the native ID encoded', () => {
    expect(embedPath(SONG)).toBe('/embed/track/ytm:dQw4w9WgXcQ')
    expect(embedPath(ARCHIVE)).toBe('/embed/track/archive:item%2Fa%20b.flac')
    expect(embedPath({ kind: 'playlist', id: formatId('yt', 'playlist', 'PL1') })).toBe(
      '/embed/playlist/yt:PL1',
    )
  })

  it('keep only the options that differ from the defaults', () => {
    expect(embedUrl(FXM_PUBLIC_ORIGIN, SONG)).toBe(
      'https://fxmusic.pages.dev/embed/track/ytm:dQw4w9WgXcQ',
    )
    expect(embedUrl(FXM_PUBLIC_ORIGIN, ALBUM, DEFAULT_EMBED_OPTIONS)).toBe(
      'https://fxmusic.pages.dev/embed/album/ytm:MPREb_abc',
    )
    expect(
      embedUrl(FXM_PUBLIC_ORIGIN, ALBUM, { layout: 'compact', theme: 'light', mode: 'all' }),
    ).toBe(
      'https://fxmusic.pages.dev/embed/album/ytm:MPREb_abc?layout=compact&theme=light&mode=all',
    )
  })

  it('read back what they write', () => {
    for (const target of [SONG, ARCHIVE, ALBUM]) {
      const url = new URL(embedUrl(FXM_PUBLIC_ORIGIN, target, { layout: 'compact', mode: 'all' }))
      expect(parseEmbedAddress(url.pathname, url.search)).toEqual({
        ok: true,
        target,
        options: { layout: 'compact', theme: 'auto', mode: 'all' },
      })
    }
  })

  it('read native IDs with colons, a trailing slash and the controller origin', () => {
    expect(
      parseEmbedAddress('/embed/track/jamendo:123:4/', '?origin=https%3A%2F%2Fblog.example'),
    ).toEqual({
      ok: true,
      target: { kind: 'track', id: 'jamendo:track:123:4' },
      options: DEFAULT_EMBED_OPTIONS,
      controller: 'https://blog.example',
    })
  })

  it('fall back to the defaults for options they do not know', () => {
    const address = parseEmbedAddress(
      '/embed/album/ytm:MPREb_abc',
      '?layout=huge&theme=toString&mode=video&origin=https%3A%2F%2Fblog.example%2Fpath',
    )
    expect(address).toEqual({ ok: true, target: ALBUM, options: DEFAULT_EMBED_OPTIONS })
  })

  it.each([
    ['another path', '/app/album/ytm:x', 'not-an-embed'],
    ['no ID', '/embed/track', 'not-an-embed'],
    ['too many segments', '/embed/track/ytm:a/b', 'not-an-embed'],
    ['an artist', '/embed/artist/ytm:UC1', 'unknown-kind'],
    ['an inherited name', '/embed/constructor/ytm:x', 'unknown-kind'],
    ['a Spotify track', '/embed/track/spotify:4uLU6hMCjMI75M1A2tKUQC', 'unsupported-source'],
    ['a local file', '/embed/track/local:abc', 'unsupported-source'],
    ['a plugin source', '/embed/track/plugin.radio:abc', 'unsupported-source'],
    ['an unknown source', '/embed/track/myspace:abc', 'unsupported-source'],
    ['no source', '/embed/track/dQw4w9WgXcQ', 'bad-id'],
    ['an empty native ID', '/embed/track/ytm:', 'bad-id'],
    ['an empty source', '/embed/track/:abc', 'bad-id'],
    ['broken percent-encoding', '/embed/track/ytm:%E0%A4%A', 'bad-id'],
    ['a control character', '/embed/track/ytm:a%0Ab', 'bad-id'],
    ['an overlong ID', `/embed/track/ytm:${'x'.repeat(513)}`, 'bad-id'],
  ])('refuse %s', (_name, path, error) => {
    expect(parseEmbedAddress(path, '')).toEqual({ ok: false, error })
  })
})

describe('embed targets', () => {
  it('exist for tracks, albums and playlists from the embed sources only', () => {
    expect(embedTargetOf(SONG.id)).toEqual(SONG)
    expect(embedTargetOf(ALBUM.id)).toEqual(ALBUM)
    expect(isEmbeddable(formatId('jamendo', 'playlist', '42'))).toBe(true)
    expect(isEmbeddable(formatId('ytm', 'artist', 'UC1'))).toBe(false)
    expect(isEmbeddable(formatId('spotify', 'track', 'abc'))).toBe(false)
    expect(isEmbeddable(formatId('local', 'track', 'abc'))).toBe(false)
    expect(isEmbeddable('plugin.radio:track:abc' as EntityId)).toBe(false)
  })

  it('lead to the app and to the install guide on the same origin', () => {
    expect(appUrlFor(FXM_PUBLIC_ORIGIN, ALBUM)).toBe(
      'https://fxmusic.pages.dev/app/album/ytm:MPREb_abc',
    )
    expect(appUrlFor('http://localhost:6330', ARCHIVE)).toBe('http://localhost:6330/app/')
    expect(
      appUrlFor(FXM_PUBLIC_ORIGIN, {
        kind: 'playlist',
        id: formatId('archive', 'playlist', 'a/b'),
      }),
    ).toBe('https://fxmusic.pages.dev/app/playlist/archive:a%2Fb')
    expect(installUrlFor(FXM_PUBLIC_ORIGIN)).toBe('https://fxmusic.pages.dev/#get')
  })

  it("send a track to the app's search for its title and artist, once known", () => {
    expect(appUrlFor(FXM_PUBLIC_ORIGIN, ARCHIVE, { title: 'Side A', artist: 'A & B' })).toBe(
      'https://fxmusic.pages.dev/app/search?q=Side+A+A+%26+B',
    )
    expect(appUrlFor(FXM_PUBLIC_ORIGIN, ARCHIVE, { title: 'Side A' })).toBe(
      'https://fxmusic.pages.dev/app/search?q=Side+A',
    )
    expect(appUrlFor(FXM_PUBLIC_ORIGIN, ARCHIVE, { title: '  ', artist: 'Band' })).toBe(
      'https://fxmusic.pages.dev/app/',
    )
    const long = appUrlFor(FXM_PUBLIC_ORIGIN, ARCHIVE, { title: 'x'.repeat(500) })
    expect(new URL(long).searchParams.get('q')).toHaveLength(200)
    // Albums and playlists have pages of their own.
    expect(appUrlFor(FXM_PUBLIC_ORIGIN, ALBUM, { title: 'Pablo Honey' })).toBe(
      'https://fxmusic.pages.dev/app/album/ytm:MPREb_abc',
    )
  })

  it('have a height for every layout and kind', () => {
    for (const layout of ['compact', 'card'] as const) {
      for (const kind of ['track', 'album', 'playlist'] as const) {
        expect(EMBED_HEIGHTS[layout][kind]).toBeGreaterThanOrEqual(80)
      }
    }
  })
})

describe('isSerializedOrigin', () => {
  it.each([
    ['https://blog.example', true],
    ['http://localhost:8080', true],
    ['https://blog.example/', false],
    ['https://blog.example/path', false],
    ['https://user@blog.example', false],
    ['HTTPS://BLOG.EXAMPLE', false],
    ['null', false],
    ['javascript:alert(1)', false],
    ['file:///etc/passwd', false],
    ['', false],
    [42, false],
  ])('%s → %s', (value, expected) => {
    expect(isSerializedOrigin(value)).toBe(expected)
  })
})
