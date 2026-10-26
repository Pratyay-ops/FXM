import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { staticFiles } from '../scripts/build.ts'
import { createZip, type ZipEntry } from '../scripts/zip.ts'
import { buildManifest } from '../src/manifest.ts'
import { lintZip } from './firefox.ts'

/**
 * The release zip for Firefox as scripts/build.ts lays it out, with the real manifest and the
 * build's other files: the release options page, its stylesheet, the icons, the rulesets, LICENSE
 * and NOTICE. Only the three scripts are stand-ins: Vite bundles them in the real build, which
 * the release workflow lints before any store job submits it.
 */
async function firefoxZip(): Promise<Uint8Array> {
  const text = (name: string, value: string): ZipEntry => ({
    name,
    data: new TextEncoder().encode(value),
  })
  const manifest = buildManifest({ browser: 'firefox', version: '1.2.3', dev: false })
  const entries: ZipEntry[] = [
    text('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`),
    ...(await staticFiles(false)),
  ]
  for (const script of ['background.js', 'content.js', 'options.js']) {
    entries.push(
      text(script, `(function () {\n  'use strict'\n  void ${JSON.stringify(script)}\n})()\n`),
    )
  }
  return createZip(entries)
}

describe("AMO's linter", () => {
  let dir = ''
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('finds nothing in the Firefox manifest, rulesets, options page, icons and licence files', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fxm-amo-lint-'))
    const zip = join(dir, 'fxm-connect-firefox-1.2.3.zip')
    await writeFile(zip, await firefoxZip())
    await expect(lintZip(zip)).resolves.toEqual({ errors: [], warnings: [], notices: [] })
  }, 60_000)
})
