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
 *   release.ts sign --version x.y.z --artifacts <dir> --out <dir> --repo owner/name
 *                   [--throwaway-key]
 *       job "sign": gathers the build jobs' files (one folder per artifact, desktop-<target>),
 *       signs the ones the updater installs with the updater key (TAURI_SIGNING_PRIVATE_KEY and
 *       TAURI_SIGNING_PRIVATE_KEY_PASSWORD), writes latest.json and checks it as each platform's
 *       updater will. The key must be the one whose public key tauri.conf.json holds, which the
 *       release's apps carry. A dry run signs with a throwaway key instead (--throwaway-key).
 *
 * The sign job installs nothing: it runs Node and this repository's own files, so no third-party
 * code ever sees the updater key (`minisign.ts` signs with Node's crypto).
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
import { MANIFEST_NAME, type ReleaseTarget, TARGETS, targetById } from './targets.ts'

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

/** Runs a subcommand. `download` replaces the network for `appimage-tools`, in tests. */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  reporter: Reporter,
  { download }: { download?: Download } = {},
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
    case 'appimage-tools':
      return appImageToolsCommand(options, reporter, download)
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
    default:
      throw new Error('usage: release.ts <check|build-key|appimage-tools|collect|sign> [options]')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reporter = createReporter()
  try {
    await main(process.argv.slice(2), process.env, reporter)
  } catch (error) {
    reporter.error('Desktop release', (error as Error).message)
    process.exitCode = 1
  }
}
