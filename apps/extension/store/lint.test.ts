import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { iconPng, iconSvg } from '../scripts/icons.ts'
import { fxmOrigins } from '../src/config.ts'
import { buildManifest, ICON_SIZES } from '../src/manifest.ts'
import { buildRulesets } from '../src/rules.ts'
import { lintWithAmo } from './firefox.ts'

const OPTIONS = new URL('../src/options/', import.meta.url)

/**
 * The release build for Firefox as scripts/build.ts lays it out, with the real manifest,
 * rulesets, options page and icons. Only the three scripts are stand-ins: Vite bundles them in
 * the real build, which the release workflow lints before it signs.
 */
async function firefoxBuild(dir: string): Promise<void> {
  const manifest = buildManifest({ browser: 'firefox', version: '1.2.3', dev: false })
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  for (const ruleset of buildRulesets(fxmOrigins(false))) {
    await writeFile(join(dir, ruleset.path), `${JSON.stringify(ruleset.rules, null, 2)}\n`)
  }
  for (const file of ['options.html', 'options.css']) {
    await cp(new URL(file, OPTIONS), join(dir, file))
  }
  for (const script of ['background.js', 'content.js', 'options.js']) {
    await writeFile(
      join(dir, script),
      `(function () {\n  'use strict'\n  void ${JSON.stringify(script)}\n})()\n`,
    )
  }
  await mkdir(join(dir, 'icons'))
  for (const size of ICON_SIZES) {
    await writeFile(join(dir, 'icons', `icon-${size}.png`), iconPng(size))
  }
  await writeFile(join(dir, 'icons', 'icon.svg'), iconSvg())
}

describe("AMO's linter", () => {
  let dir = ''
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('finds nothing in the Firefox manifest, rulesets, options page and icons', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fxm-amo-lint-'))
    await firefoxBuild(dir)
    await expect(lintWithAmo(dir)).resolves.toEqual({ errors: [], warnings: [], notices: [] })
  }, 60_000)
})
