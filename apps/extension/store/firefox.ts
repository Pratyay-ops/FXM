/**
 * FXM Connect on Firefox Add-ons (AMO), in the release workflow (.github/workflows/release.yml):
 *
 *   firefox.ts lint --zip <file>
 *       job "bundles": AMO's linter (web-ext lint) on the files of the release's Firefox zip,
 *       with no store key around; outputs result (clean or findings) for the jobs below
 *   firefox.ts plan --channel <unlisted|listed>
 *       jobs "firefox" (unlisted) and "firefox-listed" (listed): decides from AMO_CHANNEL,
 *       AMO_API_KEY_SET, AMO_API_SECRET_SET and FIREFOX_LINT whether this job submits to AMO,
 *       and tells the owner why not; outputs submit
 *   firefox.ts submit --channel <unlisted|listed> --version x.y.z --zip <file> [--out <dir>]
 *                     [--work <dir>] [--dry-run]
 *       unlisted: has AMO sign the zip and writes <out>/fxm-connect-firefox-<version>.xpi;
 *       listed: submits the zip to the public listing. Outputs signed (and file).
 *
 * AMO_CHANNEL (a repository variable) picks the channel. `unlisted`, the default, signs each
 * release for self-distribution before it is published, and the release attaches the signed
 * XPI. `listed` submits each release to the public listing after it is published, so that AMO
 * never gets a version that GitHub doesn't have, and attaches no XPI. `off` leaves AMO alone.
 *
 * `submit` uploads the zip exactly as the bundles job built it (the release attaches and attests
 * the same file), creates the version with the metadata from listing.ts and attaches the source
 * code (git archive of the release commit). For the unlisted channel it then waits for the
 * signature and checks that the signed file holds the zip's files and Mozilla's signature, and
 * nothing else (xpi.ts). AMO accepts each version number once, in either channel, so `submit`
 * first asks AMO whether it has the version already and then carries on with that one: re-running
 * a failed release is safe.
 *
 * The AMO keys reach only `submit`, through its environment. It runs on Node alone, and the jobs
 * that hold the keys install nothing, so no third-party code ever sees them (amo.ts).
 *
 * Node runs this file directly (type stripping), which is why the imports spell out `.ts`.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { EXTENSION_NAME } from '../src/config.ts'
import { FIREFOX_ADDON_ID, isExtensionVersion } from '../src/manifest.ts'
import {
  createReporter,
  isSecretSet,
  parseOptions,
  type Reporter,
  requireOption,
  sleep,
} from './actions.ts'
import {
  AmoClient,
  type AmoCredentials,
  type AmoVersion,
  waitForReview,
  waitForValidation,
} from './amo.ts'
import { type AmoChannel, amoMetadata } from './listing.ts'
import { checkSignedXpi, writeFiles, zipFiles } from './xpi.ts'

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const REPO_ROOT = resolve(PACKAGE_DIR, '../..')

/** How long to wait for AMO to sign an unlisted version: it signs them automatically, in minutes. */
export const APPROVAL_TIMEOUT_MS = 20 * 60_000
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

/** The channel a job handles, from its --channel option. */
export function jobChannel(value: string): AmoChannel {
  if (value === 'unlisted' || value === 'listed') return value
  throw new Error(`--channel must be unlisted or listed, got "${value}"`)
}

/** The job's title in annotations, as release.yml names the job. */
export const JOB_TITLE: Readonly<Record<AmoChannel, string>> = {
  unlisted: 'Signed Firefox add-on',
  listed: 'Firefox Add-ons listing',
}

/**
 * Whether the job for this channel submits to AMO, after telling the owner why not. The job runs
 * with booleans for the keys (AMO_API_KEY_SET, AMO_API_SECRET_SET), never their values. Throws,
 * failing the job, when it would submit but AMO's linter didn't pass the zip.
 */
