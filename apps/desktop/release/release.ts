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
 *       run also gives the apps the throwaway public key (`--config`), in place of FXM's. Outputs
 *       key (the secret key's path) and config-args.
 *   release.ts appimage-tools --triple <triple> --out <dir> [--after-build --bundle-dir <dir>]
 *       each Linux build job, before `tauri build`: downloads the tools the bundler makes the
 *       AppImage with, and the AppImage runtime, checks each against its pinned SHA-256 and puts
 *       them into the bundler's tools folder <out>, so it fetches none of them unchecked
 *       (appimage-tools.ts). Outputs runtime-file, for LDAI_RUNTIME_FILE. With --after-build,
 *       after `tauri build`: checks that <out> holds no tool the bundler fetched itself, and that
 *       every AppImage in <bundle-dir>/appimage starts with the pinned runtime.
 *   release.ts collect --target <id> --version x.y.z --bundle-dir <dir> --out <dir>
 *       each build job: copies the target's files (targets.ts) into <out> under their release
 *       names. With ARTIFACT_PATHS (tauri-action's artifactPaths output) it also checks that
 *       tauri-action reported each of them.
 *   release.ts notices [--version x.y.z --web <file> --out <file>]
 *       job "notices": the third-party notices that every installer carries (notices.ts): the
 *       licences of the Rust crates of the five targets, from `cargo metadata` through
 *       scripts/run.sh, then make dist's notices for the web app (--web), written to <out>. It
 *       stops on a crate whose licence FXM doesn't accept, or that ships no licence text and has
 *       no review. Without --web and --out it checks the crates only (desktop.yml's Linux build).
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
 *   release.ts windows-signing --mode <release|dry-run> [--certificate yes] [--unsigned yes]
 *       job windows-sign-app: how to sign, given whether the windows-signing environment holds a
 *       certificate: `throwaway` for a dry run (`none` with --unsigned, from desktop.yml's
 *       windows-unsigned), `certificate` or `none` for a release. Outputs signing.
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
import { spawnSync } from 'node:child_process'
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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createReporter,
  isRecord,
  messageOf,
  parseOptions,
  type Reporter,
  requireOption,
} from './actions.ts'
import {
  appImageArch,
  appImageTools,
  checkAfterBuild,
  checkTauriCli,
  type Download,
  fetchAppImageTools,
  readTauriCliVersion,
} from './appimage-tools.ts'
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
import {
  crateNotices,
  type Metadata,
  parseMetadata,
  renderDesktopNotices,
  shippedCrates,
} from './notices.ts'
import { MANIFEST_NAME, type ReleaseTarget, TARGETS, type TargetId, targetById } from './targets.ts'
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
const CARGO_TOML = join(APP_DIR, 'src-tauri', 'Cargo.toml')
const RUST_TOOLCHAIN = join(APP_DIR, 'src-tauri', 'rust-toolchain.toml')
/** The repository's root: its LICENSE, the Apache License 2.0, and scripts/run.sh. */
const ROOT = join(APP_DIR, '..', '..')
/** The licence texts that REVIEWED_CRATE_TEXTS takes from crates' repositories. */
const LICENCES_DIR = join(APP_DIR, 'release', 'licences')

/** FXM's repository, which the notices name. */
const REPOSITORY_URL = 'https://github.com/Pratyay-ops/FXM'

/** Where apps/desktop/README.md explains the updater key. */
const KEY_HELP = 'apps/desktop/README.md, "Updates"'

/** Whether a version is a release version: x.y.z, numbers up to 65535 (scripts/release-lib.sh). */
export function isReleaseVersion(version: string): boolean {
  const match = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.exec(version)
  return match?.slice(1).every((part) => Number(part) <= 65535) ?? false
}

/** A JSON file, parsed, as nothing more than JSON. */
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))

/** The version in a package.json. */
export function readAppVersion(path = PACKAGE_JSON): string {
  const manifest = readJson(path)
  const version = isRecord(manifest) ? manifest.version : undefined
  if (typeof version !== 'string') throw new Error(`${path} has no version`)
  return version
}

