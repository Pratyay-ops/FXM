/**
 * Windows code signing in the release workflow (stage 7.6, docs/CODE-SIGNING.md).
 *
 * The certificate's key never meets the build's code. `.github/workflows/desktop-release.yml`
 * makes the Windows files in five jobs, and only the two that sign name the `windows-signing`
 * environment, whose secrets hold a release's certificate. Those two install and build nothing:
 * they run GitHub's own actions, PowerShell (`windows-certificate.ps1` puts the certificate in
 * the runner's store), the Windows SDK's signtool and this folder's scripts.
 *
 * 1. `windows-build` compiles fxm.exe and bundles both installers with `tauri build`. Tauri's own
 *    signing (`bundle > windows > signCommand`) calls {@link runHook} instead of signtool, in
 *    `collect` mode: it copies each file Tauri would sign before packing it, and signs nothing.
 *    Those are fxm.exe, once for each installer, since Tauri writes the bundle type into a copy
 *    for each (the updater reads it to pick the next version's installer), and the NSIS plugins.
 *    The unsigned installers serve a release without a certificate.
 * 2. `windows-sign-app` checks those files and signs them. The two copies of fxm.exe must differ
 *    in the bundle type alone ({@link appCopyProblems}), and the plugins must be those Tauri
 *    downloads, by their SHA-256 ({@link PINNED_PLUGINS}), so the build can't get anything else
 *    signed.
 * 3. `windows-bundle` runs `tauri bundle` around the same fxm.exe, with the hook in `swap` mode:
 *    each time Tauri would sign a file, the hook puts the signed copy of those exact bytes in its
 *    place, so the installers pack the signed fxm.exe, and the NSIS installer the signed plugins.
 * 4. `windows-sign-installers` signs the two installers.
 * 5. `windows-check` reads every signature, the installers' and those of the files inside them
 *    ({@link checkWindowsSignatures}), and hands the installers to the release.
 *
 * The NSIS uninstaller is the one file left unsigned: NSIS makes it while it packs the installer,
 * so only a job that ran NSIS, which is build code, could sign it.
 *
 * Which certificate: for a dry run, a throwaway self-signed one that each signing job makes and
 * imports as it would a release's, so every dry run tries that path; for a release, the one in
 * the environment's secrets (`WINDOWS_CERTIFICATE`, a base64 PKCS #12 file, and
 * `WINDOWS_CERTIFICATE_PASSWORD`), or none, and the release goes on unsigned and says so.
 *
 * @module
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Mode } from './release.ts'
import { targetById } from './targets.ts'

/** How the Windows files are signed: see the module documentation. */
export type WindowsSigning = 'throwaway' | 'certificate' | 'none'

/**
 * The timestamp server when the repository sets none (`vars.WINDOWS_TIMESTAMP_URL`): Certum's,
 * which speaks RFC 3161, as FXM's paid fallback certificate would come from Certum. A timestamp
 * keeps a signature valid after the certificate expires.
 */
export const DEFAULT_TIMESTAMP_URL = 'http://time.certum.pl'

/** The subject of a dry run's throwaway certificate (`windows-certificate.ps1`). */
export const THROWAWAY_SUBJECT = 'CN=FXM release dry run (throwaway, untrusted)'

/** The description each signature carries (signtool's `/d`): the product name, as Tauri's. */
export const SIGNATURE_DESCRIPTION = 'FXM'

/** The app's executable, as Cargo names it (`src-tauri/Cargo.toml`). */
export const APP_BINARY = 'fxm.exe'

/**
 * The NSIS plugins that Tauri's bundler signs and packs into the NSIS installer, by their
 * SHA-256. Tauri CLI 2.12.2 (tauri-bundler 2.10.2) downloads them, each checked against a SHA-1
 * of its own: the first four from
 * https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip
 * (`Plugins/x86-unicode/`), the last from
 * https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll
 * (hashed 2026-10-26). A Tauri CLI that brings others fails `windows-sign-app` with their
 * hashes: check them against the bundler's sources, then put them here.
 */
