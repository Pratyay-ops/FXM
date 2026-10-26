/**
 * The desktop app's release steps, in `.github/workflows/desktop-release.yml`:
 *
 *   release.ts check --mode <release|dry-run> [--version x.y.z]
 *       job "check": the version to build, from apps/desktop/package.json, which must equal
 *       --version when it is given. For a release, the updater's public key in tauri.conf.json
 *       must be a real key: while it is the placeholder, every release stops here. Outputs
 *       version.
 *   release.ts build-key --out <dir> [--dry-run]
 *       each build job: a throwaway key pair for the signatures that `tauri build` makes of the
 *       updater's files, which nothing uses (the sign job signs the files again). The updater key
 *       never reaches a build job, which runs the code of hundreds of crates and packages. A dry
 *       run also gives the apps the throwaway public key (`--config`), since the placeholder can't
 *       build with updater files. Outputs key (the secret key's path) and config-args.
 *   release.ts collect --target <id> --version x.y.z --bundle-dir <dir> --out <dir>
 *       each build job: copies the target's files (targets.ts) into <out> under their release
 *       names. With ARTIFACT_PATHS (tauri-action's artifactPaths output) it also checks that
 *       tauri-action reported each of them.
 *   release.ts sign --version x.y.z --artifacts <dir> --out <dir> --repo owner/name
 *                   [--throwaway-key]
 *       job "sign": gathers the build jobs' files (one folder per artifact, desktop-<target>),
 *       signs the ones the updater installs with the updater key (TAURI_SIGNING_PRIVATE_KEY and
 *       TAURI_SIGNING_PRIVATE_KEY_PASSWORD), writes latest.json and checks it as each platform's
 *       updater will. The key must be the one whose public key tauri.conf.json holds, which the
 *       release's apps carry. A dry run signs with a throwaway key instead (--throwaway-key).
 *
 * Windows code signing (stage 7.6), in five jobs that keep the certificate's key away from the
 * build's code (windows-signing.ts explains them):
 *
 *   release.ts windows-hook-config --mode <collect|swap> --dir <dir> --out <dir>
 *       jobs windows-build (collect) and windows-bundle (swap): the Tauri config that hooks
 *       Tauri's signing to `windows-hook`, with <dir> as its folder. Outputs config-args.
 *   release.ts windows-hook --mode <collect|swap> --dir <dir> --file <path>
 *       run by Tauri's signing, for each file it would sign: collects fxm.exe and the NSIS
 *       plugins, or puts their signed copies in their place. Signs nothing.
 *   release.ts windows-collected --dir <dir>
 *       job windows-build: checks what the hook collected, as windows-sign-app will.
 *   release.ts windows-signing --mode <release|dry-run> [--certificate yes]
 *       job windows-sign-app: how to sign, given whether the windows-signing environment holds a
 *       certificate: `throwaway` for a dry run, `certificate` or `none` for a release. Outputs
 *       signing.
 *   release.ts windows-sign --phase app --dir <dir> --out <dir> --thumbprint <sha1>
 *                           [--timestamp-url <url>]
 *       job windows-sign-app: checks the collected files and signs copies of them in <out>.
 *   release.ts windows-swapped --dir <dir>
 *       job windows-bundle: checks that every signed file went into the installers.
 *   release.ts windows-sign --phase installers --dir <dir> --version x.y.z --thumbprint <sha1>
 *                           [--timestamp-url <url>]
 *       job windows-sign-installers: checks the two installers in <dir> and signs them there.
 *   release.ts windows-signatures --signing <how> [--thumbprint <sha1>] [--app-thumbprint <sha1>]
 *                                 --report <file>
 *       job windows-check: checks the signatures that PowerShell read from the installers and the
 *       files inside them (Get-AuthenticodeSignature, as JSON): the installers signed by
 *       --thumbprint, fxm.exe and the plugins by --app-thumbprint, each timestamped, or nothing
 *       signed at all for `none`.
 *
 * The sign job installs nothing: it runs Node and this repository's own files, so no third-party
 * code ever sees the updater key (`minisign.ts` signs with Node's crypto). The Windows signing
 * jobs run the same, PowerShell and the Windows SDK's signtool.
 *
 * Node runs this file directly (type stripping), which is why the imports spell out `.ts`.
 *
 * @module
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReporter, parseOptions, type Reporter, requireOption } from './actions.ts'
import { buildManifest, checkManifest, type Manifest } from './manifest.ts'
import {
  decodePublicKey,
  decodeSecretKey,
  generateKeyPair,
  keyIdHex,
  type PublicKey,
  samePublicKey,
  sign,
  trustedComment,
} from './minisign.ts'
import { MANIFEST_NAME, type ReleaseTarget, TARGETS, targetById } from './targets.ts'
import {
  checkWindowsSignatures,
  chooseWindowsSigning,
  collectedProblems,
  parseHookMode,
  parseSignatureReport,
  parseWindowsSigning,
  readCollected,
  runHook,
  signApp,
  signInstallers,
  swapProblems,
  type WindowsSignOptions,
  writeHookConfig,
} from './windows-signing.ts'

/** apps/desktop. */
export const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const TAURI_CONFIG = join(APP_DIR, 'src-tauri', 'tauri.conf.json')
const PACKAGE_JSON = join(APP_DIR, 'package.json')

