import { FxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { createProviderCatalog } from './catalog'
import { CAPABILITIES, createFakePlatform } from './testing/fake-platform'
import { FakeMetadataProvider } from './testing/fake-provider'
import {
  ALBUM,
  ARCHIVE_ATTRIBUTION,
  ARCHIVE_TRACK,
  PLAYLIST,
  SONG_A,
  targetOf,
  UPLOAD,
  VIDEO,
} from './testing/harness'

const ctx = createFakePlatform(CAPABILITIES.lite).context({ mode: 'music' })

describe('createProviderCatalog', () => {
  const youtube = new FakeMetadataProvider('ytm', {
    tracks: [SONG_A],
    albums: [ALBUM],
    playlists: [PLAYLIST],
  })
  const archive = new FakeMetadataProvider('archive', { tracks: [ARCHIVE_TRACK] })
  const catalog = createProviderCatalog([youtube, archive], {
    attribution: (track) => (track.source === 'archive' ? ARCHIVE_ATTRIBUTION : undefined),
  })

  it('loads a track as a list of one', async () => {
    expect(await catalog.load(targetOf(SONG_A), ctx)).toEqual({
      target: targetOf(SONG_A),
      title: SONG_A.title,
      artists: SONG_A.artists,
      artwork: [],
      tracks: [SONG_A],
      trackCount: 1,
    })
  })

  it('loads an album with its type and tracks', async () => {
    expect(await catalog.load(targetOf(ALBUM), ctx)).toEqual({
      target: targetOf(ALBUM),
      title: ALBUM.name,
      artists: ALBUM.artists,
      artwork: ALBUM.artwork,
      tracks: ALBUM.tracks,
      trackCount: 3,
    })
  })

  it("loads a playlist's first page, its owner and how many tracks it has in all", async () => {
    expect(await catalog.load(targetOf(PLAYLIST), ctx)).toEqual({
      target: targetOf(PLAYLIST),
      title: PLAYLIST.name,
      artists: [],
      owner: 'A Listener',
      artwork: [],
      tracks: [SONG_A, UPLOAD, VIDEO],
      trackCount: 40,
    })
  })

  it('counts what it has when the source gives no count', async () => {
    const { trackCount: _albumCount, tracks: _albumTracks, ...album } = ALBUM
    const { trackCount: _playlistCount, ...playlist } = PLAYLIST
    const bare = new FakeMetadataProvider('ytm', {
      albums: [album],
      playlists: [{ ...playlist, tracks: { items: [SONG_A] } }],
    })
    const counts = createProviderCatalog([bare])
    expect((await counts.load(targetOf(ALBUM), ctx)).trackCount).toBe(0)
    expect((await counts.load(targetOf(PLAYLIST), ctx)).trackCount).toBe(1)
  })

  it('hands on the credits of free-source tracks', () => {
    expect(catalog.attribution?.(ARCHIVE_TRACK)).toEqual(ARCHIVE_ATTRIBUTION)
    expect(catalog.attribution?.(SONG_A)).toBeUndefined()
    expect(createProviderCatalog([]).attribution).toBeUndefined()
  })

  it("passes the provider's errors on", async () => {
    youtube.errors.set(SONG_A.id, new FxmError('RateLimited', 'Slow down'))
    await expect(catalog.load(targetOf(SONG_A), ctx)).rejects.toMatchObject({ code: 'RateLimited' })
    youtube.errors.clear()
  })

  it('says which sources it has providers for', () => {
    expect(catalog.supports('ytm')).toBe(true)
    expect(catalog.supports('archive')).toBe(true)
    expect(catalog.supports('jamendo')).toBe(false)
    expect(createProviderCatalog([]).supports('ytm')).toBe(false)
  })

  it('refuses a source it has no provider for', async () => {
    await expect(
      createProviderCatalog([archive]).load(targetOf(SONG_A), ctx),
    ).rejects.toMatchObject({ code: 'Unsupported' })
  })

  it('keeps the first provider of a source', async () => {
    const other = new FakeMetadataProvider('ytm', { tracks: [] })
    const first = createProviderCatalog([youtube, other])
    expect((await first.load(targetOf(SONG_A), ctx)).title).toBe(SONG_A.title)
  })
})