export function planChannel(job: AmoChannel, env: NodeJS.ProcessEnv, reporter: Reporter): boolean {
  const setting = channelSetting(env.AMO_CHANNEL)
  const title = JOB_TITLE[job]
  if (setting !== job) {
    if (job === 'listed') {
      reporter.info(
        setting === 'off'
          ? 'AMO_CHANNEL is off: nothing to submit.'
          : `AMO_CHANNEL is unlisted, so the ${JOB_TITLE.unlisted} job handles AMO.`,
      )
    } else if (setting === 'off') {
      reporter.notice(
        title,
        "AMO_CHANNEL is off, so this release has no signed Firefox add-on and isn't submitted " +
          'to Firefox Add-ons.',
      )
    } else {
      reporter.notice(
        title,
        'AMO_CHANNEL is listed, so this release has no signed XPI: once the release is ' +
          `published, the ${JOB_TITLE.listed} job submits it to the public listing.`,
      )
    }
    return false
  }
  const key = isSecretSet(env, 'AMO_API_KEY')
  const secret = isSecretSet(env, 'AMO_API_SECRET')
  const without =
    job === 'unlisted'
      ? 'this release has no signed Firefox add-on (the unsigned Firefox zip is still attached)'
      : "this release isn't submitted to the Firefox Add-ons listing"
  if (!key && !secret) {
    reporter.notice(
      title,
      `AMO_API_KEY and AMO_API_SECRET are not set in the stores environment, so ${without}. ` +
        'apps/extension/README.md ("Store channels") says how to set them up.',
    )
    return false
  }
  if (!key || !secret) {
    reporter.warning(
      title,
      `${key ? 'AMO_API_SECRET' : 'AMO_API_KEY'} is not set in the stores environment, so ` +
        `${without}. Set both AMO_API_KEY and AMO_API_SECRET.`,
    )
    return false
  }
  if (env.FIREFOX_LINT !== 'clean') {
    throw new Error(
      env.FIREFOX_LINT === 'findings'
        ? "AMO's linter has findings on this release's Firefox zip (see the warnings of the " +
            'bundles job), and AMO would flag or refuse the same. Fix them in a new version.'
        : "AMO's linter didn't report on this release's Firefox zip, so it isn't submitted.",
    )
  }
  return true
}

/** The AMO keys from the environment of the submit step. */
export function credentialsFrom(env: NodeJS.ProcessEnv): AmoCredentials {
  const key = env.AMO_API_KEY?.trim() ?? ''
  const secret = env.AMO_API_SECRET?.trim() ?? ''
  if (!key || !secret) throw new Error('AMO_API_KEY and AMO_API_SECRET must both be set')
  return { key, secret }
}

/** What AMO's linter found, one line per message. */
export interface LintReport {
  errors: string[]
  warnings: string[]
  notices: string[]
}

/** The release file names, as fxm_release_catalog (scripts/release-lib.sh) lists them. */
export function xpiName(version: string): string {
  return `fxm-connect-firefox-${version}.xpi`
}

export function zipName(version: string): string {
  return `fxm-connect-firefox-${version}.zip`
}

function readManifest(files: ReadonlyMap<string, Uint8Array>): Record<string, unknown> {
  const bytes = files.get('manifest.json')
  if (!bytes) throw new Error('the zip has no manifest.json at its top')
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>
}

/** Throws unless the files are the Firefox release build of this version. */
export function checkBuild(files: ReadonlyMap<string, Uint8Array>, version: string): void {
  const manifest = readManifest(files)
  const gecko = (manifest.browser_specific_settings as { gecko?: { id?: unknown } } | undefined)
    ?.gecko
  if (manifest.version !== version) {
    throw new Error(`the zip holds version ${String(manifest.version)}, not ${version}`)
  }
  if (gecko?.id !== FIREFOX_ADDON_ID) throw new Error('the zip is not the Firefox build')
  const hosts = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : []
  if (
    manifest.name !== EXTENSION_NAME ||
    hosts.some((host) => String(host).includes('localhost'))
  ) {
    throw new Error('the zip is the development build, which must never go to AMO')
  }
}

export interface SubmitOptions {
  version: string
  /** The channel this job handles. */
  channel: AmoChannel
  /** The release's Firefox zip, as the bundles job built it. */
  zipPath: string
  /** Where the signed XPI goes (unlisted only); the release uploads this folder as is. */
  outDir?: string | undefined
  /** Scratch space: the metadata and the source archive. */
  workDir: string
  commit?: string | undefined
  /** Check and pack, but don't contact AMO. */
  dryRun?: boolean
  approvalTimeoutMs?: number
  validationTimeoutMs?: number
}

export type AmoApi = Pick<
  AmoClient,
  'getVersion' | 'upload' | 'uploadStatus' | 'submitVersion' | 'uploadSource' | 'download'
>

export interface SubmitDeps {
  /** Null in a dry run. */
  amo: AmoApi | null
  archiveSource: (dest: string, version: string) => Promise<void>
  reporter: Reporter
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** How often to ask AMO about an upload or a version in review. */
  pollIntervalMs?: number
}

export type SubmitOutcome =
  /** AMO signed the version; the release attaches the file. */
  | { kind: 'signed'; file: string; channel: string }
  /** AMO has the version for its listing; Firefox users get it from AMO once approved. */
  | { kind: 'submitted'; channel: string; status: string; editUrl: string | null }
  | { kind: 'dry-run' }

