import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { packageVersion } from '../src/manifest.ts'
import { buildExtension } from './build.ts'
import { readZip } from './read-zip.ts'

const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const LICENSE = readFileSync(new URL('../../../LICENSE', import.meta.url))
const NOTICE = readFileSync(new URL('../NOTICE', import.meta.url), 'utf8')
/** FXM Connect's own source folder, where every bundled module must come from. */
const SOURCE = `${fileURLToPath(new URL('../src', import.meta.url))}${sep}`

describe('package.json', () => {
  it('has a version both browsers accept, which the build writes into the manifests', () => {
    expect(packageVersion(pkg)).toMatch(/^\d+(\.\d+){0,3}$/)
  })
})

describe('NOTICE', () => {
  it('says that FXM Connect is under the Apache License 2.0 and bundles no third-party code', () => {
    const text = NOTICE.replace(/\s+/g, ' ')
    expect(text).toContain('Apache License, Version 2.0')
    expect(text).toContain('LICENSE file')
    expect(text).toContain('bundles no third-party code')
    expect(text).toContain('not affiliated with or endorsed by YouTube, Google, Spotify or Last.fm')
  })
})

describe('the release zips', () => {
  const version = packageVersion(pkg)
  const zips = new Map<string, Map<string, Buffer>>()
  let dist = ''

  // The release build itself, as make extension and the release workflow run it.
  beforeAll(async () => {
    dist = await mkdtemp(join(tmpdir(), 'fxm-connect-build-'))
    await buildExtension({ dev: false, dist, log: () => {} })
    for (const browser of ['chromium', 'firefox']) {
      const zip = await readFile(join(dist, `fxm-connect-${browser}-${version}.zip`))
      zips.set(browser, new Map(readZip(zip).map((entry) => [entry.name, entry.data])))
    }
  }, 120_000)

  afterAll(async () => {
    if (dist) await rm(dist, { recursive: true, force: true })
  })

  const each = (check: (files: Map<string, Buffer>) => void) => () => {
    expect([...zips.keys()]).toEqual(['chromium', 'firefox'])
    for (const files of zips.values()) check(files)
  }

  it(
    "carry the repository's LICENSE and FXM Connect's NOTICE",
    each((files) => {
      expect(files.get('LICENSE')?.equals(LICENSE)).toBe(true)
      expect(files.get('NOTICE')?.toString('utf8')).toBe(NOTICE)
    }),
  )

  it(
    "bundle only FXM Connect's own source, as the NOTICE says",
    each((files) => {
      const scripts = [...files.keys()].filter((name) => name.endsWith('.js'))
      expect(scripts.sort()).toEqual(['background.js', 'content.js', 'options.js'])
      for (const name of scripts) {
        // The bundler marks where each module starts with its path from the folder it ran in,
        // which here is the test's.
        const modules = [
          ...(files.get(name)?.toString('utf8') ?? '').matchAll(/\/\/#region (\S+)/g),
        ]
        expect(modules.length, name).toBeGreaterThan(0)
        for (const [, path = ''] of modules) {
          expect(resolve(path).startsWith(SOURCE), `${name}: ${path}`).toBe(true)
        }
      }
    }),
  )

  it(
    "ship the options page without the development build's parts",
    each((files) => {
      const page = files.get('options.html')?.toString('utf8') ?? ''
      expect(page).toContain('id="spotify-login"')
      expect(page).not.toContain('localhost')
      expect(page).not.toMatch(/\sdata-dev\b/)
      for (const id of ['dev-badge', 'dev-warning', 'localhost-login']) {
        expect(page).not.toContain(`id="${id}"`)
      }
    }),
  )
})
