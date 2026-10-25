import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createZip } from '../scripts/zip.ts'
import { checkSignedXpi, readBuild, readZip } from './xpi.ts'

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

describe('readBuild', () => {
  let dir = ''
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('reads every file by its path, without dot files, as web-ext packs the folder', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fxm-build-'))
    await mkdir(join(dir, 'icons'))
    await writeFile(join(dir, 'manifest.json'), '{}')
    await writeFile(join(dir, 'icons', 'icon-16.png'), 'png')
    await writeFile(join(dir, '.amo-upload-uuid'), 'left by web-ext sign')
    const files = await readBuild(dir)
    expect([...files.keys()].sort()).toEqual(['icons/icon-16.png', 'manifest.json'])
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
    expect(() => checkSignedXpi(signed(added), expected)).toThrow(/extra.js is not in the build/)
  })
})
