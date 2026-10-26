import { formatId, type Track } from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import { fetchCover, largestArtwork, MAX_COVER_BYTES, sniffImage } from './cover'
import { exportFileName } from './naming'
import { createBrowserDeviceSaver } from './save'
import { tagsFromTrack } from './track-tags'

const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03,
  0x20, 0x03, 0x01, 0x22, 0x00,
])
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0,
  0, 0, 0, 0x80, 8, 2,
])
const WEBP = new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')

describe('sniffImage', () => {
  it('tells JPEG, PNG, WebP and GIF apart, with the size where cheap to read', () => {
    expect(sniffImage(JPEG)).toEqual({ mimeType: 'image/jpeg', width: 800, height: 600 })
    expect(sniffImage(PNG)).toEqual({ mimeType: 'image/png', width: 256, height: 128 })
    expect(sniffImage(WEBP)).toEqual({ mimeType: 'image/webp' })
    expect(sniffImage(new TextEncoder().encode('GIF89a......'))).toEqual({ mimeType: 'image/gif' })
    expect(sniffImage(new TextEncoder().encode('<html>'))).toBeUndefined()
  })
})

describe('fetchCover', () => {
  const art = [
    { url: 'https://i.ytimg.com/small.jpg', width: 120, height: 120 },
    { url: 'https://i.ytimg.com/large.jpg', width: 1200, height: 1200 },
    { url: 'https://i.ytimg.com/medium.jpg', width: 544, height: 544 },
  ]

  it('fetches the largest artwork without cookies', async () => {
    const fetch = vi.fn(async () => new Response(JPEG as BodyInit))
    expect(largestArtwork(art)?.url).toBe('https://i.ytimg.com/large.jpg')
    const cover = await fetchCover(art, { fetch })
    expect(cover).toEqual({ mimeType: 'image/jpeg', data: JPEG, width: 800, height: 600 })
    expect(fetch).toHaveBeenCalledWith('https://i.ytimg.com/large.jpg', { credentials: 'omit' })
  })

  it('converts WebP to JPEG when it can, and leaves it out when it can’t', async () => {
    const fetch = async () => new Response(WEBP as BodyInit)
    const toJpeg = vi.fn(async () => new Blob([JPEG as BlobPart], { type: 'image/jpeg' }))
    expect(await fetchCover(art, { fetch, toJpeg })).toMatchObject({ mimeType: 'image/jpeg' })
    expect(toJpeg).toHaveBeenCalledOnce()
    expect(await fetchCover(art, { fetch })).toBeUndefined()
  })

  it('leaves the cover out when anything goes wrong', async () => {
    expect(await fetchCover([], { fetch: vi.fn() })).toBeUndefined()
    expect(
      await fetchCover([{ url: 'http://insecure.test/a.jpg' }], { fetch: vi.fn() }),
    ).toBeUndefined()
    expect(
      await fetchCover(art, { fetch: async () => new Response('', { status: 404 }) }),
    ).toBeUndefined()
    expect(
      await fetchCover(art, {
        fetch: async () =>
          new Response('x', { headers: { 'content-length': String(MAX_COVER_BYTES + 1) } }),
      }),
    ).toBeUndefined()
    expect(
      await fetchCover(art, {
        fetch: async () => {
          throw new TypeError('Failed to fetch')
        },
      }),
    ).toBeUndefined()
    expect(await fetchCover(art, { fetch: async () => new Response('<html>') })).toBeUndefined()
  })

  it('passes a cancellation on', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      fetchCover(art, {
        signal: controller.signal,
        fetch: async () => {
          throw new DOMException('aborted', 'AbortError')
        },
      }),
    ).rejects.toThrow('aborted')
  })
})

describe('exportFileName', () => {
  it('names a file "Artists - Title.ext", safe on every file system', () => {
    expect(exportFileName({ title: 'Blitzkrieg Bop', artists: ['Ramones'] }, 'm4a')).toBe(
      'Ramones - Blitzkrieg Bop.m4a',
    )
    expect(
      exportFileName({ title: 'AC/DC: Live? <1991> "Remaster"', artists: ['A', 'B'] }, 'flac'),
    ).toBe('A, B - AC DC Live 1991 Remaster.flac')
    expect(exportFileName({ title: '..hidden..', artists: [] }, 'mp3')).toBe('hidden.mp3')
    expect(exportFileName({ title: '', artists: [] }, 'opus')).toBe('FXM download.opus')
    expect(exportFileName({ title: 'con', artists: [] }, 'wav')).toBe('con (track).wav')
    expect(exportFileName({ title: 'x'.repeat(300), artists: [] }, 'mp3')).toHaveLength(154)
    expect(exportFileName({ title: 'Tab\tand\nnewline', artists: [] }, '.m4a')).toBe(
      'Tab and newline.m4a',
    )
  })
})

