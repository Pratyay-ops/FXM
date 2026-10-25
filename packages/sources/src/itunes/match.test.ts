import { describe, expect, it } from 'vitest'
import { type ItunesSong, parseAlbums, parseSongs } from './api'
import ramAlbums from './fixtures/search-album-daft-punk-ram.json'
import pabloHoneyAlbums from './fixtures/search-album-radiohead-pablo-honey.json'
import getLucky from './fixtures/search-song-daft-punk-get-lucky.json'
import creep from './fixtures/search-song-radiohead-creep.json'
import { bestAlbum, bestSong } from './match'

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

describe('bestSong', () => {
  it('finds the original among remixes, editions and covers', () => {
    const found = bestSong(parseSongs(getLucky), {
      title: 'Get Lucky',
      artists: ['Daft Punk', 'Pharrell Williams'],
      durationMs: 369_000,
    })
    expect(found).toMatchObject({ title: 'Get Lucky', album: 'Random Access Memories' })
  })

  it('prefers the track’s own album among equal titles', () => {
    const found = bestSong(parseSongs(getLucky), {
      title: 'Get Lucky',
      artists: ['Daft Punk'],
      album: 'Random Access Memories (10th Anniversary Edition)',
    })
    expect(found?.album).toBe('Random Access Memories (10th Anniversary Edition)')
  })

  it('finds nothing rather than a cover, another artist or another version', () => {
    // The US store's results for "Radiohead Creep" on 2026-10-26: no original among them.
    expect(bestSong(parseSongs(creep), { title: 'Creep', artists: ['Radiohead'] })).toBeNull()
  })

  it('takes the version into account, and the duration when both are known', () => {
    const acoustic = song('Creep (Acoustic)', 'Radiohead')
    expect(bestSong([acoustic], { title: 'Creep', artists: ['Radiohead'] })).toBeNull()
    expect(bestSong([acoustic], { title: 'Creep - Acoustic', artists: ['Radiohead'] })).toBe(
      acoustic,
    )
    const long = song('Creep', 'Radiohead', { durationMs: 300_000 })
    expect(
      bestSong([long], { title: 'Creep', artists: ['Radiohead'], durationMs: 239_000 }),
    ).toBeNull()
    expect(bestSong([long], { title: 'Creep', artists: ['Radiohead'], durationMs: 290_000 })).toBe(
      long,
    )
    expect(bestSong([long], { title: 'Creep', artists: ['Radiohead'] })).toBe(long)
  })

  it('prefers the exact title to a title with extras', () => {
    const featured = song('Get Lucky (feat. Pharrell Williams)', 'Daft Punk')
    const plain = song('Get Lucky', 'Daft Punk', { trackId: 2 })
    expect(bestSong([featured, plain], { title: 'Get Lucky', artists: ['Daft Punk'] })).toBe(plain)
    expect(bestSong([featured], { title: 'Get Lucky', artists: ['Daft Punk'] })).toBe(featured)
  })
})

describe('bestAlbum', () => {
  it('finds the album, preferring its exact name to an edition', () => {
    const found = bestAlbum(parseAlbums(ramAlbums), {
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
      bestAlbum([single, ep], { title: 'Creep', artists: ['Radiohead'], album: 'Creep' }),
    ).toBe(ep)
  })

  it('finds nothing for another artist’s album of the same name, or without an album', () => {
    const albums = parseAlbums(pabloHoneyAlbums)
    expect(albums[0]?.name).toBe('Pablo Honey')
    expect(
      bestAlbum(albums, { title: 'Creep', artists: ['Radiohead'], album: 'Pablo Honey' }),
    ).toBeNull()
    expect(
      bestAlbum(parseAlbums(ramAlbums), { title: 'Get Lucky', artists: ['Daft Punk'] }),
    ).toBeNull()
  })
})