export const PINNED_PLUGINS: Readonly<Record<string, string>> = {
  'NSISdl.dll': 'ddf40229dd9d6b268902d8dea88c8a04aacf1af218dd29f6dcd35babc54ac08d',
  'StartMenu.dll': 'fe330320459637d8dd2b5d84d07925c38ec264152ffd3b1760a4d44d76536caa',
  'System.dll': '8b4c47c4cf5e76ec57dd5a050d5acd832a0d532ee875d7b44f6cdaf68f90d37c',
  'nsDialogs.dll': 'b1350f487692057c8ffde75dcc55287a52a3272240d4d4912f24464b27551fc0',
  'nsis_tauri_utils.dll': '5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709',
}

/**
 * What Tauri's bundler writes into each installer's copy of the executable, in place of
 * `__TAURI_BUNDLE_TYPE_VAR_UNK`: this, then `NSS` for the NSIS installer or `MSI` for the MSI
 * (tauri-bundler's `patch_binary`; tauri-utils' `bundle_type` reads it).
 */
export const BUNDLE_TYPE_PREFIX = '__TAURI_BUNDLE_TYPE_VAR_'

/** The bundle types of the two copies of fxm.exe: the NSIS installer's and the MSI's. */
export const BUNDLE_TYPES = ['NSS', 'MSI'] as const

/** This file's sibling that the hook runs: `release.ts windows-hook`. */
const RELEASE_SCRIPT = fileURLToPath(new URL('./release.ts', import.meta.url))

/** The signing from `--signing`. */
export function parseWindowsSigning(value: string): WindowsSigning {
  if (value === 'throwaway' || value === 'certificate' || value === 'none') return value
  throw new Error(`--signing must be throwaway, certificate or none, got "${value}"`)
}

/** How to sign: a dry run always signs, a release when the environment holds a certificate. */
export function chooseWindowsSigning(mode: Mode, hasCertificate: boolean): WindowsSigning {
  if (mode === 'dry-run') return 'throwaway'
  return hasCertificate ? 'certificate' : 'none'
}

/** A certificate's SHA-1 thumbprint, as signtool takes it: 40 hexadecimal digits. */
export function parseThumbprint(value: string): string {
  const thumbprint = value.trim().toUpperCase()
  if (!/^[0-9A-F]{40}$/.test(thumbprint)) {
    throw new Error(`"${value}" is not a certificate thumbprint (40 hexadecimal digits)`)
  }
  return thumbprint
}

