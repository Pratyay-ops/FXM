import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createZip } from '../scripts/zip.ts'
import { checkSignedXpi, readZip, writeFiles, zipFiles } from './xpi.ts'

const ID = 'fxm-connect@fxmusic.pages.dev'
const encoder = new TextEncoder()

function manifest(version = '1.2.3', id = ID): Uint8Array {
  return encoder.encode(
    JSON.stringify({ version, browser_specific_settings: { gecko: { id } } }, null, 2),
  )
}

/** The build that was submitted. */
function build(): Map<string, Uint8Array> {
  return new Map([
    ['manifest.json', manifest()],
    ['background.js', encoder.encode('console.log("background")\n'.repeat(20))],
    ['icons/icon-16.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])],
  ])
}

/** What AMO sends back: the build plus its signature files. */
function signed(files: Map<string, Uint8Array>, signature = ['META-INF/cose.sig']): Uint8Array {
  const entries = [...files].map(([name, data]) => ({ name, data }))
  for (const name of ['META-INF/manifest.mf', ...signature]) {
    entries.unshift({ name, data: encoder.encode(`signature of ${name}`) })
  }
  return createZip(entries)
}

describe('readZip', () => {
  it('reads stored and deflated entries back, skipping folders', () => {
    const zip = createZip([
      { name: 'big.txt', data: encoder.encode('a'.repeat(5000)) },
      { name: 'tiny', data: new Uint8Array([7]) },
      { name: 'folder/', data: new Uint8Array() },
    ])
    expect(readZip(zip).map((entry) => [entry.name, entry.data.length])).toEqual([
      ['big.txt', 5000],
      ['tiny', 1],
    ])
  })

  it('refuses a damaged entry and anything that is not a zip', () => {
    const zip = Buffer.from(createZip([{ name: 'a.txt', data: encoder.encode('hello world') }]))
    const damaged = Buffer.from(zip)
    // The first byte of a.txt's data, right after its local header and name.
    const at = 30 + 'a.txt'.length
    damaged.writeUInt8(damaged.readUInt8(at) ^ 0xff, at)
    expect(() => readZip(damaged)).toThrow(/damaged|not a readable zip/)
    expect(() => readZip(encoder.encode('just text, long enough to search for a record'))).toThrow(
      /no end of central directory/,
    )
  })
})

/** A zip whose entry names were rewritten afterwards, as a hostile zip could hold them. */
function renamed(names: [string, string][]): Uint8Array {
  let zip = Buffer.from(
    createZip(names.map(([name], index) => ({ name, data: encoder.encode(`file ${index}`) }))),
  )
  for (const [from, to] of names) {
    if (from.length !== to.length) throw new Error('a rename must keep the length')
    zip = Buffer.from(zip.toString('latin1').replaceAll(from, to), 'latin1')
  }
  return zip
}

describe('zipFiles', () => {
  it('reads every file by its path inside the zip', () => {
    const files = zipFiles(signed(build(), ['META-INF/cose.sig']))
    expect([...files.keys()].sort()).toEqual([
      'META-INF/cose.sig',
      'META-INF/manifest.mf',
      'background.js',
      'icons/icon-16.png',
      'manifest.json',
    ])
    expect(Buffer.from(files.get('manifest.json') ?? [])).toEqual(Buffer.from(manifest()))
  })

  it.each([
    ['a parent folder', 'xx/a.js', '../a.js'],
    ['an absolute path', 'xabs.js', '/abs.js'],
    ['a backslash', 'a_b.js', 'a\\b.js'],
    ['a drive letter', 'Cx.js', 'C:.js'],
    ['an empty part', 'ab/c.js', 'a//c.js'],
  ])('refuses %s, which could write outside the folder', (_label, from, to) => {
    expect(() => zipFiles(renamed([[from, to]]))).toThrow(/unsafe path/)
  })

  it('refuses a path that appears twice', () => {
    expect(() =>
      zipFiles(
        renamed([
          ['a/x.js', 'a/x.js'],
          ['a/y.js', 'a/x.js'],
        ]),
      ),
    ).toThrow(/a\/x\.js twice/)
  })
})

describe('writeFiles', () => {
  let dir = ''
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('writes the files into a folder, and nothing outside it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fxm-files-'))
    await writeFiles(join(dir, 'out'), build())
    expect((await readdir(join(dir, 'out'), { recursive: true })).sort()).toEqual([
      'background.js',
      'icons',
      'icons/icon-16.png',
      'manifest.json',
    ])
    expect(await readFile(join(dir, 'out', 'manifest.json'))).toEqual(Buffer.from(manifest()))
    await expect(
      writeFiles(join(dir, 'out'), new Map([['../evil.js', encoder.encode('x')]])),
    ).rejects.toThrow(/refusing to write/)
    expect(await readdir(dir)).toEqual(['out'])
  })
})

describe('checkSignedXpi', () => {
  const expected = { id: ID, version: '1.2.3', files: build() }

  it('accepts the signed copy of the build', () => {
    expect(() => checkSignedXpi(signed(build()), expected)).not.toThrow()
    expect(() => checkSignedXpi(signed(build(), ['META-INF/mozilla.rsa']), expected)).not.toThrow()
  })

  it('refuses a file without a Mozilla signature', () => {
    expect(() => checkSignedXpi(signed(build(), []), expected)).toThrow(/no Mozilla signature/)
  })

  it('refuses another version or another add-on', () => {
    const files = build()
    files.set('manifest.json', manifest('1.2.4'))
    expect(() => checkSignedXpi(signed(files), expected)).toThrow(/version 1.2.4, not 1.2.3/)
    files.set('manifest.json', manifest('1.2.3', 'other@example.com'))
    expect(() => checkSignedXpi(signed(files), expected)).toThrow(/add-on ID is other@example.com/)
  })

  it('refuses files that differ from the build, are missing or were added', () => {
    const changed = build()
    changed.set('background.js', encoder.encode('console.log("changed")'))
    expect(() => checkSignedXpi(signed(changed), expected)).toThrow(/background.js differs/)

    const missing = build()
    missing.delete('icons/icon-16.png')
    expect(() => checkSignedXpi(signed(missing), expected)).toThrow(/icon-16.png is missing/)

    const added = build()
    added.set('extra.js', encoder.encode('surprise'))
    expect(() => checkSignedXpi(signed(added), expected)).toThrow(/extra.js is not in the zip/)
  })
})
