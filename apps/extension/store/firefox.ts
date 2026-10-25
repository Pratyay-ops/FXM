/**
 * Signs FXM Connect for Firefox on Firefox Add-ons (AMO) in the release workflow
 * (.github/workflows/release.yml, job "firefox"):
 *
 *   firefox.ts plan
 *       decides from AMO_API_KEY, AMO_API_SECRET and AMO_CHANNEL whether to sign, and tells the
 *       owner when the secrets are missing; outputs sign and channel
 *   firefox.ts sign --version x.y.z --out <dir> [--source-dir <dir>] [--work <dir>] [--dry-run]
 *       signs the release build in apps/extension/dist/firefox (build it first) and writes
 *       <dir>/fxm-connect-firefox-<version>.xpi; outputs signed (and file)
 *
 * AMO_CHANNEL (a repository variable) picks the channel: `unlisted` (the default) signs for
 * self-distribution, `listed` submits the version to the public listing, `off` skips AMO.
 *
 * Signing runs `web-ext sign`, which uploads the build with the AMO metadata (listing.ts) and
 * the source archive, waits for the signature and downloads the signed file. AMO accepts each
 * version number once, in either channel, so `sign` first asks AMO whether it already has the
 * version: then it waits for and fetches that one, which makes a re-run of a failed release
 * safe. Before attaching anything it checks that the signed file is exactly the submitted build
 * plus Mozilla's signature (xpi.ts).
 *
 * A listed version can wait for a human review. If AMO hasn't signed it when the wait ends, the
 * release goes out without the XPI and Firefox users get the version from AMO once approved. An
 * unlisted version that isn't signed in time fails the job instead: re-running it later fetches
 * the file.
 *
 * How web-ext 10.7.0 signs (its lib/util/submit-addon.js, read 2026-10-26): it uploads a zip of
 * --source-dir, waits for validation, then PUTs the version to addons/addon/<guid>/ (which
 * creates the add-on the first time), uploads --upload-source-code, waits until the file's
 * status is `public` for either channel and downloads it into --artifacts-dir. It reads the
 * credentials from WEB_EXT_API_KEY and WEB_EXT_API_SECRET and leaves a `.amo-upload-uuid` file
 * in --source-dir.
 *
 * Node runs this file directly (type stripping), which is why the imports spell out `.ts`.
 */
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { EXTENSION_NAME } from '../src/config.ts'
import { FIREFOX_ADDON_ID, isExtensionVersion } from '../src/manifest.ts'
import { createReporter, parseOptions, type Reporter, requireOption, sleep } from './actions.ts'
import { AmoClient, type AmoCredentials, type AmoVersion, waitForReview } from './amo.ts'
import { type AmoChannel, amoMetadata } from './listing.ts'
import { checkSignedXpi, readBuild } from './xpi.ts'

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const REPO_ROOT = resolve(PACKAGE_DIR, '../..')

/** How long to wait for AMO's signature: unlisted versions are signed automatically, in minutes. */
export const APPROVAL_TIMEOUT_MS: Readonly<Record<AmoChannel, number>> = {
  unlisted: 20 * 60_000,
  listed: 10 * 60_000,
}
/** How long AMO's validation of an upload may take. */
export const VALIDATION_TIMEOUT_MS = 10 * 60_000

export type ChannelSetting = AmoChannel | 'off'

/** Reads AMO_CHANNEL: unset or empty means unlisted. Throws on anything unknown. */
export function channelSetting(value: string | undefined): ChannelSetting {
  const channel = (value ?? '').trim().toLowerCase()
  if (channel === '' || channel === 'unlisted') return 'unlisted'
  if (channel === 'listed' || channel === 'off') return channel
  throw new Error(`AMO_CHANNEL must be unlisted, listed or off, got "${value}"`)
}

export interface SigningPlan {
  channel: AmoChannel
  credentials: AmoCredentials
}

/** What to sign with, or null after telling the owner why this release has no signed XPI. */
export function planSigning(env: NodeJS.ProcessEnv, reporter: Reporter): SigningPlan | null {
  const channel = channelSetting(env.AMO_CHANNEL)
  const title = 'Firefox add-on'
  if (channel === 'off') {
    reporter.notice(title, 'AMO_CHANNEL is off, so this release has no signed Firefox add-on.')
    return null
  }
  const key = env.AMO_API_KEY?.trim() ?? ''
  const secret = env.AMO_API_SECRET?.trim() ?? ''
  if (!key && !secret) {
    reporter.notice(
      title,
      'AMO_API_KEY and AMO_API_SECRET are not set, so this release has no signed Firefox ' +
        'add-on (the unsigned Firefox zip is still attached). apps/extension/README.md ' +
        '("Store channels") says how to set them up.',
    )
    return null
  }
  if (!key || !secret) {
    reporter.warning(
      title,
      `${key ? 'AMO_API_SECRET' : 'AMO_API_KEY'} is not set, so this release has no signed ` +
        'Firefox add-on. Set both AMO_API_KEY and AMO_API_SECRET.',
    )
    return null
  }
  return { channel, credentials: { key, secret } }
}

