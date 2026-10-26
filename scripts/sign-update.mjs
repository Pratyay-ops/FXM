/**
 * FXM's signing tool for the updates that the desktop and Android apps download (stage 1.13).
 * The owner runs it through the scripts, never by hand:
 *
 *   scripts/make-signing-key.sh <folder outside the repository>   once: the two key pairs
 *   scripts/sign-config.sh --key <private key file>               after changing the config
 *   scripts/sign-module.sh --key <private key file>               after changing the YouTube code
 *
 * Commands:
 *
 *   keygen <folder>                         the signing key pair and its offline backup pair
 *   build config|module --out <file>        makes the file to sign and checks it, with no key
 *   sign config|module (--key <file> | --key-env <variable>) [--from <file>] [--out <folder>]
 *                                           signs it; without --from, runs `build` first
 *   verify module [--out <folder>]          rebuilds the module and compares it with the published one
 *
 * The private key never shares a process with the build toolchain: `build` and `verify` are the
 * only commands that load Vite or run the module, and `sign` runs `build` as a child process,
 * after taking the key out of its own environment, or signs a file built elsewhere (`--from`).
 * `sign` also refuses to sign uncommitted sources, and records the commit in the statement, so
 * `verify` can rebuild a published module and compare. Node runs this with type stripping, so it
 * uses the same TypeScript as the apps.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { keyIdOf, sha256Hex } from '../packages/platform/src/updates/digest.ts'
import { equalBytes, fromBase64, toBase64 } from '../packages/platform/src/updates/encoding.ts'
import {
  DEFAULT_CODE_MAX_BYTES,
  DEFAULT_JSON_MAX_BYTES,
  MAX_VERSION,
  parseEnvelope,
  parseStatement,
  SIGNATURE_SUFFIX,
} from '../packages/platform/src/updates/format.ts'
import {
  generateSigningKey,
  importSigningKey,
  pemToPkcs8,
  pkcs8ToPem,
  signUpdate,
} from '../packages/platform/src/updates/sign.ts'
import {
  checkArtifactBytes,
  createSignatureVerifier,
  isValidPublicKey,
  verifySignatureFile,
} from '../packages/platform/src/updates/verify.ts'
import {
  YOUTUBE_CONFIG_FILE,
  YOUTUBE_CONFIG_KIND,
  YOUTUBE_CONFIG_SCHEMA,
  YOUTUBE_MODULE_API,
  YOUTUBE_MODULE_FILE,
  YOUTUBE_MODULE_KIND,
  YOUTUBE_MODULE_VERSION,
} from '../packages/sources/src/youtube/module/version.ts'

const SCRIPT = fileURLToPath(import.meta.url)
const REPO = resolve(dirname(SCRIPT), '..')
const KEYS_FILE = join(REPO, 'packages/platform/src/updates/update-keys.json')
const CONFIG_SOURCE = join(REPO, 'packages/sources/src/youtube/youtube-config.json')
const DEFAULT_OUT = join(REPO, 'apps/site/public/updates')
/** The key pairs `keygen` creates: the one that signs, and a backup kept offline for a leak. */
const PAIRS = [
  { file: 'fxm-update-signing-key', role: 'signing key' },
  { file: 'fxm-update-backup-key', role: 'backup key' },
]
/** What the module is built from: a change here changes its bytes. */
const MODULE_INPUTS = [
  'packages/core',
  'packages/sources',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'LICENSE',
]
/** What must be committed before anything is signed: the inputs, and the signing code. */
const SIGNED_INPUTS = [
  ...MODULE_INPUTS,
  'packages/platform/src/updates',
  'scripts/sign-update.mjs',
  'scripts/sign-config.sh',
  'scripts/sign-module.sh',
]

