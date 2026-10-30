import { formatId, type Track } from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import { fetchCover, largestArtwork, MAX_COVER_BYTES, sniffImage } from './cover'
import { exportFileName, MAX_NAME_BYTES } from './naming'
import { createBrowserDeviceSaver, numberedFileName } from './save'
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
    expect(exportFileName({ title: 'x'.repeat(300), artists: [] }, 'mp3')).toHaveLength(204)
    expect(exportFileName({ title: 'Tab\tand\nnewline', artists: [] }, '.m4a')).toBe(
      'Tab and newline.m4a',
    )
  })

  const utf8Bytes = (text: string) => new TextEncoder().encode(text).length

  it('keeps long names within the bytes file systems allow, in any script', () => {
    // 200 CJK characters are 600 bytes of UTF-8: after "歌手 - " (9 bytes) 63 of them fit.
    const cjk = exportFileName({ title: '春'.repeat(200), artists: ['歌手'] }, 'flac')
    expect(cjk).toBe(`歌手 - ${'春'.repeat(63)}.flac`)
    expect(utf8Bytes(cjk.slice(0, -'.flac'.length))).toBe(198)
    expect(utf8Bytes(cjk)).toBeLessThanOrEqual(MAX_NAME_BYTES + '.flac'.length)
  })

  it('never splits an emoji or an accented letter', () => {
    const emoji = exportFileName({ title: `${'a'.repeat(199)}🎵🎵`, artists: [] }, 'mp3')
    expect(emoji).toBe(`${'a'.repeat(199)}.mp3`)
    expect(emoji).not.toMatch(/[\uD800-\uDFFF]/)
    // A family emoji is one character of 25 bytes: it goes whole or not at all.
    const family = '👨‍👩‍👧‍👦'
    expect(exportFileName({ title: `${'b'.repeat(180)}${family}`, artists: [] }, 'mp3')).toBe(
      `${'b'.repeat(180)}.mp3`,
    )
    // "é" written as e + a combining accent becomes one letter; "q́", which has no single
    // letter, goes whole or not at all.
    expect(exportFileName({ title: `${'c'.repeat(198)}e\u0301x`, artists: [] }, 'mp3')).toBe(
      `${'c'.repeat(198)}\u00e9.mp3`,
    )
    expect(exportFileName({ title: `${'c'.repeat(198)}q\u0301`, artists: [] }, 'mp3')).toBe(
      `${'c'.repeat(198)}.mp3`,
    )
    // Half a surrogate pair in the metadata is dropped.
    expect(exportFileName({ title: 'Song \uD83D', artists: [] }, 'mp3')).toBe('Song.mp3')
  })

  it('names the file from what is text, whatever a stored track holds', () => {
    const tags = { title: 42, artists: ['Artist', null, 7, ' '] } as unknown as {
      title: string
      artists: string[]
    }
    expect(exportFileName(tags, 'mp3')).toBe('Artist.mp3')
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

  /** A picked file as Chromium hands it over: created, empty, when the picker closed. */
  function pickedFile(options: { size?: number; failWrite?: boolean } = {}) {
    const events: string[] = []
    let size = options.size ?? 0
    const handle = {
      name: 'A - B.flac',
      getFile: async () => ({ size }),
      remove: async () => {
        events.push('remove')
      },
      createWritable: async () => ({
        write: async (blob: Blob) => {
          if (options.failWrite) throw new DOMException('No space left', 'QuotaExceededError')
          events.push('write')
          size = blob.size
        },
        close: async () => {
          events.push('close')
        },
        abort: async () => {
          events.push('abort')
        },
      }),
    }
    const saver = createBrowserDeviceSaver({ window: { showSaveFilePicker: async () => handle } })
    return { events, saver }
  }

  it('removes the empty file the picker created when the save is given up', async () => {
    const { events, saver } = pickedFile()
    const target = await saver.choose({ fileName: 'A - B.flac', mimeType: 'audio/flac' })
    await target?.discard()
    expect(events).toEqual(['remove'])
  })

  it('never removes a file with content in it', async () => {
    const { events, saver } = pickedFile({ size: 1234 })
    const target = await saver.choose({ fileName: 'A - B.flac', mimeType: 'audio/flac' })
    await target?.discard()
    expect(events).toEqual([])
  })

  it('drops a half-written file when writing fails, and still removes the empty file', async () => {
    const { events, saver } = pickedFile({ failWrite: true })
    const target = await saver.choose({ fileName: 'A - B.flac', mimeType: 'audio/flac' })
    await expect(target?.write(new Blob(['x']))).rejects.toThrow('No space left')
    expect(events).toEqual(['abort'])
    await target?.discard()
    expect(events).toEqual(['abort', 'remove'])
  })

  it('gives a file up quietly where the browser can’t remove it', async () => {
    const saver = createBrowserDeviceSaver({
      window: {
        showSaveFilePicker: async () => ({
          name: 'x.mp3',
          createWritable: async () => ({ write: async () => {}, close: async () => {} }),
          getFile: async () => {
            throw new DOMException('gone', 'NotFoundError')
          },
          remove: async () => {},
        }),
      },
    })
    const target = await saver.choose({ fileName: 'x.mp3', mimeType: 'audio/mpeg' })
    await expect(target?.discard()).resolves.toBeUndefined()
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

  it('says whether choosing shows a picker that needs the click', () => {
    expect(createBrowserDeviceSaver({ window: {} }).asksWhere?.()).toBe(false)
    const picker = createBrowserDeviceSaver({
      window: { showSaveFilePicker: async () => Promise.reject(new Error('unused')) },
    })
    expect(picker.asksWhere?.()).toBe(true)
  })
})

/** A picked folder in memory: its files by name, what was asked of it, and what failed. */
function fakeFolder(options: { existing?: string[]; failWrite?: boolean } = {}) {
  const files = new Map<string, Blob>(
    (options.existing ?? []).map((name) => [name, new Blob(['old'])]),
  )
  const events: string[] = []
  const handle = (name: string) => ({
    name,
    getFile: async () => ({ size: files.get(name)?.size ?? 0 }),
    createWritable: async () => ({
      write: async (blob: Blob) => {
        if (options.failWrite) throw new DOMException('No space left', 'QuotaExceededError')
        files.set(name, blob)
        events.push(`write ${name}`)
      },
      close: async () => {},
      abort: async () => {
        events.push(`abort ${name}`)
      },
    }),
  })
  const folder = {
    name: 'Music',
    getFileHandle: async (name: string, options: { create?: boolean } = {}) => {
      if (!files.has(name)) {
        if (!options.create) throw new DOMException('Not found', 'NotFoundError')
        files.set(name, new Blob([]))
        events.push(`create ${name}`)
      }
      return handle(name)
    },
    removeEntry: async (name: string) => {
      files.delete(name)
      events.push(`remove ${name}`)
    },
  }
  return { files, events, folder }
}

describe('saving several files into a folder', () => {
  it('asks for a folder once, with write access, starting in Music', async () => {
    const { folder } = fakeFolder()
    const showDirectoryPicker = vi.fn(async () => folder)
    const saver = createBrowserDeviceSaver({ window: { showDirectoryPicker } })
    const picked = await saver.chooseFolder?.({ id: 'fxm-downloads' })
    expect(showDirectoryPicker).toHaveBeenCalledWith({
      id: 'fxm-downloads',
      mode: 'readwrite',
      startIn: 'music',
    })
    expect(picked?.name).toBe('Music')
  })

  it('writes each file under its name, never replacing one that is there', async () => {
    const { files, events, folder } = fakeFolder({ existing: ['A - B.flac', 'A - B (2).flac'] })
    const saver = createBrowserDeviceSaver({ window: { showDirectoryPicker: async () => folder } })
    const picked = await saver.chooseFolder?.()
    const first = picked?.target({ fileName: 'A - B.flac', mimeType: 'audio/flac' })
    const second = picked?.target({ fileName: 'C - D.mp3', mimeType: 'audio/mpeg' })
    // Nothing is created before it is written.
    expect(events).toEqual([])
    await first?.write(new Blob(['new']))
    await second?.write(new Blob(['mp3']))
    expect(first?.fileName).toBe('A - B (3).flac')
    expect(second?.fileName).toBe('C - D.mp3')
    expect(await files.get('A - B.flac')?.text()).toBe('old')
    expect(await files.get('A - B (3).flac')?.text()).toBe('new')
    // A target given up after writing keeps its file.
    await first?.discard()
    expect(files.has('A - B (3).flac')).toBe(true)
  })

  it('removes the empty file a failed write created', async () => {
    const { files, events, folder } = fakeFolder({ failWrite: true })
    const saver = createBrowserDeviceSaver({ window: { showDirectoryPicker: async () => folder } })
    const target = (await saver.chooseFolder?.())?.target({
      fileName: 'A - B.flac',
      mimeType: 'audio/flac',
    })
    await expect(target?.write(new Blob(['x']))).rejects.toThrow('No space left')
    expect(events).toEqual(['create A - B.flac', 'abort A - B.flac', 'remove A - B.flac'])
    expect(files.size).toBe(0)
  })

  it('reports a cancelled folder picker as no folder, and no folder picker as null', async () => {
    const cancelled = createBrowserDeviceSaver({
      window: {
        showDirectoryPicker: async () => {
          throw new DOMException('The user aborted a request.', 'AbortError')
        },
      },
    })
    expect(await cancelled.chooseFolder?.()).toBeUndefined()
    expect(await createBrowserDeviceSaver({ window: {} }).chooseFolder?.()).toBeNull()
    const refusing = createBrowserDeviceSaver({
      window: {
        showDirectoryPicker: async () => {
          throw new DOMException('Must be handling a user gesture', 'SecurityError')
        },
      },
    })
    expect(await refusing.chooseFolder?.()).toBeNull()
  })

  it('numbers a second file of the same name before its extension', () => {
    expect(numberedFileName('A - B.flac', 1)).toBe('A - B.flac')
    expect(numberedFileName('A - B.flac', 2)).toBe('A - B (2).flac')
    expect(numberedFileName('A. B - C.m4a', 3)).toBe('A. B - C (3).m4a')
    expect(numberedFileName('README', 2)).toBe('README (2)')
  })
})