/** What AMO's linter found, one line per message. */
export interface LintReport {
  errors: string[]
  warnings: string[]
  notices: string[]
}

export interface SignOptions {
  version: string
  channel: AmoChannel
  /** The release build for Firefox: apps/extension/dist/firefox. */
  sourceDir: string
  /** Where the signed XPI goes; the release uploads this folder as is. */
  outDir: string
  /** Scratch space: the metadata, the source archive and web-ext's download. */
  workDir: string
  commit?: string | undefined
  /** Check, lint and pack, but don't contact AMO. */
  dryRun?: boolean
  approvalTimeoutMs?: number
}

export interface SignDeps {
  /** Null in a dry run. */
  amo: Pick<AmoClient, 'getVersion' | 'download'> | null
  lint: (dir: string) => Promise<LintReport>
  archiveSource: (dest: string, version: string) => Promise<void>
  /** Runs `web-ext` with these arguments and resolves to its exit code. */
  runWebExt: (args: readonly string[]) => Promise<number>
  reporter: Reporter
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** How often to ask AMO about a version in review. */
  pollIntervalMs?: number
}

export type SignOutcome =
  | { signed: true; file: string; channel: string }
  | { signed: false; reason: 'dry-run' | 'in-review' }

/** The release file name, as fxm_release_catalog (scripts/release-lib.sh) lists it. */
export function xpiName(version: string): string {
  return `fxm-connect-firefox-${version}.xpi`
}

function readManifest(files: ReadonlyMap<string, Uint8Array>): Record<string, unknown> {
  const bytes = files.get('manifest.json')
  if (!bytes) throw new Error('the build has no manifest.json: run the extension build first')
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>
}

/** Throws unless the folder holds the release build of this version. */
function checkBuild(files: ReadonlyMap<string, Uint8Array>, version: string): void {
  const manifest = readManifest(files)
  const gecko = (manifest.browser_specific_settings as { gecko?: { id?: unknown } } | undefined)
    ?.gecko
  if (manifest.version !== version) {
    throw new Error(
      `the build is version ${String(manifest.version)}, not ${version}: build the release first`,
    )
  }
  if (gecko?.id !== FIREFOX_ADDON_ID) throw new Error('the build is not the Firefox build')
  const hosts = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : []
  if (
    manifest.name !== EXTENSION_NAME ||
    hosts.some((host) => String(host).includes('localhost'))
  ) {
    throw new Error('the build is the development build, which must never be signed')
  }
}