/** The two artifacts, as the apps expect them. */
const ARTIFACTS = {
  config: {
    kind: YOUTUBE_CONFIG_KIND,
    file: YOUTUBE_CONFIG_FILE,
    api: YOUTUBE_CONFIG_SCHEMA,
    maxBytes: DEFAULT_JSON_MAX_BYTES,
    raise: 'raise "revision" in packages/sources/src/youtube/youtube-config.json',
  },
  module: {
    kind: YOUTUBE_MODULE_KIND,
    file: YOUTUBE_MODULE_FILE,
    api: YOUTUBE_MODULE_API,
    maxBytes: DEFAULT_CODE_MAX_BYTES,
    raise: 'raise YOUTUBE_MODULE_VERSION in packages/sources/src/youtube/module/version.ts',
  },
}

class UsageError extends Error {}

function fail(message) {
  throw new UsageError(message)
}

function artifactOf(what) {
  if (what !== 'config' && what !== 'module') fail('Which one? config or module.')
  return ARTIFACTS[what]
}

/** Whether `path` is inside `folder` (or is it). */
function inside(folder, path) {
  const rel = relative(folder, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The FXM checkouts a key must stay out of: this one and the main one that owns `.tools`. */
function checkouts() {
  return [REPO, process.env.FXM_HOME, process.env.FXM_ROOT]
    .filter(Boolean)
    .map((path) => resolve(path))
}

function refuseInsideRepo(path, what) {
  for (const checkout of checkouts()) {
    if (inside(checkout, path)) {
      fail(`${what} must stay outside the repository (${checkout}), so it can never be committed.`)
    }
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    return fail(`git ${args[0]} failed: ${String(error.stderr ?? error.message).trim()}`)
  }
}

/** The commit everything is signed from; refuses uncommitted changes to what is signed. */
function cleanCommit() {
  const changes = git(['status', '--porcelain', '--untracked-files=all', '--', ...SIGNED_INPUTS])
  if (changes.trim() !== '') {
    fail(
      `Commit these first, so that what is signed is reviewed source:\n${changes.trimEnd()}\n` +
        'The signature records the commit, and anyone can rebuild the module from it.',
    )
  }
  return git(['rev-parse', 'HEAD']).trim()
}

/** The keys `update-keys.json` lists, checked as the apps check them. */
async function trustedKeys() {
  const file = JSON.parse(await readFile(KEYS_FILE, 'utf8'))
  return (Array.isArray(file.keys) ? file.keys : []).flatMap((entry) => {
    const publicKey = typeof entry?.publicKey === 'string' ? fromBase64(entry.publicKey) : undefined
    const valid = publicKey !== undefined && isValidPublicKey(publicKey)
    return valid && entry.keyId === keyIdOf(publicKey) ? [{ keyId: entry.keyId, publicKey }] : []
  })
}

/** The highest version of `kind` already in the output folder, across all its files. */
async function publishedVersion(out, kind) {
  let names = []
  try {
    names = await readdir(out)
  } catch {
    return undefined
  }
  let highest
  for (const name of names.filter((file) => file.endsWith(SIGNATURE_SUFFIX))) {
    try {
      const envelope = parseEnvelope(new Uint8Array(await readFile(join(out, name))))
      const { kind: signed, version } = parseStatement(envelope.statementBytes)
      if (signed === kind) highest = Math.max(highest ?? 0, version)
    } catch {
      // Not a signature file in this format.
    }
  }
  return highest
}

// --- keygen ------------------------------------------------------------------------------------

async function keygen(args) {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} })
  if (positionals.length !== 1)
    fail('Usage: scripts/make-signing-key.sh <folder outside the repository>')
  const folder = resolve(positionals[0])
  refuseInsideRepo(folder, 'The signing keys')
  const paths = PAIRS.flatMap(({ file }) => [`${file}.pem`, `${file}.pub.json`]).map((name) =>
    join(folder, name),
  )
  for (const path of paths) {
    if (await exists(path)) fail(`${path} already exists: a key pair is never overwritten.`)
  }
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const entries = []
  for (const { file } of PAIRS) {
    const key = await generateSigningKey()
    const entry = { keyId: key.keyId, publicKey: toBase64(key.publicKey) }
    await writeFile(join(folder, `${file}.pem`), pkcs8ToPem(key.pkcs8), { mode: 0o600, flag: 'wx' })
    key.pkcs8.fill(0)
    await writeFile(join(folder, `${file}.pub.json`), `${JSON.stringify(entry, null, 2)}\n`, {
      mode: 0o644,
      flag: 'wx',
    })
    entries.push(entry)
  }
  const [signing, backup] = PAIRS.map(({ file }) => join(folder, `${file}.pem`))
  console.log(`Created the FXM update signing keys:

  ${PAIRS[0].role}  ${entries[0].keyId}  ${signing}
  ${PAIRS[1].role}   ${entries[1].keyId}  ${backup}

Both are secret: never commit or share them.

1. Trust both in every build: in packages/platform/src/updates/update-keys.json, replace the
   placeholder entry with these two, and commit that file:

${JSON.stringify(entries, null, 2)
  .split('\n')
  .map((line) => `   ${line}`)
  .join('\n')}

2. Move the backup key off this machine, to offline storage (a password manager, or an
   encrypted drive), and delete it here. It signs only if the signing key leaks or is lost:
   apps already trust it, so updates go on while an app update replaces the other key.

3. Sign with: scripts/sign-config.sh --key ${signing}
         and: scripts/sign-module.sh --key ${signing}`)
}

