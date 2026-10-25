import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createZip } from '../scripts/zip.ts'
import { buildManifest } from '../src/manifest.ts'
import type { Reporter } from './actions.ts'
import type { AmoVersion } from './amo.ts'
import {
  APPROVAL_TIMEOUT_MS,
  channelSetting,
  type LintReport,
  planSigning,
  type SignDeps,
  signFirefox,
  VALIDATION_TIMEOUT_MS,
  xpiName,
} from './firefox.ts'
import { amoMetadata } from './listing.ts'

const VERSION = '1.2.3'
const GUID = 'fxm-connect@fxmusic.pages.dev'
const FILE_URL = 'https://amo.test/firefox/downloads/file/99/fxm_connect-1.2.3.xpi'
const encoder = new TextEncoder()

function recorder() {
  const lines: string[] = []
  const reporter: Reporter = {
    info: (m) => lines.push(`info ${m}`),
    notice: (t, m) => lines.push(`notice ${t}: ${m}`),
    warning: (t, m) => lines.push(`warning ${t}: ${m}`),
    error: (t, m) => lines.push(`error ${t}: ${m}`),
    output: (n, v) => lines.push(`output ${n}=${v}`),
    summary: (m) => lines.push(`summary ${m}`),
  }
  return { lines, reporter }
}

describe('channelSetting', () => {
  it('reads AMO_CHANNEL, unlisted by default', () => {
    expect(channelSetting(undefined)).toBe('unlisted')
    expect(channelSetting('')).toBe('unlisted')
    expect(channelSetting(' Listed ')).toBe('listed')
    expect(channelSetting('off')).toBe('off')
    expect(() => channelSetting('lsited')).toThrow(/AMO_CHANNEL must be unlisted, listed or off/)
  })
})

describe('planSigning', () => {
  it('skips with a notice when the AMO secrets are missing', () => {
    const { lines, reporter } = recorder()
    expect(planSigning({}, reporter)).toBeNull()
    expect(lines).toEqual([
      expect.stringMatching(
        /^notice Firefox add-on: AMO_API_KEY and AMO_API_SECRET are not set.*README\.md/,
      ),
    ])
  })

  it('skips with a warning when only one of them is set', () => {
    const { lines, reporter } = recorder()
    expect(planSigning({ AMO_API_KEY: 'user:1:2' }, reporter)).toBeNull()
    expect(lines).toEqual([
      expect.stringMatching(/^warning Firefox add-on: AMO_API_SECRET is not set/),
    ])
  })

  it('skips with a notice when AMO_CHANNEL is off, secrets or not', () => {
    const { lines, reporter } = recorder()
    const env = { AMO_API_KEY: 'k', AMO_API_SECRET: 's', AMO_CHANNEL: 'off' }
    expect(planSigning(env, reporter)).toBeNull()
    expect(lines).toEqual([expect.stringMatching(/^notice Firefox add-on: AMO_CHANNEL is off/)])
  })

  it('signs with both secrets, in the chosen channel', () => {
    const { lines, reporter } = recorder()
    expect(planSigning({ AMO_API_KEY: ' k ', AMO_API_SECRET: 's' }, reporter)).toEqual({
      channel: 'unlisted',
      credentials: { key: 'k', secret: 's' },
    })
    expect(
      planSigning({ AMO_API_KEY: 'k', AMO_API_SECRET: 's', AMO_CHANNEL: 'listed' }, reporter)
        ?.channel,
    ).toBe('listed')
    expect(lines).toEqual([])
  })
})