/** Where apps/desktop/README.md explains the updater key. */
const KEY_HELP = 'apps/desktop/README.md, "Updates"'

/** Whether a version is a release version: x.y.z, numbers up to 65535 (scripts/release-lib.sh). */
export function isReleaseVersion(version: string): boolean {
  const match = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.exec(version)
  return match?.slice(1).every((part) => Number(part) <= 65535) ?? false
}

/** The version in a package.json. */
export function readAppVersion(path = PACKAGE_JSON): string {
  const version = (JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }).version
  if (typeof version !== 'string') throw new Error(`${path} has no version`)
  return version
}

/** The updater's public key in a tauri.conf.json, as the apps carry it. */
export function readUpdaterPubkey(path = TAURI_CONFIG): string {
  const config = JSON.parse(readFileSync(path, 'utf8')) as {
    plugins?: { updater?: { pubkey?: unknown } }
  }
  const pubkey = config.plugins?.updater?.pubkey
  if (typeof pubkey !== 'string') throw new Error(`${path} has no plugins > updater > pubkey`)
  return pubkey
}

/** The updater's public key, or why a release can't use it. */
export function releaseKey(pubkey: string): PublicKey {
  try {
    return decodePublicKey(pubkey)
  } catch {
    throw new Error(
      'The updater public key in apps/desktop/src-tauri/tauri.conf.json is still the ' +
        `placeholder, or not a key: make the key pair and commit its public key (${KEY_HELP}). ` +
        'Releases stop until then, so no app ships that could never verify an update.',
    )
  }
}

export type Mode = 'release' | 'dry-run'

/** The mode from --mode. */
export function parseMode(value: string): Mode {
  if (value === 'release' || value === 'dry-run') return value
  throw new Error(`--mode must be release or dry-run, got "${value}"`)
}

export interface CheckOptions {
  readonly mode: Mode
  /** The version the release workflow builds, or empty to take the app's. */
  readonly version: string
  /** apps/desktop/package.json's version. */
  readonly appVersion: string
  /** tauri.conf.json's updater public key. */
  readonly pubkey: string
}

/** The version to build, after the checks of `check`. Throws when the build must not go on. */
export function checkRelease(
  { mode, version, appVersion, pubkey }: CheckOptions,
  reporter: Reporter,
) {
  if (version !== '' && version !== appVersion) {
    throw new Error(`apps/desktop/package.json has version ${appVersion}, not ${version}`)
  }
  if (!isReleaseVersion(appVersion)) {
    throw new Error(`${appVersion} is not a release version (x.y.z, numbers up to 65535)`)
  }
  if (mode === 'release') {
    const key = releaseKey(pubkey)
    reporter.info(`The apps carry updater key ${keyIdHex(key.keyId)}.`)
  } else {
    reporter.notice(
      'Desktop release dry run',
      'This run builds and signs with a throwaway key, and publishes nothing: no release, no tag.',
    )
  }
  return appVersion
}