// --- build -------------------------------------------------------------------------------------

/** Builds the module from this checkout and imports it in this process (`build` only). */
async function freshModule() {
  const { buildYouTubeModule } = await import('../packages/sources/src/youtube/module/build.mjs')
  const built = await buildYouTubeModule()
  const url = `data:text/javascript;base64,${Buffer.from(built.bytes).toString('base64')}`
  const { youtubeModule } = await import(url)
  return { built, youtubeModule }
}

/** Checks that `youtubeModule` reads `document` as `revision` and starts with it. */
function checkReads(youtubeModule, document, revision, what) {
  let read
  try {
    read = youtubeModule.checkConfig(document)
    youtubeModule.create({ config: document })
  } catch (error) {
    fail(`The YouTube module built from this checkout can't use ${what}: ${error.message}`)
  }
  if (read !== revision) fail(`The module reads ${what} as revision ${read}, not ${revision}.`)
}

async function build(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { out: { type: 'string' } },
  })
  const artifact = artifactOf(positionals[0])
  if (values.out === undefined) fail('Give the file to write: --out <file>.')
  let bytes
  if (artifact.kind === YOUTUBE_CONFIG_KIND) {
    bytes = new Uint8Array(await readFile(CONFIG_SOURCE))
    const document = JSON.parse(new TextDecoder().decode(bytes))
    if (document.schema !== YOUTUBE_CONFIG_SCHEMA) {
      fail(
        `youtube-config.json has schema ${document.schema}, but apps fetch ${YOUTUBE_CONFIG_FILE}. ` +
          'A new schema goes under a new file name: raise YOUTUBE_CONFIG_SCHEMA in ' +
          'youtube/module/version.ts along with the one in youtube/config.ts.',
      )
    }
    const { youtubeModule } = await freshModule()
    checkReads(youtubeModule, document, document.revision, 'youtube-config.json')
  } else {
    const { built, youtubeModule } = await freshModule()
    if (
      youtubeModule.api !== YOUTUBE_MODULE_API ||
      youtubeModule.version !== YOUTUBE_MODULE_VERSION
    ) {
      fail(
        `The built module is ${youtubeModule.api}/${youtubeModule.version}, not what version.ts says.`,
      )
    }
    checkReads(
      youtubeModule,
      youtubeModule.config,
      youtubeModule.config?.revision,
      'its own config',
    )
    bytes = built.bytes
  }
  await writeFile(resolve(values.out), bytes)
  console.log(`Built and checked ${artifact.file} (${bytes.length} bytes).`)
}

// --- sign --------------------------------------------------------------------------------------

/** Runs `build` in a child process, which inherits no key: it was taken out of the environment. */
async function buildInChild(what, out) {
  await new Promise((done, failed) => {
    const child = spawn(
      process.execPath,
      [...process.execArgv, SCRIPT, 'build', what, '--out', out],
      {
        stdio: 'inherit',
        env: process.env,
      },
    )
    child.once('error', failed)
    child.once('exit', (code) =>
      code === 0
        ? done()
        : failed(new UsageError(`Building the ${what} failed: nothing was signed.`)),
    )
  })
}

