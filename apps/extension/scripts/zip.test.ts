import { describe, expect, it } from 'vitest'
import { readZip } from './read-zip.ts'
import { createZip } from './zip.ts'

const ENTRIES = [
  { name: 'manifest.json', data: Buffer.from(JSON.stringify({ a: 'x'.repeat(200) })) },
  { name: 'icons/icon-16.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
  { name: 'empty.txt', data: new Uint8Array(0) },
]

describe('createZip', () => {
  it('writes entries in order that unzip back to the same bytes', () => {
    const entries = readZip(createZip(ENTRIES))
    expect(entries.map((entry) => entry.name)).toEqual(ENTRIES.map((entry) => entry.name))
    for (const [index, entry] of entries.entries()) {
      expect(entry.crcOk).toBe(true)
      expect([...entry.data]).toEqual([...(ENTRIES[index]?.data ?? [])])
    }
    // Compressible data is deflated; tiny data is stored.
    expect(entries.map((entry) => entry.method)).toEqual([8, 0, 0])
  })

  it('is deterministic', () => {
    expect(createZip(ENTRIES).equals(createZip(ENTRIES))).toBe(true)
  })

  it('rejects duplicate and unsafe names', () => {
    const data = new Uint8Array(1)
    expect(() =>
      createZip([
        { name: 'a', data },
        { name: 'a', data },
      ]),
    ).toThrow(/duplicate/)
    expect(() => createZip([{ name: '/etc/passwd', data }])).toThrow()
    expect(() => createZip([{ name: 'a\\b', data }])).toThrow()
    expect(() => createZip([{ name: '', data }])).toThrow()
  })
})