/** A timestamp server's address: an http or https URL, which signtool takes with `/tr`. */
export function parseTimestampUrl(value: string): string {
  const url = value.trim() === '' ? DEFAULT_TIMESTAMP_URL : value.trim()
  if (!URL.canParse(url) || !['http:', 'https:'].includes(new URL(url).protocol)) {
    throw new Error(`"${value}" is not an http or https URL of a timestamp server`)
  }
  return url
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** A path's last part, whichever separator it uses: Tauri mixes `\` and `/` on Windows. */
function baseName(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

// --- The hook in Tauri's signing --------------------------------------------------------------

/** The hook's mode: see the module documentation. */
export type HookMode = 'collect' | 'swap'

/** The mode from `--mode`. */
export function parseHookMode(value: string): HookMode {
  if (value === 'collect' || value === 'swap') return value
  throw new Error(`--mode must be collect or swap, got "${value}"`)
}

/** A file Tauri hands the hook: fxm.exe, an NSIS plugin, or anything else. */
export type FileKind = 'app' | 'plugin' | 'other'

/**
 * Which file Tauri asks the hook to sign: fxm.exe (`target/<triple>/release/fxm.exe`, patched
 * for one installer), an NSIS plugin (`…/nsis/x64/Plugins/x86-unicode/[additional/]*.dll`), or
 * anything else: the NSIS uninstaller (a temporary file of NSIS's), WiX's extension libraries,
 * which sign nothing in the MSI, and the installers themselves, which are signed later.
 */
export function classifyFile(path: string): FileKind {
  const normalized = path.replaceAll('\\', '/')
  if (baseName(normalized).toLowerCase() === APP_BINARY) return 'app'
  if (/\/Plugins\/x86-unicode\/(?:additional\/)?[^/]+\.dll$/i.test(normalized)) return 'plugin'
  return 'other'
}

/** A file to sign, as the hook collected it. */
export interface CollectedFile {
  /** The SHA-256 of its bytes, unsigned. */
  readonly sha256: string
  readonly kind: 'app' | 'plugin'
  /** Its name where Tauri had it, such as `fxm.exe` or `System.dll`. */
  readonly name: string
}

/** The lists in the hook's folder: what it collected, what was signed, what it swapped. */
export const COLLECTED_LIST = 'collected.jsonl'
export const SIGNED_LIST = 'signed.json'
export const SWAPPED_LIST = 'swapped.jsonl'

/**
 * Where a file to sign is kept in the hook's folder: its unsigned SHA-256 and its extension.
 * Its signed copy keeps the same name, so the hook finds it by the bytes Tauri hands it.
 */
export function keptName(file: Pick<CollectedFile, 'sha256' | 'name'>): string {
  const extension = /\.[a-z0-9]+$/i.exec(file.name)?.[0]?.toLowerCase() ?? ''
  return `${file.sha256}${extension}`
}

/**
 * The Tauri config that hooks its signing to {@link runHook} in `mode`, with `dir` as the hook's
 * folder. The paths use `/`, which Windows takes, as Tauri hands the command to NSIS for the
 * uninstaller in Rust's debug notation, which would double every `\`.
 */
export function hookConfig(mode: HookMode, dir: string, node = process.execPath) {
  const slashes = (path: string) => path.replaceAll('\\', '/')
  return {
    bundle: {
      windows: {
        signCommand: {
          cmd: slashes(node),
          args: [
            '--experimental-strip-types',
            '--disable-warning=ExperimentalWarning',
            slashes(RELEASE_SCRIPT),
            'windows-hook',
            '--mode',
            mode,
            '--dir',
            slashes(resolve(dir)),
            '--file',
            '%1',
          ],
        },
      },
    },
  }
}

/** Writes {@link hookConfig} for `tauri build --config` or `tauri bundle --config`. */
export function writeHookConfig(out: string, mode: HookMode, dir: string, node?: string): string {
  mkdirSync(out, { recursive: true })
  mkdirSync(dir, { recursive: true })
  const path = join(resolve(out), `windows-${mode}.conf.json`)
  writeFileSync(path, `${JSON.stringify(hookConfig(mode, dir, node))}\n`)
  return `--config ${path}`
}

/**
 * One call of the hook by Tauri's signing, for `file`. `collect` copies fxm.exe and the NSIS
 * plugins into `dir` and lists them; `swap` puts the signed copy of `file`'s bytes in its place,
 * if `dir` has one, and lists what it did. Neither signs anything. Returns a line for Tauri's log.
 */
export function runHook(mode: HookMode, dir: string, file: string): string {
  const bytes = readFileSync(file)
  const hash = sha256(bytes)
  const name = baseName(file)
  mkdirSync(dir, { recursive: true })
  if (mode === 'collect') {
    const kind = classifyFile(file)
    if (kind === 'other') return `${name}: not collected (signed later, or not at all)`
    const collected: CollectedFile = { sha256: hash, kind, name }
    writeFileSync(join(dir, keptName(collected)), bytes)
    appendFileSync(join(dir, COLLECTED_LIST), `${JSON.stringify(collected)}\n`)
    return `${name}: collected to be signed (${kind}, SHA-256 ${hash})`
  }
  const signed = join(dir, keptName({ sha256: hash, name }))
  const swapped = existsSync(signed)
  if (swapped) copyFileSync(signed, file)
  appendFileSync(join(dir, SWAPPED_LIST), `${JSON.stringify({ sha256: hash, name, swapped })}\n`)
  return swapped ? `${name}: the signed copy put in its place` : `${name}: left as it is`
}

/** Reads a list of JSON lines. */
function readLines(path: string): unknown[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown)
}

/** The files the hook collected in `dir`, each once, after checking what the list says. */
export function readCollected(dir: string): CollectedFile[] {
  const path = join(dir, COLLECTED_LIST)
  if (!existsSync(path)) throw new Error(`${path} is missing: Tauri's signing never ran the hook`)
  const files = new Map<string, CollectedFile>()
  for (const item of readLines(path)) {
    const entry = item as Record<string, unknown>
    const { sha256: hash, kind, name } = entry
    if (
      typeof hash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(hash) ||
      (kind !== 'app' && kind !== 'plugin') ||
      typeof name !== 'string' ||
      !/^[\w.-]+$/.test(name)
    ) {
      throw new Error(`not a collected file: ${JSON.stringify(item)}`)
    }
    files.set(hash, { sha256: hash, kind, name })
  }
  return [...files.values()]
}

/**
 * What is wrong with the two copies of fxm.exe: they must have the same length and differ in
 * the bundle type alone, `NSS` in one and `MSI` in the other.
 */
export function appCopyProblems(a: Uint8Array, b: Uint8Array): string[] {
  if (a.length !== b.length) {
    return [`the two copies of ${APP_BINARY} differ in length (${a.length} and ${b.length} bytes)`]
  }
  let first = -1
  let last = -1
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) {
      if (first < 0) first = index
      last = index
    }
  }
  if (first < 0) return [`the two copies of ${APP_BINARY} are the same: no bundle type in them`]
  // NSS and MSI differ in their first and third letters, so those mark where the type is.
  const start = first - BUNDLE_TYPE_PREFIX.length
  const type = (bytes: Uint8Array) => {
    const token = Buffer.from(bytes.subarray(Math.max(0, start), first + 3)).toString('latin1')
    return token.startsWith(BUNDLE_TYPE_PREFIX) ? token.slice(BUNDLE_TYPE_PREFIX.length) : ''
  }
  const types = [type(a), type(b)].sort()
  if (start < 0 || last > first + 2 || types.join() !== [...BUNDLE_TYPES].sort().join()) {
    return [`the two copies of ${APP_BINARY} differ in more than their bundle type`]
  }
  return []
}

