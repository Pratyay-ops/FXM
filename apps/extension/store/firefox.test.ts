import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createZip } from '../scripts/zip.ts'
import { buildManifest } from '../src/manifest.ts'
import type { Reporter } from './actions.ts'
import type { AmoUpload, AmoVersion } from './amo.ts'
import {
  type AmoApi,
  APPROVAL_TIMEOUT_MS,
  channelSetting,
  credentialsFrom,
  jobChannel,
  lintZip,
  planChannel,
  type SubmitDeps,
  type SubmitOptions,
  submitToAmo,
  xpiName,
  zipName,
} from './firefox.ts'
import { type AmoChannel, amoMetadata } from './listing.ts'

const VERSION = '1.2.3'
const GUID = 'fxm-connect@fxmusic.pages.dev'
const FILE_URL = 'https://amo.test/firefox/downloads/file/99/fxm_connect-1.2.3.xpi'
const UUID = 'upload-1'
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

  it("reads a job's --channel strictly", () => {
    expect(jobChannel('unlisted')).toBe('unlisted')
    expect(jobChannel('listed')).toBe('listed')
    expect(() => jobChannel('off')).toThrow(/--channel must be unlisted or listed/)
  })
})

describe('planChannel', () => {
  const KEYS = { AMO_API_KEY_SET: 'true', AMO_API_SECRET_SET: 'true', FIREFOX_LINT: 'clean' }

  it('submits with both keys set and a clean lint, knowing only that the keys are set', () => {
    const { lines, reporter } = recorder()
    expect(planChannel('unlisted', KEYS, reporter)).toBe(true)
    expect(planChannel('listed', { ...KEYS, AMO_CHANNEL: 'listed' }, reporter)).toBe(true)
    expect(lines).toEqual([])
  })

  it('skips with a notice when the AMO keys are missing', () => {
    const { lines, reporter } = recorder()
    const env = { AMO_API_KEY_SET: 'false', AMO_API_SECRET_SET: 'false', FIREFOX_LINT: 'clean' }
    expect(planChannel('unlisted', env, reporter)).toBe(false)
    expect(planChannel('listed', { ...env, AMO_CHANNEL: 'listed' }, reporter)).toBe(false)
    expect(lines).toEqual([
      expect.stringMatching(
        /^notice Signed Firefox add-on: AMO_API_KEY and AMO_API_SECRET are not set in the stores environment, so this release has no signed Firefox add-on.*README\.md/,
      ),
      expect.stringMatching(
        /^notice Firefox Add-ons listing: AMO_API_KEY and AMO_API_SECRET are not set.*isn't submitted to the Firefox Add-ons listing/,
      ),
    ])
  })

  it('skips with a warning when only one of them is set', () => {
    const { lines, reporter } = recorder()
    expect(planChannel('unlisted', { AMO_API_KEY_SET: 'true' }, reporter)).toBe(false)
    expect(lines).toEqual([
      expect.stringMatching(/^warning Signed Firefox add-on: AMO_API_SECRET is not set/),
    ])
  })

  it('leaves AMO to the job of the channel AMO_CHANNEL picks', () => {
    const { lines, reporter } = recorder()
    expect(planChannel('unlisted', { ...KEYS, AMO_CHANNEL: 'listed' }, reporter)).toBe(false)
    expect(planChannel('listed', KEYS, reporter)).toBe(false)
    expect(lines).toEqual([
      expect.stringMatching(
        /^notice Signed Firefox add-on: AMO_CHANNEL is listed, so this release has no signed XPI: once the release is published, the Firefox Add-ons listing job submits it/,
      ),
      'info AMO_CHANNEL is unlisted, so the Signed Firefox add-on job handles AMO.',
    ])
  })

  it('says once that AMO_CHANNEL is off', () => {
    const { lines, reporter } = recorder()
    const env = { ...KEYS, AMO_CHANNEL: 'off' }
    expect(planChannel('unlisted', env, reporter)).toBe(false)
    expect(planChannel('listed', env, reporter)).toBe(false)
    expect(lines).toEqual([
      expect.stringMatching(/^notice Signed Firefox add-on: AMO_CHANNEL is off/),
      'info AMO_CHANNEL is off: nothing to submit.',
    ])
  })

  it("fails the job when it would submit a zip that AMO's linter didn't pass", () => {
    const { reporter } = recorder()
    expect(() => planChannel('unlisted', { ...KEYS, FIREFOX_LINT: 'findings' }, reporter)).toThrow(
      /linter has findings/,
    )
    expect(() => planChannel('unlisted', { ...KEYS, FIREFOX_LINT: '' }, reporter)).toThrow(
      /linter didn't report/,
    )
    // Without the keys there is nothing to submit, so the lint doesn't matter.
    expect(planChannel('unlisted', { FIREFOX_LINT: 'findings' }, reporter)).toBe(false)
  })
})