/** The updater's public key in a tauri.conf.json, as the apps carry it. */
export function readUpdaterPubkey(path = TAURI_CONFIG): string {
  const config = readJson(path)
  const plugins = isRecord(config) ? config.plugins : undefined
  const updater = isRecord(plugins) ? plugins.updater : undefined
  const pubkey = isRecord(updater) ? updater.pubkey : undefined
  if (typeof pubkey !== 'string') throw new Error(`${path} has no plugins > updater > pubkey`)
  return pubkey
}

/** tauri-action's artifactPaths output: a JSON array of the paths it found. */
export function parseArtifactPaths(text: string): string[] {
  let paths: unknown
  try {
    paths = JSON.parse(text)
  } catch {
    throw new Error('ARTIFACT_PATHS is not JSON')
  }
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === 'string')) {
    throw new Error('ARTIFACT_PATHS is not a JSON array of paths')
  }
  return paths
}

/** The updater's public key, or why a release can't use it. */
export function releaseKey(pubkey: string): PublicKey {
  // tauri-plugin-updater and the Tauri CLI decode the key exactly as it stands: with a space or a
  // line break around it, every build job would fail, and an app built with it would refuse
  // every update.
  if (pubkey !== pubkey.trim()) {
    throw new Error(
      'The updater public key in apps/desktop/src-tauri/tauri.conf.json has spaces or line ' +
        "breaks around it, which the Tauri CLI and the updater refuse: put the .pub file's " +
        `single line there, and nothing else (${KEY_HELP}).`,
    )
  }
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

/**
 * An option that a workflow sets from a condition, `yes` or empty (`--certificate yes`,
 * `--certificate ''`), or leaves out. Anything else is a mistake, never a no.
 */
export function yesOption(options: ReadonlyMap<string, string>, name: string): boolean {
  const value = options.get(name) ?? ''
  if (value !== '' && value !== 'yes') {
    throw new Error(`--${name} must be yes or empty, got "${value}"`)
  }
  return value === 'yes'
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

/** The Rust release that rust-toolchain.toml pins, whose standard library the app includes. */
export function readRustVersion(path = RUST_TOOLCHAIN): string {
  const channel = /^channel = "([^"]+)"$/m.exec(readFileSync(path, 'utf8'))?.[1]
  if (channel === undefined) throw new Error(`${path} names no channel`)
  return channel
}

/** Reads `cargo metadata` for a target triple. */
export type MetadataSource = (triple: string) => Metadata

/** `cargo metadata` of the app's crate for one target, with the repository's pinned toolchain. */
function cargoMetadata(triple: string): Metadata {
  const result = spawnSync(
    join(ROOT, 'scripts', 'run.sh'),
    [
      'cargo',
      'metadata',
      '--format-version',
      '1',
      '--locked',
      '--filter-platform',
      triple,
      '--manifest-path',
      CARGO_TOML,
    ],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] },
  )
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`cargo metadata for ${triple} failed`)
  return parseMetadata(result.stdout)
}

/** The first line of the notices file that make dist writes (scripts/build-dist/src/licenses.ts). */
const WEB_NOTICES_TITLE = 'FXM third-party notices'

/** Checks the crates' licences and writes the desktop notices file (`notices`). */
function noticesCommand(
  options: Map<string, string>,
  reporter: Reporter,
  metadataOf: MetadataSource,
) {
  const web = options.get('web')
  const out = options.get('out')
  if ((web === undefined) !== (out === undefined)) throw new Error('give --web and --out together')
  const perTarget = new Map<TargetId, Metadata>(
    TARGETS.map((target) => [target.id, metadataOf(target.triple)]),
  )
  const crates = shippedCrates(perTarget)
  const notices = crateNotices(crates, {
    apacheLicense: () => readFileSync(join(ROOT, 'LICENSE'), 'utf8'),
    reviewedFile: (name) => readFileSync(join(LICENCES_DIR, name), 'utf8'),
  })
  if (notices.problems.length > 0) {
    throw new Error(
      `The crates' licences stop the third-party notices (apps/desktop/release/notices.ts):\n${notices.problems.join('\n')}`,
    )
  }
  const mpl = notices.sourceCrates.map((crate) => `${crate.name} ${crate.version}`)
  reporter.info(
    `${crates.length} crates, ${notices.groups.length} licence texts. Under the MPL-2.0, with their source code named: ${mpl.join(', ') || 'none'}.`,
  )
  if (web === undefined || out === undefined) return
  const webNotices = readFileSync(web, 'utf8')
  if (!webNotices.startsWith(WEB_NOTICES_TITLE)) {
    throw new Error(`${web} isn't make dist's third-party notices file`)
  }
  const text = renderDesktopNotices({
    version: options.get('version') || readAppVersion(),
    repositoryUrl: REPOSITORY_URL,
    rustVersion: readRustVersion(),
    crates: notices,
    web: webNotices,
  })
  mkdirSync(dirname(resolve(out)), { recursive: true })
  writeFileSync(out, text)
  const size = Buffer.byteLength(text)
  reporter.info(`${out}: ${size} bytes`)
  reporter.summary(
    [
      '### Third-party notices',
      '',
      `${crates.length} crates (${notices.groups.length} licence texts) and make dist's notices for the web app: ${size} bytes, in every installer.`,
    ].join('\n'),
  )
}