/**
 * What is wrong with the files collected in `dir`: each must hold the bytes listed; there must be
 * two copies of fxm.exe ({@link appCopyProblems}) and exactly the plugins of `pins`, by name and
 * SHA-256 ({@link PINNED_PLUGINS}).
 */
export function collectedProblems(
  dir: string,
  files: readonly CollectedFile[],
  pins: Readonly<Record<string, string>> = PINNED_PLUGINS,
): string[] {
  const problems: string[] = []
  const read = (file: CollectedFile) => {
    const path = join(dir, keptName(file))
    if (!existsSync(path)) {
      problems.push(`${file.name} (${file.sha256}) is missing`)
      return new Uint8Array()
    }
    const bytes = readFileSync(path)
    if (sha256(bytes) !== file.sha256) problems.push(`${file.name}: not the bytes collected`)
    return bytes
  }
  const apps = files.filter((file) => file.kind === 'app')
  const [first, second] = apps
  if (apps.length !== 2 || first === undefined || second === undefined) {
    problems.push(`${apps.length} copies of ${APP_BINARY}, not 2 (one for each installer)`)
  } else {
    problems.push(...appCopyProblems(read(first), read(second)))
  }
  const plugins = files.filter((file) => file.kind === 'plugin')
  for (const plugin of plugins) {
    read(plugin)
    const pinned = pins[plugin.name]
    if (pinned === undefined) {
      problems.push(`${plugin.name} (${plugin.sha256}) is no NSIS plugin that Tauri packs`)
    } else if (pinned !== plugin.sha256) {
      problems.push(
        `${plugin.name} has SHA-256 ${plugin.sha256}, not ${pinned}: check it against the ` +
          "Tauri CLI's sources before trusting it (PINNED_PLUGINS)",
      )
    }
  }
  for (const name of Object.keys(pins)) {
    if (!plugins.some((plugin) => plugin.name === name)) problems.push(`${name} wasn't collected`)
  }
  return problems
}