/**
 * With --key-env, the PEM text of the private key, taken out of the environment at once; with
 * --key, nothing yet (the file is read just before signing). Refuses a call that gives neither.
 */
function takeKeyFromEnvironment(values) {
  if (values.key !== undefined && values['key-env'] !== undefined) {
    fail('Give --key or --key-env, not both.')
  }
  if (values['key-env'] === undefined) {
    if (values.key === undefined) {
      fail('Give the private key: --key <file> (or --key-env <variable> in CI).')
    }
    return undefined
  }
  const name = values['key-env']
  const pem = process.env[name]
  delete process.env[name]
  if (!pem) fail(`The environment variable ${name} holds no private key.`)
  return pem
}

async function loadKey(values, pem) {
  let text = pem
  if (text === undefined) {
    const path = resolve(values.key)
    refuseInsideRepo(path, 'The private key')
    text = await readFile(path, 'utf8').catch(() => fail(`Can't read the private key ${path}`))
    const { mode } = await stat(path)
    if ((mode & 0o077) !== 0)
      console.warn(`! ${path} can be read by other users: run chmod 600 on it.`)
  }
  try {
    return await importSigningKey(pemToPkcs8(text))
  } catch {
    return fail('That is not an Ed25519 private key in PEM (-----BEGIN PRIVATE KEY-----).')
  }
}

async function sign(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      key: { type: 'string' },
      'key-env': { type: 'string' },
      from: { type: 'string' },
      out: { type: 'string' },
      'allow-untrusted-key': { type: 'boolean' },
    },
  })
  const pem = takeKeyFromEnvironment(values)
  const what = positionals[0]
  const artifact = artifactOf(what)
  const out = resolve(values.out ?? DEFAULT_OUT)
  const source = cleanCommit()

  // The version, from the committed sources, before anything is built.
  const committedConfig = new Uint8Array(await readFile(CONFIG_SOURCE))
  const version =
    artifact.kind === YOUTUBE_CONFIG_KIND
      ? JSON.parse(new TextDecoder().decode(committedConfig)).revision
      : YOUTUBE_MODULE_VERSION
  if (!Number.isSafeInteger(version) || version < 1 || version > MAX_VERSION) {
    fail(`${version} is not a version: it must be a whole number from 1 to ${MAX_VERSION}.`)
  }
  const published = await publishedVersion(out, artifact.kind)
  if (published !== undefined && published >= version) {
    fail(
      `Version ${published} of ${artifact.kind} is already in ${out}. Apps take only higher ` +
        `versions, also across file names: ${artifact.raise} first.`,
    )
  }

  // The file to sign: built now, in a child process, or built elsewhere from the same commit.
  let bytes
  if (values.from === undefined) {
    const work = await mkdtemp(join(tmpdir(), 'fxm-sign-'))
    try {
      await buildInChild(what, join(work, artifact.file))
      bytes = new Uint8Array(await readFile(join(work, artifact.file)))
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  } else {
    bytes = new Uint8Array(await readFile(resolve(values.from)))
  }
  if (bytes.length > artifact.maxBytes) fail(`${artifact.file} is over ${artifact.maxBytes} bytes.`)
  if (artifact.kind === YOUTUBE_CONFIG_KIND && !equalBytes(bytes, committedConfig)) {
    fail('The config to sign is not youtube-config.json as committed.')
  }

  // Only now the key, in this process, which has loaded no build tool.
  const key = await loadKey(values, pem)
  const trusted = (await trustedKeys()).find((entry) => entry.keyId === key.keyId)
  if (trusted === undefined && values['allow-untrusted-key'] !== true) {
    fail(
      `The key ${key.keyId} is not in packages/platform/src/updates/update-keys.json, so apps ` +
        'would refuse what it signs. Add its public key there first (make-signing-key.sh printed it).',
    )
  }
  const signed = await signUpdate(key, {
    kind: artifact.kind,
    version,
    api: artifact.api,
    file: artifact.file,
    bytes,
    source,
  })
  // Check the result exactly as the apps will, before anything is written.
  const verdict = await verifySignatureFile(
    signed.envelope,
    { kind: artifact.kind, file: artifact.file, api: artifact.api, maxBytes: artifact.maxBytes },
    [trusted ?? { keyId: key.keyId, publicKey: key.publicKey }],
    createSignatureVerifier(),
  )
  if (!verdict.ok || checkArtifactBytes(bytes, verdict.statement) !== undefined) {
    fail('The new signature does not verify: nothing was written.')
  }
  await mkdir(out, { recursive: true })
  await writeFile(join(out, artifact.file), bytes)
  await writeFile(join(out, `${artifact.file}${SIGNATURE_SUFFIX}`), signed.envelope)
  const { statement } = signed
  console.log(`Signed ${statement.kind} version ${statement.version} with ${key.keyId}, from ${source}:

  ${join(out, artifact.file)}  (${statement.size} bytes, SHA-256 ${statement.sha256})
  ${join(out, `${artifact.file}${SIGNATURE_SUFFIX}`)}

Commit both files and deploy the site: the desktop and Android apps pick them up on their next
start. Publish both files together, and never edit the signed file afterwards.`)
}