export async function signFirefox(options: SignOptions, deps: SignDeps): Promise<SignOutcome> {
  const { version, channel } = options
  const { reporter } = deps
  if (!/^\d+\.\d+\.\d+$/.test(version) || !isExtensionVersion(version)) {
    throw new Error(`not a release version: ${version}`)
  }
  const files = await readBuild(options.sourceDir)
  checkBuild(files, version)

  const lint = await deps.lint(options.sourceDir)
  const found = [...lint.errors, ...lint.warnings, ...lint.notices]
  if (found.length > 0) {
    throw new Error(`AMO's linter has findings, so AMO would too:\n${found.join('\n')}`)
  }
  reporter.info("AMO's linter (web-ext lint) found nothing.")

  await mkdir(options.workDir, { recursive: true })
  const metadataPath = join(options.workDir, 'amo-metadata.json')
  await writeFile(
    metadataPath,
    `${JSON.stringify(amoMetadata(channel, version, options.commit), null, 2)}\n`,
  )
  const sourcePath = join(options.workDir, `fxm-${version}-source.zip`)
  await deps.archiveSource(sourcePath, version)
  reporter.info(`Packed the source code for AMO's reviewers: ${sourcePath}`)

  if (options.dryRun || !deps.amo) {
    reporter.info(
      `Dry run: would sign ${version} on AMO (${channel}) with ${metadataPath} and ${sourcePath}.`,
    )
    return { signed: false, reason: 'dry-run' }
  }
  const amo = deps.amo
  const approvalTimeoutMs = options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS[channel]

  const deliver = async (bytes: Uint8Array, from: string): Promise<SignOutcome> => {
    checkSignedXpi(bytes, { id: FIREFOX_ADDON_ID, version, files })
    await mkdir(options.outDir, { recursive: true })
    const file = join(options.outDir, xpiName(version))
    await writeFile(file, bytes)
    reporter.info(`Checked the signed XPI against the build and saved it as ${file}`)
    return { signed: true, file, channel: from }
  }

  /**
   * Carries on with a version AMO already has: waits for its review (unless told not to), then
   * fetches the signed file, or gives up on a listed version still in review, or fails.
   */
  const settle = async (existing: AmoVersion, wait: boolean): Promise<SignOutcome> => {
    const reviewed = existing.status === 'public' || existing.status === 'disabled'
    const current =
      reviewed || !wait
        ? existing
        : await waitForReview(amo, FIREFOX_ADDON_ID, version, {
            timeoutMs: approvalTimeoutMs,
            ...(deps.pollIntervalMs !== undefined ? { intervalMs: deps.pollIntervalMs } : {}),
            ...(deps.sleep ? { sleep: deps.sleep } : {}),
            ...(deps.now ? { now: deps.now } : {}),
            onWait: () => reporter.info(`AMO is still reviewing ${version}…`),
          })
    const where = existing.editUrl ? ` (${existing.editUrl})` : ''
    if (!current) throw new Error(`AMO no longer lists ${version}${where}`)
    if (current.status === 'public') {
      if (!current.fileUrl) throw new Error(`AMO lists ${version} as signed but has no file URL`)
      return deliver(await amo.download(current.fileUrl), current.channel)
    }
    if (current.status === 'disabled') {
      throw new Error(
        `AMO rejected or disabled ${version}${where}. Its email to the add-on's owner says why; ` +
          'fix it in a new version.',
      )
    }
    if (current.channel === 'listed') {
      reporter.warning(
        'Firefox add-on',
        `AMO is reviewing ${version} for the listing${where}, so this release goes out without ` +
          'the signed XPI. Firefox users get the version from AMO once it is approved.',
      )
      return { signed: false, reason: 'in-review' }
    }
    throw new Error(
      `AMO hasn't signed ${version} yet${where}. Re-run this job later: it fetches the file once ` +
        'AMO has signed it.',
    )
  }

  const existing = await amo.getVersion(FIREFOX_ADDON_ID, version)
  if (existing) {
    reporter.info(
      `AMO already has ${version} (${existing.channel}, ${existing.status}): fetching it instead ` +
        'of submitting it again.',
    )
    if (existing.channel !== channel) {
      reporter.warning(
        'Firefox add-on',
        `AMO has ${version} in the ${existing.channel} channel, not ${channel}. A version number ` +
          'can be used once, so this release uses that one.',
      )
    }
    return settle(existing, true)
  }

  const signedDir = join(options.workDir, 'signed')
  const code = await deps.runWebExt([
    'sign',
    '--source-dir',
    options.sourceDir,
    '--artifacts-dir',
    signedDir,
    '--channel',
    channel,
    '--amo-metadata',
    metadataPath,
    '--upload-source-code',
    sourcePath,
    '--approval-timeout',
    String(approvalTimeoutMs),
    '--timeout',
    String(VALIDATION_TIMEOUT_MS),
    '--no-config-discovery',
    '--no-input',
  ])
  if (code === 0) {
    const xpis = (await readdir(signedDir).catch(() => [])).filter((name) => name.endsWith('.xpi'))
    if (xpis.length !== 1) {
      throw new Error(`web-ext sign left ${xpis.length} XPI files in ${signedDir}, expected one`)
    }
    return deliver(await readFile(join(signedDir, xpis[0] ?? '')), channel)
  }
  // web-ext failed. If AMO took the version anyway (web-ext gave up waiting for the review, say),
  // carry on with that version, without waiting a second time.
  const after = await amo.getVersion(FIREFOX_ADDON_ID, version)
  if (!after) {
    throw new Error(`web-ext sign failed (exit code ${code}) and AMO has no ${version}: see above`)
  }
  return settle(after, false)
}