// --- signtool -----------------------------------------------------------------------------------

/** signtool's arguments: SHA-256 digests, the certificate of `thumbprint` and an RFC 3161 timestamp. */
export function signtoolArgs(
  thumbprint: string,
  timestampUrl: string,
  files: readonly string[],
): string[] {
  if (files.length === 0) throw new Error('nothing to sign')
  return [
    'sign',
    '/fd',
    'sha256',
    '/sha1',
    parseThumbprint(thumbprint),
    '/d',
    SIGNATURE_DESCRIPTION,
    '/tr',
    parseTimestampUrl(timestampUrl),
    '/td',
    'sha256',
    ...files,
  ]
}

/** Compares dotted version numbers, such as `10.0.26100.0`. */
function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * The Windows SDK's signtool: `SIGNTOOL` if set, else the x64 one of the newest SDK under
 * `%ProgramFiles(x86)%\Windows Kits\10\bin`, where GitHub's Windows runners have it.
 */
export function findSigntool(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SIGNTOOL) return env.SIGNTOOL
  const root = join(
    env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'Windows Kits',
    '10',
    'bin',
  )
  const versions = existsSync(root)
    ? readdirSync(root).filter((name) => /^10(?:\.\d+){3}$/.test(name))
    : []
  for (const version of versions.sort(compareVersions).reverse()) {
    const path = join(root, version, 'x64', 'signtool.exe')
    if (existsSync(path)) return path
  }
  throw new Error(`no signtool.exe under ${root}: the Windows SDK's signtool signs the files`)
}

/** Runs signtool with these arguments, and returns its exit status. */
export type RunSigntool = (args: readonly string[]) => number

/** signtool, found by {@link findSigntool}, with its output in the job's log. */
export const runSigntool: RunSigntool = (args) =>
  spawnSync(findSigntool(), args, { stdio: 'inherit' }).status ?? 1

/** Waits, synchronously, between attempts. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** How to sign: the certificate, the timestamp server and signtool. */
export interface WindowsSignOptions {
  readonly thumbprint: string
  readonly timestampUrl: string
  readonly run?: RunSigntool
  /** How many times to try: a timestamp server that doesn't answer is the usual failure. */
  readonly attempts?: number
  readonly wait?: (ms: number) => void
}

/** Signs `files` in place with one signtool call, trying again after a failure. */
export function signFiles(files: readonly string[], options: WindowsSignOptions): void {
  const { run = runSigntool, attempts = 3, wait = pause } = options
  const args = signtoolArgs(options.thumbprint, options.timestampUrl, files)
  for (let attempt = 1; ; attempt++) {
    const status = run(args)
    if (status === 0) return
    if (attempt >= attempts) throw new Error(`signtool failed ${attempts} times (exit ${status})`)
    // Signing a signed file again replaces its signature, so trying again is safe.
    wait(10_000 * attempt)
  }
}

/**
 * `windows-sign-app`: checks the files collected in `dir` ({@link collectedProblems}), copies
 * them into `out`, which must be empty or missing, signs the copies, and lists them there for
 * the hook's `swap` mode. Returns the files signed.
 */