describe('signFirefox', () => {
  let root = ''
  let sourceDir = ''
  let workDir = ''
  let outDir = ''
  let buildFiles: Map<string, Uint8Array>

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fxm-sign-'))
    sourceDir = join(root, 'firefox')
    workDir = join(root, 'work')
    outDir = join(root, 'out')
    buildFiles = new Map([
      [
        'manifest.json',
        encoder.encode(
          JSON.stringify(buildManifest({ browser: 'firefox', version: VERSION, dev: false })),
        ),
      ],
      ['background.js', encoder.encode('console.log("FXM Connect")\n')],
      ['icons/icon-16.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
    ])
    await writeBuild(buildFiles)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function writeBuild(files: Map<string, Uint8Array>) {
    await rm(sourceDir, { recursive: true, force: true })
    for (const [name, data] of files) {
      await mkdir(join(sourceDir, name, '..'), { recursive: true })
      await writeFile(join(sourceDir, name), data)
    }
  }

  /** AMO's signed copy of a build. */
  function signedXpi(files = buildFiles): Uint8Array {
    return createZip([
      { name: 'META-INF/cose.sig', data: encoder.encode('cose') },
      { name: 'META-INF/mozilla.rsa', data: encoder.encode('pkcs7') },
      ...[...files].map(([name, data]) => ({ name, data })),
    ])
  }

  const version = (status: string, channel = 'unlisted'): AmoVersion => ({
    id: 7,
    version: VERSION,
    channel,
    status,
    fileUrl: status === 'public' ? FILE_URL : null,
    editUrl: 'https://amo.test/developers/addon/fxm-connect/versions/7',
  })

  interface Fakes {
    /** What AMO answers to each version lookup, in order (the last one repeats). */
    lookups?: (AmoVersion | null)[]
    /** web-ext's exit code; on 0 it saves the signed file first. */
    webExtCode?: number
    lint?: LintReport
    download?: Uint8Array
  }

  function deps({ lookups = [null], webExtCode = 0, lint, download }: Fakes) {
    const { lines, reporter } = recorder()
    const webExtCalls: (readonly string[])[] = []
    const downloads: string[] = []
    let time = 0
    const answers = [...lookups]
    const fake: SignDeps = {
      amo: {
        getVersion: async (guid, number) => {
          expect([guid, number]).toEqual([GUID, VERSION])
          return (answers.length > 1 ? answers.shift() : answers[0]) ?? null
        },
        download: async (url) => {
          downloads.push(url)
          return download ?? signedXpi()
        },
      },
      lint: async () => lint ?? { errors: [], warnings: [], notices: [] },
      archiveSource: async (dest, v) => writeFile(dest, `source of ${v}`),
      runWebExt: async (args) => {
        webExtCalls.push(args)
        if (webExtCode === 0) {
          const dir = args[args.indexOf('--artifacts-dir') + 1] ?? ''
          await mkdir(dir, { recursive: true })
          await writeFile(join(dir, 'fxm_connect-1.2.3.xpi'), signedXpi())
        }
        return webExtCode
      },
      reporter,
      now: () => time,
      sleep: async (ms) => {
        time += ms
      },
      pollIntervalMs: 60_000,
    }
    return { fake, lines, webExtCalls, downloads, elapsed: () => time }
  }

  const options = (channel: 'listed' | 'unlisted' = 'unlisted') => ({
    version: VERSION,
    channel,
    sourceDir,
    outDir,
    workDir,
    commit: 'abc1234',
  })

  it('signs a new version with web-ext, checks the file and saves it under its release name', async () => {
    const { fake, webExtCalls, downloads } = deps({})
    await expect(signFirefox(options(), fake)).resolves.toEqual({
      signed: true,
      file: join(outDir, xpiName(VERSION)),
      channel: 'unlisted',
    })
    expect(xpiName(VERSION)).toBe('fxm-connect-firefox-1.2.3.xpi')
    expect(await readdir(outDir)).toEqual(['fxm-connect-firefox-1.2.3.xpi'])
    expect(await readFile(join(outDir, xpiName(VERSION)))).toEqual(Buffer.from(signedXpi()))
    expect(downloads).toEqual([])
    expect(webExtCalls).toEqual([
      [
        'sign',
        '--source-dir',
        sourceDir,
        '--artifacts-dir',
        join(workDir, 'signed'),
        '--channel',
        'unlisted',
        '--amo-metadata',
        join(workDir, 'amo-metadata.json'),
        '--upload-source-code',
        join(workDir, 'fxm-1.2.3-source.zip'),
        '--approval-timeout',
        String(APPROVAL_TIMEOUT_MS.unlisted),
        '--timeout',
        String(VALIDATION_TIMEOUT_MS),
        '--no-config-discovery',
        '--no-input',
      ],
    ])
  })

  it('sends the metadata and source code of the release, and never the credentials', async () => {
    const { fake, webExtCalls } = deps({})
    await signFirefox(options('listed'), fake)
    const metadata = JSON.parse(await readFile(join(workDir, 'amo-metadata.json'), 'utf8'))
    expect(metadata).toEqual(amoMetadata('listed', VERSION, 'abc1234'))
    expect(await readFile(join(workDir, 'fxm-1.2.3-source.zip'), 'utf8')).toBe('source of 1.2.3')
    const args = webExtCalls[0] ?? []
    expect(args).not.toContain('--api-key')
    expect(args).not.toContain('--api-secret')
    expect(args[args.indexOf('--channel') + 1]).toBe('listed')
    expect(args[args.indexOf('--approval-timeout') + 1]).toBe(String(APPROVAL_TIMEOUT_MS.listed))
  })

  it('fetches a version AMO already signed instead of submitting it again', async () => {
    const { fake, webExtCalls, downloads, lines } = deps({ lookups: [version('public')] })
    await expect(signFirefox(options(), fake)).resolves.toMatchObject({ signed: true })
    expect(webExtCalls).toEqual([])
    expect(downloads).toEqual([FILE_URL])
    expect(lines).toContain(
      'info AMO already has 1.2.3 (unlisted, public): fetching it instead of submitting it again.',
    )
  })

  it('waits for a version AMO is still reviewing, then fetches it', async () => {
    const { fake, webExtCalls, downloads, elapsed } = deps({
      lookups: [version('unreviewed'), version('unreviewed'), version('public')],
    })
    await expect(signFirefox(options(), fake)).resolves.toMatchObject({ signed: true })
    expect(webExtCalls).toEqual([])
    expect(downloads).toEqual([FILE_URL])
    expect(elapsed()).toBe(60_000)
  })

  it('fails when an unlisted version stays unsigned, so that a re-run can fetch it later', async () => {
    const { fake, elapsed } = deps({ lookups: [version('unreviewed')] })
    await expect(signFirefox(options(), fake)).rejects.toThrow(/hasn't signed 1.2.3 yet.*Re-run/)
    expect(elapsed()).toBeLessThanOrEqual(APPROVAL_TIMEOUT_MS.unlisted)
    await expect(readdir(outDir)).rejects.toThrow()
  })

  it('lets a release go without the XPI while AMO reviews a listed version', async () => {
    const { fake, webExtCalls, lines, elapsed } = deps({
      lookups: [null, version('unreviewed', 'listed')],
      webExtCode: 1,
    })
    await expect(signFirefox(options('listed'), fake)).resolves.toEqual({
      signed: false,
      reason: 'in-review',
    })
    expect(webExtCalls).toHaveLength(1)
    // web-ext already waited; no second wait.
    expect(elapsed()).toBe(0)
    expect(lines).toContainEqual(
      expect.stringMatching(/^warning Firefox add-on: AMO is reviewing 1.2.3 for the listing/),
    )
  })

  it('fetches the version when web-ext failed after AMO signed it', async () => {
    const { fake, downloads } = deps({ lookups: [null, version('public')], webExtCode: 1 })
    await expect(signFirefox(options(), fake)).resolves.toMatchObject({ signed: true })
    expect(downloads).toEqual([FILE_URL])
  })

  it('fails when web-ext fails and AMO has no such version', async () => {
    const { fake } = deps({ lookups: [null], webExtCode: 2 })
    await expect(signFirefox(options(), fake)).rejects.toThrow(
      'web-ext sign failed (exit code 2) and AMO has no 1.2.3: see above',
    )
  })

  it('fails when AMO rejected the version', async () => {
    const { fake } = deps({ lookups: [version('disabled')] })
    await expect(signFirefox(options(), fake)).rejects.toThrow(/AMO rejected or disabled 1.2.3/)
  })

  it('warns when AMO has the version in the other channel, and uses it', async () => {
    const { fake, lines } = deps({ lookups: [version('public', 'listed')] })
    await expect(signFirefox(options('unlisted'), fake)).resolves.toMatchObject({
      signed: true,
      channel: 'listed',
    })
    expect(lines).toContainEqual(
      expect.stringMatching(/^warning Firefox add-on: AMO has 1.2.3 in the listed channel/),
    )
  })

  it('refuses a signed file that is not the build', async () => {
    const other = new Map(buildFiles)
    other.set('background.js', encoder.encode('console.log("something else")'))
    const { fake } = deps({ lookups: [version('public')], download: signedXpi(other) })
    await expect(signFirefox(options(), fake)).rejects.toThrow(/background.js differs/)
    await expect(readdir(outDir)).rejects.toThrow()
  })

  it("stops before AMO when AMO's linter has findings", async () => {
    const { fake, webExtCalls } = deps({
      lint: {
        errors: [],
        warnings: ['UNSAFE_VAR_ASSIGNMENT: innerHTML (options.js)'],
        notices: [],
      },
    })
    await expect(signFirefox(options(), fake)).rejects.toThrow(/UNSAFE_VAR_ASSIGNMENT/)
    expect(webExtCalls).toEqual([])
  })

  it('refuses a build of another version and the development build', async () => {
    const { fake } = deps({})
    await expect(signFirefox({ ...options(), version: '1.2.4' }, fake)).rejects.toThrow(
      /build is version 1.2.3, not 1.2.4/,
    )
    await expect(signFirefox({ ...options(), version: '1.2' }, fake)).rejects.toThrow(
      /not a release version/,
    )
    const dev = new Map(buildFiles)
    dev.set(
      'manifest.json',
      encoder.encode(
        JSON.stringify(buildManifest({ browser: 'firefox', version: VERSION, dev: true })),
      ),
    )
    await writeBuild(dev)
    await expect(signFirefox(options(), fake)).rejects.toThrow(/development build/)
    const chromium = new Map(buildFiles)
    chromium.set(
      'manifest.json',
      encoder.encode(
        JSON.stringify(buildManifest({ browser: 'chromium', version: VERSION, dev: false })),
      ),
    )
    await writeBuild(chromium)
    await expect(signFirefox(options(), fake)).rejects.toThrow(/not the Firefox build/)
  })

  it('checks, lints and packs in a dry run without contacting AMO', async () => {
    const { fake, webExtCalls } = deps({})
    const amo = fake.amo
    await expect(
      signFirefox({ ...options(), dryRun: true }, { ...fake, amo: null }),
    ).resolves.toEqual({
      signed: false,
      reason: 'dry-run',
    })
    expect(amo).not.toBeNull()
    expect(webExtCalls).toEqual([])
    expect(await readdir(workDir)).toEqual(['amo-metadata.json', 'fxm-1.2.3-source.zip'])
  })
})