/** Prepares the AppImage tools before `tauri build`, or checks them after it (`appimage-tools`). */
async function appImageToolsCommand(
  options: Map<string, string>,
  reporter: Reporter,
  download: Download | undefined,
) {
  const arch = appImageArch(requireOption(options, 'triple'))
  const out = requireOption(options, 'out')
  const tools = appImageTools(arch)
  if (options.get('after-build') === 'true') {
    const bundleDir = requireOption(options, 'bundle-dir')
    for (const name of checkAfterBuild({ out, tools, bundleDir })) {
      reporter.info(`${name} was built with the checked tools only, behind the pinned runtime.`)
    }
    return
  }
  checkTauriCli(readTauriCliVersion())
  const { runtimeFile, files } = await fetchAppImageTools({
    out,
    tools,
    ...(download ? { download } : {}),
  })
  for (const file of files) reporter.info(`${file.name}  ${file.size} bytes  ${file.sha256}`)
  reporter.output('runtime-file', runtimeFile)
}

/** What `main` runs outside this file, which tests replace. */
export interface MainTools {
  /** The network, for `appimage-tools`. Default: appimage-tools.ts's, with fetch. */
  readonly download?: Download
  /** `cargo metadata`, for `notices`. Default: cargo's, through scripts/run.sh. */
  readonly metadata?: MetadataSource
  /** signtool, for `windows-sign`. Default: the Windows SDK's (`runSigntool`). */
  readonly signtool?: WindowsSignOptions['run']
  /** The wait between signtool's attempts. */
  readonly wait?: WindowsSignOptions['wait']
}

/** Runs a subcommand. */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  reporter: Reporter,
  tools: MainTools = {},
) {
  const { download, metadata = cargoMetadata } = tools
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
    case 'appimage-tools':
      return appImageToolsCommand(options, reporter, download)
    case 'notices':
      return noticesCommand(options, reporter, metadata)
    case 'collect': {
      const target = targetById(requireOption(options, 'target'))
      const paths = env.ARTIFACT_PATHS ? parseArtifactPaths(env.ARTIFACT_PATHS) : undefined
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
          'TAURI_SIGNING_PRIVATE_KEY is not set: add the updater key to the secrets of the ' +
            `desktop-updater environment, and approve the run (${KEY_HELP})`,
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
      const mode = parseMode(requireOption(options, 'mode'))
      const signing = chooseWindowsSigning(
        mode,
        yesOption(options, 'certificate'),
        yesOption(options, 'unsigned'),
      )
      reporter.output('signing', signing)
      if (signing === 'none') {
        reporter.notice(
          'Windows signing',
          mode === 'release'
            ? 'The windows-signing environment holds no certificate (WINDOWS_CERTIFICATE), so ' +
                "this release's Windows files are unsigned (docs/CODE-SIGNING.md)."
            : 'This dry run leaves the Windows files unsigned (windows-unsigned), as a release ' +
                'without a certificate does (docs/CODE-SIGNING.md).',
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
        'usage: release.ts <check|build-key|appimage-tools|notices|collect|sign|' +
          'windows-hook-config|windows-hook|windows-collected|windows-signing|windows-sign|' +
          'windows-swapped|windows-signatures> [options]',
      )
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reporter = createReporter()
  try {
    await main(process.argv.slice(2), process.env, reporter)
  } catch (error) {
    reporter.error('Desktop release', messageOf(error))
    process.exitCode = 1
  }
}
