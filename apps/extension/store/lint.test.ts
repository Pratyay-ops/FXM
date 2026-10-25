import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { iconPng, iconSvg } from '../scripts/icons.ts'
import { createZip, type ZipEntry } from '../scripts/zip.ts'
import { fxmOrigins } from '../src/config.ts'
import { buildManifest, ICON_SIZES } from '../src/manifest.ts'
import { buildRulesets } from '../src/rules.ts'
import { lintZip } from './firefox.ts'

const OPTIONS = new URL('../src/options/', import.meta.url)

/**
 * The release zip for Firefox as scripts/build.ts lays it out, with the real manifest, rulesets,
 * options page and icons. Only the three scripts are stand-ins: Vite bundles them in the real
 * build, which the release workflow lints before any store job submits it.
 */
async function firefoxZip(): Promise<Uint8Array> {
  const text = (name: string, value: string): ZipEntry => ({
    name,
    data: new TextEncoder().encode(value),
  })
  const manifest = buildManifest({ browser: 'firefox', version: '1.2.3', dev: false })
  const entries: ZipEntry[] = [text('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)]
  for (const ruleset of buildRulesets(fxmOrigins(false))) {
    entries.push(text(ruleset.path, `${JSON.stringify(ruleset.rules, null, 2)}\n`))
  }
  for (const file of ['options.html', 'options.css']) {
    entries.push({ name: file, data: await readFile(new URL(file, OPTIONS)) })
  }
  for (const script of ['background.js', 'content.js', 'options.js']) {
    entries.push(
      text(script, `(function () {\n  'use strict'\n  void ${JSON.stringify(script)}\n})()\n`),
    )
  }
  for (const size of ICON_SIZES)
    entries.push({ name: `icons/icon-${size}.png`, data: iconPng(size) })
  entries.push(text('icons/icon.svg', iconSvg()))
  return createZip(entries)
}

describe("AMO's linter", () => {
  let dir = ''
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('finds nothing in the Firefox manifest, rulesets, options page and icons', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fxm-amo-lint-'))
    const zip = join(dir, 'fxm-connect-firefox-1.2.3.zip')
    await writeFile(zip, await firefoxZip())
    await expect(lintZip(zip)).resolves.toEqual({ errors: [], warnings: [], notices: [] })
  }, 60_000)
})