/** Writes a throwaway key pair for `tauri build` (`build-key`). */
export function writeBuildKey(out: string, dryRun: boolean) {
  mkdirSync(out, { recursive: true })
  const pair = generateKeyPair('')
  const key = join(resolve(out), 'build.key')
  writeFileSync(key, pair.secretKey, { mode: 0o600 })
  writeFileSync(`${key}.pub`, pair.publicKey)
  if (!dryRun) return { key, configArgs: '' }
  const config = join(resolve(out), 'dry-run.conf.json')
  writeFileSync(config, `${JSON.stringify({ plugins: { updater: { pubkey: pair.publicKey } } })}\n`)
  return { key, configArgs: `--config ${config}` }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export interface CollectOptions {
  readonly target: ReleaseTarget
  readonly version: string
  readonly bundleDir: string
  readonly out: string
  /** tauri-action's artifactPaths: the files it found, if given. */
  readonly artifactPaths?: readonly string[] | undefined
}

/** Copies a target's files into `out` under their release names (`collect`). */
export function collectTarget({ target, version, bundleDir, out, artifactPaths }: CollectOptions) {
  const reported = artifactPaths && new Set(artifactPaths.map((path) => resolve(path)))
  mkdirSync(out, { recursive: true })
  return target.files(version).map((file) => {
    const source = resolve(bundleDir, file.source)
    if (!existsSync(source) || !lstatSync(source).isFile()) {
      throw new Error(`${target.id}: the build made no ${file.source}`)
    }
    if (reported && !reported.has(source)) {
      throw new Error(`${target.id}: tauri-action didn't report ${file.source}`)
    }
    copyFileSync(source, join(out, file.name))
    const bytes = readFileSync(source)
    return { name: file.name, size: bytes.length, sha256: sha256(bytes) }
  })
}

/** The key to sign with: the updater key, or a throwaway one for a dry run. */
export type SigningKey =
  | { readonly kind: 'updater'; readonly secretKey: string; readonly password: string }
  | { readonly kind: 'throwaway' }

export interface SignOptions {
  readonly version: string
  /** The build jobs' artifacts, one folder each (desktop-<target>). */
  readonly artifacts: string
  /** Where the release's files go; must be empty or missing. */
  readonly out: string
  readonly repo: string
  readonly key: SigningKey
  /** tauri.conf.json's updater public key: the key the apps carry. */
  readonly pubkey: string
  readonly now: Date
}

/** Copies the build jobs' files into `out`, refusing anything missing, extra or out of place. */
export function gatherArtifacts(artifacts: string, out: string, version: string) {
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`${out} is not empty`)
  mkdirSync(out, { recursive: true })
  const folders = readdirSync(artifacts).sort()
  const expected = TARGETS.map((target) => `desktop-${target.id}`).sort()
  if (folders.join() !== expected.join()) {
    throw new Error(`${artifacts} holds ${folders.join(', ')}, not ${expected.join(', ')}`)
  }
  for (const target of TARGETS) {
    const folder = join(artifacts, `desktop-${target.id}`)
    const names = target.files(version).map((file) => file.name)
    const found = readdirSync(folder).sort()
    if (found.join() !== [...names].sort().join()) {
      throw new Error(`desktop-${target.id} holds ${found.join(', ')}, not ${names.join(', ')}`)
    }
    for (const name of names) {
      const path = join(folder, name)
      if (!lstatSync(path).isFile()) throw new Error(`desktop-${target.id}/${name} is not a file`)
      copyFileSync(path, join(out, name))
    }
  }
}

/** Gathers, signs and writes latest.json, then checks it (`sign`). Throws on any problem. */
export function signRelease(options: SignOptions): { manifest: Manifest; keyId: string } {
  const { version, artifacts, out, repo, key, now } = options
  if (!isReleaseVersion(version)) throw new Error(`${version} is not a release version`)
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`--repo must be owner/name, got "${repo}"`)
  let secret: ReturnType<typeof decodeSecretKey>
  let publicKey: PublicKey
  if (key.kind === 'throwaway') {
    const password = randomBytes(18).toString('base64')
    const pair = generateKeyPair(password)
    secret = decodeSecretKey(pair.secretKey, password)
    publicKey = decodePublicKey(pair.publicKey)
  } else {
    publicKey = releaseKey(options.pubkey)
    secret = decodeSecretKey(key.secretKey, key.password)
    if (!samePublicKey(secret, publicKey)) {
      throw new Error(
        `TAURI_SIGNING_PRIVATE_KEY is key ${keyIdHex(secret.keyId)}, but the apps carry ` +
          `${keyIdHex(publicKey.keyId)} (tauri.conf.json): they would refuse every update ` +
          `signed with it (${KEY_HELP})`,
      )
    }
  }
  gatherArtifacts(artifacts, out, version)
  const signatures = new Map<string, string>()
  const timestamp = now.getTime() / 1000
  for (const target of TARGETS) {
    for (const file of target.files(version)) {
      if (file.platforms.length === 0) continue
      const bytes = readFileSync(join(out, file.name))
      signatures.set(file.name, sign(bytes, secret, trustedComment(file.name, version, timestamp)))
    }
  }
  const manifest = buildManifest({ version, repo, published: now, signatures })
  const path = join(out, MANIFEST_NAME)
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  const problems = checkManifest(JSON.parse(readFileSync(path, 'utf8')), {
    version,
    repo,
    publicKey,
    read: (name) => (existsSync(join(out, name)) ? readFileSync(join(out, name)) : undefined),
  })
  if (problems.length > 0) throw new Error(`latest.json doesn't hold:\n${problems.join('\n')}`)
  return { manifest, keyId: keyIdHex(secret.keyId) }
}

