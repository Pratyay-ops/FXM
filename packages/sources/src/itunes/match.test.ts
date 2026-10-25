import { describe, expect, it } from 'vitest'
import { type ItunesSong, parseItunesAlbums, parseItunesSongs } from './api'
import ramAlbums from './fixtures/search-album-daft-punk-ram.json'
import pabloHoneyAlbums from './fixtures/search-album-radiohead-pablo-honey.json'
import getLucky from './fixtures/search-song-daft-punk-get-lucky.json'
import creep from './fixtures/search-song-radiohead-creep.json'
import { bestItunesAlbum, bestItunesSong } from './match'

/** A song result. */
function song(title: string, artist: string, extra: Partial<ItunesSong> = {}): ItunesSong {
  return {
    trackId: 1,
    title,
    artist,
    artworkUrl: 'https://is1-ssl.mzstatic.com/a/100x100bb.jpg',
    ...extra,
  }
}

describe('bestItunesSong', () => {
  it('finds the original among remixes, editions and covers', () => {
    const found = bestItunesSong(parseItunesSongs(getLucky), {
      title: 'Get Lucky',
      artists: ['Daft Punk', 'Pharrell Williams'],
      durationMs: 369_000,
    })
    expect(found).toMatchObject({ title: 'Get Lucky', album: 'Random Access Memories' })
  })

  it('prefers the track’s own album among equal titles', () => {
    const found = bestItunesSong(parseItunesSongs(getLucky), {
      title: 'Get Lucky',
      artists: ['Daft Punk'],
      album: 'Random Access Memories (10th Anniversary Edition)',
    })
    expect(found?.album).toBe('Random Access Memories (10th Anniversary Edition)')
  })

  it('finds nothing rather than a cover, another artist or another version', () => {
    // The US store's results for "Radiohead Creep" on 2026-10-26: no original among them.
    expect(
      bestItunesSong(parseItunesSongs(creep), { title: 'Creep', artists: ['Radiohead'] }),
    ).toBeNull()
  })

  it('takes the version into account, and the duration when both are known', () => {
    const acoustic = song('Creep (Acoustic)', 'Radiohead')
    expect(bestItunesSong([acoustic], { title: 'Creep', artists: ['Radiohead'] })).toBeNull()
    expect(bestItunesSong([acoustic], { title: 'Creep - Acoustic', artists: ['Radiohead'] })).toBe(
      acoustic,
    )
    const long = song('Creep', 'Radiohead', { durationMs: 300_000 })
    expect(
      bestItunesSong([long], { title: 'Creep', artists: ['Radiohead'], durationMs: 239_000 }),
    ).toBeNull()
    expect(
      bestItunesSong([long], { title: 'Creep', artists: ['Radiohead'], durationMs: 290_000 }),
    ).toBe(long)
    expect(bestItunesSong([long], { title: 'Creep', artists: ['Radiohead'] })).toBe(long)
  })

  it('finds nothing by tribute, karaoke or cover acts named after the artist', () => {
    const query = { title: 'Creep', artists: ['Radiohead'] }
    for (const artist of [
      'Radiohead Tribute',
      'Radiohead Karaoke',
      'Tribute to Radiohead',
      'Radiohead Experience',
    ]) {
      expect(bestItunesSong([song('Creep', artist)], query)).toBeNull()
    }
    const uprising = { title: 'Uprising', artists: ['Muse'] }
    for (const artist of ['Amuse', 'Musey', 'The Muses']) {
      expect(bestItunesSong([song('Uprising', artist)], uprising)).toBeNull()
    }
    const muse = song('Uprising', 'Muse')
    expect(bestItunesSong([song('Uprising', 'Amuse'), muse], uprising)).toBe(muse)
    expect(
      bestItunesAlbum([{ collectionId: 1, name: 'Pablo Honey', artist: 'Radiohead Tribute' }], {
        ...query,
        album: 'Pablo Honey',
      }),
    ).toBeNull()
  })

  it('prefers the exact title to a title with extras', () => {
    const featured = song('Get Lucky (feat. Pharrell Williams)', 'Daft Punk')
    const plain = song('Get Lucky', 'Daft Punk', { trackId: 2 })
    expect(bestItunesSong([featured, plain], { title: 'Get Lucky', artists: ['Daft Punk'] })).toBe(
      plain,
    )
    expect(bestItunesSong([featured], { title: 'Get Lucky', artists: ['Daft Punk'] })).toBe(
      featured,
    )
  })
})

describe('bestItunesAlbum', () => {
  it('finds the album, preferring its exact name to an edition', () => {
    const found = bestItunesAlbum(parseItunesAlbums(ramAlbums), {
      title: 'Get Lucky',
      artists: ['Daft Punk'],
      album: 'Random Access Memories',
    })
    expect(found?.name).toBe('Random Access Memories')
  })

  it('reads singles and EPs without Apple’s suffix', () => {
    const single = {
      collectionId: 1,
      name: 'Creep (Very 2021 Rmx) [feat. Radiohead] - Single',
      artist: 'Thom Yorke',
    }
    const ep = { collectionId: 2, name: 'Creep - EP', artist: 'Radiohead' }
    expect(
      bestItunesAlbum([single, ep], { title: 'Creep', artists: ['Radiohead'], album: 'Creep' }),
    ).toBe(ep)
  })

  it('finds nothing for another artist’s album of the same name, or without an album', () => {
    const albums = parseItunesAlbums(pabloHoneyAlbums)
    expect(albums[0]?.name).toBe('Pablo Honey')
    expect(
      bestItunesAlbum(albums, { title: 'Creep', artists: ['Radiohead'], album: 'Pablo Honey' }),
    ).toBeNull()
    expect(
      bestItunesAlbum(parseItunesAlbums(ramAlbums), { title: 'Get Lucky', artists: ['Daft Punk'] }),
    ).toBeNull()
  })
})