// --- verify ------------------------------------------------------------------------------------

async function verify(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { out: { type: 'string' } },
  })
  if (positionals[0] !== 'module') fail('Usage: sign-update.mjs verify module [--out <folder>]')
  const artifact = ARTIFACTS.module
  const out = resolve(values.out ?? DEFAULT_OUT)
  const signature = join(out, `${artifact.file}${SIGNATURE_SUFFIX}`)
  if (!(await exists(signature))) {
    console.log(`No ${artifact.file} is published in ${out} yet: nothing to verify.`)
    return
  }
  const envelope = new Uint8Array(await readFile(signature))
  const statement = parseStatement(parseEnvelope(envelope).statementBytes)
  const keys = await trustedKeys()
  if (keys.length > 0) {
    const verdict = await verifySignatureFile(envelope, artifact, keys, createSignatureVerifier())
    if (!verdict.ok) fail(`${signature}: ${verdict.failure}: ${verdict.message}`)
  }
  const published = new Uint8Array(await readFile(join(out, artifact.file)))
  if (checkArtifactBytes(published, statement) !== undefined) {
    fail(`${artifact.file} does not match its signature.`)
  }
  const { buildYouTubeModule } = await import('../packages/sources/src/youtube/module/build.mjs')
  const built = await buildYouTubeModule({ version: statement.version })
  if (built.bytes.length === statement.size && sha256Hex(built.bytes) === statement.sha256) {
    console.log(`✔ ${artifact.file} version ${statement.version} is what this checkout builds.`)
    return
  }
  const from = statement.source
  const changed =
    from === undefined
      ? 'Its statement names no commit to rebuild it from.'
      : (() => {
          try {
            execFileSync('git', ['diff', '--quiet', from, '--', ...MODULE_INPUTS], { cwd: REPO })
            return `The module's sources are as at ${from}, yet the build differs: investigate.`
          } catch {
            return `The module's sources changed since ${from}: check that commit out to compare.`
          }
        })()
  fail(
    `${artifact.file} version ${statement.version} is not what this checkout builds ` +
      `(SHA-256 ${statement.sha256}, this build ${sha256Hex(built.bytes)}). ${changed}`,
  )
}

// --- main --------------------------------------------------------------------------------------

const COMMANDS = { keygen, build, sign, verify }
const [command, ...rest] = process.argv.slice(2)
try {
  if (!Object.hasOwn(COMMANDS, command ?? '')) {
    fail(
      'Usage: sign-update.mjs keygen <folder> | build config|module --out <file> | ' +
        'sign config|module --key <file> [--from <file>] [--out <folder>] | verify module',
    )
  }
  await COMMANDS[command](rest)
} catch (error) {
  if (!(error instanceof UsageError)) throw error
  console.error(`✘ ${error.message}`)
  process.exitCode = 1
}