/** What `main` runs outside this file, which tests replace. */
export interface MainTools {
  /** signtool, for `windows-sign`. Default: the Windows SDK's (`runSigntool`). */
  readonly signtool?: WindowsSignOptions['run']
  /** The wait between signtool's attempts. */
  readonly wait?: WindowsSignOptions['wait']
}

/** Runs a subcommand. */
export function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  reporter: Reporter,
  tools: MainTools = {},
) {
  const [command, ...rest] = argv
  const options = parseOptions(rest)
  switch (command) {
    case 'check': {
      const version = checkRelease(
        {
          mode: parseMode(requireOption(options, 'mode')),
          version: options.get('version') ?? '',
          appVersion: readAppVersion(),
          pubkey: readUpdaterPubkey(),
        },
        reporter,
      )
      reporter.output('version', version)
      return
    }
    case 'build-key': {
      const { key, configArgs } = writeBuildKey(
        requireOption(options, 'out'),
        options.get('dry-run') === 'true',
      )
      reporter.output('key', key)
      reporter.output('config-args', configArgs)
      return
    }
    case 'collect': {
      const target = targetById(requireOption(options, 'target'))
      const paths = env.ARTIFACT_PATHS ? (JSON.parse(env.ARTIFACT_PATHS) as string[]) : undefined
      const files = collectTarget({
        target,
        version: requireOption(options, 'version'),
        bundleDir: requireOption(options, 'bundle-dir'),
        out: requireOption(options, 'out'),
        artifactPaths: paths,
      })
      reporter.summary(
        [
          `### ${target.id}`,
          '',
          '| File | Size | SHA-256 |',
          '|---|---|---|',
          ...files.map((file) => `| \`${file.name}\` | ${file.size} | \`${file.sha256}\` |`),
        ].join('\n'),
      )
      for (const file of files) reporter.info(`${file.name}  ${file.size} bytes  ${file.sha256}`)
      return
    }
    case 'sign': {
      const throwaway = options.get('throwaway-key') === 'true'
      const secretKey = env.TAURI_SIGNING_PRIVATE_KEY?.trim() ?? ''
      if (!throwaway && secretKey === '') {
        throw new Error(
          `TAURI_SIGNING_PRIVATE_KEY is not set: add the updater key to the repository's secrets (${KEY_HELP})`,
        )
      }
      const { manifest, keyId } = signRelease({
        version: requireOption(options, 'version'),
        artifacts: requireOption(options, 'artifacts'),
        out: requireOption(options, 'out'),
        repo: requireOption(options, 'repo'),
        key: throwaway
          ? { kind: 'throwaway' }
          : { kind: 'updater', secretKey, password: env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '' },
        pubkey: readUpdaterPubkey(),
        now: new Date(),
      })
      const platforms = Object.keys(manifest.platforms)
      reporter.info(`Signed with key ${keyId}: ${platforms.join(', ')}`)
      reporter.summary(
        [
          `### Updater signatures (key ${keyId}${throwaway ? ', throwaway' : ''})`,
          '',
          `latest.json announces ${manifest.version} for ${platforms.length} platforms: ${platforms.map((p) => `\`${p}\``).join(', ')}.`,
        ].join('\n'),
      )
      return
    }
    case 'windows-signing': {
      const signing = chooseWindowsSigning(
        parseMode(requireOption(options, 'mode')),
        options.get('certificate') === 'yes',
      )
      reporter.output('signing', signing)
      if (signing === 'none') {
        reporter.notice(
          'Windows signing',
          'The windows-signing environment holds no certificate (WINDOWS_CERTIFICATE), so this ' +
            "release's Windows files are unsigned (docs/CODE-SIGNING.md).",
        )
      } else {
        reporter.info(
          `Windows files: signed with ${signing === 'throwaway' ? 'a throwaway' : 'the release'} certificate`,
        )
      }
      return
    }
    case 'windows-hook-config': {
      const configArgs = writeHookConfig(
        requireOption(options, 'out'),
        parseHookMode(requireOption(options, 'mode')),
        requireOption(options, 'dir'),
      )
      reporter.output('config-args', configArgs)
      return
    }
    case 'windows-hook': {
      reporter.info(
        runHook(
          parseHookMode(requireOption(options, 'mode')),
          requireOption(options, 'dir'),
          requireOption(options, 'file'),
        ),
      )
      return
    }
    case 'windows-collected': {
      const dir = requireOption(options, 'dir')
      const files = readCollected(dir)
      const problems = collectedProblems(dir, files)
      reporter.summary(
        [
          '### Windows files to sign',
          '',
          '| File | Kind | SHA-256 |',
          '|---|---|---|',
          ...files.map((file) => `| \`${file.name}\` | ${file.kind} | \`${file.sha256}\` |`),
        ].join('\n'),
      )
      if (problems.length > 0) {
        throw new Error(`The files to sign don't hold:\n${problems.join('\n')}`)
      }
      reporter.info(`Windows: ${files.length} files to sign, as expected`)
      return
    }
    case 'windows-sign': {
      const sign: WindowsSignOptions = {
        thumbprint: requireOption(options, 'thumbprint'),
        timestampUrl: options.get('timestamp-url') ?? '',
        ...(tools.signtool === undefined ? {} : { run: tools.signtool }),
        ...(tools.wait === undefined ? {} : { wait: tools.wait }),
      }
      const phase = requireOption(options, 'phase')
      if (phase === 'app') {
        const files = signApp(requireOption(options, 'dir'), requireOption(options, 'out'), sign)
        reporter.info(`Signed ${files.map((file) => file.name).join(', ')}`)
      } else if (phase === 'installers') {
        const names = signInstallers(
          requireOption(options, 'dir'),
          requireOption(options, 'version'),
          sign,
        )
        reporter.info(`Signed ${names.join(', ')}`)
      } else {
        throw new Error(`--phase must be app or installers, got "${phase}"`)
      }
      return
    }
    case 'windows-swapped': {
      const { problems, left } = swapProblems(requireOption(options, 'dir'))
      if (problems.length > 0) throw new Error(problems.join('\n'))
      reporter.info(
        `Windows: every signed file went into the installers; left as built: ${left.join(', ')}`,
      )
      return
    }
    case 'windows-signatures': {
      const signing = parseWindowsSigning(requireOption(options, 'signing'))
      const signatures = parseSignatureReport(
        readFileSync(requireOption(options, 'report'), 'utf8'),
      )
      const problems = checkWindowsSignatures(signatures, signing, {
        installers: options.get('thumbprint'),
        app: options.get('app-thumbprint'),
      })
      reporter.summary(
        [
          `### Windows signatures (${signing})`,
          '',
          '| File | Status | Signer | Timestamp |',
          '|---|---|---|---|',
          ...signatures.map(
            (s) =>
              `| \`${s.file}\` | ${s.status} | ${s.signer ?? ''} | ${s.timestamped ? 'yes' : 'no'} |`,
          ),
        ].join('\n'),
      )
      if (problems.length > 0)
        throw new Error(`The Windows signatures don't hold:\n${problems.join('\n')}`)
      reporter.info(`Windows signatures: ${signatures.length} files, as expected (${signing})`)
      return
    }
    default:
      throw new Error(
        'usage: release.ts <check|build-key|collect|sign|windows-hook-config|windows-hook|' +
          'windows-collected|windows-signing|windows-sign|windows-swapped|windows-signatures> ' +
          '[options]',
      )
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reporter = createReporter()
  try {
    main(process.argv.slice(2), process.env, reporter)
  } catch (error) {
    reporter.error('Desktop release', (error as Error).message)
    process.exitCode = 1
  }
}