/** AMO's linter, as `web-ext lint` runs it and as AMO runs it on every upload. */
export async function lintWithAmo(dir: string): Promise<LintReport> {
  const { cmd } = await import('web-ext')
  const result = await cmd.lint(
    {
      sourceDir: dir,
      artifactsDir: join(tmpdir(), 'fxm-web-ext-lint'),
      ignoreFiles: [],
      output: 'none',
      boring: true,
      pretty: false,
      metadata: false,
      privileged: false,
      selfHosted: false,
      enterprise: false,
      verbose: false,
      warningsAsErrors: false,
    },
    { shouldExitProgram: false },
  )
  const line = (message: { code: string; message: string; file?: string }) =>
    `${message.code}: ${message.message}${message.file ? ` (${message.file})` : ''}`
  return {
    errors: result.errors.map(line),
    warnings: result.warnings.map(line),
    notices: result.notices.map(line),
  }
}

const run = promisify(execFile)

/** The repository at HEAD as a zip, for AMO's reviewers (git archive). */
export async function archiveSource(dest: string, version: string, reporter?: Reporter) {
  const { stdout } = await run('git', ['status', '--porcelain'], { cwd: REPO_ROOT })
  if (stdout.trim() && reporter) {
    reporter.warning(
      'Firefox add-on',
      'The source archive holds the last commit, without the uncommitted changes in this checkout.',
    )
  }
  await run('git', ['archive', '--format=zip', `--prefix=fxm-${version}/`, '-o', dest, 'HEAD'], {
    cwd: REPO_ROOT,
  })
}

/** Runs the web-ext command line of this package with the AMO credentials in its environment. */
export function webExtRunner(credentials: AmoCredentials) {
  const bin = join(dirname(fileURLToPath(import.meta.resolve('web-ext'))), 'bin', 'web-ext.js')
  return (args: readonly string[]): Promise<number> =>
    new Promise((resolveCode, reject) => {
      const child = spawn(process.execPath, [bin, ...args], {
        cwd: PACKAGE_DIR,
        stdio: 'inherit',
        // Through the environment, never the command line, which ends up in logs.
        env: {
          ...process.env,
          WEB_EXT_API_KEY: credentials.key,
          WEB_EXT_API_SECRET: credentials.secret,
        },
      })
      child.on('error', reject)
      child.on('close', (code) => resolveCode(code ?? 1))
    })
}

async function main(args: readonly string[], reporter: Reporter): Promise<void> {
  const [command, ...rest] = args
  if (command === 'plan') {
    const plan = planSigning(process.env, reporter)
    reporter.output('sign', String(plan !== null))
    reporter.output('channel', plan?.channel ?? 'none')
    return
  }
  if (command !== 'sign') {
    throw new Error('usage: firefox.ts plan | sign --version x.y.z --out <dir> [--dry-run]')
  }
  const options = parseOptions(rest)
  const dryRun = options.get('dry-run') === 'true'
  const base = process.env.INIT_CWD ?? process.cwd()
  const version = requireOption(options, 'version')
  let plan: SigningPlan | null
  if (dryRun) {
    const channel = channelSetting(process.env.AMO_CHANNEL)
    plan = {
      channel: channel === 'off' ? 'unlisted' : channel,
      credentials: { key: '', secret: '' },
    }
  } else {
    plan = planSigning(process.env, reporter)
    if (!plan) throw new Error('nothing to sign with')
  }
  const outcome = await signFirefox(
    {
      version,
      channel: plan.channel,
      sourceDir: resolve(base, options.get('source-dir') ?? join(PACKAGE_DIR, 'dist/firefox')),
      outDir: resolve(base, requireOption(options, 'out')),
      workDir: resolve(
        base,
        options.get('work') ?? (await mkdtemp(join(tmpdir(), 'fxm-firefox-sign-'))),
      ),
      commit: process.env.GITHUB_SHA,
      dryRun,
    },
    {
      amo: dryRun ? null : new AmoClient({ credentials: plan.credentials }),
      lint: lintWithAmo,
      archiveSource: (dest, v) => archiveSource(dest, v, reporter),
      runWebExt: webExtRunner(plan.credentials),
      reporter,
      sleep,
    },
  )
  reporter.output('signed', String(outcome.signed))
  if (outcome.signed) {
    reporter.output('file', outcome.file)
    reporter.summary(
      `**Firefox add-on:** signed FXM Connect ${version} on AMO (${outcome.channel}); the release ` +
        `attaches \`${xpiName(version)}\`.`,
    )
  } else if (outcome.reason === 'in-review') {
    reporter.summary(
      `**Firefox add-on:** AMO is reviewing FXM Connect ${version} for the listing; this release ` +
        'has no signed XPI.',
    )
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reporter = createReporter()
  main(process.argv.slice(2), reporter).catch((error: unknown) => {
    reporter.error('Firefox add-on', error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