export function signApp(
  dir: string,
  out: string,
  options: WindowsSignOptions,
  pins: Readonly<Record<string, string>> = PINNED_PLUGINS,
): CollectedFile[] {
  const files = readCollected(dir)
  const problems = collectedProblems(dir, files, pins)
  if (problems.length > 0) throw new Error(`The files to sign don't hold:\n${problems.join('\n')}`)
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`${out} is not empty`)
  mkdirSync(out, { recursive: true })
  const copies = files.map((file) => {
    const copy = join(out, keptName(file))
    copyFileSync(join(dir, keptName(file)), copy)
    return copy
  })
  signFiles(copies, options)
  writeFileSync(join(out, SIGNED_LIST), `${JSON.stringify(files, null, 2)}\n`)
  return files
}

/**
 * After `windows-bundle`'s `tauri bundle`: every file signed must have gone into the installers,
 * which takes Tauri asking the hook to sign the very same bytes. Returns what is wrong, and what
 * the hook left as it was.
 */
export function swapProblems(dir: string): { problems: string[]; left: string[] } {
  const signed = JSON.parse(readFileSync(join(dir, SIGNED_LIST), 'utf8')) as CollectedFile[]
  const calls = readLines(join(dir, SWAPPED_LIST)) as {
    sha256?: unknown
    name?: unknown
    swapped?: unknown
  }[]
  const swapped = new Set(calls.filter((call) => call.swapped === true).map((call) => call.sha256))
  const problems = signed
    .filter((file) => !swapped.has(file.sha256))
    .map(
      (file) =>
        `Tauri never asked to sign ${file.name} (${file.sha256}) again: the installers would ` +
        'carry it unsigned',
    )
  const left = calls.filter((call) => call.swapped !== true).map((call) => String(call.name))
  return { problems, left }
}

/** The first bytes of each installer: a Windows executable's, and an MSI's (a compound file). */
const MAGIC: readonly [RegExp, Buffer][] = [
  [/-setup\.exe$/, Buffer.from('MZ', 'latin1')],
  [/\.msi$/, Buffer.from('d0cf11e0a1b11ae1', 'hex')],
]

/** What is wrong with the installers in `dir`: exactly the two of `version`, each what it says. */
export function installerProblems(dir: string, version: string): string[] {
  const names = targetById('windows-x64')
    .files(version)
    .map((file) => file.name)
  const found = existsSync(dir) ? readdirSync(dir) : []
  if ([...found].sort().join() !== [...names].sort().join()) {
    return [`${dir} holds ${found.join(', ') || 'nothing'}, not ${names.join(', ')}`]
  }
  const problems: string[] = []
  for (const name of names) {
    const magic = MAGIC.find(([pattern]) => pattern.test(name))?.[1]
    const bytes = readFileSync(join(dir, name))
    if (magic === undefined || !bytes.subarray(0, magic.length).equals(magic)) {
      problems.push(`${name} is not the installer its name says`)
    }
  }
  return problems
}

/** `windows-sign-installers`: checks the two installers in `dir` and signs them in place. */
export function signInstallers(
  dir: string,
  version: string,
  options: WindowsSignOptions,
): string[] {
  const problems = installerProblems(dir, version)
  if (problems.length > 0) throw new Error(`The installers don't hold:\n${problems.join('\n')}`)
  const names = targetById('windows-x64')
    .files(version)
    .map((file) => file.name)
  signFiles(
    names.map((name) => join(dir, name)),
    options,
  )
  return names
}

// --- The signature check ------------------------------------------------------------------------

/** What a checked file is: an installer, fxm.exe inside one, or an NSIS plugin inside one. */
export type SignedRole = 'installer' | 'app' | 'plugin'