describe('credentialsFrom', () => {
  it('reads both AMO keys of the submit step, or refuses to go on', () => {
    expect(credentialsFrom({ AMO_API_KEY: ' user:1:2 ', AMO_API_SECRET: 's' })).toEqual({
      key: 'user:1:2',
      secret: 's',
    })
    expect(() => credentialsFrom({ AMO_API_KEY: 'user:1:2' })).toThrow(/must both be set/)
  })
})

describe('submitToAmo', () => {
  let root = ''
  let zipPath = ''
  let workDir = ''
  let outDir = ''
  let files: Map<string, Uint8Array>

  const releaseZip = (entries: Map<string, Uint8Array>) =>
    createZip([...entries].map(([name, data]) => ({ name, data })))

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fxm-submit-'))
    zipPath = join(root, zipName(VERSION))
    workDir = join(root, 'work')
    outDir = join(root, 'out')
    files = new Map([
      [
        'manifest.json',
        encoder.encode(
          JSON.stringify(buildManifest({ browser: 'firefox', version: VERSION, dev: false })),
        ),
      ],
      ['background.js', encoder.encode('console.log("FXM Connect")\n')],
      ['icons/icon-16.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
    ])
    await writeFile(zipPath, releaseZip(files))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** AMO's signed copy of the zip's files. */
  function signedXpi(entries = files): Uint8Array {
    return createZip([
      { name: 'META-INF/cose.sig', data: encoder.encode('cose') },
      { name: 'META-INF/mozilla.rsa', data: encoder.encode('pkcs7') },
      ...[...entries].map(([name, data]) => ({ name, data })),
    ])
  }

  const version = (status: string, channel = 'unlisted', hasSource = true): AmoVersion => ({
    id: 7,
    version: VERSION,
    channel,
    status,
    fileUrl: status === 'public' ? FILE_URL : null,
    editUrl: 'https://amo.test/developers/addon/fxm-connect/versions/7',
    hasSource,
  })

  interface Fakes {
    /** What AMO answers to each version lookup, in order (the last one repeats). */
    lookups?: (AmoVersion | null)[]
    /** What the validator says on each look (the last one repeats). */
    validation?: AmoUpload[]
    /** The version AMO creates from the upload. */
    created?: AmoVersion
    download?: Uint8Array
    sourceFails?: boolean
  }

  function fakeAmo({
    lookups = [null, version('public')],
    validation = [{ uuid: UUID, processed: true, valid: true, errors: [] }],
    created = version('unreviewed'),
    download,
    sourceFails = false,
  }: Fakes) {
    const calls: string[] = []
    const uploads: { file: Uint8Array; name: string; channel: AmoChannel }[] = []
    const submissions: unknown[] = []
    const sources: { id: number; file: Uint8Array; name: string }[] = []
    const lookupAnswers = [...lookups]
    const validationAnswers = [...validation]
    const next = <T>(list: T[]): T => (list.length > 1 ? (list.shift() as T) : (list[0] as T))
    const amo: AmoApi = {
      getVersion: async (guid, number) => {
        expect([guid, number]).toEqual([GUID, VERSION])
        calls.push('getVersion')
        return next(lookupAnswers)
      },
      upload: async (file, name, channel) => {
        calls.push('upload')
        uploads.push({ file, name, channel })
        return UUID
      },
      uploadStatus: async (uuid) => {
        expect(uuid).toBe(UUID)
        calls.push('uploadStatus')
        return next(validationAnswers)
      },
      submitVersion: async (guid, uuid, metadata) => {
        expect([guid, uuid]).toEqual([GUID, UUID])
        calls.push('submitVersion')
        submissions.push(metadata)
        return created
      },
      uploadSource: async (guid, id, file, name) => {
        expect(guid).toBe(GUID)
        calls.push('uploadSource')
        if (sourceFails) throw new Error('HTTP 400: source locked')
        sources.push({ id, file, name })
      },
      download: async (url) => {
        expect(url).toBe(FILE_URL)
        calls.push('download')
        return download ?? signedXpi()
      },
    }
    return { amo, calls, uploads, submissions, sources }
  }

  function deps(amo: AmoApi | null) {
    const { lines, reporter } = recorder()
    let time = 0
    const fake: SubmitDeps = {
      amo,
      archiveSource: async (dest, v) => writeFile(dest, `source of ${v}`),
      reporter,
      now: () => time,
      sleep: async (ms) => {
        time += ms
      },
      pollIntervalMs: 60_000,
    }
    return { fake, lines, elapsed: () => time }
  }

  const options = (channel: AmoChannel = 'unlisted'): SubmitOptions => ({
    version: VERSION,
    channel,
    zipPath,
    outDir,
    workDir,
    commit: 'abc1234',
  })

  it('uploads the release zip as it is, creates the version, attaches the source and saves the signed file', async () => {
    const amo = fakeAmo({})
    const { fake } = deps(amo.amo)
    await expect(submitToAmo(options(), fake)).resolves.toEqual({
      kind: 'signed',
      file: join(outDir, xpiName(VERSION)),
      channel: 'unlisted',
    })
    expect(amo.calls).toEqual([
      'getVersion',
      'upload',
      'uploadStatus',
      'submitVersion',
      'uploadSource',
      'getVersion',
      'download',
    ])
    expect(amo.uploads).toEqual([
      { file: await readFile(zipPath), name: 'fxm-connect-firefox-1.2.3.zip', channel: 'unlisted' },
    ])
    expect(amo.submissions).toEqual([amoMetadata('unlisted', VERSION, 'abc1234')])
    expect(amo.sources).toEqual([
      { id: 7, file: Buffer.from('source of 1.2.3'), name: 'fxm-1.2.3-source.zip' },
    ])
    expect(await readdir(outDir)).toEqual(['fxm-connect-firefox-1.2.3.xpi'])
    expect(await readFile(join(outDir, xpiName(VERSION)))).toEqual(Buffer.from(signedXpi()))
  })

  it('waits for the validator, then for the signature', async () => {
    const amo = fakeAmo({
      validation: [
        { uuid: UUID, processed: false, valid: false, errors: [] },
        { uuid: UUID, processed: true, valid: true, errors: [] },
      ],
      lookups: [null, version('unreviewed'), version('public')],
    })
    const { fake, elapsed } = deps(amo.amo)
    await expect(submitToAmo(options(), fake)).resolves.toMatchObject({ kind: 'signed' })
    expect(amo.calls.filter((call) => call === 'uploadStatus')).toHaveLength(2)
    expect(elapsed()).toBe(120_000)
  })

  it('submits a listed version with the listing and leaves it to AMO, without waiting or a file', async () => {
    const amo = fakeAmo({ lookups: [null], created: version('unreviewed', 'listed') })
    const { fake, elapsed } = deps(amo.amo)
    const outcome = await submitToAmo({ ...options('listed'), outDir: undefined }, fake)
    expect(outcome).toEqual({
      kind: 'submitted',
      channel: 'listed',
      status: 'unreviewed',
      editUrl: 'https://amo.test/developers/addon/fxm-connect/versions/7',
    })
    expect(amo.uploads[0]?.channel).toBe('listed')
    expect(amo.submissions).toEqual([amoMetadata('listed', VERSION, 'abc1234')])
    expect(amo.calls).toEqual([
      'getVersion',
      'upload',
      'uploadStatus',
      'submitVersion',
      'uploadSource',
    ])
    expect(elapsed()).toBe(0)
  })

  it('refuses a zip that the validator rejects, before AMO creates a version', async () => {
    const amo = fakeAmo({
      validation: [
        {
          uuid: UUID,
          processed: true,
          valid: false,
          errors: ['Duplicate add-on ID found. (manifest.json)'],
        },
      ],
    })
    const { fake } = deps(amo.amo)
    await expect(submitToAmo(options(), fake)).rejects.toThrow(
      /validator refused fxm-connect-firefox-1.2.3.zip:\nDuplicate add-on ID found/,
    )
    expect(amo.calls).not.toContain('submitVersion')
  })

  it("stops when the validator doesn't finish in time", async () => {
    const amo = fakeAmo({
      validation: [{ uuid: UUID, processed: false, valid: false, errors: [] }],
    })
    const { fake } = deps(amo.amo)
    await expect(submitToAmo(options(), fake)).rejects.toThrow(/hasn't finished with upload-1/)
    expect(amo.calls).not.toContain('submitVersion')
  })

  it('fetches a version AMO already signed instead of submitting it again', async () => {
    const amo = fakeAmo({ lookups: [version('public')] })
    const { fake, lines } = deps(amo.amo)
    await expect(submitToAmo(options(), fake)).resolves.toMatchObject({ kind: 'signed' })
    expect(amo.calls).toEqual(['getVersion', 'download'])
    expect(lines).toContain(
      'info AMO already has 1.2.3 (unlisted, public): carrying on with it instead of submitting it again.',
    )
  })

  it('waits for a version AMO is still signing, then fetches it', async () => {
    const amo = fakeAmo({
      lookups: [version('unreviewed'), version('unreviewed'), version('public')],
    })
    const { fake, elapsed } = deps(amo.amo)
    await expect(submitToAmo(options(), fake)).resolves.toMatchObject({ kind: 'signed' })
    expect(amo.calls).not.toContain('upload')
    expect(elapsed()).toBe(60_000)
  })

  it('attaches the source code that an earlier, failed run left out', async () => {
    const amo = fakeAmo({ lookups: [version('public', 'unlisted', false)] })
    const { fake } = deps(amo.amo)
    await expect(submitToAmo(options(), fake)).resolves.toMatchObject({ kind: 'signed' })
    expect(amo.calls).toEqual(['getVersion', 'uploadSource', 'download'])

    const refused = fakeAmo({ lookups: [version('public', 'unlisted', false)], sourceFails: true })
    const second = deps(refused.amo)
    await expect(submitToAmo(options(), second.fake)).resolves.toMatchObject({ kind: 'signed' })
    expect(second.lines).toContainEqual(
      expect.stringMatching(/^warning Signed Firefox add-on: AMO's 1.2.3 has no source code/),
    )
  })

  it('fails when an unlisted version stays unsigned, so that a re-run can fetch it later', async () => {
    const amo = fakeAmo({ lookups: [version('unreviewed')] })
    const { fake, elapsed } = deps(amo.amo)
    await expect(submitToAmo(options(), fake)).rejects.toThrow(/hasn't signed 1.2.3 yet.*Re-run/)
    expect(elapsed()).toBeLessThanOrEqual(APPROVAL_TIMEOUT_MS)
    await expect(readdir(outDir)).rejects.toThrow()
  })

  it('fails when AMO rejected the version, in either job', async () => {
    for (const channel of ['unlisted', 'listed'] as const) {
      const amo = fakeAmo({ lookups: [version('disabled', channel)] })
      await expect(submitToAmo(options(channel), deps(amo.amo).fake)).rejects.toThrow(
        /AMO rejected or disabled 1.2.3/,
      )
    }
    const later = fakeAmo({ lookups: [version('unreviewed'), version('disabled')] })
    await expect(submitToAmo(options(), deps(later.amo).fake)).rejects.toThrow(/rejected/)
  })

  it('lets the release go without the XPI when the version waits in the listing review', async () => {
    const amo = fakeAmo({ lookups: [version('unreviewed', 'listed')] })
    const { fake, lines, elapsed } = deps(amo.amo)
    await expect(submitToAmo(options('unlisted'), fake)).resolves.toMatchObject({
      kind: 'submitted',
      channel: 'listed',
    })
    expect(elapsed()).toBe(0)
    expect(lines).toContainEqual(
      expect.stringMatching(/^warning Signed Firefox add-on: AMO has 1.2.3 in the listed channel/),
    )
  })

  it('attaches the file of a listed version that AMO already approved', async () => {
    const amo = fakeAmo({ lookups: [version('public', 'listed')] })
    const { fake } = deps(amo.amo)
    await expect(submitToAmo(options('unlisted'), fake)).resolves.toMatchObject({
      kind: 'signed',
      channel: 'listed',
    })
  })

  it("tells the listed job that a version AMO has unlisted can't be listed", async () => {
    const amo = fakeAmo({ lookups: [version('public', 'unlisted')] })
    const { fake, lines } = deps(amo.amo)
    await expect(submitToAmo(options('listed'), fake)).resolves.toMatchObject({
      kind: 'submitted',
      channel: 'unlisted',
    })
    expect(amo.calls).toEqual(['getVersion'])
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^warning Firefox Add-ons listing: AMO has 1.2.3 in the unlisted channel/,
      ),
    )
  })

  it('refuses a signed file that is not the zip', async () => {
    const other = new Map(files)
    other.set('background.js', encoder.encode('console.log("something else")'))
    const amo = fakeAmo({ lookups: [version('public')], download: signedXpi(other) })
    const { fake } = deps(amo.amo)
    await expect(submitToAmo(options(), fake)).rejects.toThrow(/background.js differs from the zip/)
    await expect(readdir(outDir)).rejects.toThrow()
  })

  it('refuses a zip of another version, the development build and the Chromium build', async () => {
    const amo = fakeAmo({})
    const { fake } = deps(amo.amo)
    await expect(submitToAmo({ ...options(), version: '1.2.4' }, fake)).rejects.toThrow(
      /zip holds version 1.2.3, not 1.2.4/,
    )
    await expect(submitToAmo({ ...options(), version: '1.2' }, fake)).rejects.toThrow(
      /not a release version/,
    )
    for (const [manifest, error] of [
      [buildManifest({ browser: 'firefox', version: VERSION, dev: true }), /development build/],
      [
        buildManifest({ browser: 'chromium', version: VERSION, dev: false }),
        /not the Firefox build/,
      ],
    ] as const) {
      const variant = new Map(files)
      variant.set('manifest.json', encoder.encode(JSON.stringify(manifest)))
      await writeFile(zipPath, releaseZip(variant))
      await expect(submitToAmo(options(), fake)).rejects.toThrow(error)
    }
    expect(amo.calls).toEqual([])
  })

  it('needs a folder for the signed file in the unlisted job', async () => {
    const { fake } = deps(fakeAmo({}).amo)
    await expect(submitToAmo({ ...options(), outDir: undefined }, fake)).rejects.toThrow(/--out/)
  })

  it('checks and packs in a dry run without contacting AMO', async () => {
    const { fake } = deps(null)
    await expect(submitToAmo({ ...options(), dryRun: true }, fake)).resolves.toEqual({
      kind: 'dry-run',
    })
    expect((await readdir(workDir)).sort()).toEqual(['amo-metadata.json', 'fxm-1.2.3-source.zip'])
    const metadata = JSON.parse(await readFile(join(workDir, 'amo-metadata.json'), 'utf8'))
    expect(metadata).toEqual(amoMetadata('unlisted', VERSION, 'abc1234'))
  })
})

describe('lintZip', () => {
  let root = ''
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  it("hands AMO's linter the zip's files in a scratch folder, and removes it afterwards", async () => {
    root = await mkdtemp(join(tmpdir(), 'fxm-lint-zip-'))
    const zipPath = join(root, 'fxm-connect-firefox-1.2.3.zip')
    await writeFile(
      zipPath,
      createZip([
        { name: 'manifest.json', data: encoder.encode('{}') },
        { name: 'icons/icon-16.png', data: new Uint8Array([1, 2]) },
      ]),
    )
    let seen = ''
    const report = await lintZip(zipPath, async (dir) => {
      seen = dir
      expect((await readdir(dir, { recursive: true })).sort()).toEqual([
        'icons',
        'icons/icon-16.png',
        'manifest.json',
      ])
      return { errors: [], warnings: ['W: something'], notices: [] }
    })
    expect(report.warnings).toEqual(['W: something'])
    await expect(readdir(seen)).rejects.toThrow()
  })
})
