import { describe, expect, it } from 'vitest'
import { isImportInputError } from './errors'
import { parseExportFiles } from './files'
import { isZip, readZip } from './zip'

/** Raw deflate, as a ZIP entry stores it. */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

interface Entry {
  name: string
  data: Uint8Array
  method?: 0 | 8
  /** Overrides the uncompressed size the headers claim. */
  claimedSize?: number
  flags?: number
}

/** A minimal ZIP writer for tests: local headers, data, central directory, end record. */
async function zip(entries: readonly Entry[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const method = entry.method ?? 8
    const stored = method === 8 ? await deflate(entry.data) : entry.data
    const name = new TextEncoder().encode(entry.name)
    const size = entry.claimedSize ?? entry.data.length
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, entry.flags ?? 0, true)
    lv.setUint16(8, method, true)
    lv.setUint32(18, stored.length, true)
    lv.setUint32(22, size, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    const header = new Uint8Array(46 + name.length)
    const cv = new DataView(header.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, entry.flags ?? 0, true)
    cv.setUint16(10, method, true)
    cv.setUint32(20, stored.length, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    header.set(name, 46)
    parts.push(local, stored)
    central.push(header)
    offset += local.length + stored.length
  }
  const directorySize = central.reduce((sum, part) => sum + part.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, directorySize, true)
  ev.setUint32(16, offset, true)
  const all = [...parts, ...central, end]
  const result = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of all) {
    result.set(part, at)
    at += part.length
  }
  return result
}

const text = (value: string) => new TextEncoder().encode(value)

describe('readZip', () => {
  it('unpacks the wanted entries, deflated or stored, and skips the rest', async () => {
    const archive = await zip([
      { name: 'Spotify Account Data/', data: new Uint8Array(), method: 0 },
      { name: 'Spotify Account Data/Playlist1.json', data: text('{"playlists":[]}') },
      { name: 'Spotify Account Data/Userdata.json', data: text('{"username":"x"}') },
      { name: 'Spotify Account Data/YourLibrary.json', data: text('{"tracks":[]}'), method: 0 },
    ])
    expect(isZip(archive)).toBe(true)
    const files = await readZip(archive, { want: (name) => !name.includes('Userdata') })
    expect(files.map((file) => [file.name, new TextDecoder().decode(file.bytes)])).toEqual([
      ['Spotify Account Data/Playlist1.json', '{"playlists":[]}'],
      ['Spotify Account Data/YourLibrary.json', '{"tracks":[]}'],
    ])
  })

  it('refuses an entry that unpacks to more than it claims, and entries over the limits', async () => {
    const big = text('x'.repeat(10_000))
    const lying = await zip([{ name: 'a.json', data: big, claimedSize: 100 }])
    await expect(readZip(lying, { want: () => true })).rejects.toMatchObject({ code: 'bad-zip' })
    const honest = await zip([{ name: 'a.json', data: big }])
    await expect(readZip(honest, { want: () => true, maxEntryBytes: 1000 })).rejects.toMatchObject({
      code: 'too-large',
    })
    await expect(
      readZip(
        await zip([
          { name: 'a.json', data: big },
          { name: 'b.json', data: big },
        ]),
        {
          want: () => true,
          maxTotalBytes: 15_000,
        },
      ),
    ).rejects.toMatchObject({ code: 'too-large' })
  })

  it('refuses encrypted entries, damaged archives and other files', async () => {
    const encrypted = await zip([{ name: 'a.json', data: text('{}'), flags: 1 }])
    await expect(readZip(encrypted, { want: () => true })).rejects.toMatchObject({
      code: 'bad-zip',
    })
    const archive = await zip([{ name: 'a.json', data: text('{"a":1}') }])
    const cut = archive.slice(0, 20)
    await expect(readZip(cut, { want: () => true })).rejects.toMatchObject({ code: 'bad-zip' })
    const notZip = text('just some text that is long enough to scan for an end record')
    expect(isZip(notZip)).toBe(false)
    await expect(readZip(notZip, { want: () => true })).rejects.toSatisfy((error) =>
      isImportInputError(error, 'bad-zip'),
    )
    const damaged = archive.slice()
    damaged[damaged.length - 22 + 16] = 0xff
    await expect(readZip(damaged, { want: () => true })).rejects.toMatchObject({ code: 'bad-zip' })
  })
})

describe('parseExportFiles', () => {
  it('reads a data export from its ZIP archive and from loose JSON files', async () => {
    const playlists = {
      playlists: [
        {
          name: 'Mix',
          items: [
            {
              track: {
                trackName: 'Angel',
                artistName: 'Massive Attack',
                albumName: 'Mezzanine',
                trackUri: 'spotify:track:0000000000000000000003',
              },
              addedDate: '2024-01-01',
            },
          ],
        },
      ],
    }
    const archive = await zip([
      { name: 'Spotify Account Data/Playlist1.json', data: text(JSON.stringify(playlists)) },
      { name: 'Spotify Account Data/SearchQueries.json', data: text('[{"searchQuery":"secret"}]') },
    ])
    const fromZip = await parseExportFiles([{ name: 'my_spotify_data.zip', bytes: archive }])
    expect(fromZip.collections[0]?.rows[0]?.title).toBe('Angel')
    expect(JSON.stringify(fromZip)).not.toContain('secret')
    const fromJson = await parseExportFiles([
      { name: 'Playlist1.json', bytes: text(JSON.stringify(playlists)) },
      { name: 'notes.txt', bytes: text('ignored') },
    ])
    expect(fromJson.collections).toEqual(fromZip.collections)
  })
})