describe('tagsFromTrack', () => {
  const track: Track = {
    id: formatId('ytm', 'track', 'abc'),
    source: 'ytm',
    title: 'Song',
    artists: [{ name: 'A' }, { name: 'B' }],
    album: { name: 'Album' },
    artwork: [],
    kind: 'song',
    isrc: 'GBARL9300135',
    trackNumber: 4,
    releaseDate: '2010-05',
  }

  it('takes the metadata, and the lyrics as plain and synced text', () => {
    expect(
      tagsFromTrack(track, {
        lyrics: {
          synced: true,
          source: 'lrclib',
          lines: [
            { timeMs: 500, text: 'One' },
            { timeMs: 900, text: '' },
            { timeMs: 1500, text: 'Two' },
          ],
        },
      }),
    ).toEqual({
      title: 'Song',
      artists: ['A', 'B'],
      album: 'Album',
      trackNumber: 4,
      releaseDate: '2010-05',
      isrc: 'GBARL9300135',
      lyrics: 'One\nTwo',
      syncedLyrics: [
        { timeMs: 500, text: 'One' },
        { timeMs: 1500, text: 'Two' },
      ],
    })
  })

  it('leaves out what is missing', () => {
    const plain: Track = {
      id: formatId('archive', 'track', 'x/y.mp3'),
      source: 'archive',
      title: 'T',
      artists: [],
      artwork: [],
      kind: 'song',
    }
    expect(tagsFromTrack(plain, { lyrics: null })).toEqual({ title: 'T', artists: [] })
    expect(
      tagsFromTrack(plain, {
        lyrics: { synced: false, source: 'lrclib', lines: [{ text: 'Plain' }] },
      }),
    ).toEqual({ title: 'T', artists: [], lyrics: 'Plain' })
  })
})

describe('createBrowserDeviceSaver', () => {
  it('asks where to save with the browser’s picker, then writes there', async () => {
    const written: Blob[] = []
    const showSaveFilePicker = vi.fn(async () => ({
      name: 'Renamed.flac',
      createWritable: async () => ({
        write: async (blob: Blob) => {
          written.push(blob)
        },
        close: async () => {},
      }),
    }))
    const saver = createBrowserDeviceSaver({ window: { showSaveFilePicker } })
    const target = await saver.choose({
      fileName: 'A - B.flac',
      mimeType: 'audio/flac',
      description: 'FLAC audio',
    })
    expect(showSaveFilePicker).toHaveBeenCalledWith({
      suggestedName: 'A - B.flac',
      types: [{ description: 'FLAC audio', accept: { 'audio/flac': ['.flac'] } }],
    })
    expect(target?.fileName).toBe('Renamed.flac')
    const blob = new Blob(['x'])
    await target?.write(blob)
    expect(written).toEqual([blob])
  })

  it('reports a cancelled picker as no target', async () => {
    const saver = createBrowserDeviceSaver({
      window: {
        showSaveFilePicker: async () => {
          throw new DOMException('The user aborted a request.', 'AbortError')
        },
      },
    })
    expect(await saver.choose({ fileName: 'a.mp3', mimeType: 'audio/mpeg' })).toBeUndefined()
  })

  it('downloads through a link where there is no picker, or the picker refuses', async () => {
    const clicks: { href: string; download: string }[] = []
    const document = {
      body: { append: () => {} },
      createElement: () => {
        const link = {
          href: '',
          download: '',
          rel: '',
          click: () => clicks.push({ href: link.href, download: link.download }),
          remove: () => {},
        }
        return link
      },
    } as unknown as Pick<Document, 'createElement' | 'body'>
    vi.useFakeTimers()
    try {
      const revoked: string[] = []
      const environment = {
        document,
        createObjectURL: () => 'blob:fxm/1',
        revokeObjectURL: (url: string) => revoked.push(url),
      }
      const plain = createBrowserDeviceSaver({ ...environment, window: {} })
      const target = await plain.choose({ fileName: 'a.mp3', mimeType: 'audio/mpeg' })
      await target?.write(new Blob(['x']))
      expect(clicks).toEqual([{ href: 'blob:fxm/1', download: 'a.mp3' }])
      vi.advanceTimersByTime(60_000)
      expect(revoked).toEqual(['blob:fxm/1'])

      const refusing = createBrowserDeviceSaver({
        ...environment,
        window: {
          showSaveFilePicker: async () => {
            throw new DOMException('Must be handling a user gesture', 'SecurityError')
          },
        },
      })
      const fallback = await refusing.choose({ fileName: 'b.flac', mimeType: 'audio/flac' })
      await fallback?.write(new Blob(['y']))
      expect(clicks.at(-1)?.download).toBe('b.flac')
    } finally {
      vi.useRealTimers()
    }
  })
})