export async function submitToAmo(
  options: SubmitOptions,
  deps: SubmitDeps,
): Promise<SubmitOutcome> {
  const { version, channel } = options
  const { reporter } = deps
  if (!/^\d+\.\d+\.\d+$/.test(version) || !isExtensionVersion(version)) {
    throw new Error(`not a release version: ${version}`)
  }
  if (channel === 'unlisted' && !options.outDir) {
    throw new Error('the unlisted channel needs --out <dir> for the signed XPI')
  }
  const zip = await readFile(options.zipPath)
  const files = zipFiles(zip)
  checkBuild(files, version)

  await mkdir(options.workDir, { recursive: true })
  const metadata = amoMetadata(channel, version, options.commit)
  const metadataPath = join(options.workDir, 'amo-metadata.json')
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
  const sourceName = `fxm-${version}-source.zip`
  const sourcePath = join(options.workDir, sourceName)
  await deps.archiveSource(sourcePath, version)
  reporter.info(`Packed the source code for AMO's reviewers: ${sourcePath}`)

  if (options.dryRun || !deps.amo) {
    reporter.info(
      `Dry run: would submit ${basename(options.zipPath)} to AMO (${channel}) with ` +
        `${metadataPath} and ${sourcePath}.`,
    )
    return { kind: 'dry-run' }
  }
  const amo = deps.amo
  const source = await readFile(sourcePath)
  const waiting = {
    ...(deps.pollIntervalMs !== undefined ? { intervalMs: deps.pollIntervalMs } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  }
  const where = (found: AmoVersion) => (found.editUrl ? ` (${found.editUrl})` : '')
  const rejected = (found: AmoVersion) =>
    new Error(
      `AMO rejected or disabled ${version}${where(found)}. Its email to the add-on's owner says ` +
        'why; fix it in a new version.',
    )

  let current = await amo.getVersion(FIREFOX_ADDON_ID, version)
  if (current) {
    reporter.info(
      `AMO already has ${version} (${current.channel}, ${current.status}): carrying on with it ` +
        'instead of submitting it again.',
    )
    if (current.channel !== channel) {
      reporter.warning(
        JOB_TITLE[channel],
        `AMO has ${version} in the ${current.channel} channel, not ${channel}. A version number ` +
          'can be used once, so this release keeps that one.',
      )
    }
    if (current.hasSource === false) {
      // A run that failed right after creating the version: attach the source code now.
      try {
        await amo.uploadSource(FIREFOX_ADDON_ID, current.id, source, sourceName)
        reporter.info("Attached the source code for AMO's reviewers.")
      } catch (error) {
        reporter.warning(
          JOB_TITLE[channel],
          `AMO's ${version} has no source code and taking it failed ` +
            `(${error instanceof Error ? error.message : String(error)}). Upload ` +
            `${sourceName} in AMO's Developer Hub${where(current)}.`,
        )
      }
    }
  } else {
    const uuid = await amo.upload(zip, zipName(version), channel)
    reporter.info(`Uploaded ${zipName(version)}; AMO's validator is checking it (${uuid}).`)
    const upload = await waitForValidation(amo, uuid, {
      timeoutMs: options.validationTimeoutMs ?? VALIDATION_TIMEOUT_MS,
      ...waiting,
    })
    if (!upload.processed) {
      throw new Error(`AMO's validator hasn't finished with ${uuid}. Re-run this job later.`)
    }
    if (!upload.valid) {
      throw new Error(
        `AMO's validator refused ${zipName(version)}:\n${upload.errors.join('\n') || '(no details)'}`,
      )
    }
    current = await amo.submitVersion(FIREFOX_ADDON_ID, uuid, metadata)
    reporter.info(`AMO created ${version} (${current.channel})${where(current)}.`)
    await amo.uploadSource(FIREFOX_ADDON_ID, current.id, source, sourceName)
    reporter.info("Attached the source code for AMO's reviewers.")
  }

  if (current.status === 'disabled') throw rejected(current)
  const submitted: SubmitOutcome = {
    kind: 'submitted',
    channel: current.channel,
    status: current.status,
    editUrl: current.editUrl,
  }
  // The listed job runs after the release is published, which can't attach a file any more.
  if (channel === 'listed') return submitted
  // A listed version can wait days for a reviewer: the release goes out without it.
  if (current.channel === 'listed' && current.status !== 'public') return submitted

  const reviewed =
    current.status === 'public'
      ? current
      : await waitForReview(amo, FIREFOX_ADDON_ID, version, {
          timeoutMs: options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS,
          ...waiting,
          onWait: () => reporter.info(`AMO is still signing ${version}…`),
        })
  if (!reviewed) throw new Error(`AMO no longer lists ${version}${where(current)}`)
  if (reviewed.status === 'disabled') throw rejected(reviewed)
  if (reviewed.status !== 'public') {
    throw new Error(
      `AMO hasn't signed ${version} yet${where(reviewed)}. Re-run this job later: it fetches the ` +
        'file once AMO has signed it.',
    )
  }
  if (!reviewed.fileUrl) throw new Error(`AMO lists ${version} as signed but has no file URL`)
  const signed = await amo.download(reviewed.fileUrl)
  checkSignedXpi(signed, { id: FIREFOX_ADDON_ID, version, files })
  const outDir = options.outDir ?? ''
  await mkdir(outDir, { recursive: true })
  const file = join(outDir, xpiName(version))
  await writeFile(file, signed)
  reporter.info(`Checked the signed XPI against the zip and saved it as ${file}`)
  return { kind: 'signed', file, channel: reviewed.channel }
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

/** AMO's linter on the files of a zip, unpacked into a scratch folder. */
export async function lintZip(
  zipPath: string,
  lint: (dir: string) => Promise<LintReport> = lintWithAmo,
): Promise<LintReport> {
  const files = zipFiles(await readFile(zipPath))
  const dir = await mkdtemp(join(tmpdir(), 'fxm-amo-lint-'))
  try {
    await writeFiles(dir, files)
    return await lint(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
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

const USAGE =
  'usage: firefox.ts lint --zip <file> | plan --channel <unlisted|listed> | submit --channel ' +
  '<unlisted|listed> --version x.y.z --zip <file> [--out <dir>] [--work <dir>] [--dry-run]'

async function main(args: readonly string[], reporter: Reporter): Promise<void> {
  const [command, ...rest] = args
  const options = parseOptions(rest)
  // Relative to where the command was started, not to the package folder pnpm runs it in.
  const base = process.env.INIT_CWD ?? process.cwd()
  if (command === 'lint') {
    const zipPath = resolve(base, requireOption(options, 'zip'))
    const report = await lintZip(zipPath)
    const found = [...report.errors, ...report.warnings, ...report.notices]
    if (found.length > 0) {
      reporter.warning(
        "AMO's linter",
        `web-ext lint has ${found.length} finding(s) on ${basename(zipPath)}, so the Firefox ` +
          `jobs won't submit it to AMO:\n${found.join('\n')}`,
      )
      reporter.output('result', 'findings')
    } else {
      reporter.info(`AMO's linter (web-ext lint) found nothing in ${basename(zipPath)}.`)
      reporter.output('result', 'clean')
    }
    return
  }
  if (command === 'plan') {
    const submit = planChannel(jobChannel(requireOption(options, 'channel')), process.env, reporter)
    reporter.output('submit', String(submit))
    return
  }
  if (command !== 'submit') throw new Error(USAGE)
  const channel = jobChannel(requireOption(options, 'channel'))
  const dryRun = options.get('dry-run') === 'true'
  const version = requireOption(options, 'version')
  const out = options.get('out')
  const outcome = await submitToAmo(
    {
      version,
      channel,
      zipPath: resolve(base, requireOption(options, 'zip')),
      outDir: out ? resolve(base, out) : undefined,
      workDir: resolve(
        base,
        options.get('work') ?? (await mkdtemp(join(tmpdir(), 'fxm-firefox-submit-'))),
      ),
      commit: process.env.GITHUB_SHA,
      dryRun,
    },
    {
      amo: dryRun ? null : new AmoClient({ credentials: credentialsFrom(process.env) }),
      archiveSource: (dest, v) => archiveSource(dest, v, reporter),
      reporter,
      sleep,
    },
  )
  reporter.output('signed', String(outcome.kind === 'signed'))
  if (outcome.kind === 'signed') {
    reporter.output('file', outcome.file)
    reporter.summary(
      `**Firefox add-on:** AMO signed FXM Connect ${version} (${outcome.channel}); the release ` +
        `attaches \`${xpiName(version)}\`.`,
    )
  } else if (outcome.kind === 'submitted') {
    const page = outcome.editUrl ? ` ([Developer Hub](${outcome.editUrl}))` : ''
    if (outcome.channel !== 'listed') {
      // Already warned: the version is unlisted, so the listing gets the next one.
      reporter.summary(
        `**Firefox Add-ons:** AMO has FXM Connect ${version} in the ${outcome.channel} ` +
          `channel, so it can't be listed${page}.`,
      )
      return
    }
    const message =
      outcome.status === 'public'
        ? `AMO has approved FXM Connect ${version} for its listing`
        : `AMO is reviewing FXM Connect ${version} for its listing`
    reporter.notice(
      JOB_TITLE[channel],
      `${message}. Firefox users get it from addons.mozilla.org once it is approved; this ` +
        'release attaches no signed XPI.',
    )
    reporter.summary(`**Firefox Add-ons:** ${message}${page}.`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reporter = createReporter()
  main(process.argv.slice(2), reporter).catch((error: unknown) => {
    reporter.error('Firefox add-on', error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