/** One file's signature, as `Get-AuthenticodeSignature` reports it. */
export interface FileSignature {
  /** The file, for the report: `fxm.exe in fxm-desktop-1.0.0-windows-x64.msi`. */
  readonly file: string
  readonly role: SignedRole
  /** `Valid`, `NotSigned`, `UnknownError` (an untrusted root, for one), `HashMismatch`, … */
  readonly status: string
  /** The signing certificate's thumbprint, if the file is signed. */
  readonly signer?: string | null
  /** Whether the signature carries a timestamp. */
  readonly timestamped?: boolean
}

/** The certificates that should have signed: the installers', and the app's and plugins'. */
export interface Signers {
  /** Who signed the installers (`windows-sign-installers`). */
  readonly installers?: string | undefined
  /** Who signed fxm.exe and the plugins (`windows-sign-app`). */
  readonly app?: string | undefined
}

/**
 * What is wrong with the signatures of the Windows files, given how they were signed. There
 * must be both installers, the fxm.exe inside each and the plugins inside the NSIS installer.
 * For `none`, nothing may be signed. Otherwise each file must be signed by the certificate of
 * its job and timestamped: the installers by `windows-sign-installers`', the rest by
 * `windows-sign-app`'s. A release's certificate signs both, with a signature Windows trusts
 * (`Valid`); a dry run's throwaway certificates, one per job, chain to no trusted root
 * (`UnknownError`, or `NotTrusted`), but their signatures must still match the files.
 */
export function checkWindowsSignatures(
  signatures: readonly FileSignature[],
  signing: WindowsSigning,
  signers: Signers = {},
): string[] {
  const problems: string[] = []
  const count = (role: SignedRole) => signatures.filter((s) => s.role === role).length
  if (count('installer') !== 2) problems.push(`${count('installer')} installers checked, not 2`)
  if (count('app') !== 2) problems.push(`${count('app')} copies of ${APP_BINARY} checked, not 2`)
  if (count('plugin') === 0) problems.push('no NSIS plugins checked')
  if (signing === 'none') {
    for (const { file, status } of signatures) {
      if (status !== 'NotSigned')
        problems.push(`${file} is signed (${status}), but nothing should be`)
    }
    return problems
  }
  const expected: Record<SignedRole, string> = {
    installer: parseThumbprint(signers.installers ?? ''),
    app: parseThumbprint(signers.app ?? ''),
    plugin: parseThumbprint(signers.app ?? ''),
  }
  if (signing === 'certificate' && expected.installer !== expected.app) {
    problems.push(
      `the installers are signed by ${expected.installer}, the app by ${expected.app}: a ` +
        "release's certificate signs both",
    )
  }
  const trusted = signing === 'certificate' ? ['Valid'] : ['Valid', 'UnknownError', 'NotTrusted']
  for (const signature of signatures) {
    const { file, status, role } = signature
    if (status === 'NotSigned') {
      problems.push(`${file} is not signed`)
      continue
    }
    if (!trusted.includes(status)) problems.push(`${file}: the signature is ${status}`)
    if (signature.signer?.toUpperCase() !== expected[role]) {
      problems.push(`${file} is signed by ${signature.signer ?? 'nobody'}, not ${expected[role]}`)
    }
    if (signature.timestamped !== true) problems.push(`${file} has no timestamp`)
  }
  return problems
}

/** Reads the report the workflow's PowerShell writes: one object, or an array of them. */
export function parseSignatureReport(json: string): FileSignature[] {
  const parsed: unknown = JSON.parse(json)
  const items = Array.isArray(parsed) ? parsed : [parsed]
  return items.map((item) => {
    const entry = item as Record<string, unknown>
    const role = entry.role
    if (
      typeof entry.file !== 'string' ||
      typeof entry.status !== 'string' ||
      (role !== 'installer' && role !== 'app' && role !== 'plugin')
    ) {
      throw new Error(`not a signature: ${JSON.stringify(item)}`)
    }
    return {
      file: entry.file,
      role,
      status: entry.status,
      signer: typeof entry.signer === 'string' ? entry.signer : null,
      timestamped: entry.timestamped === true,
    }
  })
}
